// ADR 0006 — Concierge: o REGISTRO de tarefas (Task), o barramento de eventos e a
// reivindicação de arquivos. PORTÁTIL: sem Ink, sem I/O. O motor (cli) atualiza o registro;
// o Concierge e a TUI só LEEM e assinam eventos.

export type TaskStatus =
  | 'blocked' // espera outra tarefa liberar arquivos
  | 'running'
  | 'waiting_approval'
  | 'paused_quota'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'interrupted'; // estava em voo quando a sessão foi encerrada (resume)

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'done',
  'failed',
  'stopped',
  'interrupted',
]);

/** Fase fina de uma tarefa viva — decide se uma correção ainda pode entrar. */
export type TaskPhase = 'idle' | 'model_call' | 'tool' | 'asking';

export interface TaskRecord {
  readonly id: string;
  readonly goal: string;
  readonly status: TaskStatus;
  readonly phase: TaskPhase;
  /** Como a tarefa roda: o turno do agente principal ou um sub-agente desacoplado. */
  readonly kind: 'main' | 'detached';
  readonly files: readonly string[];
  /** Tarefa que segura os arquivos desta (status `blocked`). */
  readonly blockedBy?: string;
  /** Resumo curto do desfecho (já redigido por quem publica). DADO, nunca instrução. */
  readonly summary?: string;
  /** Resultado mais longo (até ~1500 chars) para o Concierge relatar ao dono. DADO. */
  readonly result?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly steps: number;
  /** O que a tarefa está fazendo AGORA (ferramenta em curso, p.ex. `bash ls -la`). */
  readonly current?: string;
}

export type TaskEventKind =
  | 'started'
  | 'blocked'
  | 'step'
  | 'tool'
  | 'waiting_approval'
  | 'paused_quota'
  | 'resumed'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'interrupted';

export interface TaskEvent {
  readonly seq: number;
  readonly at: number;
  readonly taskId: string;
  readonly kind: TaskEventKind;
  readonly detail?: string;
}

export type TaskListener = (ev: TaskEvent, task: TaskRecord) => void;

export const MAX_LIVE_TASKS = 4;
const MAX_EVENTS = 60;

export interface TaskRegistryOptions {
  readonly clock?: () => number;
}

/** Normaliza um caminho p/ comparação (sem `./`, barras repetidas, `/` final). */
export function normalizeClaimPath(p: string): string {
  const parts = p
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s !== '' && s !== '.');
  return parts.join('/');
}

/** `a` e `b` colidem se são o mesmo caminho ou um contém o outro (pasta ⊇ arquivo). */
export function claimsOverlap(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly events: TaskEvent[] = [];
  private readonly listeners = new Set<TaskListener>();
  private seq = 0;
  private nextId = 1;
  private readonly clock: () => number;

  constructor(opts: TaskRegistryOptions = {}) {
    this.clock = opts.clock ?? Date.now;
  }

  subscribe(fn: TaskListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Cria a tarefa. Já nasce `blocked` se algum arquivo está reivindicado por tarefa viva. */
  create(args: { goal: string; kind: 'main' | 'detached'; files?: readonly string[] }): TaskRecord {
    const files = [...new Set((args.files ?? []).map(normalizeClaimPath).filter((f) => f !== ''))];
    const holder = this.findClaimHolder(files);
    const id = `t${this.nextId++}`;
    const rec: TaskRecord = {
      id,
      goal: args.goal,
      status: holder ? 'blocked' : 'running',
      phase: 'idle',
      kind: args.kind,
      files,
      ...(holder ? { blockedBy: holder.id } : {}),
      startedAt: this.clock(),
      steps: 0,
    };
    this.tasks.set(id, rec);
    this.emit(holder ? 'blocked' : 'started', rec, holder ? `espera ${holder.id}` : undefined);
    return rec;
  }

  /** Tarefa VIVA (não-terminal, não-bloqueada) que segura algum dos `files`. */
  findClaimHolder(files: readonly string[], ignoreId?: string): TaskRecord | undefined {
    if (files.length === 0) return undefined;
    for (const t of this.tasks.values()) {
      if (t.id === ignoreId || TERMINAL_STATUSES.has(t.status) || t.status === 'blocked') continue;
      if (t.files.some((c) => files.some((f) => claimsOverlap(c, f)))) return t;
    }
    return undefined;
  }

  get(id: string): TaskRecord | undefined {
    return this.tasks.get(id);
  }

  list(): readonly TaskRecord[] {
    return [...this.tasks.values()];
  }

  live(): readonly TaskRecord[] {
    return this.list().filter((t) => !TERMINAL_STATUSES.has(t.status));
  }

  recentEvents(n = 8): readonly TaskEvent[] {
    return this.events.slice(-n);
  }

  /** Atualiza fase/passos sem evento de transição (alimenta a lista viva). */
  touch(id: string, patch: { phase?: TaskPhase; steps?: number; current?: string | null }): void {
    const t = this.tasks.get(id);
    if (!t || TERMINAL_STATUSES.has(t.status)) return;
    const { current: _c, ...rest } = t;
    void _c;
    const current = patch.current === undefined ? t.current : (patch.current ?? undefined);
    this.tasks.set(id, {
      ...rest,
      ...(patch.phase !== undefined ? { phase: patch.phase } : {}),
      ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
      ...(current !== undefined ? { current } : {}),
    });
  }

  /** Publica um evento "informativo" (step/tool) sem mudar o status. */
  note(id: string, kind: 'step' | 'tool', detail?: string): void {
    const t = this.tasks.get(id);
    if (!t) return;
    const next = kind === 'step' ? { ...t, steps: t.steps + 1 } : t;
    this.tasks.set(id, next);
    this.emit(kind, next, detail);
  }

  /** Muda o status. Transição para terminal é IDEMPOTENTE (a 1ª vence). */
  transition(
    id: string,
    to: TaskStatus,
    detail?: string,
    extra?: { summary?: string; result?: string },
  ): TaskRecord | undefined {
    const t = this.tasks.get(id);
    if (!t) return undefined;
    if (TERMINAL_STATUSES.has(t.status)) return t; // terminal é final
    if (t.status === to && extra?.summary === undefined) return t;
    const terminal = TERMINAL_STATUSES.has(to);
    const { blockedBy: _drop, current: _cur, ...rest } = t;
    void _drop;
    void _cur;
    const next: TaskRecord = {
      ...rest,
      status: to,
      phase:
        terminal || to === 'waiting_approval'
          ? to === 'waiting_approval'
            ? 'asking'
            : 'idle'
          : t.phase,
      ...(terminal ? { endedAt: this.clock() } : {}),
      ...(extra?.summary !== undefined
        ? { summary: extra.summary }
        : t.summary !== undefined
          ? { summary: t.summary }
          : {}),
      ...(extra?.result !== undefined
        ? { result: extra.result }
        : t.result !== undefined
          ? { result: t.result }
          : {}),
      ...(to === 'blocked' && t.blockedBy !== undefined ? { blockedBy: t.blockedBy } : {}),
    };
    this.tasks.set(id, next);
    const kind: TaskEventKind =
      to === 'running' ? (t.status === 'blocked' ? 'started' : 'resumed') : (to as TaskEventKind);
    this.emit(kind, next, detail);
    return next;
  }

  /** Tarefas bloqueadas cujos arquivos agora estão livres (na ordem de criação). */
  releasable(): readonly TaskRecord[] {
    const out: TaskRecord[] = [];
    const claimed: TaskRecord[] = [];
    for (const t of this.tasks.values()) {
      if (t.status !== 'blocked') continue;
      if (this.findClaimHolder(t.files, t.id)) continue;
      // Duas bloqueadas pelo mesmo arquivo: só a mais antiga sai agora.
      if (claimed.some((c) => c.files.some((f) => t.files.some((g) => claimsOverlap(f, g)))))
        continue;
      claimed.push(t);
      out.push(t);
    }
    return out;
  }

  /** Restaura do disco (resume). O que estava vivo volta `interrupted`. */
  restore(records: readonly TaskRecord[], nextId: number): void {
    for (const r of records) {
      const live = !TERMINAL_STATUSES.has(r.status);
      this.tasks.set(r.id, live ? { ...r, status: 'interrupted', phase: 'idle' } : r);
    }
    this.nextId = Math.max(this.nextId, nextId);
  }

  snapshot(): { tasks: readonly TaskRecord[]; nextId: number } {
    return { tasks: this.list(), nextId: this.nextId };
  }

  private emit(kind: TaskEventKind, task: TaskRecord, detail?: string): void {
    const ev: TaskEvent = {
      seq: ++this.seq,
      at: this.clock(),
      taskId: task.id,
      kind,
      ...(detail !== undefined ? { detail } : {}),
    };
    this.events.push(ev);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    for (const l of [...this.listeners]) {
      try {
        l(ev, task);
      } catch {
        /* um assinante com defeito não derruba o motor */
      }
    }
  }
}

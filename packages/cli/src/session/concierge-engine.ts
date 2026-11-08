// ADR 0006 — o MOTOR das tarefas do Concierge, sobre o `SessionController` (intocado).
//
// Cada tarefa é uma `TaskSession`: a primeira roda no controller da TUI (o turno que o dono
// vê, como no clássico); as paralelas rodam em controllers HEADLESS que o `createHeadless`
// constrói (mesmo `buildSession`: histórico, fila de injeção, sub-agentes e catraca próprios).
// Este módulo só OBSERVA o estado de cada sessão e publica no `TaskRegistry`; nunca decide
// permissão (todo efeito segue por `decide()` dentro da sessão).

import type {
  AskResolution,
  ConciergeEngine,
  EngineSnapshot,
  TaskRecord,
  TaskRegistry,
} from '@hiperplano/aluy-cli-core';
import { clip, redactOutputSecrets, taskGoalForAgent } from '@hiperplano/aluy-cli-core';
import type { HistoryItem } from '@hiperplano/aluy-cli-core';
import type { SessionState } from './model.js';

/** O recorte do `SessionController` que o motor usa (permite fake nos testes). */
export interface TaskSession {
  readonly current: SessionState;
  subscribe(observer: (s: SessionState) => void): () => void;
  addToolObserver(observer: {
    onToolStart?(call: { name: string; input?: Readonly<Record<string, unknown>> }): void;
    onToolEnd?(call: { name: string }, ok: boolean): void;
  }): () => void;
  submit(
    goal: string,
    attachments?: readonly HistoryItem[],
    opts?: { readonly display?: string },
  ): Promise<void>;
  injectInput(nodeId: string, input: string): boolean;
  interrupt(): void;
  /** Derruba o turno E os sub-agentes da tarefa (cessar ≠ agir: só aborta). */
  cancelAllFlows?(origin: 'f8' | 'panel' | 'exit'): void;
  resolveAsk(r: AskResolution): void;
  /** "Aprovar sempre NESTA tarefa" (liga a flag da engine DESTA sessão); `false` se não dá. */
  allowAllInTask?(): boolean;
  /** Tokens do turno até agora (vivo); ausente em sessões falsas. */
  turnAccounting?(): { readonly tokens: number; readonly cachePct?: number } | undefined;
  dispose?(): void;
}

export interface TaskEngineDeps {
  readonly registry: TaskRegistry;
  /** Constrói a sessão headless de uma tarefa; `null` ⇒ indisponível. */
  readonly createHeadless?: (taskId: string) => TaskSession | null;
}

interface Handle {
  readonly session: TaskSession;
  readonly headless: boolean;
  readonly unsubs: (() => void)[];
  stopRequested: boolean;
  startBlocks: number;
  /** O dono escolheu "aprovar sempre nesta tarefa" (morre com a tarefa). */
  allowAll: boolean;
  /** Ferramentas em execução agora (o rótulo de atividade é da ferramenta, não da fase). */
  toolsInFlight: number;
}

export class ControllerTaskEngine implements ConciergeEngine {
  private readonly handles = new Map<string, Handle>();

  constructor(private readonly d: TaskEngineDeps) {}

  start(task: TaskRecord): void {
    // TODA tarefa roda numa sessão headless PRÓPRIA (histórico, fila de injeção, sub-agentes e
    // catraca próprios). O controller da TUI só conversa: nada do trabalho (blocos de turno,
    // ferramentas, raciocínio, self-check) entra na transcrição — vai para o painel do rodapé.
    let session: TaskSession | null;
    try {
      session = this.d.createHeadless?.(task.id) ?? null;
    } catch (e) {
      session = null;
      this.d.registry.transition(task.id, 'failed', `sessão da tarefa falhou: ${msg(e)}`);
      return;
    }
    if (!session) {
      this.d.registry.transition(task.id, 'failed', 'sessões de tarefa indisponíveis neste modo');
      return;
    }
    const headless = true;
    const h: Handle = {
      session,
      headless,
      unsubs: [],
      stopRequested: false,
      allowAll: false,
      toolsInFlight: 0,
      startBlocks: session.current.blocks.length,
    };
    this.handles.set(task.id, h);
    h.unsubs.push(this.observeState(task.id, h));
    h.unsubs.push(
      session.addToolObserver({
        onToolStart: (c) => {
          h.toolsInFlight += 1;
          this.d.registry.touch(task.id, { phase: 'tool', current: toolLabel(c) });
          this.d.registry.note(task.id, 'tool', c.name);
        },
        onToolEnd: () => {
          h.toolsInFlight = Math.max(0, h.toolsInFlight - 1);
          this.d.registry.touch(task.id, {
            phase: 'idle',
            ...(h.toolsInFlight === 0 ? { current: null } : {}),
          });
          this.d.registry.note(task.id, 'step');
        },
      }),
    );
    session
      .submit(taskGoalForAgent(task.goal), [], { display: `▸ ${task.id}: ${clip(task.goal, 100)}` })
      .then(
        () => this.finish(task.id, h),
        (e: unknown) => {
          this.cleanup(h);
          this.d.registry.transition(task.id, 'failed', msg(e), { result: clip(msg(e), 600) });
        },
      );
  }

  send(task: TaskRecord, message: string): { delivered: boolean; note: string } {
    const h = this.handles.get(task.id);
    if (!h) return { delivered: false, note: 'a tarefa não tem sessão ativa' };
    const ok = h.session.injectInput('root', message);
    return ok
      ? { delivered: true, note: 'entra após o passo atual' }
      : { delivered: false, note: 'a sessão recusou a mensagem' };
  }

  stop(task: TaskRecord): boolean {
    const h = this.handles.get(task.id);
    if (!h) return false;
    h.stopRequested = true;
    if (h.session.cancelAllFlows) h.session.cancelAllFlows('panel');
    else h.session.interrupt();
    return true;
  }

  /** Para TODAS as tarefas vivas (F8). */
  stopAll(): void {
    for (const t of this.d.registry.live()) {
      if (t.status === 'blocked') this.d.registry.transition(t.id, 'stopped', 'parada (tudo)');
      else {
        this.stop(t);
        this.d.registry.transition(t.id, 'stopped', 'parada (tudo)');
      }
    }
  }

  snapshot(): EngineSnapshot {
    const approvals: { taskId?: string; summary: string }[] = [];
    const quotaPauses: { taskId?: string; reason: string }[] = [];
    const subAgents: { label: string; status: string; taskId?: string }[] = [];
    for (const [taskId, h] of this.handles) {
      const t = this.d.registry.get(taskId);
      if (!t || t.endedAt !== undefined) continue;
      const s = h.session.current;
      if (s.pendingAsk) approvals.push({ taskId, summary: askSummary(s) });
      if (s.quotaPause) quotaPauses.push({ taskId, reason: s.quotaPause.reason });
      for (const f of s.liveSubagents ?? []) {
        subAgents.push({ label: f.label, status: f.phase, taskId });
      }
    }
    return { approvals, quotaPauses, subAgents };
  }

  /** A sessão da tarefa (para a vista de detalhe do rodapé). */
  sessionOf(taskId: string): TaskSession | undefined {
    return this.handles.get(taskId)?.session;
  }

  /** Aprovações pendentes na ordem das tarefas (a caixa de entrada). */
  pendingApprovals(): readonly PendingApproval[] {
    const out: PendingApproval[] = [];
    for (const [taskId, h] of this.handles) {
      const t = this.d.registry.get(taskId);
      if (!t || t.endedAt !== undefined) continue;
      if (h.session.current.pendingAsk)
        out.push({
          taskId,
          summary: askSummary(h.session.current),
          ...askEffect(h.session.current),
        });
    }
    return out;
  }

  /**
   * Tokens da tarefa AGORA: o uso reportado (agregado pai+filhos) ou, se o provider não
   * reporta uso em stream, uma ESTIMATIVA pelos caracteres gerados (≈4 por token), marcada.
   */
  liveTokens(taskId: string): {
    readonly tokens: number;
    readonly estimated: boolean;
    readonly cachePct?: number;
  } {
    const h = this.handles.get(taskId);
    if (!h) return { tokens: 0, estimated: false };
    const acc = h.session.turnAccounting?.();
    const real = acc?.tokens ?? h.session.current.meta?.tokens ?? 0;
    if (real > 0)
      return {
        tokens: real,
        estimated: false,
        ...(acc?.cachePct !== undefined ? { cachePct: acc.cachePct } : {}),
      };
    let chars = 0;
    for (const b of h.session.current.blocks.slice(h.startBlocks)) {
      if (b.kind === 'aluy') chars += b.text.length + (b.reasoning?.length ?? 0);
    }
    return { tokens: Math.ceil(chars / 4), estimated: true };
  }

  /** A tarefa está em "aprovar sempre nesta tarefa"? (p/ o rótulo do painel). */
  isAllowAll(taskId: string): boolean {
    return this.handles.get(taskId)?.allowAll === true;
  }

  /**
   * Responde a aprovação da tarefa `taskId` (ou da mais antiga). `undefined` se não há.
   * `alwaysInTask`: liga também "aprovar sempre nesta tarefa" — SÓ se o pedido NÃO é de uma
   * categoria sempre-ask (essas perguntam toda vez); a flag vive na engine da sessão da
   * tarefa e a decisão segue passando por `decide()`.
   */
  resolveApproval(
    taskId: string | undefined,
    r: AskResolution,
    opts: { readonly alwaysInTask?: boolean } = {},
  ): { taskId: string; alwaysInTask: boolean; alwaysRefused: boolean } | undefined {
    const pend = this.pendingApprovals();
    const target = taskId ? pend.find((p) => p.taskId === taskId) : pend[0];
    if (!target) return undefined;
    const h = this.handles.get(target.taskId)!;
    let alwaysInTask = false;
    let alwaysRefused = false;
    if (opts.alwaysInTask === true && r.kind !== 'deny') {
      const req = h.session.current.pendingAsk?.request;
      if (req?.alwaysAsk === true || !h.session.allowAllInTask) alwaysRefused = true;
      else if (h.session.allowAllInTask()) {
        h.allowAll = true;
        alwaysInTask = true;
      } else alwaysRefused = true;
    }
    h.session.resolveAsk(r);
    return { taskId: target.taskId, alwaysInTask, alwaysRefused };
  }

  dispose(): void {
    for (const h of this.handles.values()) {
      this.cleanup(h);
      if (h.headless) h.session.dispose?.();
    }
    this.handles.clear();
  }

  // ── observação ─────────────────────────────────────────────────────────────

  private observeState(id: string, h: Handle): () => void {
    let asking = false;
    let paused = false;
    return h.session.subscribe((s) => {
      const reg = this.d.registry;
      const t = reg.get(id);
      if (!t || t.endedAt !== undefined) return;
      if (s.pendingAsk && !asking) {
        asking = true;
        reg.transition(id, 'waiting_approval', askSummary(s));
      } else if (!s.pendingAsk && asking) {
        asking = false;
        reg.transition(id, 'running');
      }
      if (s.quotaPause && !paused) {
        paused = true;
        reg.transition(id, 'paused_quota', s.quotaPause.reason);
      } else if (!s.quotaPause && paused) {
        paused = false;
        reg.transition(id, 'running');
      }
      if (s.phase === 'thinking' || s.phase === 'streaming') {
        // Sem ferramenta em curso: diz o que o modelo está fazendo (o painel nunca fica mudo).
        reg.touch(id, {
          phase: 'model_call',
          ...(h.toolsInFlight === 0
            ? { current: s.phase === 'thinking' ? 'pensando' : 'escrevendo' }
            : {}),
        });
      }
    });
  }

  private finish(id: string, h: Handle): void {
    this.cleanup(h);
    const reg = this.d.registry;
    const s = h.session.current;
    if (h.stopRequested) {
      reg.transition(id, 'stopped', 'parada a pedido do dono');
      return;
    }
    const blocks = s.blocks.slice(h.startBlocks);
    const lastAluy = [...blocks].reverse().find((b) => b.kind === 'aluy');
    const interrupted = lastAluy?.kind === 'aluy' && lastAluy.interrupted === true;
    if (s.phase === 'error') {
      const err = [...blocks].reverse().find((b) => b.kind === 'broker-error');
      const why = err?.kind === 'broker-error' ? err.message : 'erro no turno';
      reg.transition(id, 'failed', why, { result: clip(why, 600) });
      return;
    }
    if (interrupted) {
      reg.transition(id, 'stopped', 'interrompida');
      return;
    }
    const text = lastAluy?.kind === 'aluy' ? lastAluy.text : '';
    reg.transition(id, 'done', undefined, {
      summary: clip(text || 'sem resposta textual', 300),
      result: clip(text || 'sem resposta textual', 1500),
    });
  }

  private cleanup(h: Handle): void {
    for (const u of h.unsubs.splice(0)) u();
  }
}

/** O pedido de aprovação de uma tarefa (a caixa de entrada do rodapé). */
export interface PendingApproval {
  readonly taskId: string;
  /** Uma linha (redigida) — fallback e o que o Concierge lê. */
  readonly summary: string;
  /** O efeito EXATO estruturado (diff multi-linha, comando…), redigido linha a linha. */
  readonly effect?: {
    readonly kind: string;
    readonly tool: string;
    readonly path?: string;
    readonly lines: readonly string[];
  };
}

function askEffect(s: SessionState): { effect?: NonNullable<PendingApproval['effect']> } {
  const r = s.pendingAsk?.request;
  if (!r) return {};
  return {
    effect: {
      kind: r.effect.kind,
      tool: r.call.name,
      ...(r.effect.path !== undefined ? { path: r.effect.path } : {}),
      lines: redactOutputSecrets(r.effect.exact).split('\n'),
    },
  };
}

function askSummary(s: SessionState): string {
  const r = s.pendingAsk?.request;
  if (!r) return '';
  // O comando EXATO, não truncado cedo: quem aprova precisa ver o que está aprovando. Se o
  // efeito já começa pelo nome da tool (tool sem descritor próprio), não o repete.
  const exact = r.effect.exact ?? '';
  const body = exact.startsWith(`${r.call.name} `) ? exact.slice(r.call.name.length + 1) : exact;
  return `${r.call.name}: ${clip(body, 600)}`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `lendo calc.py` / `editando calc.py` / `bash ls -la`: a ferramenta em curso, em poucas palavras. */
export function toolLabel(c: { name: string; input?: Readonly<Record<string, unknown>> }): string {
  const i = c.input ?? {};
  const str = (k: string): string | undefined =>
    typeof i[k] === 'string' && i[k] !== '' ? (i[k] as string) : undefined;
  const path = str('path');
  const verb: Readonly<Record<string, string>> = {
    read_file: 'lendo',
    edit_file: 'editando',
    write_file: 'escrevendo',
    run_command: 'bash',
    run_tests: 'testes',
    grep: 'buscando',
    web_fetch: 'baixando',
    web_search: 'pesquisando',
  };
  const arg = path ?? str('command') ?? str('pattern') ?? str('query') ?? str('url');
  if (c.name === 'spawn_agent') return 'delegando a agentes';
  const v = verb[c.name] ?? c.name;
  return clip(arg !== undefined ? `${v} ${arg}` : v, 48);
}

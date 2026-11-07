// ADR 0006 — o RUNTIME do Concierge no cli: junta registro de tarefas, motor (sobre o
// SessionController), Concierge (core) e a persistência. A TUI fala só com isto:
//   • `handleOwnerMessage(texto)` — NUNCA espera o trabalho; responde por nota na conversa.
//   • `stopAll()` / `stopTask(id)` / `approve(...)` / `deny(...)` — controle explícito.
//   • `subscribe(fn)` — a lista compacta de tarefas ao vivo.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  Concierge,
  TERMINAL_STATUSES,
  TaskRegistry,
  clip,
  formatElapsed,
  statusPt,
  type AskResolution,
  type ChatMessage,
  type ConciergeGate,
  type ConciergeModel,
  type TaskRecord,
} from '@hiperplano/aluy-cli-core';
import { abbreviateCount } from './model.js';
import type { SubAgentChildView } from '../ui/components/SubAgents.js';
import type { SessionBlock } from './model.js';
import { ControllerTaskEngine, type TaskSession } from './concierge-engine.js';

/** O recorte da sessão da TUI que o runtime escreve na conversa. */
export interface ConversationSink {
  pushConciergeEcho(text: string): void;
  pushConciergeLine(text: string): void;
  conciergeReplyStart(): void;
  conciergeReplyEnd(fallback?: string): void;
  cancelAllFlows(origin: 'f8' | 'panel' | 'exit'): void;
}

export interface ConciergeRuntimeDeps {
  readonly sink: ConversationSink;
  readonly model: ConciergeModel;
  readonly gate?: ConciergeGate;
  readonly createHeadless?: (taskId: string) => TaskSession | null;
  readonly ownerFacts?: () => Promise<readonly string[]>;
  readonly projectSummary?: () => string | undefined;
  /** Arquivo de persistência (`--resume`); ausente ⇒ sem persistência. */
  readonly storePath?: () => string | undefined;
  readonly clock?: () => number;
}

interface Persisted {
  readonly version: 1;
  readonly tasks: readonly TaskRecord[];
  readonly nextId: number;
  readonly history: readonly ChatMessage[];
}

export class ConciergeRuntime {
  readonly registry: TaskRegistry;
  readonly engine: ControllerTaskEngine;
  readonly concierge: Concierge;
  private facts: readonly string[] = [];
  private readonly listeners = new Set<() => void>();
  private inflight = new Set<AbortController>();
  private readonly clock: () => number;

  constructor(private readonly d: ConciergeRuntimeDeps) {
    const clock = d.clock ?? Date.now;
    this.clock = clock;
    this.registry = new TaskRegistry({ clock });
    this.engine = new ControllerTaskEngine({
      registry: this.registry,
      ...(d.createHeadless ? { createHeadless: d.createHeadless } : {}),
    });
    this.concierge = new Concierge({
      registry: this.registry,
      engine: this.engine,
      model: d.model,
      ...(d.gate ? { gate: d.gate } : {}),
      ownerFacts: () => this.facts,
      ...(d.projectSummary ? { projectSummary: d.projectSummary } : {}),
      clock,
    });
    // Relatos: uma linha por evento que importa, na conversa (sem chamar o modelo).
    this.concierge.attachRelay((line) => d.sink.pushConciergeLine(line));
    this.registry.subscribe(() => {
      this.persist();
      for (const l of [...this.listeners]) l();
    });
    this.restore();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  tasks(): readonly TaskRecord[] {
    return this.registry.list();
  }

  /** Tarefas para a lista compacta: vivas + as 2 últimas terminadas. */
  visibleTasks(): readonly TaskRecord[] {
    const all = this.registry.list();
    const live = all.filter((t) => !TERMINAL_STATUSES.has(t.status));
    const now = this.clock();
    // Terminadas somem da lista 60s depois (o relato já foi para a conversa; `/task` mostra tudo).
    const ended = all
      .filter((t) => TERMINAL_STATUSES.has(t.status) && now - (t.endedAt ?? 0) < 60_000)
      .slice(-2);
    return [...ended, ...live];
  }

  /** Sub-agentes da tarefa (último lote do bloco `subagents` da sessão dela), p/ o painel. */
  taskChildren(id: string): readonly SubAgentChildView[] {
    const blocks = this.engine.sessionOf(id)?.current.blocks ?? [];
    for (let i = blocks.length - 1; i >= 0; i -= 1) {
      const b = blocks[i];
      if (b?.kind === 'subagents') return b.children;
    }
    return [];
  }

  /**
   * A tarefa na MESMA gramática de linha dos sub-agentes (`<ChildLine>`): nome, estado com
   * brilho enquanto roda, modelo (`herdado (…)`), atividade atual, tokens, tools e tempo.
   */
  taskView(t: TaskRecord): SubAgentChildView {
    const s = this.engine.sessionOf(t.id)?.current;
    const ended = t.endedAt !== undefined;
    const parts: string[] = [];
    if (t.status === 'waiting_approval') parts.push('aguardando aprovação');
    else if (t.status === 'blocked') parts.push(`espera ${t.blockedBy ?? 'outra tarefa'}`);
    else if (t.current) parts.push(t.current);
    parts.push(`${abbreviateCount(s?.meta?.tokens ?? 0)} tokens`);
    if (t.steps > 0) parts.push(`${t.steps} tools`);
    if (ended) parts.push(formatElapsed((t.endedAt ?? 0) - t.startedAt));
    const status: SubAgentChildView['status'] =
      t.status === 'done'
        ? 'done'
        : t.status === 'failed'
          ? 'fail'
          : t.status === 'stopped' || t.status === 'interrupted' || t.status === 'paused_quota'
            ? 'cancelled'
            : 'running';
    const tier = s?.meta?.activeModel ?? s?.meta?.model ?? s?.meta?.tier;
    return {
      label: `${t.id} ${clip(t.goal, 22)}`,
      status,
      summary: parts.join(' · '),
      ...(t.status === 'paused_quota' ? { stop: 'paused' as const } : {}),
      ...(tier !== undefined ? { model: `herdado (${tier})` } : {}),
      ...(!ended ? { startedAt: t.startedAt } : {}),
    };
  }

  /** O transcrito da tarefa (como teria aparecido no clássico), p/ a vista de detalhe. */
  taskBlocks(id: string): readonly SessionBlock[] {
    return this.engine.sessionOf(id)?.current.blocks ?? [];
  }

  hasLiveTasks(): boolean {
    return this.registry.live().length > 0;
  }

  /**
   * A mensagem do dono: ecoa JÁ, responde por uma chamada curta ao modelo concorrente ao
   * trabalho. Resolve quando a resposta foi escrita; quem chama NÃO precisa aguardar.
   */
  async handleOwnerMessage(text: string): Promise<void> {
    // Eco IMEDIATO (a mensagem aparece na hora, mesmo que a resposta anterior ainda corra).
    this.d.sink.pushConciergeEcho(text);
    // As respostas do Concierge correm UMA POR VEZ (cada uma é um bloco `Λluy` em stream; duas
    // ao mesmo tempo se misturariam). Isso NÃO espera tarefa nenhuma: só a fala anterior,
    // que dura segundos.
    const run = this.replyChain.then(() => this.reply(text));
    this.replyChain = run.catch(() => undefined);
    return run;
  }

  private replyChain: Promise<void> = Promise.resolve();

  private async reply(text: string): Promise<void> {
    const ac = new AbortController();
    this.inflight.add(ac);
    this.d.sink.conciergeReplyStart();
    let fallback = '';
    try {
      this.facts = (await this.d.ownerFacts?.().catch(() => [])) ?? [];
      const r = await this.concierge.handle(text, ac.signal);
      fallback = r.reply;
      this.d.sink.conciergeReplyEnd(fallback);
      for (const n of r.notes) this.d.sink.pushConciergeLine(n);
      this.persist();
    } catch (e) {
      this.d.sink.conciergeReplyEnd(
        `Não consegui responder agora (${e instanceof Error ? e.message : String(e)}).`,
      );
    } finally {
      this.inflight.delete(ac);
    }
  }

  /**
   * Depois de restaurar a transcrição (`restoreBlocks` a substitui): avisa, em UMA nota, o que
   * ficou interrompido ao fechar a sessão anterior. O Concierge oferece reiniciar se o dono quiser.
   */
  announceRestored(): void {
    const interrupted = this.registry.list().filter((t) => t.status === 'interrupted');
    if (interrupted.length === 0) return;
    this.d.sink.pushConciergeLine(
      `↯ ${interrupted.length} tarefa${interrupted.length > 1 ? 's' : ''} interrompida${interrupted.length > 1 ? 's' : ''} ao fechar — ${interrupted
        .map((t) => `${t.id} (${clip(t.goal, 40)})`)
        .join('; ')}`,
    );
  }

  // ── controle explícito (Esc NUNCA chama isto) ──────────────────────────────

  /** F8 — para tudo: tarefas, sub-agentes e (via cancelAllFlows) o turno principal. */
  stopAll(): void {
    // `stopAll` interrompe o turno de cada tarefa; `cancelAllFlows` derruba também os
    // sub-agentes (inclusive os desacoplados). Sem um `interrupt` extra (nota duplicada).
    this.engine.stopAll();
    this.d.sink.cancelAllFlows('f8');
  }

  /** `/task stop <id>`. Devolve a frase para o dono. */
  stopTask(id: string): string {
    const t = this.registry.get(id);
    if (!t) return `tarefa ${id} não existe`;
    if (TERMINAL_STATUSES.has(t.status)) return `${id} já terminou (${statusPt(t.status)})`;
    if (t.status !== 'blocked') this.engine.stop(t);
    this.registry.transition(id, 'stopped', 'parada pelo dono');
    return `${id} parada`;
  }

  approve(taskId: string | undefined, kind: 'once' | 'session' = 'once'): string {
    const r: AskResolution =
      kind === 'session' ? { kind: 'approve-session' } : { kind: 'approve-once' };
    const id = this.engine.resolveApproval(taskId, r);
    return id ? `aprovado em ${id}` : 'nenhuma aprovação pendente';
  }

  deny(taskId: string | undefined): string {
    const id = this.engine.resolveApproval(taskId, { kind: 'deny', reason: 'negado pelo dono' });
    return id ? `negado em ${id}` : 'nenhuma aprovação pendente';
  }

  pendingApprovals(): readonly { taskId: string; summary: string }[] {
    return this.engine.pendingApprovals();
  }

  /** Linhas para `/task` (lista completa). */
  describeTasks(): string[] {
    const ts = this.registry.list();
    if (ts.length === 0) return ['nenhuma tarefa nesta sessão'];
    return ts.map(
      (t) =>
        `${t.id}  ${statusPt(t.status)}  ${clip(t.goal, 70)}${t.blockedBy ? `  (espera ${t.blockedBy})` : ''}`,
    );
  }

  dispose(): void {
    for (const ac of this.inflight) ac.abort();
    // Quem ainda corre ao sair fica `interrupted` (e não `done` por o abort resolver o submit).
    for (const t of this.registry.live())
      this.registry.transition(t.id, 'interrupted', 'sessão encerrada');
    this.engine.dispose();
  }

  // ── persistência (--resume/--continue) ─────────────────────────────────────

  private persist(): void {
    const path = this.d.storePath?.();
    if (!path) return;
    try {
      const snap = this.registry.snapshot();
      if (snap.tasks.length === 0 && this.concierge.getHistory().length === 0) return;
      const data: Persisted = {
        version: 1,
        tasks: snap.tasks,
        nextId: snap.nextId,
        history: this.concierge.getHistory(),
      };
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
      renameSync(tmp, path);
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best-effort */
      }
    } catch {
      /* persistência é best-effort: nunca derruba a sessão */
    }
  }

  private restore(): void {
    const path = this.d.storePath?.();
    if (!path) return;
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Persisted>;
      if (raw.version !== 1 || !Array.isArray(raw.tasks)) return;
      const tasks = raw.tasks.filter(
        (t): t is TaskRecord =>
          typeof t === 'object' &&
          t !== null &&
          typeof t.id === 'string' &&
          typeof t.goal === 'string',
      );
      this.registry.restore(tasks, typeof raw.nextId === 'number' ? raw.nextId : tasks.length + 1);
      if (Array.isArray(raw.history)) this.concierge.restoreHistory(raw.history as ChatMessage[]);
    } catch {
      /* sem arquivo ou ilegível: começa limpo */
    }
  }
}

/** Caminho do arquivo de tarefas da sessão (ao lado das sessões do usuário). */
export function conciergeStorePath(baseDir: string, sessionId: string): string {
  return join(baseDir, 'concierge', `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

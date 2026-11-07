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
import { clip } from '@hiperplano/aluy-cli-core';
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
      startBlocks: session.current.blocks.length,
    };
    this.handles.set(task.id, h);
    h.unsubs.push(this.observeState(task.id, h));
    h.unsubs.push(
      session.addToolObserver({
        onToolStart: (c) => {
          this.d.registry.touch(task.id, { phase: 'tool', current: toolLabel(c) });
          this.d.registry.note(task.id, 'tool', c.name);
        },
        onToolEnd: () => {
          this.d.registry.touch(task.id, { phase: 'idle', current: null });
          this.d.registry.note(task.id, 'step');
        },
      }),
    );
    session.submit(task.goal, [], { display: `▸ ${task.id}: ${clip(task.goal, 100)}` }).then(
      () => this.finish(task.id, h),
      (e: unknown) => {
        this.cleanup(h);
        this.d.registry.transition(task.id, 'failed', msg(e));
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
  pendingApprovals(): readonly { taskId: string; summary: string }[] {
    const out: { taskId: string; summary: string }[] = [];
    for (const [taskId, h] of this.handles) {
      const t = this.d.registry.get(taskId);
      if (!t || t.endedAt !== undefined) continue;
      if (h.session.current.pendingAsk)
        out.push({ taskId, summary: askSummary(h.session.current) });
    }
    return out;
  }

  /** Responde a aprovação da tarefa `taskId` (ou da mais antiga). `false` se não há. */
  resolveApproval(taskId: string | undefined, r: AskResolution): string | undefined {
    const pend = this.pendingApprovals();
    const target = taskId ? pend.find((p) => p.taskId === taskId) : pend[0];
    if (!target) return undefined;
    this.handles.get(target.taskId)!.session.resolveAsk(r);
    return target.taskId;
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
      if (s.phase === 'thinking' || s.phase === 'streaming') reg.touch(id, { phase: 'model_call' });
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
      reg.transition(id, 'failed', err?.kind === 'broker-error' ? err.message : 'erro no turno');
      return;
    }
    if (interrupted) {
      reg.transition(id, 'stopped', 'interrompida');
      return;
    }
    const text = lastAluy?.kind === 'aluy' ? lastAluy.text : '';
    reg.transition(id, 'done', undefined, { summary: clip(text || 'sem resposta textual', 300) });
  }

  private cleanup(h: Handle): void {
    for (const u of h.unsubs.splice(0)) u();
  }
}

function askSummary(s: SessionState): string {
  const r = s.pendingAsk?.request;
  if (!r) return '';
  return `${r.call.name}: ${clip(r.effect.exact ?? '', 70)}`;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `bash ls -la` / `read_file src/x.ts`: a ferramenta em curso, em poucas palavras. */
function toolLabel(c: { name: string; input?: Readonly<Record<string, unknown>> }): string {
  const i = c.input ?? {};
  const arg = [i['command'], i['path'], i['pattern'], i['query'], i['url']].find(
    (v) => typeof v === 'string' && v !== '',
  );
  const name = c.name === 'run_command' ? 'bash' : c.name;
  return clip(typeof arg === 'string' ? `${name} ${arg}` : name, 48);
}

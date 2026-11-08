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
import {
  ControllerTaskEngine,
  type PendingApproval,
  type TaskSession,
} from './concierge-engine.js';

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
  /** Rótulo do modelo herdado (o MESMO que os sub-agentes mostram: `herdado (<modelo>)`). */
  readonly modelLabel?: () => string | undefined;
  /** O dono está no meio de um turno/pergunta (a fala automática espera). Default: nunca. */
  readonly ownerBusy?: () => boolean;
  /** Reavalia a fila de relatos automáticos a cada tanto (ms). Default 400. */
  readonly reportRetryMs?: number;
  /**
   * Janela de agrupamento (ms): ao terminar uma tarefa o relato espera esta folga por mais
   * términos e sai UM só (cada novo término reinicia a espera, no máx. 4×). Default 0 (imediato).
   */
  readonly reportSettleMs?: number;
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
    // Fim de tarefa (done/failed) ⇒ turno AUTOMÁTICO do Concierge com o resultado.
    this.registry.subscribe((ev) => {
      if (ev.kind === 'done' || ev.kind === 'failed') this.queueReport(ev.taskId);
    });
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
    return [...this.recentEnded(all).slice(-2), ...live];
  }

  private recentEnded(all: readonly TaskRecord[]): TaskRecord[] {
    const now = this.clock();
    // Terminadas somem da lista 60s depois (o relato já foi para a conversa; `/task` mostra tudo).
    return all.filter((t) => TERMINAL_STATUSES.has(t.status) && now - (t.endedAt ?? 0) < 60_000);
  }

  /** Encerradas recentes que `visibleTasks` não lista (teto de 2 linhas) — o resumo as conta. */
  hiddenEndedCount(): number {
    return Math.max(0, this.recentEnded(this.registry.list()).length - 2);
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
  taskView(t: TaskRecord, labelMax = 22): SubAgentChildView {
    const s = this.engine.sessionOf(t.id)?.current;
    const ended = t.endedAt !== undefined;
    const parts: string[] = [];
    const word =
      t.status === 'waiting_approval'
        ? 'aguardando aprovação'
        : t.status === 'blocked'
          ? `espera ${t.blockedBy ?? 'outra tarefa'}`
          : undefined;
    if (word === undefined && t.current) parts.push(t.current);
    const lt = ended
      ? { tokens: s?.meta?.tokens ?? 0, estimated: false }
      : this.engine.liveTokens(t.id);
    if (lt.tokens > 0 || ended) {
      // Soma de prompt+completion de TODAS as chamadas (pai e sub-agentes), com o prompt em cache
      // contado por inteiro: é volume processado, não o que foi cobrado. O `% cache` (quando o
      // provider reporta) mostra quanto desse prompt veio do cache.
      parts.push(
        `${lt.estimated ? '~' : ''}${abbreviateCount(lt.tokens)} tokens${
          lt.cachePct !== undefined && lt.cachePct > 0 ? ` (${Math.round(lt.cachePct)}% cache)` : ''
        }`,
      );
    }
    if (t.steps > 0) parts.push(`${t.steps} tools`);
    if (!ended && this.engine.isAllowAll(t.id)) parts.push('aprova tudo');
    if (ended) parts.push(formatElapsed((t.endedAt ?? 0) - t.startedAt));
    const status: SubAgentChildView['status'] =
      t.status === 'done'
        ? 'done'
        : t.status === 'failed'
          ? 'fail'
          : t.status === 'stopped' || t.status === 'interrupted' || t.status === 'paused_quota'
            ? 'cancelled'
            : 'running';
    const tier = this.d.modelLabel?.() ?? s?.meta?.activeModel ?? s?.meta?.model ?? s?.meta?.tier;
    return {
      label: `${t.id} ${clip(t.goal, labelMax)}`,
      status,
      summary: parts.join(' · '),
      ...(word !== undefined ? { word } : {}),
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

  // ── relato automático do resultado ─────────────────────────────────────────
  private readonly reportQueue: string[] = [];
  private readonly reported = new Set<string>();
  /** Tarefas nascidas de um turno automático: o relato delas não pode iniciar mais nada. */
  private readonly autoSpawned = new Set<string>();
  private reportTimer: ReturnType<typeof setTimeout> | null = null;
  private reportRunning = false;
  private disposed = false;

  private queueReport(taskId: string): void {
    if (this.disposed || this.reported.has(taskId)) return;
    this.reported.add(taskId);
    const first = this.reportQueue.length === 0;
    this.reportQueue.push(taskId);
    this.emitChange();
    const settle = this.d.reportSettleMs ?? 0;
    if (settle <= 0) {
      this.scheduleReports(0);
      return;
    }
    // Várias tarefas terminando juntas viram UM relato: reinicia a espera a cada término.
    const now = Date.now();
    if (first) this.reportFirstAt = now;
    if (this.reportTimer !== null) {
      clearTimeout(this.reportTimer);
      this.reportTimer = null;
    }
    this.scheduleReports(Math.max(0, Math.min(settle, this.reportFirstAt + settle * 4 - now)));
  }

  private reportFirstAt = 0;

  /**
   * Há relato automático a caminho (tarefa terminou e o resumo ainda não começou a sair)? Vale da
   * hora em que a tarefa entra na fila (janela de agrupamento, dono ocupado) até o relato começar
   * a fazer stream. A TUI mantém a linha de trabalho nesse intervalo: se ela sumisse, o composer
   * subia 1 linha e descia de novo quando o resumo começava.
   */
  reportPending(): boolean {
    if (this.reportQueue.length > 0 || this.reportRunning) return true;
    // A tarefa acabou de terminar mas o relato ainda não entrou na fila (a ordem dos ouvintes do
    // registro pode pintar o quadro antes): conta como a caminho, por poucos segundos.
    const now = this.clock();
    return this.registry
      .list()
      .some(
        (t) =>
          (t.status === 'done' || t.status === 'failed') &&
          !this.reported.has(t.id) &&
          now - (t.endedAt ?? 0) < 5000,
      );
  }

  private emitChange(): void {
    for (const l of [...this.listeners]) l();
  }

  private scheduleReports(delay: number): void {
    if (this.disposed || this.reportTimer !== null || this.reportQueue.length === 0) return;
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null;
      this.pumpReports();
    }, delay);
    this.reportTimer.unref?.();
  }

  private pumpReports(): void {
    if (this.disposed || this.reportQueue.length === 0 || this.reportRunning) return;
    // Fila: o dono no meio de um turno/aprovação, ou uma fala ainda correndo ⇒ espera ficar ocioso.
    if (this.replyBusy > 0 || this.d.ownerBusy?.() === true) {
      this.scheduleReports(this.d.reportRetryMs ?? 400);
      return;
    }
    // Tudo que terminou até agora vira UM relato; os de turno automático ficam separados.
    const batch = this.reportQueue.splice(0);
    const plain = batch.filter((id) => !this.autoSpawned.has(id));
    const restricted = batch.filter((id) => this.autoSpawned.has(id));
    this.reportRunning = true;
    const run = async (): Promise<void> => {
      if (plain.length > 0) await this.autoReply(plain, true);
      if (restricted.length > 0) await this.autoReply(restricted, false);
    };
    this.emitChange();
    void run().finally(() => {
      this.reportRunning = false;
      this.emitChange();
      this.scheduleReports(0);
    });
  }

  private replyBusy = 0;

  private async autoReply(ids: readonly string[], allowStart: boolean): Promise<void> {
    const run = this.replyChain.then(async () => {
      const ac = new AbortController();
      this.inflight.add(ac);
      this.replyBusy++;
      this.d.sink.conciergeReplyStart();
      try {
        const r = await this.concierge.handleTaskResults(ids, ac.signal, { allowStart });
        this.d.sink.conciergeReplyEnd(r.reply);
        for (const n of r.notes) this.d.sink.pushConciergeLine(n);
        if (allowStart)
          for (const a of r.actions)
            if (a.tool === 'task_start' && a.taskId) this.autoSpawned.add(a.taskId);
        this.persist();
      } catch (e) {
        this.d.sink.conciergeReplyEnd(
          `Não consegui relatar o resultado agora (${e instanceof Error ? e.message : String(e)}).`,
        );
      } finally {
        this.replyBusy--;
        this.inflight.delete(ac);
      }
    });
    this.replyChain = run.catch(() => undefined);
    return run;
  }

  private async reply(text: string): Promise<void> {
    const ac = new AbortController();
    this.inflight.add(ac);
    this.replyBusy++;
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
      this.replyBusy--;
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

  /**
   * `/a [tN]` aprova uma vez · `/a s` sessão (grant exato da catraca) · `/a!` (`always`) aprova
   * e liga "sempre nesta tarefa". Cada resposta deixa UMA linha compacta na conversa
   * (`✓ aprovado · t1 · run_command python3 -c …`) — consecutivas ficam coladas (block-rhythm).
   * Devolve só o aviso de "nada pendente" (o resto já foi escrito na conversa).
   */
  approve(taskId: string | undefined, kind: 'once' | 'session' | 'always' = 'once'): string {
    const r: AskResolution =
      kind === 'session' ? { kind: 'approve-session' } : { kind: 'approve-once' };
    const what = this.pendingLabel(taskId);
    const res = this.engine.resolveApproval(taskId, r, { alwaysInTask: kind === 'always' });
    if (!res) return 'nenhuma aprovação pendente';
    const tail = res.alwaysInTask
      ? ' · sempre nesta tarefa'
      : res.alwaysRefused
        ? ' · só desta vez (pedido sempre-pergunta)'
        : kind === 'session'
          ? ' · nesta sessão'
          : '';
    this.d.sink.pushConciergeLine(`✓ aprovado${tail} · ${res.taskId} · ${what ?? ''}`.trimEnd());
    return '';
  }

  deny(taskId: string | undefined): string {
    const what = this.pendingLabel(taskId);
    const res = this.engine.resolveApproval(taskId, { kind: 'deny', reason: 'negado pelo dono' });
    if (!res) return 'nenhuma aprovação pendente';
    this.d.sink.pushConciergeLine(`✘ negado · ${res.taskId} · ${what ?? ''}`.trimEnd());
    return '';
  }

  /** `run_command python3 -c …` / `edit_file calc.py`: o que está pendente (uma linha). */
  private pendingLabel(taskId: string | undefined): string | undefined {
    const pend = this.engine.pendingApprovals();
    const p = taskId ? pend.find((x) => x.taskId === taskId) : pend[0];
    if (!p) return undefined;
    const e = p.effect;
    if (e === undefined) return clip(p.summary, 70);
    const body =
      e.kind === 'diff' || e.kind === 'path'
        ? (e.path ?? '')
        : (e.lines[0] ?? '').replace(/^\$\s*/, '').replace(new RegExp(`^${e.tool}\\s+`), '');
    return clip(`${e.tool} ${body}`, 70);
  }

  pendingApprovals(): readonly PendingApproval[] {
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
    this.disposed = true;
    if (this.reportTimer !== null) clearTimeout(this.reportTimer);
    this.reportTimer = null;
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

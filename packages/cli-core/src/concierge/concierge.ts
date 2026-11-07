// ADR 0006 — o CONCIERGE: cada mensagem do dono ganha UMA chamada curta ao modelo (no máximo
// duas), concorrente ao trabalho. Só plano de controle (task_*). PORTÁTIL: modelo, motor e
// permissão entram por portas. Nunca lança: erro de modelo vira uma linha honesta.

import { randomUUID } from 'node:crypto';
import type { ChatMessage, NativeToolCall } from '../model/types.js';
import { buildDigest, clip, describeTask, EMPTY_SNAPSHOT } from './digest.js';
import { buildConciergePrompt } from './prompt.js';
import {
  TERMINAL_STATUSES,
  MAX_LIVE_TASKS,
  normalizeClaimPath,
  type TaskEvent,
  type TaskRecord,
  type TaskRegistry,
} from './tasks.js';
import {
  CONCIERGE_TOOL_NAMES,
  type ConciergeEngine,
  type ConciergeGate,
  type ConciergeModel,
  type ConciergeToolName,
} from './tools.js';

/** Teto do texto que o Concierge repassa a uma tarefa (o mesmo do ADR 0002). */
export const MAX_TASK_MESSAGE_CHARS = 1500;
const MAX_TOOL_CALLS_PER_MESSAGE = 3;
const MAX_HISTORY_MESSAGES = 8;

export interface ConciergeOptions {
  readonly registry: TaskRegistry;
  readonly engine: ConciergeEngine;
  readonly model: ConciergeModel;
  readonly gate?: ConciergeGate;
  readonly ownerFacts?: () => readonly string[];
  readonly projectSummary?: () => string | undefined;
  readonly clock?: () => number;
  /** O erro é de cota/limite do modelo do Concierge? Default: heurística por texto/código. */
  readonly isQuotaError?: (e: unknown) => boolean;
}

export interface ConciergeReply {
  /** O que mostrar ao dono (já pronto). */
  readonly text: string;
  /** Chamadas ao modelo gastas nesta mensagem (0 se falhou antes). */
  readonly modelCalls: number;
  readonly actions: readonly { tool: ConciergeToolName; ok: boolean; taskId?: string }[];
  readonly tokens: number;
  /** O modelo do Concierge está sem cota (a UI segue; só esta resposta falhou). */
  readonly quota?: boolean;
}

function defaultIsQuotaError(e: unknown): boolean {
  const s = `${(e as { name?: string })?.name ?? ''} ${(e as { code?: string })?.code ?? ''} ${
    e instanceof Error ? e.message : String(e)
  }`;
  return /quota|cota|rate.?limit|429|insufficient|exceeded|402/i.test(s);
}

export class Concierge {
  private readonly o: ConciergeOptions;
  private readonly clock: () => number;
  private history: ChatMessage[] = [];
  private readonly relayed = new Set<string>();
  private relaySink: ((line: string) => void) | null = null;

  constructor(opts: ConciergeOptions) {
    this.o = opts;
    this.clock = opts.clock ?? Date.now;
    // Escalonador: terminou uma tarefa ⇒ libera as bloqueadas por arquivo.
    opts.registry.subscribe((ev) => this.onEvent(ev));
  }

  /** A TUI liga aqui o canal de relatos (uma linha por evento que importa). */
  attachRelay(sink: ((line: string) => void) | null): void {
    this.relaySink = sink;
  }

  /** Histórico do Concierge (persistido no resume). */
  getHistory(): readonly ChatMessage[] {
    return this.history;
  }
  restoreHistory(h: readonly ChatMessage[]): void {
    this.history = h
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-MAX_HISTORY_MESSAGES);
  }

  digest(): string {
    return buildDigest({
      tasks: this.o.registry.list(),
      events: this.o.registry.recentEvents(),
      engine: this.safeSnapshot(),
      now: this.clock(),
    });
  }

  private safeSnapshot() {
    try {
      return this.o.engine.snapshot();
    } catch {
      return EMPTY_SNAPSHOT;
    }
  }

  async handle(text: string, signal?: AbortSignal): Promise<ConciergeReply> {
    const actions: { tool: ConciergeToolName; ok: boolean; taskId?: string }[] = [];
    let modelCalls = 0;
    let tokens = 0;
    const system: ChatMessage = {
      role: 'system',
      content: buildConciergePrompt({
        ...(this.o.ownerFacts ? { ownerFacts: this.o.ownerFacts() } : {}),
        ...(this.o.projectSummary?.() ? { projectSummary: this.o.projectSummary()! } : {}),
      }),
    };
    const user: ChatMessage = {
      role: 'user',
      content: `<estado>\n${this.digest()}\n</estado>\n\nMensagem do dono: ${text}`,
    };
    const messages: ChatMessage[] = [system, ...this.history, user];
    const notes: string[] = [];
    let reply = '';
    try {
      const r1 = await this.o.model.call({
        messages,
        idempotencyKey: `concierge-${randomUUID()}`,
        ...(signal ? { signal } : {}),
      });
      modelCalls++;
      tokens += (r1.usage?.tokens_in ?? 0) + (r1.usage?.tokens_out ?? 0);
      const calls = (r1.tool_calls ?? []).filter((c) =>
        (CONCIERGE_TOOL_NAMES as readonly string[]).includes(c.name),
      );
      reply = r1.content.trim();
      if (calls.length > 0) {
        const results: ChatMessage[] = [];
        for (const c of calls.slice(0, MAX_TOOL_CALLS_PER_MESSAGE)) {
          const out = await this.runTool(c);
          actions.push(out.action);
          if (out.note) notes.push(out.note);
          results.push({ role: 'tool', tool_call_id: c.id, content: out.result });
        }
        if (reply === '') {
          // Sem texto junto da tool-call: 2ª (e última) chamada para o modelo falar.
          try {
            const r2 = await this.o.model.call({
              messages: [
                ...messages,
                {
                  role: 'assistant',
                  content: '',
                  tool_calls: calls.slice(0, MAX_TOOL_CALLS_PER_MESSAGE),
                },
                ...results,
              ],
              idempotencyKey: `concierge-${randomUUID()}`,
              ...(signal ? { signal } : {}),
            });
            modelCalls++;
            tokens += (r2.usage?.tokens_in ?? 0) + (r2.usage?.tokens_out ?? 0);
            reply = r2.content.trim();
          } catch {
            /* o ack por template abaixo cobre */
          }
          if (reply === '') reply = actions.map((a) => ackFor(a, this.o.registry)).join(' ');
        }
      }
      if (reply === '') reply = 'Não consegui formular uma resposta; pode repetir?';
    } catch (e) {
      const aborted = signal?.aborted === true;
      if (aborted) {
        return { text: '', modelCalls, actions, tokens };
      }
      const quota = (this.o.isQuotaError ?? defaultIsQuotaError)(e);
      const text1 = quota
        ? 'Estou sem cota no meu modelo agora; as tarefas seguem. Use /task para ver e /a /n para aprovações.'
        : `Não consegui responder agora (${clip(e instanceof Error ? e.message : String(e), 100)}). As tarefas seguem.`;
      return { text: text1, modelCalls, actions, tokens, ...(quota ? { quota: true } : {}) };
    }
    const full = [reply, ...notes].join('\n');
    const turn: ChatMessage[] = [
      { role: 'user', content: text },
      { role: 'assistant', content: reply },
    ];
    this.history = [...this.history, ...turn].slice(-MAX_HISTORY_MESSAGES);
    return { text: full, modelCalls, actions, tokens };
  }

  // ── ferramentas ────────────────────────────────────────────────────────────

  private async runTool(call: NativeToolCall): Promise<{
    result: string;
    note?: string;
    action: { tool: ConciergeToolName; ok: boolean; taskId?: string };
  }> {
    const name = call.name as ConciergeToolName;
    const fail = (why: string, taskId?: string) => ({
      result: `erro: ${why}`,
      action: { tool: name, ok: false, ...(taskId ? { taskId } : {}) },
    });
    if (this.o.gate) {
      const g = await this.o.gate({ name, input: call.input });
      if (!g.allow) return fail(`não permitido (${g.reason})`);
    }
    const reg = this.o.registry;
    const inp = call.input;
    const str = (k: string): string =>
      typeof inp[k] === 'string' ? (inp[k] as string).trim() : '';
    switch (name) {
      case 'task_start': {
        const goal = str('goal');
        if (goal === '') return fail('objetivo vazio');
        if (reg.live().length >= MAX_LIVE_TASKS)
          return fail(`já há ${MAX_LIVE_TASKS} tarefas vivas; espere uma terminar ou pare uma`);
        const files = Array.isArray(inp['files'])
          ? (inp['files'] as unknown[])
              .filter((f): f is string => typeof f === 'string')
              .slice(0, 20)
          : [];
        const rec = reg.create({
          goal,
          kind: reg.live().length === 0 ? 'main' : 'detached',
          files,
        });
        if (rec.status === 'blocked') {
          return {
            result: `tarefa ${rec.id} criada mas ESPERA ${rec.blockedBy} (mexem nos mesmos arquivos); começa sozinha quando ${rec.blockedBy} terminar`,
            note: `⏳ ${rec.id} espera ${rec.blockedBy}: mexem nos mesmos arquivos (${rec.files.slice(0, 3).join(', ')}).`,
            action: { tool: name, ok: true, taskId: rec.id },
          };
        }
        this.o.engine.start(rec);
        return {
          result: `tarefa ${rec.id} iniciada`,
          action: { tool: name, ok: true, taskId: rec.id },
        };
      }
      case 'task_send': {
        const t = reg.get(str('task_id'));
        const msg = str('message');
        if (!t) return fail(`tarefa ${str('task_id') || '?'} não existe`);
        if (msg === '') return fail('mensagem vazia', t.id);
        if (TERMINAL_STATUSES.has(t.status))
          return fail(
            `${t.id} já terminou (${t.status}); inicie uma nova tarefa se for o caso`,
            t.id,
          );
        if (t.status === 'blocked')
          return fail(
            `${t.id} ainda não começou (espera ${t.blockedBy}); não dá para enviar`,
            t.id,
          );
        const clipped =
          msg.length > MAX_TASK_MESSAGE_CHARS
            ? `${msg.slice(0, MAX_TASK_MESSAGE_CHARS - 1)}…`
            : msg;
        const r = this.o.engine.send(t, clipped);
        const caveat =
          t.phase === 'model_call'
            ? ' A tarefa está no meio de uma chamada ao modelo: essa chamada não muda; a mensagem entra na próxima iteração.'
            : '';
        return r.delivered
          ? {
              result: `entregue a ${t.id}: ${r.note}.${caveat}`,
              action: { tool: name, ok: true, taskId: t.id },
            }
          : fail(`${t.id}: ${r.note}`, t.id);
      }
      case 'task_stop': {
        const t = reg.get(str('task_id'));
        if (!t) return fail(`tarefa ${str('task_id') || '?'} não existe`);
        if (TERMINAL_STATUSES.has(t.status)) return fail(`${t.id} já terminou (${t.status})`, t.id);
        if (t.status !== 'blocked') this.o.engine.stop(t);
        reg.transition(t.id, 'stopped', 'parada a pedido do dono');
        return { result: `${t.id} parada`, action: { tool: name, ok: true, taskId: t.id } };
      }
      case 'task_status': {
        const id = str('task_id');
        const now = this.clock();
        if (id !== '') {
          const t = reg.get(id);
          if (!t) return fail(`tarefa ${id} não existe`);
          return { result: describeTask(t, now), action: { tool: name, ok: true, taskId: t.id } };
        }
        return { result: this.digest(), action: { tool: name, ok: true } };
      }
    }
  }

  // ── eventos: escalonamento + relatos ───────────────────────────────────────

  private onEvent(ev: TaskEvent): void {
    const t = this.o.registry.get(ev.taskId);
    if (!t) return;
    if (TERMINAL_STATUSES.has(t.status)) this.releaseBlocked();
    this.relay(ev, t);
  }

  private releaseBlocked(): void {
    for (const b of this.o.registry.releasable()) {
      const started = this.o.registry.transition(b.id, 'running', 'arquivos liberados');
      if (started) this.o.engine.start(started);
    }
  }

  private relay(ev: TaskEvent, t: TaskRecord): void {
    if (!this.relaySink) return;
    let line: string | undefined;
    switch (ev.kind) {
      case 'done':
        line = `✔ ${t.id} concluída${t.summary ? `: ${clip(t.summary, 140)}` : '.'}`;
        break;
      case 'failed':
        line = `✘ ${t.id} falhou${ev.detail ? `: ${clip(ev.detail, 140)}` : '.'}`;
        break;
      case 'waiting_approval':
        line = `⚠ ${t.id} espera sua aprovação${ev.detail ? ` (${clip(ev.detail, 80)})` : ''}: /a aprova, /n nega.`;
        break;
      case 'paused_quota':
        line = `⏸ ${t.id} pausada por cota${ev.detail ? ` (${clip(ev.detail, 80)})` : ''}.`;
        break;
      case 'interrupted':
        line = `↯ ${t.id} ficou interrompida: ${clip(t.goal, 80)}. Quer reiniciar?`;
        break;
      case 'started':
        // Só relata quando era uma tarefa bloqueada que acabou de ser liberada.
        if (ev.detail === 'arquivos liberados')
          line = `▶ ${t.id} começou: os arquivos foram liberados.`;
        break;
      default:
        break;
    }
    if (!line) return;
    const key = `${ev.taskId}:${ev.kind}:${ev.seq}`;
    if (this.relayed.has(key)) return;
    this.relayed.add(key);
    try {
      this.relaySink(line);
    } catch {
      /* relato nunca derruba o motor */
    }
  }
}

function ackFor(
  a: { tool: ConciergeToolName; ok: boolean; taskId?: string },
  reg: TaskRegistry,
): string {
  if (!a.ok) return 'Não consegui fazer isso.';
  const id = a.taskId ?? '';
  switch (a.tool) {
    case 'task_start':
      return reg.get(id)?.status === 'blocked'
        ? `${id} criada, espera outra tarefa.`
        : `Iniciei ${id}.`;
    case 'task_send':
      return `Enviei a ${id}; entra após o passo atual.`;
    case 'task_stop':
      return `Parei ${id}.`;
    case 'task_status':
      return 'Veja a lista de tarefas.';
  }
}

export { normalizeClaimPath };

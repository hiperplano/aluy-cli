// Rastro OPT-IN de uso por REQUEST ao modelo (`ALUY_DEBUG_USAGE=<arquivo>`).
//
// Serve para medir ao vivo onde os tokens vão (prompt de sistema × schemas de tools × histórico ×
// cache). DESLIGADO por padrão e de graça: sem a variável, `traceClient` devolve o PRÓPRIO client
// (nenhum wrapper, nenhum arquivo, nenhuma conta). Ligado, cada request vira UMA linha JSONL
// (append) com SÓ tamanhos, contagens, nomes de tool e hashes curtos — nunca conteúdo de mensagem,
// chave, header ou URL. (Um hash curto de prompt/tools não revela o texto; serve para ver se o
// prefixo MUDOU entre requests, que é o que quebra o cache de prompt.)

import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ChatMessage,
  ModelCallRequest,
  ModelCallResult,
  ModelClient,
  ModelStreamEvent,
  ModelUsage,
  StreamCallArgs,
} from '@hiperplano/aluy-cli-core';

/** O caminho do rastro, ou `undefined` (desligado). */
export function usageTracePath(env: NodeJS.ProcessEnv): string | undefined {
  const p = env['ALUY_DEBUG_USAGE'];
  return p !== undefined && p.trim() !== '' ? p.trim() : undefined;
}

/** Rótulo do filho corrente (sub-agente), propagado pelo contexto assíncrono da chamada. */
const childLabel = new AsyncLocalStorage<string>();

/** Envolve o caller de UM sub-agente: as requests dele saem rotuladas `<sessão>/sub:<nome>`. */
export function withTraceLabel<T extends { call: (...a: never[]) => unknown }>(
  caller: T,
  label: string,
): T {
  return {
    ...caller,
    call: (...a: never[]) => childLabel.run(label, () => caller.call(...a)),
  } as T;
}

const textLen = (c: ChatMessage['content']): number =>
  typeof c === 'string' ? c.length : JSON.stringify(c).length;

const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 8);

function commonPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

interface SessionState {
  idx: number;
  prevHead?: string;
}

/** Tamanhos/nomes de UM request (sem conteúdo). PURO. */
export function describeRequest(request: ModelCallRequest): {
  readonly messages: number;
  readonly chars: {
    readonly system: number;
    readonly tools: number;
    readonly history: number;
    readonly last: number;
  };
  readonly lastRole: string | undefined;
  readonly toolNames: readonly string[];
  readonly head: string;
} {
  const msgs = request.messages;
  let system = 0;
  let history = 0;
  let headText = '';
  const nonSystem: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'system') {
      system += textLen(m.content);
      headText += typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    } else nonSystem.push(m);
  }
  const lastMsg = nonSystem[nonSystem.length - 1];
  for (let i = 0; i < nonSystem.length - 1; i += 1) history += textLen(nonSystem[i]!.content);
  const toolsJson = request.tools !== undefined ? JSON.stringify(request.tools) : '';
  return {
    messages: msgs.length,
    chars: {
      system,
      tools: toolsJson.length,
      history,
      last: lastMsg !== undefined ? textLen(lastMsg.content) : 0,
    },
    lastRole: lastMsg?.role,
    toolNames: (request.tools ?? []).map((t) => t.function.name),
    // `head` = tudo o que antecede o histórico num cache de prefixo (tools + system). Só na
    // memória, para os hashes/prefixo comum; NUNCA escrito.
    head: `${toolsJson}\u0000${headText}`,
  };
}

/** Envolve um client para rastrear; `label` dá o rótulo da sessão (`concierge`, `task t1`…). */
export type UsageTracer = (client: ModelClient, label: () => string) => ModelClient;

/**
 * Cria o rastreador (UM por sessão montada: o contador de requests é por rótulo). O rótulo de
 * sub-agente vem do contexto assíncrono. Desligado (`ALUY_DEBUG_USAGE` ausente) ⇒ `undefined`:
 * quem usa não envolve nada (custo zero).
 */
export function makeUsageTracer(env: NodeJS.ProcessEnv): UsageTracer | undefined {
  const path = usageTracePath(env);
  if (path === undefined) return undefined;
  const sessions = new Map<string, SessionState>();
  let ready = false;
  const write = (line: Record<string, unknown>): void => {
    try {
      if (!ready) {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        ready = true;
      }
      appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best-effort */
      }
    } catch {
      /* rastro nunca derruba a sessão */
    }
  };
  const begin = (request: ModelCallRequest, label: () => string) => {
    const base = label();
    const child = childLabel.getStore();
    const session = child !== undefined ? `${base}/sub:${child}` : base;
    const st = sessions.get(session) ?? { idx: 0 };
    sessions.set(session, st);
    st.idx += 1;
    const d = describeRequest(request);
    const prefixSame = st.prevHead === undefined ? undefined : commonPrefix(st.prevHead, d.head);
    const prefixChars = st.prevHead === undefined ? undefined : st.prevHead.length;
    st.prevHead = d.head;
    return { session, idx: st.idx, d, prefixSame, prefixChars };
  };
  const finish = (
    b: ReturnType<typeof begin>,
    request: ModelCallRequest,
    usage: ModelUsage | undefined,
  ): void => {
    write({
      ts: new Date().toISOString(),
      session: b.session,
      request: b.idx,
      tier: request.tier,
      provider: usage?.provider ?? request.provider,
      model: usage?.model ?? request.model,
      messages: b.d.messages,
      chars: b.d.chars,
      last_role: b.d.lastRole,
      tool_names: b.d.toolNames,
      // Estabilidade do prefixo (tools + system) frente ao request anterior DESTA sessão:
      // `prefix_same_chars` == `prefix_prev_chars` ⇒ idêntico (o cache de prefixo acerta).
      head_hash: hash(b.d.head),
      prefix_same_chars: b.prefixSame,
      prefix_prev_chars: b.prefixChars,
      usage:
        usage === undefined
          ? undefined
          : {
              prompt_tokens: usage.tokens_in,
              cached_tokens: usage.tokens_cached,
              cache_write_tokens: usage.tokens_cache_write,
              completion_tokens: usage.tokens_out,
              reasoning_tokens: usage.tokens_reasoning,
            },
    });
  };
  return (client, label) => ({
    async *stream(args: StreamCallArgs): AsyncGenerator<ModelStreamEvent> {
      const b = begin(args.request, label);
      let usage: ModelUsage | undefined;
      try {
        for await (const ev of client.stream(args)) {
          if (ev.type === 'usage') usage = ev.usage;
          yield ev;
        }
      } finally {
        finish(b, args.request, usage);
      }
    },
    async call(args: StreamCallArgs): Promise<ModelCallResult> {
      const b = begin(args.request, label);
      let usage: ModelUsage | undefined;
      try {
        const r = await client.call(args);
        usage = r.usage;
        return r;
      } finally {
        finish(b, args.request, usage);
      }
    },
  });
}

/** Atalho: envolve `client` se o rastro estiver ligado no `env`; senão devolve o próprio client. */
export function traceClient(
  client: ModelClient,
  label: () => string,
  env: NodeJS.ProcessEnv = process.env,
): ModelClient {
  const t = makeUsageTracer(env);
  return t === undefined ? client : t(client, label);
}

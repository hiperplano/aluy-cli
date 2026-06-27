// ADR-0120 / EST-1113 — adapter ANTHROPIC-DIRECT (Messages API) — o Claude, PRIORIDADE.
//
// Fala `POST {base}/v1/messages` em STREAMING. Espelha o que o broker faz com a
// Anthropic (referência de DESIGN), client-side. Diferenças do shape OpenAI que
// este adapter TRADUZ:
//   - `system` é um campo SEPARADO (não uma mensagem `role:system`).
//   - `messages` alterna user/assistant; NÃO há `role:tool` — o resultado de uma
//     tool-call volta como um bloco `tool_result` numa mensagem `role:user`, e a
//     proposta de tool-call do modelo é um bloco `tool_use` na `role:assistant`.
//   - `max_tokens` é OBRIGATÓRIO.
//   - `tools` no shape Anthropic `{name, description, input_schema}` (convertido do
//     shape de função OpenAI que o CLI usa internamente).
//   - SSE próprio: `message_start` (usage.input_tokens), `content_block_start`
//     (text|tool_use), `content_block_delta` (text_delta|input_json_delta|thinking_delta),
//     `content_block_stop`, `message_delta` (stop_reason + usage.output_tokens),
//     `message_stop`, `ping`, `error`.
//
// Auth (ADR-0120): API key ⇒ header `x-api-key: <key>` + `anthropic-version`. OAuth
// (assinatura, EST-1114) ⇒ `Authorization: Bearer <token>` + `anthropic-beta:
// oauth-2025-04-20` e SEM `x-api-key`. ⚠ a via OAuth de assinatura em cliente
// não-oficial é zona cinzenta de ToS (opção consciente do usuário).

import { BrokerError } from '../errors.js';
import type { ModelStreamEvent, ModelUsage, NativeToolCall, ToolFunctionSchema } from '../types.js';
import type { ProviderAdapter, BuiltRequest, SseAccumulator } from './adapter.js';
import type { LocalRequest, ResolvedCredential, LocalMessage } from './types.js';

/** Versão da API Anthropic (header obrigatório `anthropic-version`). */
const ANTHROPIC_VERSION = '2023-06-01';
/** Beta header exigido pela via OAuth de assinatura (ADR-0120 / EST-1114). */
const OAUTH_BETA = 'oauth-2025-04-20';

export class AnthropicAdapter implements ProviderAdapter {
  readonly kind = 'anthropic';
  // CLI-SEC-7 / CA-3 — o HOST do provider NÃO mora no core (seria endpoint cru no
  // pacote portável). O `baseUrl` EFETIVO é SEMPRE injetado pelo wiring (@aluy/cli,
  // factory), que detém os defaults públicos. O adapter só monta o PATH do protocolo.
  readonly defaultBaseUrl = '';
  readonly allowsBaseUrlOverride = true;

  buildRequest(args: {
    readonly request: LocalRequest;
    readonly baseUrl: string;
    readonly credential: ResolvedCredential;
  }): BuiltRequest {
    const { request, baseUrl, credential } = args;
    const base = baseUrl.replace(/\/+$/, '');
    const url = `${base}/v1/messages`;

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens, // OBRIGATÓRIO.
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (request.system !== undefined && request.system !== '') body.system = request.system;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map(toAnthropicTool);
      body.tool_choice = toAnthropicToolChoice(request.toolChoice);
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': ANTHROPIC_VERSION,
    };
    if (credential.kind === 'oauth') {
      // Via de assinatura: Bearer + beta header; NÃO manda x-api-key (ADR-0120).
      headers.authorization = `Bearer ${credential.secret}`;
      headers['anthropic-beta'] = OAUTH_BETA;
    } else {
      headers['x-api-key'] = credential.secret;
    }
    return { url, headers, body: JSON.stringify(body) };
  }

  mapSse(event: string, data: string, acc: SseAccumulator): readonly ModelStreamEvent[] {
    const payload = safeJson(data);
    if (!isRecord(payload)) return [];
    // O nome do evento vem do `event:` do SSE; o `type` no data confirma.
    const type = event !== '' ? event : (str(payload, 'type') ?? '');
    switch (type) {
      case 'message_start': {
        const out: ModelStreamEvent[] = [];
        const msg = isRecord(payload.message) ? payload.message : undefined;
        const reqId = msg !== undefined ? str(msg, 'id') : undefined;
        out.push({ type: 'start', request_id: reqId ?? '' });
        // usage.input_tokens chega aqui; guardamos p/ compor o usage final.
        const usage = msg !== undefined && isRecord(msg.usage) ? msg.usage : undefined;
        if (usage !== undefined) {
          const inTok = num(usage, 'input_tokens');
          if (inTok !== undefined) anthropicState(acc).inputTokens = inTok;
        }
        const model = msg !== undefined ? str(msg, 'model') : undefined;
        if (model !== undefined) anthropicState(acc).model = model;
        if (reqId !== undefined) anthropicState(acc).requestId = reqId;
        return out;
      }
      case 'content_block_start': {
        const block = isRecord(payload.content_block) ? payload.content_block : undefined;
        const index = num(payload, 'index') ?? 0;
        if (block !== undefined && str(block, 'type') === 'tool_use') {
          // abre uma tool-call (id+name vêm aqui; args chegam por input_json_delta).
          acc.toolCalls.set(index, {
            id: str(block, 'id') ?? '',
            name: str(block, 'name') ?? '',
            argsText: '',
          });
        }
        return [];
      }
      case 'content_block_delta': {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (delta === undefined) return [];
        const dtype = str(delta, 'type');
        if (dtype === 'text_delta') {
          const text = str(delta, 'text');
          return text !== undefined && text !== '' ? [{ type: 'delta', content: text }] : [];
        }
        if (dtype === 'input_json_delta') {
          const index = num(payload, 'index') ?? 0;
          const partial = str(delta, 'partial_json') ?? '';
          const tc = acc.toolCalls.get(index);
          if (tc !== undefined) tc.argsText += partial;
          return [];
        }
        // thinking_delta / signature_delta: não viram conteúdo visível do turno.
        return [];
      }
      case 'message_delta': {
        const out: ModelStreamEvent[] = [];
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        // tool-calls completas vão ANTES do done.
        out.push(...flushToolCalls(acc));
        // usage.output_tokens cumulativo chega aqui.
        const usage = isRecord(payload.usage) ? payload.usage : undefined;
        if (usage !== undefined) {
          const outTok = num(usage, 'output_tokens');
          if (outTok !== undefined) anthropicState(acc).outputTokens = outTok;
        }
        const stop = delta !== undefined ? str(delta, 'stop_reason') : undefined;
        // o trailer de usage é emitido aqui (antes do done) com o que acumulamos.
        out.push({ type: 'usage', usage: buildUsage(acc) });
        out.push({ type: 'done', finish_reason: normalizeStop(stop) });
        return out;
      }
      case 'error': {
        const err = isRecord(payload.error) ? payload.error : undefined;
        throw toBrokerError(err);
      }
      case 'ping':
      case 'content_block_stop':
      case 'message_stop':
      default:
        return [];
    }
  }
}

// ── estado por-chamada específico do Anthropic (anexado ao acumulador comum) ──
interface AnthropicState {
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  requestId?: string;
}
const ANTHROPIC_STATE = new WeakMap<SseAccumulator, AnthropicState>();
function anthropicState(acc: SseAccumulator): AnthropicState {
  let s = ANTHROPIC_STATE.get(acc);
  if (s === undefined) {
    s = {};
    ANTHROPIC_STATE.set(acc, s);
  }
  return s;
}

function buildUsage(acc: SseAccumulator): ModelUsage {
  const s = anthropicState(acc);
  const out: { -readonly [K in keyof ModelUsage]: ModelUsage[K] } = {
    request_id: s.requestId ?? '',
    tier: 'local',
    provider: 'anthropic',
  };
  if (s.model !== undefined) out.model = s.model;
  if (s.inputTokens !== undefined) out.tokens_in = s.inputTokens;
  if (s.outputTokens !== undefined) out.tokens_out = s.outputTokens;
  return out;
}

function flushToolCalls(acc: SseAccumulator): readonly ModelStreamEvent[] {
  if (acc.emittedToolCalls || acc.toolCalls.size === 0) return [];
  acc.emittedToolCalls = true;
  const out: ModelStreamEvent[] = [];
  for (const partial of acc.toolCalls.values()) {
    if (partial.name === '') continue;
    const input = coerceArgs(partial.argsText);
    const call: NativeToolCall = { id: partial.id, name: partial.name, input };
    out.push({ type: 'tool_call', call });
  }
  return out;
}

/**
 * Converte as mensagens PORTÁVEIS (estilo OpenAI: system/user/assistant/tool com
 * `tool_calls`/`tool_call_id`) p/ o shape Anthropic:
 *   - `role:tool` ⇒ uma `role:user` com um bloco `tool_result` (`tool_use_id`).
 *   - `role:assistant` com `tool_calls` ⇒ blocos `tool_use` (+ texto, se houver).
 *   - texto puro ⇒ `content` string.
 * (mensagens `role:system` portáveis NÃO devem chegar aqui — o `system` já é campo
 * separado; se chegarem, viram um bloco de texto user p/ não perder a instrução.)
 */
export function toAnthropicMessages(messages: readonly LocalMessage[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === 'tool') {
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: m.content,
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls !== undefined && m.tool_calls.length > 0) {
      const blocks: Record<string, unknown>[] = [];
      if (m.content !== '') blocks.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input ?? {} });
      }
      out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // system portável (não deveria vir) ⇒ trata como user p/ não perder instrução.
    const role = m.role === 'system' ? 'user' : m.role;
    out.push({ role, content: m.content });
  }
  return out;
}

/** Converte o schema de função OpenAI (`{type:function, function:{...}}`) p/ Anthropic. */
function toAnthropicTool(t: ToolFunctionSchema): Record<string, unknown> {
  return {
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  };
}

function toAnthropicToolChoice(choice: 'auto' | 'none' | 'required' | undefined): {
  type: string;
} {
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'auto' };
}

/** Normaliza o `stop_reason` Anthropic p/ o vocabulário do CLI (espelha o broker). */
function normalizeStop(stop: string | undefined): string {
  // 'tool_use' ⇒ o loop espera 'tool_calls'; 'end_turn' ⇒ 'stop' (fim normal, como o
  // broker reporta); 'stop_sequence'/'max_tokens' passam; ausente ⇒ 'stop'.
  if (stop === 'tool_use') return 'tool_calls';
  if (stop === 'end_turn' || stop === undefined || stop === null || stop === '') return 'stop';
  return stop;
}

function toBrokerError(err: Record<string, unknown> | undefined): BrokerError {
  const type = err !== undefined ? str(err, 'type') : undefined;
  const message = (err !== undefined ? str(err, 'message') : undefined) ?? 'provider error';
  // 'overloaded_error' ⇒ 529 (retryable); 'rate_limit_error' ⇒ 429; senão 502.
  const status = type === 'overloaded_error' ? 529 : type === 'rate_limit_error' ? 429 : 502;
  return new BrokerError({ status, code: 'PROVIDER_ERROR', detail: message });
}

function coerceArgs(argsText: string): Record<string, unknown> {
  if (argsText.trim() === '') return {};
  const parsed = safeJson(argsText);
  return isRecord(parsed) ? (parsed as Record<string, unknown>) : {};
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown, key: string): string | undefined {
  if (!isRecord(v)) return undefined;
  const val = v[key];
  return typeof val === 'string' ? val : undefined;
}
function num(v: unknown, key: string): number | undefined {
  if (!isRecord(v)) return undefined;
  const val = v[key];
  return typeof val === 'number' ? val : undefined;
}

// ADR-0120 / EST-1113 — adapter OpenAI-COMPAT (openrouter + openai-direct).
//
// Fala `POST {base}/chat/completions` em STREAMING (`stream:true`), o protocolo que
// a OpenAI, a OpenRouter e clones servem. Espelha o que o broker faz com a
// OpenRouter (`aluy-broker/src/openrouter.py` = referência de DESIGN, não cópia).
//
// SSE (estilo OpenAI): linhas `data: {json}` (sem `event:`), terminadas por
// `data: [DONE]`. Cada chunk traz `choices[0].delta` com `content` (texto) e/ou
// `tool_calls[]` (fragmentados por `index`: `function.arguments` chega em pedaços).
// `usage` pode vir no ÚLTIMO chunk (se `stream_options.include_usage`). `finish_reason`
// fecha o turno. Mapeamos tudo p/ o `ModelStreamEvent` do CLI.
//
// Auth: `Authorization: Bearer <key>` (apikey e oauth iguais aqui). OpenRouter aceita
// headers opcionais `HTTP-Referer`/`X-Title` (boa-praxis de atribuição) — mandamos
// um identificador honesto do aluy-cli.

import { BrokerError } from '../errors.js';
import type { ModelStreamEvent, ModelUsage, NativeToolCall } from '../types.js';
import type { ProviderAdapter, BuiltRequest, SseAccumulator } from './adapter.js';
import type { LocalRequest, ResolvedCredential, LocalProviderKind } from './types.js';

const ATTRIBUTION_URL = 'https://github.com/hiperplano/aluy-cli';
const ATTRIBUTION_TITLE = 'aluy-cli';

export interface OpenAiCompatAdapterOptions {
  /**
   * Id do provider (ex.: `openrouter`/`openai`/`deepseek`/`groq`/…) — só p/ rotular
   * `kind` e o `usage.provider`. ABERTO (ADR-0118): qualquer vendor OpenAI-compatible do
   * catálogo usa este adapter; o id é DADO. A atribuição extra (referer/title) só vale
   * p/ `openrouter` (feature do agregador).
   */
  readonly provider: LocalProviderKind;
  readonly defaultBaseUrl: string;
}

export class OpenAiCompatAdapter implements ProviderAdapter {
  readonly kind: string;
  readonly defaultBaseUrl: string;
  readonly allowsBaseUrlOverride = true;
  private readonly provider: string;

  constructor(opts: OpenAiCompatAdapterOptions) {
    this.provider = opts.provider;
    this.kind = opts.provider;
    this.defaultBaseUrl = opts.defaultBaseUrl;
  }

  buildRequest(args: {
    readonly request: LocalRequest;
    readonly baseUrl: string;
    readonly credential: ResolvedCredential;
  }): BuiltRequest {
    const { request, baseUrl, credential } = args;
    const base = baseUrl.replace(/\/+$/, '');
    const url = `${base}/chat/completions`;

    // `system` vira a 1ª mensagem `role:system` (OpenAI não tem campo separado).
    const messages: Record<string, unknown>[] = [];
    if (request.system !== undefined && request.system !== '') {
      messages.push({ role: 'system', content: request.system });
    }
    for (const m of request.messages) messages.push(serializeMessage(m));

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      max_tokens: request.maxTokens,
      stream: true,
      // pede o trailer de usage no fim do stream (OpenRouter/OpenAI honram).
      stream_options: { include_usage: true },
    };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    // reasoning_effort: passthrough (o3/gpt-5 e openrouter aceitam; demais ignoram).
    if (request.reasoningEffort !== undefined && request.reasoningEffort !== '') {
      body.reasoning_effort = request.reasoningEffort;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools; // já no shape de função OpenAI.
      body.tool_choice = request.toolChoice ?? 'auto';
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${credential.secret}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    if (this.provider === 'openrouter') {
      headers['http-referer'] = ATTRIBUTION_URL;
      headers['x-title'] = ATTRIBUTION_TITLE;
    }
    return { url, headers, body: JSON.stringify(body) };
  }

  mapSse(_event: string, data: string, acc: SseAccumulator): readonly ModelStreamEvent[] {
    const trimmed = data.trim();
    if (trimmed === '') return [];
    if (trimmed === '[DONE]') return this.flush(acc);

    const payload = safeJson(trimmed);
    if (!isRecord(payload)) return [];

    // Erro mid-stream (OpenRouter pode mandar `{error:{message,code}}` no data).
    if (isRecord(payload.error)) {
      throw toBrokerError(payload.error);
    }

    const out: ModelStreamEvent[] = [];
    const choice = firstChoice(payload);
    if (choice !== undefined) {
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      const content = delta !== undefined ? str(delta, 'content') : undefined;
      if (content !== undefined && content !== '') out.push({ type: 'delta', content });
      if (delta !== undefined && Array.isArray(delta.tool_calls)) {
        accumulateToolCalls(acc, delta.tool_calls);
      }
      const finish = str(choice, 'finish_reason');
      if (finish !== undefined && finish !== null && finish !== '') {
        // antes do done, emite as tool-calls acumuladas (se houver).
        out.push(...this.flush(acc));
        out.push({ type: 'done', finish_reason: finish });
      }
    }
    // `usage` pode chegar no MESMO chunk do done (include_usage) ou num chunk só.
    if (isRecord(payload.usage)) {
      out.unshift({ type: 'usage', usage: this.toUsage(payload.usage, payload) });
    }
    return out;
  }

  /** Emite as tool-calls acumuladas UMA vez (idempotente no done/finish/[DONE]). */
  private flush(acc: SseAccumulator): readonly ModelStreamEvent[] {
    if (acc.emittedToolCalls || acc.toolCalls.size === 0) return [];
    acc.emittedToolCalls = true;
    const out: ModelStreamEvent[] = [];
    for (const partial of acc.toolCalls.values()) {
      if (partial.name === '') continue; // call sem nome ⇒ inútil, descarta.
      const input = coerceArgs(partial.argsText);
      const call: NativeToolCall = { id: partial.id, name: partial.name, input };
      out.push({ type: 'tool_call', call });
    }
    return out;
  }

  private toUsage(raw: Record<string, unknown>, full: Record<string, unknown>): ModelUsage {
    const out: { -readonly [K in keyof ModelUsage]: ModelUsage[K] } = {
      request_id: str(full, 'id') ?? '',
      tier: 'local',
      provider: this.provider,
    };
    const model = str(full, 'model');
    if (model !== undefined) out.model = model;
    const inTok = num(raw, 'prompt_tokens');
    if (inTok !== undefined) out.tokens_in = inTok;
    const outTok = num(raw, 'completion_tokens');
    if (outTok !== undefined) out.tokens_out = outTok;
    return out;
  }
}

/** Acumula os deltas de `tool_calls[]` (fragmentados por `index`) no acumulador. */
function accumulateToolCalls(acc: SseAccumulator, deltas: unknown[]): void {
  for (const d of deltas) {
    if (!isRecord(d)) continue;
    const index = typeof d.index === 'number' ? d.index : 0;
    const existing = acc.toolCalls.get(index) ?? { id: '', name: '', argsText: '' };
    const id = str(d, 'id');
    if (id !== undefined && id !== '') existing.id = id;
    const fn = isRecord(d.function) ? d.function : undefined;
    if (fn !== undefined) {
      const name = str(fn, 'name');
      if (name !== undefined && name !== '') existing.name = name;
      const argsChunk = str(fn, 'arguments');
      if (argsChunk !== undefined) existing.argsText += argsChunk;
    }
    acc.toolCalls.set(index, existing);
  }
}

/** Serializa UMA mensagem portável p/ o shape OpenAI (tool_calls/tool_call_id). */
function serializeMessage(m: {
  role: string;
  content: string;
  tool_calls?: readonly { id: string; name: string; input: Record<string, unknown> }[];
  tool_call_id?: string;
}): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.tool_calls !== undefined && m.tool_calls.length > 0) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.input ?? {}) },
    }));
  }
  if (m.tool_call_id !== undefined) out.tool_call_id = m.tool_call_id;
  return out;
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!Array.isArray(payload.choices)) return undefined;
  const c = payload.choices[0];
  return isRecord(c) ? c : undefined;
}

/** Converte `{error:{message,code,type}}` do OpenAI/openrouter num `BrokerError`. */
function toBrokerError(err: Record<string, unknown>): BrokerError {
  const status = num(err, 'code') ?? num(err, 'status') ?? 502;
  const message = str(err, 'message') ?? 'provider error';
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

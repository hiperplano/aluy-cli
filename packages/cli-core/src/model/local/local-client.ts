// ADR-0120 / EST-1113 — `LocalModelClient`: o "smallbroker" IN-PROCESS (BYO).
//
// Implementa o MESMO contrato `ModelClient` do `BrokerModelClient` (`stream()`/
// `call()` → `start`/`delta`/`tool_call`/`usage`/`done` + `ModelCallResult`), mas
// fala com o PROVIDER DIRETO via um `ProviderAdapter`, com credencial BYO. O loop/
// callers NÃO distinguem — é troca de estratégia no *seam* (escolhida no wiring).
//
// O que o broker faria SERVER-SIDE (resolver provider+credencial, montar o corpo
// nativo, normalizar o SSE), o backend local faz CLIENT-SIDE: o adapter monta a
// requisição e mapeia o SSE; este client faz o fetch/stream e agrega.
//
// PORTÁVEL (ADR-0053 §8): `fetch` injetável (subset WHATWG), credencial via porta
// injetada (resolvida no locus a partir do keychain→env), adapter PURO. Sem Ink/IO.
//
// REUSA os erros estruturados do broker (`BrokerError`/`BrokerTransportError`/
// `ModelCallAbortedError`) e as guardas (degeneração + stream-cap) ⇒ o loop trata
// o local IGUAL ao broker (incl. o degrade de tools no `isToolsUnsupported`).

import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
  toProblemDetails,
} from '../errors.js';
import { parseSse } from '../sse.js';
import { newDegenerationSink } from '../../agent/degeneration.js';
import { newStreamByteCap, STREAM_CAP_FINISH_REASON } from '../../agent/stream-cap.js';
import type { StreamFetch, StreamCallArgs, ModelClient } from '../broker-client.js';
import { pushOrMergeToolCall } from '../broker-client.js';
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelStreamEvent,
  ModelUsage,
  NativeToolCall,
} from '../types.js';
import type { ProviderAdapter, SseAccumulator } from './adapter.js';
import { newSseAccumulator } from './adapter.js';
import type {
  CredentialProvider,
  LocalProviderConfig,
  LocalRequest,
  LocalMessage,
} from './types.js';

export interface LocalModelClientOptions {
  /** O adapter do provider (anthropic/openrouter/openai). */
  readonly adapter: ProviderAdapter;
  /** Config resolvida (model + base_url efetiva + auth). */
  readonly config: LocalProviderConfig;
  /** base_url EFETIVA (já validada por anti-SSRF no wiring — PROV-SEC-1). */
  readonly baseUrl: string;
  /** Provedor da credencial (keychain→env, resolvido por chamada no locus). */
  readonly getCredential: CredentialProvider;
  /** `fetch` injetável (default: global). MESMO subset do broker-client. */
  readonly fetch?: StreamFetch;
  /**
   * Teto de OUTPUT por chamada. O Anthropic EXIGE `max_tokens`; usamos este (ou um
   * default seguro) quando o request não traz. Os adapters OpenAI também o mandam.
   */
  readonly maxTokens?: number;
}

/** Default seguro de `max_tokens` quando nada foi configurado (Anthropic exige). */
const DEFAULT_MAX_TOKENS = 8192;

export class LocalModelClient implements ModelClient {
  private readonly adapter: ProviderAdapter;
  private readonly config: LocalProviderConfig;
  private readonly baseUrl: string;
  private readonly getCredential: CredentialProvider;
  private readonly doFetch: StreamFetch;
  private readonly maxTokens: number;

  constructor(opts: LocalModelClientOptions) {
    this.adapter = opts.adapter;
    this.config = opts.config;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getCredential = opts.getCredential;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as StreamFetch);
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async *stream(args: StreamCallArgs): AsyncGenerator<ModelStreamEvent> {
    const { request, signal } = args;
    throwIfAborted(signal);

    const credential = await this.getCredential();
    throwIfAborted(signal);

    const local = this.toLocalRequest(request);
    const built = this.adapter.buildRequest({ request: local, baseUrl: this.baseUrl, credential });

    let res;
    try {
      res = await this.doFetch(built.url, {
        method: 'POST',
        headers: built.headers,
        body: built.body,
        // EST-1115 · PROV-SEC-1 — fail-closed em redirect: o fetch pinado do locus
        // NUNCA segue um `302 → http://169.254.169.254/` cego. Campo opcional ⇒
        // back-compat com fetches de teste/genéricos que o ignoram.
        redirect: 'error',
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err)) throw new ModelCallAbortedError();
      // NUNCA loga o segredo/headers (CLI-SEC-10) — mensagem genérica.
      throw new BrokerTransportError(
        'falha de transporte ao chamar o provider (backend local).',
        err,
      );
    }

    if (!res.ok) {
      throw await this.toProviderError(res);
    }
    if (res.body === null) {
      throw new BrokerTransportError('provider respondeu 2xx sem corpo de stream.');
    }

    const acc: SseAccumulator = newSseAccumulator();
    try {
      for await (const sse of parseSse(res.body)) {
        throwIfAborted(signal);
        const mapped = this.adapter.mapSse(sse.event, sse.data, acc);
        for (const ev of mapped) {
          yield ev;
          if (ev.type === 'done') return;
        }
      }
    } catch (err) {
      if (isAbortError(err) || err instanceof ModelCallAbortedError) {
        throw new ModelCallAbortedError();
      }
      if (err instanceof BrokerError) throw err;
      throw new BrokerTransportError('falha ao ler o stream do provider (backend local).', err);
    }
  }

  /** Conveniência NÃO-stream: agrega o stream (mesmo contrato do broker-client). */
  async call(args: StreamCallArgs): Promise<ModelCallResult> {
    let content = '';
    let requestId = '';
    let finishReason = 'stop';
    let usage: ModelUsage | undefined;
    const toolCalls: NativeToolCall[] = [];
    const guard = newDegenerationSink();
    const cap = newStreamByteCap();
    let capped = false;

    for await (const ev of this.stream(args)) {
      switch (ev.type) {
        case 'start':
          requestId = ev.request_id;
          break;
        case 'delta':
          content += ev.content;
          guard.push(ev.content);
          if (cap.addText(ev.content)) capped = true;
          break;
        case 'tool_call':
          pushOrMergeToolCall(toolCalls, ev.call);
          if (cap.addToolCall(ev.call)) capped = true;
          break;
        case 'usage':
          usage = ev.usage;
          break;
        case 'done':
          finishReason = ev.finish_reason;
          break;
      }
      if (capped) {
        finishReason = STREAM_CAP_FINISH_REASON;
        break;
      }
    }

    return {
      request_id: requestId,
      content,
      finish_reason: finishReason,
      ...(usage !== undefined ? { usage } : {}),
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    };
  }

  /**
   * Traduz o `ModelCallRequest` PORTÁVEL (tier-based) p/ o `LocalRequest` nativo. O
   * `tier`/`session_id` são IGNORADOS no local (o `model` concreto vem da config
   * BYO; não há sessão server-side). Extrai o `system` da 1ª mensagem `role:system`
   * (estilo do loop). Tools: o CLI já as monta no shape de função OpenAI — o adapter
   * Anthropic as converte; o OpenAI-compat as usa direto.
   */
  private toLocalRequest(request: ModelCallRequest): LocalRequest {
    let system: string | undefined;
    const messages: LocalMessage[] = [];
    for (const m of request.messages) {
      if (m.role === 'system' && system === undefined) {
        // 1ª system vira o campo `system`; subsequentes (raras) viram mensagens.
        system = m.content;
        continue;
      }
      messages.push({
        role: m.role,
        content: m.content,
        ...(m.tool_calls !== undefined
          ? {
              tool_calls: m.tool_calls.map((tc) => ({
                id: tc.id,
                name: tc.name,
                input: { ...tc.input },
              })),
            }
          : {}),
        ...(m.tool_call_id !== undefined ? { tool_call_id: m.tool_call_id } : {}),
      });
    }
    // F146 · FIX: /model → Custom: quando o usuário trocou de modelo pela via
    // Custom (tier:"custom" + model slug), o slug SOBRESCREVE this.config.model.
    // Sem tier custom (ou slug vazio), mantém o model do boot (fallback seguro).
    const slug = request.tier === 'custom' ? request.model?.trim() : undefined;
    const model = slug && slug.length > 0 ? slug : this.config.model;
    const out: {
      -readonly [K in keyof LocalRequest]: LocalRequest[K];
    } = {
      model,
      messages,
      maxTokens: request.max_tokens ?? this.maxTokens,
    };
    if (system !== undefined) out.system = system;
    if (request.temperature !== undefined) out.temperature = request.temperature;
    if (request.reasoning_effort !== undefined) out.reasoningEffort = request.reasoning_effort;
    if (request.tools !== undefined && request.tools.length > 0) {
      out.tools = request.tools;
      out.toolChoice = request.tool_choice ?? 'auto';
    }
    return out;
  }

  /** Converte uma resposta de erro do provider num `BrokerError` estruturado. */
  private async toProviderError(res: {
    status: number;
    json(): Promise<unknown>;
    headers: { get(name: string): string | null };
  }): Promise<BrokerError> {
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    // Corpo de erro dos providers: `{error:{message,type,code}}`. Extrai a mensagem
    // (sem vazar headers/credencial) e mapeia p/ o vocabulário do broker.
    const message = extractErrorMessage(parsed);
    const code = mapProviderErrorCode(res.status, parsed);
    // EST-0996 — p/ o degrade de tools funcionar, o `BrokerError.isToolsUnsupported`
    // exige status 422 + code TOOLS_UNSUPPORTED. Um provider pode devolver 400 nesse
    // caso ⇒ NORMALIZAMOS o status p/ 422 quando o code é TOOLS_UNSUPPORTED.
    const status = code === 'TOOLS_UNSUPPORTED' ? 422 : res.status;
    const problem = toProblemDetails(status, {
      code,
      ...(message !== undefined ? { detail: message } : {}),
    });
    return new BrokerError(problem);
  }
}

/**
 * Detecta `422 TOOLS_UNSUPPORTED`-equivalente: alguns providers respondem 400/422
 * quando o modelo não suporta `tools`. Mapeamos p/ `TOOLS_UNSUPPORTED` (status 422)
 * SÓ quando a mensagem do provider claramente cita tools/function-calling — assim o
 * loop DEGRADA p/ texto (EST-0996) em vez de falhar. Senão, `PROVIDER_ERROR`.
 */
function mapProviderErrorCode(status: number, body: unknown): string {
  if (status === 401 || status === 403) return 'UNAUTHENTICATED';
  if (status === 429) return 'RATE_LIMITED';
  const msg = (extractErrorMessage(body) ?? '').toLowerCase();
  if (
    (status === 400 || status === 422) &&
    (msg.includes('tool') || msg.includes('function calling') || msg.includes('function_call'))
  ) {
    return 'TOOLS_UNSUPPORTED';
  }
  if (status >= 500) return 'PROVIDER_ERROR';
  if (status === 400 || status === 422) return 'VALIDATION_FAILED';
  return 'PROVIDER_ERROR';
}

function extractErrorMessage(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const obj = body as Record<string, unknown>;
  // `{error:{message}}` (OpenAI/Anthropic) OU `{message}` OU `{error:"..."}`.
  if (typeof obj.message === 'string') return obj.message;
  const err = obj.error;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const m = (err as Record<string, unknown>).message;
    if (typeof m === 'string') return m;
  }
  return undefined;
}

// IMPORTANTE: `toProblemDetails` espera o status como 1º arg; aqui o re-mapeamos
// p/ injetar o `code` derivado. Pequeno wrapper p/ casar com a assinatura.
// (mapProviderErrorCode acima devolve o code; toProviderError o injeta no body.)

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new ModelCallAbortedError();
}
function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

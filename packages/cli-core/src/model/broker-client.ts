// Cliente de modelo CLI→broker (EST-0943) — o ÚNICO caminho de modelo do CLI.
//
// CLI-SEC-7 (DURO): este é o caminho ÚNICO e EXCLUSIVO de chamada de modelo. Ele
// fala SÓ com o `aluy-broker` (`POST /v1/chat`, transporte interno cravado em Q3)
// e a ÚNICA pista de modelo que envia é o `tier` (HG-2). Não carrega credencial
// de provider, não sabe o provider, não lê/ajusta quota, não mantém ledger, não
// resolve markup. Não há — e o teste de regressão CLI-SEC-7 garante que não
// passe a haver — nenhuma rota alternativa (provider direto / chave local).
//
// Topologia (Q2, cravada — ADR-0053 §3 / EST-0943): CLI→broker DIRETO. NÃO há
// BFF do app no caminho. Por isso o cliente NÃO seta `X-Actor-User`/`X-Org`
// (que o app/runtime setariam como intermediário confiável): ele só apresenta a
// CREDENCIAL HEADLESS de usuário no `Authorization: Bearer`, e o BROKER resolve
// `X-Actor-User`/`X-Org` introspectando essa credencial (caminho headless da
// EST-0940). Ver o "delta do broker" no PR/estória.
//
// PORTÁVEL (ADR-0053 §8): usa `fetch` injetável + um provedor de token injetável
// (a LoginService.getAccessToken, EST-0942). Sem Ink/React, sem I/O de terminal.

import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
  toProblemDetails,
} from './errors.js';
import { parseSse } from './sse.js';
import { newDegenerationSink } from '../agent/degeneration.js';
import { newStreamByteCap, STREAM_CAP_FINISH_REASON } from '../agent/stream-cap.js';
import { parseQuotaFromUsage, type Quota } from './quota.js';
import type {
  ModelCallRequest,
  ModelCallResult,
  ModelStreamEvent,
  ModelUsage,
  NativeToolCall,
} from './types.js';

/**
 * `fetch` mínimo que o cliente precisa — subset do WHATWG fetch com `body`
 * legível como stream. Injetável p/ teste (mesma disciplina do IdentityClient).
 *
 * `body` é OPCIONAL (EST-0962): o `fetch` REAL do Node LANÇA em GET/HEAD com
 * `body` definido — mesmo `body: ''` — ("Request with GET/HEAD method cannot
 * have body."). Logo um GET deve OMITIR `body` por completo; só POST/PUT o
 * mandam. O fake de teste deve espelhar isso (rejeitar `body` em GET/HEAD).
 */
export type StreamFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    /**
     * EST-1115 · PROV-SEC-1 — política de redirect. Campo OPCIONAL p/ back-compat:
     * o `broker-client` NUNCA o seta (o broker é confiável, não redireciona p/
     * alvo arbitrário). O `LocalModelClient` (backend BYO) PEDE `'error'`
     * (fail-closed) ao seu fetch pinado — um `302 → http://169.254.169.254/`
     * jamais é seguido cego. Valores: `'follow'` (default do `globalThis.fetch`),
     * `'manual'` (devolve a resposta de redirect crua), `'error'` (rejeita).
     */
    redirect?: 'error' | 'follow' | 'manual';
  },
) => Promise<StreamResponse>;

/** Resposta mínima consumida pelo cliente. */
export interface StreamResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  /** Corpo como stream de bytes (SSE). `null` quando não há corpo. */
  readonly body: AsyncIterable<Uint8Array | string> | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/**
 * Provedor da credencial headless de usuário. É a `LoginService.getAccessToken`
 * (EST-0942): devolve o access JWT (device-flow, refrescando se preciso) ou o
 * PAT. O cliente NÃO conhece o keychain — só pede o bearer a cada chamada.
 */
export type AccessTokenProvider = () => Promise<string>;

export interface BrokerModelClientOptions {
  /** Base URL do broker — de `ALUY_BROKER_URL` (sem `/v1`; é acrescentado). */
  readonly baseUrl: string;
  /** Provedor da credencial headless (LoginService.getAccessToken). */
  readonly getAccessToken: AccessTokenProvider;
  /** `fetch` injetável (default: global). */
  readonly fetch?: StreamFetch;
}

/** Argumentos de uma chamada de stream (request + cancelamento). */
export interface StreamCallArgs {
  readonly request: ModelCallRequest;
  /** Abort do chamador (cancelamento da sessão/teto — EST-0947). */
  readonly signal?: AbortSignal;
  /**
   * Idempotency-Key da chamada LÓGICA de modelo (correção do revisor do EST-0943,
   * coração da tese reseller). **A key NASCE NO LOOP** (EST-0944, dono): o loop
   * gera uma key estável por chamada-lógica e a passa aqui; um **retry de rede
   * reusa a MESMA key**, e o broker DEDUPLICA o billing (não cobra 2× a mesma
   * chamada). O cliente é só o portador: repassa no header `Idempotency-Key` sem
   * gerar nem mutar. `undefined` ⇒ sem header (compat com chamadas não-loop).
   */
  readonly idempotencyKey?: string;
}

const CHAT_PATH = '/v1/chat';

/**
 * ADR-0120 — o CONTRATO de cliente de modelo que o loop/callers consomem. O
 * `BrokerModelClient` (caminho de PRODUTO, broker central) e o `LocalModelClient`
 * (backend LOCAL/BYO, EST-1113) o satisfazem AMBOS — o `StreamingModelCaller`/
 * `BrokerModelCaller`/loop não distinguem qual está por baixo (é troca de
 * ESTRATÉGIA no *seam*, escolhida no wiring). `stream()` é a fonte da verdade
 * (token-a-token); `call()` agrega. Manter este contrato ESTREITO: tudo que o
 * caller precisa do transporte está aqui.
 */
export interface ModelClient {
  stream(args: StreamCallArgs): AsyncGenerator<ModelStreamEvent>;
  call(args: StreamCallArgs): Promise<ModelCallResult>;
}

export class BrokerModelClient implements ModelClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly doFetch: StreamFetch;

  constructor(opts: BrokerModelClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as StreamFetch);
  }

  /**
   * Chama o modelo via broker em STREAMING (CA-2). Async-generator: emite
   * `start`/`delta`/`usage`/`done` na ORDEM. Mapeamentos:
   *  - `event: error` do broker ⇒ LANÇA `BrokerError` (CA-5: erro estruturado).
   *  - resposta HTTP não-2xx (erro antes do stream) ⇒ LANÇA `BrokerError`.
   *  - `AbortSignal` abortado ⇒ LANÇA `ModelCallAbortedError`.
   *  - falha de rede ⇒ LANÇA `BrokerTransportError`.
   *
   * O CLI NÃO faz retry aqui (CA-5: sem retry infinito) — devolve o erro
   * estruturado e o loop/tetos (EST-0944/0947) decidem.
   */
  async *stream(args: StreamCallArgs): AsyncGenerator<ModelStreamEvent> {
    const { request, signal, idempotencyKey } = args;
    throwIfAborted(signal);

    const token = await this.getAccessToken();
    throwIfAborted(signal);

    const res = await this.send(token, request, signal, /* stream */ true, idempotencyKey);

    if (!res.ok) {
      throw await this.toBrokerError(res);
    }
    if (res.body === null) {
      throw new BrokerTransportError('broker respondeu 2xx sem corpo de stream.');
    }

    // EST-0948 · ADR-0069 (footer/quota, path A) — a quota de JANELA da PRÓPRIA conta
    // chega ACHATADA no evento `usage` do broker (`quota_5h_*`/`quota_week_*`, broker#59),
    // SEM request extra no loop quente. Lê do MESMO payload do `usage` (tolerante:
    // ilimitada/ausente ⇒ `undefined`) e emite UM evento `quota` logo após. O CRÉDITO
    // (dimensão primária) vem à parte pelo `QuotaClient`/`GET /v1/quota` (path B), no
    // boot/refresh — não pelo `usage`. O CLI só LÊ/mostra (HG-3/HG-4, CLI-SEC-7).
    try {
      for await (const sse of parseSse(res.body)) {
        throwIfAborted(signal);
        const mapped = mapSseEvent(sse.event, sse.data);
        if (mapped) yield mapped;
        // Após o `usage`, deriva a quota de janela dos seus campos achatados e emite-a
        // (uma vez, junto do trailer). Ausente (janela ilimitada/desligada) ⇒ nada.
        if (sse.event === 'usage') {
          const quota = parseQuotaFromUsage(safeJson(sse.data));
          if (quota !== undefined) yield { type: 'quota', quota };
        }
        if (sse.event === 'done') return;
      }
    } catch (err) {
      // Abort propagado de dentro do loop é re-lançado como cancelamento limpo.
      if (isAbortError(err) || err instanceof ModelCallAbortedError) {
        throw new ModelCallAbortedError();
      }
      if (err instanceof BrokerError) throw err;
      throw new BrokerTransportError('falha ao ler o stream do broker.', err);
    }
  }

  /**
   * Conveniência NÃO-stream: consome o stream até o fim e devolve o resultado
   * agregado (texto + usage). Útil pro comando mínimo `aluy "pergunta"` e p/ o
   * loop quando não precisa renderizar token-a-token. Mesmo caminho/contrato —
   * NÃO é uma 2ª rota de modelo (CLI-SEC-7): reusa `stream()`.
   */
  async call(args: StreamCallArgs): Promise<ModelCallResult> {
    let content = '';
    let requestId = '';
    let sessionId: string | undefined;
    let finishReason = 'stop';
    let usage: ModelUsage | undefined;
    let quota: Quota | undefined;
    // EST-0996 — acumula as tool-calls NATIVAS agregadas (`event: tool_call`) do
    // stream. O broker já junta os deltas de `function.arguments`; aqui só as
    // coletamos na ORDEM em que chegam. Vazio ⇒ o loop cai no parser de texto.
    const toolCalls: NativeToolCall[] = [];
    // EST-0969 (anti-runaway) — guarda anti-repetição POR CHAMADA: cada delta a
    // alimenta; se o conteúdo degenerar (mesma linha/ciclo curto sem novidade)
    // ela LANÇA `DegenerateLoopError`, que aborta o consumo do stream AQUI (o
    // generator para de ser drenado ⇒ a conexão é fechada) e sobe pro AgentLoop,
    // que o converte num `stop:'degenerate'`. Ligada por default; `ALUY_DEGENERATE_OFF`
    // devolve um no-op (stream idêntico ao baseline).
    const guard = newDegenerationSink();
    // EST-1010 (BUG-0020) — TETO de BYTES agregados (anti-OOM client-side). Pega o
    // stream GIGANTE NÃO-repetitivo que a guarda de degeneração não pega (broker
    // bugado / `done` que nunca chega). Ao cruzar o teto, PARA de drenar e devolve
    // o turno acumulado (capado) com `finish_reason` truncado — preserva o parcial.
    const cap = newStreamByteCap();
    let capped = false;

    for await (const ev of this.stream(args)) {
      switch (ev.type) {
        case 'start':
          requestId = ev.request_id;
          sessionId = ev.session_id;
          break;
        case 'delta':
          content += ev.content;
          guard.push(ev.content);
          if (cap.addText(ev.content)) capped = true;
          break;
        case 'tool_call':
          // EST-0996 — tool-call NATIVA agregada: coleta na ordem (1+ por turno).
          // HUNT-SSE — COALESCE por `id`: se o broker vazar fragmentos do MESMO id
          // (nome num frame, args noutro), funde em UMA call em vez de empilhar
          // duplicata (que daria `tool_call_id` repetido ⇒ 400 do provider).
          pushOrMergeToolCall(toolCalls, ev.call);
          if (cap.addToolCall(ev.call)) capped = true;
          break;
        case 'usage':
          usage = ev.usage;
          break;
        case 'quota':
          quota = ev.quota;
          break;
        case 'done':
          finishReason = ev.finish_reason;
          break;
      }
      // Teto cruzado: encerra o consumo do stream AQUI (o generator deixa de ser
      // drenado ⇒ a conexão fecha) e marca o motivo do corte. NÃO lança — o turno
      // parcial é válido (texto/tool-calls preservados).
      if (capped) {
        finishReason = STREAM_CAP_FINISH_REASON;
        break;
      }
    }

    return {
      request_id: requestId,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      content,
      finish_reason: finishReason,
      ...(usage !== undefined ? { usage } : {}),
      // EST-0996 — só inclui quando há tool-calls nativas (campo opcional). Vazio ⇒
      // ausente ⇒ o loop usa o parser de texto (#99) — ponto único, fallback limpo.
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(quota !== undefined ? { quota } : {}),
    };
  }

  /** Monta e dispara o POST. CLI-SEC-7: corpo SÓ com tier/messages — sem provider. */
  private async send(
    token: string,
    request: ModelCallRequest,
    signal: AbortSignal | undefined,
    stream: boolean,
    idempotencyKey?: string,
  ): Promise<StreamResponse> {
    const body = buildChatBody(request, stream);
    const headers: Record<string, string> = {
      // ÚNICA credencial: a headless de USUÁRIO (device JWT ou PAT). O broker
      // a introspecta p/ resolver ator+org (delta do broker — EST-0940/0943).
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    // Idempotency-Key (dono = loop, EST-0944): repassada quando o chamador a
    // fornece. Retry de rede com a MESMA key ⇒ broker deduplica o billing.
    if (idempotencyKey !== undefined) headers['idempotency-key'] = idempotencyKey;
    try {
      return await this.doFetch(`${this.baseUrl}${CHAT_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      if (isAbortError(err)) throw new ModelCallAbortedError();
      // Mensagem genérica — NUNCA o token/headers (CLI-SEC-10).
      throw new BrokerTransportError('falha de transporte ao chamar o broker.', err);
    }
  }

  /** Converte uma resposta de erro do broker em `BrokerError` (problem+json). */
  private async toBrokerError(res: StreamResponse): Promise<BrokerError> {
    let parsed: unknown = undefined;
    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }
    const problem = toProblemDetails(res.status, parsed);
    // `Retry-After` do header complementa o corpo quando o broker o usa (429/502).
    if (problem.retry_after === undefined) {
      const secs = parseRetryAfter(res.headers.get('retry-after'), Date.now());
      if (secs !== undefined) {
        return new BrokerError({ ...problem, retry_after: secs });
      }
    }
    return new BrokerError(problem);
  }
}

/**
 * Monta o corpo de `POST /v1/chat` (`broker.md` §1). CLI-SEC-7/HG-2: só
 * `tier`/`messages`/flags de transporte — NUNCA `provider`/`api_key`/`base_url`.
 * O `model` é a ÚNICA exceção sancionada (ADR-0030 §3): só entra sob
 * `tier:'custom'`, como chave de catálogo OU slug livre (warn-but-allow), JAMAIS
 * id-de-provedor com credencial — o broker o revalida e resolve a credencial
 * server-side (SEC-4/HG-1). Fora de `custom`, `model` NÃO sai (mesmo se presente
 * no request). Campos opcionais só entram quando definidos
 * (`exactOptionalPropertyTypes`).
 */
export function buildChatBody(request: ModelCallRequest, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    tier: request.tier,
    messages: request.messages.map(serializeMessage),
    stream,
  };
  if (request.session_id !== undefined) body.session_id = request.session_id;
  if (request.max_tokens !== undefined) body.max_tokens = request.max_tokens;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.context !== undefined) body.context = request.context;
  // EST-0996 — TOOL-CALLING NATIVO: o catálogo de funções só vai quando há tools a
  // mandar (o caller já decidiu pelo suporte do modelo — supports_tools/422). HG-2:
  // `tools` é o catálogo LOCAL de ferramentas (nome/descrição/JSONSchema do input),
  // NÃO credencial — ok mandar. `tool_choice`/`parallel_tool_calls` só acompanham
  // `tools` (sem tools, são inertes). Default de escolha: 'auto' (o modelo decide).
  if (request.tools !== undefined && request.tools.length > 0) {
    body.tools = request.tools;
    body.tool_choice = request.tool_choice ?? 'auto';
    if (request.parallel_tool_calls !== undefined) {
      body.parallel_tool_calls = request.parallel_tool_calls;
    }
  }
  // Via Custom (ADR-0030 §3): `model` SÓ acompanha `tier:'custom'`. A trava
  // dupla (`!== undefined` E `tier === 'custom'`) garante que nenhum `model`
  // vaze nos tiers canônicos — defesa contra um caller que setasse `model` por
  // engano fora da via Custom (HG-2 intocado nos tiers normais).
  // HUNT-CATALOG — o slug precisa ser NÃO-VAZIO após trim: um `model:''`/`'  '`
  // (vindo de um `--tier custom` nu, de um resume/pref legado, ou do texto-livre
  // do picker) NÃO é "modelo escolhido" — é AUSÊNCIA de slug. Mandá-lo como `''`
  // faria o broker rotear errado / 422 com um par `(custom,'')` ambíguo. DEGRADA
  // honesto: OMITE o campo (o broker recusa `tier:custom` sem model com erro claro,
  // em vez de receber um slug vazio que mascara a causa). O slug efetivo é o trim.
  const trimmedModel = request.model?.trim();
  const hasModel = trimmedModel !== undefined && trimmedModel !== '';
  if (hasModel && request.tier === 'custom') body.model = trimmedModel;
  // EST-0962 (`--provider`) — o NOME do provider acompanha o `model` da via Custom.
  // TRAVA TRIPLA: só sai com `tier === 'custom'` E `model` presente E `provider`
  // presente — nunca sozinho, nunca fora de Custom. É só o NOME (DADO, não credencial):
  // o broker resolve `(provider, model)` → credencial server-side (HG-2/CLI-SEC-7/
  // PROV-SEC-5). Sem a flag, o campo NÃO entra (retrocompat — o broker escolhe o provider).
  // HUNT-CATALOG — provider VAZIO (`''`/`'  '`) é ausência de provider, não escolha:
  // mandá-lo faria o broker tentar resolver `(provider:'', model)` → falha. OMITE (broker
  // escolhe o default do slug). Trim p/ o NOME canônico (sem espaços de borda).
  const trimmedProvider = request.provider?.trim();
  const hasProvider = trimmedProvider !== undefined && trimmedProvider !== '';
  if (hasProvider && hasModel && request.tier === 'custom') {
    body.provider = trimmedProvider;
  }
  // EST-0962 (--effort / /effort) — reasoning_effort PASSTHROUGH (qualquer string ≤32 chars).
  // SEM tier-gate: vale em qualquer tier. `undefined` ⇒ NÃO sai (o provider usa o default).
  // HUNT-CATALOG — effort VAZIO/só-espaços é AUSÊNCIA de valor (provider deve usar o
  // default), não um effort `''` literal: alguns providers rejeitam `reasoning_effort:''`.
  // OMITE quando vazio após trim; senão manda o valor trimado (NOME canônico do nível).
  const trimmedEffort = request.reasoning_effort?.trim();
  if (trimmedEffort !== undefined && trimmedEffort !== '') {
    body.reasoning_effort = trimmedEffort;
  }
  return body;
}

/**
 * EST-0996 — serializa UMA `ChatMessage` p/ o corpo do `/v1/chat`. Carrega
 * `tool_calls`/`tool_call_id` SÓ quando presentes (`exactOptionalPropertyTypes`):
 *  - turno `assistant` com `tool_calls`: o ECO das funções que o modelo pediu, no
 *    formato de função do provider (`{id, type:'function', function:{name, arguments}}`)
 *    — `arguments` é STRING JSON (o provider as quer assim). É o que pareia o
 *    `role:"tool"` seguinte.
 *  - turno `tool` com `tool_call_id`: a qual call este resultado responde. O
 *    `content` segue sendo o DADO já envelopado pelo context.ts (CLI-SEC-4).
 * Sem tool-calling (baseline), devolve `{role, content}` IDÊNTICO ao de antes.
 */
function serializeMessage(m: {
  role: string;
  content: string;
  tool_calls?: readonly NativeToolCall[];
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

/** Mapeia um evento SSE bruto do broker p/ o `ModelStreamEvent`. `error` lança. */
function mapSseEvent(event: string, data: string): ModelStreamEvent | null {
  const payload = safeJson(data);
  switch (event) {
    case 'start':
      return {
        type: 'start',
        request_id: str(payload, 'request_id') ?? '',
        ...(str(payload, 'session_id') !== undefined
          ? { session_id: str(payload, 'session_id') as string }
          : {}),
      };
    case 'delta': {
      const content = str(payload, 'content');
      return content !== undefined ? { type: 'delta', content } : null;
    }
    case 'tool_call': {
      // EST-0996 — `event: tool_call` AGREGADO: o payload é UMA call completa
      // (`{id, function:{name, arguments}}` ou já `{id, name, input}`). Parse
      // tolerante (boundary = não-confiável): call sem nome ⇒ ignorada (null).
      const call = parseNativeToolCall(payload);
      return call !== null ? { type: 'tool_call', call } : null;
    }
    case 'usage':
      return { type: 'usage', usage: toUsage(payload) };
    case 'done':
      return { type: 'done', finish_reason: str(payload, 'finish_reason') ?? 'stop' };
    case 'error':
      // `event: error` carrega o envelope problem+json (`broker.md` §1.2) — vira
      // erro estruturado LANÇADO (CA-5), encerrando o stream.
      throw new BrokerError(toProblemDetails(num(payload, 'status') ?? 502, payload));
    default:
      // Evento desconhecido (heartbeat/extensão futura): ignora, não quebra.
      return null;
  }
}

function toUsage(payload: unknown): ModelUsage {
  const out: { -readonly [K in keyof ModelUsage]: ModelUsage[K] } = {
    request_id: str(payload, 'request_id') ?? '',
    tier: str(payload, 'tier') ?? '',
  };
  const provider = str(payload, 'provider');
  if (provider !== undefined) out.provider = provider;
  const model = str(payload, 'model');
  if (model !== undefined) out.model = model;
  const tokensIn = num(payload, 'tokens_in');
  if (tokensIn !== undefined) out.tokens_in = tokensIn;
  const tokensOut = num(payload, 'tokens_out');
  if (tokensOut !== undefined) out.tokens_out = tokensOut;
  const cost = str(payload, 'cost');
  if (cost !== undefined) out.cost = cost;
  const priceVersion = str(payload, 'price_version');
  if (priceVersion !== undefined) out.price_version = priceVersion;
  const partial = bool(payload, 'partial');
  if (partial !== undefined) out.partial = partial;
  const balanceAfter = str(payload, 'balance_after');
  if (balanceAfter !== undefined) out.balance_after = balanceAfter;
  return out;
}

/**
 * EST-0996 — parseia UMA tool-call NATIVA do boundary (rede = não-confiável) num
 * `NativeToolCall` achatado `{id, name, input}`. Tolera os TRÊS shapes que
 * aparecem na vida real (ordem de precedência: input-objeto > function.arguments >
 * arguments-no-topo):
 *  - achatado normalizado: `{ id, name, input:{...} }` (caso o broker já normalize).
 *  - OpenAI/provider aninhado: `{ id, type:'function', function:{ name, arguments } }`,
 *    onde `arguments` é uma STRING JSON (o padrão do provider).
 *  - **achatado do broker (o shape REAL do `event: tool_call`)**:
 *    `{ id, name, arguments:"<json-string>", index }` — `arguments` STRING JSON no
 *    TOPO (NÃO dentro de `function`). Este era o caso que furava: o `input` ficava
 *    `{}` e a tool rodava sem args.
 * Em qualquer caso `arguments` STRING inválida ⇒ `input` vira `{}` (não lança — a
 * tool depois valida o seu input). `index`, quando presente, é ignorado (a ordem já
 * vem da sequência dos eventos).
 * Sem `name` (string não-vazia) ⇒ `null` (call inútil; o chamador a descarta). O
 * `id` ausente vira `''` — o loop ainda parea (best-effort), mas o broker deve mandá-lo.
 */
export function parseNativeToolCall(raw: unknown): NativeToolCall | null {
  if (!isRecord(raw)) return null;
  const fn = isRecord(raw.function) ? raw.function : undefined;
  const name = (typeof raw.name === 'string' ? raw.name : undefined) ?? str(fn, 'name');
  if (name === undefined || name.length === 0) return null;
  const id = str(raw, 'id') ?? '';
  let input: Record<string, unknown> = {};
  if (isRecord(raw.input)) {
    // 1) achatado normalizado: `input` já é um objeto.
    input = raw.input as Record<string, unknown>;
  } else if (fn !== undefined && fn.arguments !== undefined) {
    // 2) OpenAI aninhado: `function.arguments` (objeto OU string JSON).
    input = coerceArgs(fn.arguments);
  } else if (raw.arguments !== undefined) {
    // 3) achatado do broker: `arguments` no TOPO (objeto OU string JSON). Era o
    //    shape REAL do `event: tool_call` que ninguém tratava ⇒ input vazio.
    input = coerceArgs(raw.arguments);
  }
  return { id, name, input };
}

/**
 * EST-0996 — normaliza um campo `arguments` (de `function.arguments` ou do topo)
 * num objeto de input. Objeto ⇒ usado direto; STRING JSON válida de objeto ⇒
 * parseada; qualquer outra coisa (string inválida/vazia, número, array) ⇒ `{}`.
 */
function coerceArgs(args: unknown): Record<string, unknown> {
  if (isRecord(args)) return args as Record<string, unknown>;
  if (typeof args === 'string' && args.trim() !== '') {
    const parsed = safeJson(args);
    if (isRecord(parsed)) return parsed as Record<string, unknown>;
  }
  return {};
}

/**
 * EST-0996 — extrai o array `tool_calls` de um corpo de resposta NÃO-stream do
 * broker (`{ ..., tool_calls:[...] }` ou `{ message:{ tool_calls:[...] } }`,
 * estilo OpenAI). Saneia cada entrada via `parseNativeToolCall` (descarta lixo).
 * Devolve `[]` quando não há nada — o caller então cai no parser de texto.
 */
export function parseToolCalls(body: unknown): readonly NativeToolCall[] {
  if (!isRecord(body)) return [];
  const direct = body.tool_calls;
  const nested =
    isRecord(body.message) && Array.isArray(body.message.tool_calls)
      ? body.message.tool_calls
      : undefined;
  const arr = Array.isArray(direct) ? direct : nested;
  if (!Array.isArray(arr)) return [];
  const out: NativeToolCall[] = [];
  for (const item of arr) {
    const call = parseNativeToolCall(item);
    if (call !== null) out.push(call);
  }
  return out;
}

/**
 * HUNT-SSE — ACUMULA uma tool-call NATIVA do stream COALESCENDO por `id`.
 *
 * O broker DEVERIA aprumar (aggregate) os deltas de `function.arguments` num único
 * `event: tool_call` por call (ADR-0071). Mas o cliente é o BOUNDARY: um provider
 * que vaze fragmentos pelo broker (nome num frame, args noutro — ambos com o MESMO
 * `id`) faria o acumulador EMPILHAR DUAS `NativeToolCall` com o mesmo `id`. O loop
 * então ECOA dois `tool_calls` de id duplicado e gera dois `role:"tool"` com o
 * MESMO `tool_call_id` — e provedores OpenAI-compat REJEITAM (400) histórico com
 * `tool_call_id` repetido, quebrando o turno / o `[c] continuar` / o resume.
 *
 * Aqui COALESCEMOS por `id` (não-vazio): um 2º frame do mesmo `id` ATUALIZA a
 * entrada existente IN-PLACE — o `name` não-vazio mais recente vence; o `input` é
 * fundido (chaves do frame novo sobrescrevem; um `{}` de um frame "só-nome" NÃO
 * apaga args já vistos). `id` vazio (broker não mandou handle) NÃO pode parear ⇒
 * sempre empilha (best-effort, igual ao baseline). Preserva a ORDEM de 1ª aparição.
 * Sem fragmentos (caso normal — 1 frame por call), o comportamento é IDÊNTICO ao
 * `push` simples (cada `id` aparece 1×).
 */
export function pushOrMergeToolCall(acc: NativeToolCall[], call: NativeToolCall): void {
  if (call.id !== '') {
    const existing = acc.find((c) => c.id === call.id);
    if (existing !== undefined) {
      const idx = acc.indexOf(existing);
      acc[idx] = {
        id: existing.id,
        // `name` não-vazio mais recente vence (um frame só-args pode vir sem nome,
        // já filtrado por `parseNativeToolCall`, mas defendemos mesmo assim).
        name: call.name.length > 0 ? call.name : existing.name,
        // Funde os inputs: o frame novo sobrescreve chave a chave. Um frame
        // "só-nome" traz `{}` ⇒ não apaga os args já acumulados.
        input: { ...existing.input, ...call.input },
      };
      return;
    }
  }
  acc.push(call);
}

/**
 * HUNT-IO-NET — parseia o header `Retry-After` (RFC 7231 §7.1.3): pode ser
 * `delta-seconds` (`"7"`) OU um `HTTP-date` (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * O código antigo só fazia `Number(header)` ⇒ a forma DATA virava `NaN` e o hint
 * de backoff do servidor era SILENCIOSAMENTE PERDIDO (caía no exponencial). CDNs/
 * proxies na frente do broker usam a forma data com frequência (429/503). Agora
 * tratamos as duas: número ⇒ direto; data ⇒ `(data - agora)/1000`, piso 0. Lixo/
 * ausente/data no passado ⇒ `undefined` (o caller cai no exponencial). Exportada p/ teste.
 */
export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (trimmed === '') return undefined;
  // delta-seconds: dígitos puros (a forma mais comum).
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : undefined;
  }
  // HTTP-date: Date.parse devolve epoch-ms (ou NaN). Converte p/ segundos no futuro.
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return undefined;
  const deltaSec = Math.round((dateMs - nowMs) / 1000);
  return deltaSec >= 0 ? deltaSec : 0; // data no passado ⇒ 0 (retry já liberado).
}

// ── helpers de boundary (rede = unknown; narrowing sem `any`) ────────────────
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
function isRecord(v: unknown): v is Record<string, unknown> {
  // `typeof [] === 'object'` ⇒ um ARRAY passaria e seria castado a Record (input
  // malformado entrando sem normalização — `arguments:[]` ⇒ `{}` esperado, não `[]`).
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
function bool(v: unknown, key: string): boolean | undefined {
  if (!isRecord(v)) return undefined;
  const val = v[key];
  return typeof val === 'boolean' ? val : undefined;
}

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

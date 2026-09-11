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
import { MAX_TRAILER_EVENTS } from './adapter.js';
import type { ProviderAdapter, BuiltRequest, SseAccumulator } from './adapter.js';
import type { LocalRequest, ResolvedCredential, LocalProviderKind, ContentPart } from './types.js';
import { lerUsoDeCache } from './cache-usage.js';
import { systemOpenAiComCache } from './cache-breakpoint.js';

/**
 * É o OpenRouter? Pelo ID do catálogo OU pela baseURL.
 *
 * Os dois porque o dono já rodou um provider CUSTOM (`tokenrouter`) apontando para um
 * agregador: gate só por id perderia esse caso, e é justamente quem tem provider custom que
 * fica sem o número sem entender por quê. A baseURL é o que de fato decide quem atende.
 */
/**
 * Um identificador OPACO de sessão, gerado uma vez por adaptador.
 *
 * O adaptador é construído uma vez por sessão (`buildLocalModelClient`), então a vida dele é
 * exatamente o escopo que o roteamento pegajoso precisa.
 *
 * PRIVACIDADE: aleatório, não carrega nada — nem caminho, nem usuário, nem máquina. O
 * agregador já correlaciona requisições pela credencial; isto não conta nada novo sobre quem
 * está do lado de cá.
 */
function novoIdDeSessao(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof c?.randomUUID === 'function') return `aluy-${c.randomUUID()}`;
  // Sem `crypto` (runtime exótico): um id fraco ainda serve — ele não protege nada, só
  // AGRUPA. O que não pode é ficar sem id e perder o cache.
  return `aluy-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function ehOpenRouter(provider: string, baseUrl: string): boolean {
  if (provider === 'openrouter') return true;
  try {
    return new URL(baseUrl).hostname.toLowerCase().endsWith('openrouter.ai');
  } catch {
    return false;
  }
}

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
  /**
   * ROTEAMENTO PEGAJOSO — o achado que explica "o cache não pega" no OpenRouter.
   *
   * Ele roteia cada requisição para um provedor UPSTREAM, e cada upstream tem o PRÓPRIO
   * cache. Sem fixar a sessão, o turno 2 pode cair num endpoint diferente do turno 1 e o
   * cache nunca acerta — por mais que o `cache_control` esteja perfeito e o prefixo seja
   * byte-idêntico (os dois estão; eu medi). A doc é explícita: sem `session_id` a fixação só
   * liga DEPOIS de detectar um acerto, que é o ovo e a galinha.
   *
   * Uma vez por adaptador = uma vez por sessão, que é o escopo certo: trocar de provider
   * reconstrói o client e gera outro, e aí o cache anterior não valia mesmo.
   */
  private readonly sessionId = novoIdDeSessao();

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
      // CACHE DE PROMPT — o `content` vira array de partes SÓ quando há o que ganhar (ver
      // `cache-breakpoint.ts`). Quem não conhece `cache_control` ignora o campo extra; quem
      // conhece (OpenRouter repassando p/ Anthropic/Gemini) passa a cachear o system, que
      // hoje era reprocessado inteiro a cada turno.
      messages.push({
        role: 'system',
        content: systemOpenAiComCache(request.system, request.model),
      });
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
    // CONTABILIDADE DETALHADA do OpenRouter — sem isto o trailer vem SÓ com os dois totais,
    // e o `prompt_tokens_details.cached_tokens` (de onde sai o `% cache` do rodapé) nunca
    // chega. O dono reportou exatamente isso em 10/09: "no windows não está aparecendo o
    // cache", já na rc.177 (a versão em que a exibição funciona) e falando com o OpenRouter.
    //
    // GUARDADO ao provider, como os headers de atribuição logo abaixo: campo desconhecido no
    // corpo é ignorado pela maioria dos compatíveis, mas alguns respondem 400 — e uma troca
    // de provider não pode virar erro de requisição por causa de um extra de observabilidade.
    if (ehOpenRouter(this.provider, base)) {
      // Ver `sessionId`: sem isto o cache pode nunca acertar, porque cada turno pode cair
      // num upstream diferente — cada um com o próprio cache.
      body.session_id = this.sessionId;
      // A doc diz que os campos de cache vêm automaticamente, então isto é REDUNDANTE hoje.
      // Mantido porque é barato, é ignorado quando redundante, e cobre o caso de a
      // contabilidade detalhada voltar a ser opt-in.
      body.usage = { include: true };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    // reasoning_effort: passthrough (o3/gpt-5 e openrouter aceitam; demais ignoram).
    if (request.reasoningEffort !== undefined && request.reasoningEffort !== '') {
      body.reasoning_effort = request.reasoningEffort;
    }
    // FRAGMENTO CRU do dono (ex.: `provider: { only: ["gmicloud"] }` no OpenRouter).
    // Mesclado por ÚLTIMO de propósito: o dono manda mais que o default. Mas NUNCA
    // sobrescreve `messages`/`model`/`stream` — quem mexe nesses três quebra o protocolo,
    // não configura roteamento, e o erro apareceria longe daqui.
    if (request.extraBody !== undefined) {
      for (const [k, v] of Object.entries(request.extraBody)) {
        if (k === 'messages' || k === 'model' || k === 'stream') continue;
        body[k] = v;
      }
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools; // já no shape de função OpenAI.
      body.tool_choice = request.toolChoice ?? 'auto';
    }

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    };
    // auth `none` (ex.: Ollama local) ⇒ SEM header de Authorization. Só manda o Bearer
    // quando há segredo de fato (apikey/oauth) — o Ollama no loopback rejeitaria/ignoraria
    // um `Bearer undefined`, e mandar header vazio é ruído.
    if (credential.kind !== 'none' && credential.secret !== '') {
      headers.authorization = `Bearer ${credential.secret}`;
    }
    if (this.provider === 'openrouter') {
      headers['http-referer'] = ATTRIBUTION_URL;
      headers['x-title'] = ATTRIBUTION_TITLE;
    }
    return { url, headers, body: JSON.stringify(body) };
  }

  mapSse(_event: string, data: string, acc: SseAccumulator): readonly ModelStreamEvent[] {
    const trimmed = data.trim();
    if (trimmed === '') return [];
    // BUG-TRAILER — enquanto o `done` está ADIADO, conta os eventos do trailer (teto
    // anti-hang). Vale p/ QUALQUER data não-vazio, inclusive o `[DONE]` logo abaixo.
    if (acc.pendingFinish !== undefined && !acc.emittedDone) acc.afterFinish += 1;
    // Sentinela de fim do estilo OpenAI: é AQUI que o `done` adiado finalmente sai —
    // depois, portanto, do chunk-trailer de `usage` (que vem entre o `finish_reason`
    // e o `[DONE]`). Sem turno pendente, mantém o comportamento antigo (só o flush).
    if (trimmed === '[DONE]') return [...this.flush(acc), ...this.closeTurn(acc)];

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
      // F-RAC — RACIOCÍNIO. Dois nomes, porque não há padrão: `reasoning_content` é a
      // convenção da DeepSeek (e a que os relays repassam quando servem o upstream
      // nativo) e `reasoning` é como o OpenRouter a normaliza. Aceitamos os dois e
      // NÃO inventamos um terceiro. Medido num `deepseek-v4-pro` servido por relay:
      // 18 chunks com `content: null` + `reasoning_content` preenchido, e só o
      // ÚLTIMO trazendo o `content` de verdade — quem lê só `content` fica cego pelo
      // turno inteiro. Vai num evento PRÓPRIO: pensamento não é fala.
      const reasoning =
        delta !== undefined
          ? (str(delta, 'reasoning_content') ?? str(delta, 'reasoning'))
          : undefined;
      if (reasoning !== undefined && reasoning !== '') {
        out.push({ type: 'reasoning', content: reasoning });
      }
      if (delta !== undefined && Array.isArray(delta.tool_calls)) {
        accumulateToolCalls(acc, delta.tool_calls);
      }
      const finish = str(choice, 'finish_reason');
      if (finish !== undefined && finish !== null && finish !== '') {
        // antes do done, emite as tool-calls acumuladas (se houver).
        out.push(...this.flush(acc));
        // BUG-TRAILER (a raiz do "0 tokens") — o `done` NÃO sai mais aqui. No estilo
        // OpenAI com `stream_options:{include_usage:true}`, o `usage` REAL vem num
        // chunk SEPARADO (`choices: []`) DEPOIS deste; como o `LocalModelClient`
        // encerra o generator no `done` (fecha o socket), emitir `done` agora fazia o
        // trailer NUNCA ser lido ⇒ `ModelCallResult.usage` undefined ⇒ `budget`,
        // `applyUsage` do pai e `SubAgentOutcome.usage.tokens` todos ZERADOS. Agora só
        // ANOTAMOS o motivo; o `done` sai no `[DONE]`/teto/`finalize`.
        acc.pendingFinish = finish;
        acc.afterFinish = 0;
      }
    }
    // `usage` pode chegar no MESMO chunk do done (include_usage) ou num chunk só.
    if (isRecord(payload.usage)) {
      out.unshift({ type: 'usage', usage: this.toUsage(payload.usage, payload) });
    }
    // BUG-TRAILER (anti-hang) — o provider excedeu o teto de eventos pós-`finish_reason`
    // sem mandar `[DONE]`: fecha o turno à força, com o `finish_reason` REAL anotado.
    if (acc.pendingFinish !== undefined && acc.afterFinish >= MAX_TRAILER_EVENTS) {
      out.push(...this.closeTurn(acc));
    }
    return out;
  }

  /**
   * BUG-TRAILER — REDE de fechamento: o corpo do SSE acabou (provider fechou a
   * conexão) sem `[DONE]`. Emite o que ficou pendente (tool-calls + o `done` com o
   * `finish_reason` REAL). Idempotente via `acc.emittedDone`.
   */
  finalize(acc: SseAccumulator): readonly ModelStreamEvent[] {
    return [...this.flush(acc), ...this.closeTurn(acc)];
  }

  /**
   * Emite o `done` ADIADO — UMA vez por turno (`acc.emittedDone`). Sem
   * `pendingFinish` (o provider nunca mandou `finish_reason`) o turno fecha como
   * `'stop'`, que é o default histórico do `LocalModelClient`/`StreamingModelCaller`.
   */
  private closeTurn(acc: SseAccumulator): readonly ModelStreamEvent[] {
    if (acc.emittedDone) return [];
    acc.emittedDone = true;
    return [{ type: 'done', finish_reason: acc.pendingFinish ?? 'stop' }];
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
    // CACHE DE PROMPT — até 10/09/2026 este trailer era lido pela metade: pegávamos os dois
    // totais e descartávamos quanto do prompt veio do cache. Nos providers de cache
    // IMPLÍCITO isso já vinha acontecendo e sendo cobrado mais barato, sem ninguém ver.
    const cache = lerUsoDeCache(raw);
    if (cache.lidos !== undefined) out.tokens_cached = cache.lidos;
    if (cache.gravados !== undefined) out.tokens_cache_write = cache.gravados;
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

/**
 * ADR-0159 — serializa `ContentPart[]` pro shape de conteúdo MULTIMODAL da OpenAI
 * (vision): array de blocos, `{type:'text', text}` e `{type:'image_url',
 * image_url:{url:'data:<mime>;base64,<...>'}}` — o formato "data URL" que a
 * OpenAI/OpenRouter aceitam inline (sem precisar de upload prévio).
 */
function serializeContentParts(parts: readonly ContentPart[]): Record<string, unknown>[] {
  return parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.base64}` } },
  );
}

/** Serializa UMA mensagem portável p/ o shape OpenAI (tool_calls/tool_call_id). */
function serializeMessage(m: {
  role: string;
  content: string | readonly ContentPart[];
  tool_calls?: readonly { id: string; name: string; input: Record<string, unknown> }[];
  tool_call_id?: string;
}): Record<string, unknown> {
  // ADR-0159 — string SEGUE IDÊNTICA a antes (compatibilidade retroativa); só o
  // ramo `ContentPart[]` é novo.
  const content = typeof m.content === 'string' ? m.content : serializeContentParts(m.content);
  const out: Record<string, unknown> = { role: m.role, content };
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

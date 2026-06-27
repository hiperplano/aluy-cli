// EST-1015 (POC — pedido do dono: "execute o retrieve tool") — o LADO RETRIEVE do
// CCR (Compress-Cache-Retrieve) do headroom. PAR do `compressViaHeadroom`:
//
//   • COMPRESS (headroom.ts) é LOSSY — dedupa/trunca observações de tool verbosas e
//     deixa um MARCADOR no lugar: `[N items compressed … hash=abc123]`.
//   • RETRIEVE (aqui) é como o modelo RECUPERA o conteúdo original: ao ver o
//     marcador e precisar do todo, ele chama a tool `headroom_retrieve` com o `hash`
//     (e, opcional, uma `query` p/ uma busca BM25 dentro do conteúdo cacheado). Sem
//     esta tool, o compress degradava a correção (o conteúdo dedupado sumia). É ELA
//     que torna a compressão REVERSÍVEL — o ponto inteiro do CCR.
//
// Endpoint (público do proxy headroom — `headroom proxy --port 8787`):
//   POST {baseUrl}/v1/retrieve
//     req:  { "hash": "<hash>", "query"?: "<busca opcional>" }
//     res:  { "original_content": "…", "original_tokens": <n>, "tool_name": "…" }
//   404 ⇒ conteúdo EXPIROU (TTL do cache passou OU o proxy reiniciou) ⇒ o modelo
//        deve RErodar o comando original p/ regerar — não há o que recuperar.
//
// ⚠️ EXPERIMENTAL — OFF por default. Só é REGISTRADA quando `ALUY_HEADROOM_URL`
//    aponta p/ o proxy local do usuário (mesma flag que liga o compress). NÃO toca o
//    broker: é HTTP direto ao proxy LOCAL (loopback) que o usuário roda.
//
// EFEITO = `network` (egress): PASSA pela catraca como `always-ask:network` (gate
//    coerente com `web_fetch`/`curl` — Plan-deny, não-relaxável, só `--unsafe` passa).
//    Ver `classifyAlwaysAsk` em cli-core/permission/categories.ts.
//
// FALHA: ao contrário do compress (fail-OPEN, silencioso — devolve o original), o
//    retrieve é INICIADO PELO MODELO e não tem fallback (o conteúdo só existe no
//    cache do proxy). Erro/timeout/404 ⇒ `ok:false` com observação CLARA — o modelo
//    TRATA o erro (CLI-SEC-4: a observação é DADO, não ordem), nunca lança o turno.

import type { NativeTool, ToolResult, HostResolver } from '@aluy/cli-core';
import { wrapUntrusted } from '@aluy/cli-core';
import { headroomFetch } from './headroom-fetch.js';

export interface HeadroomRetrieveToolOptions {
  /** Base URL do proxy headroom (ex.: `http://127.0.0.1:8787`). */
  readonly baseUrl: string;
  /** `fetch` injetável (teste). Default `globalThis.fetch`. */
  readonly fetchFn?: typeof fetch;
  /** EST-1075 — resolver de host injetável (teste). Default `NodeHostResolver`. */
  readonly resolver?: HostResolver;
  /** F85 — teto DURO de tempo (ms). Default `RETRIEVE_TIMEOUT_MS` (2.5s). */
  readonly timeoutMs?: number;
}

interface RetrieveResponse {
  readonly original_content?: unknown;
  readonly original_tokens?: unknown;
  readonly tool_name?: unknown;
}

/** Schema do input — FONTE ÚNICA p/ o nativo (function-calling) e o fallback texto. */
/**
 * F85 — teto DURO do retrieve (ms). Como o compress (F84), um proxy PENDURADO não
 * lança; sem teto, a tool-call estala o loop (o loop NÃO tem timeout universal de
 * tool — cada tool se cerca). Estourado ⇒ `ok:false` (a observação já existente).
 */
const RETRIEVE_TIMEOUT_MS = 2_500;

const RETRIEVE_PARAMETERS = {
  type: 'object',
  properties: {
    hash: {
      type: 'string',
      description: 'O hash do marcador de compressão (ex.: `[… hash=abc123]`). Obrigatório.',
    },
    query: {
      type: 'string',
      description:
        'Opcional: busca BM25 DENTRO do conteúdo cacheado — recorta resultados grandes p/ só o trecho relevante.',
    },
  },
  required: ['hash'],
  additionalProperties: false,
} as const;

const DESCRIPTION =
  'Recupera o conteúdo ORIGINAL que a compressão headroom dedupou/truncou. ' +
  'Quando uma observação de tool trouxer um marcador como `[N items compressed … hash=abc123]` ' +
  'e você precisar do conteúdo completo, chame com `{hash:"abc123"}`. ' +
  'Passe `query` p/ buscar (BM25) só o trecho relevante dentro de um cache grande.';

/** `hash` não-vazio (string). Best-effort: aceita o que o proxy depois valida. */
function readHash(input: Readonly<Record<string, unknown>>): string | undefined {
  const h = input.hash;
  return typeof h === 'string' && h.trim() !== '' ? h.trim() : undefined;
}

function readQuery(input: Readonly<Record<string, unknown>>): string | undefined {
  const q = input.query;
  return typeof q === 'string' && q.trim() !== '' ? q.trim() : undefined;
}

/**
 * Constrói a tool `headroom_retrieve` ligada ao proxy `baseUrl`. PURA quanto à
 * config (fecha sobre `baseUrl`/`fetchFn`); o `run` faz o HTTP ao proxy LOCAL.
 */
export function makeHeadroomRetrieveTool(opts: HeadroomRetrieveToolOptions): NativeTool {
  const fetchDeps = {
    ...(opts.resolver ? { resolver: opts.resolver } : {}),
    ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}),
  };
  // EST-1075 · HR-SEC-4 / CLI-SEC-9 — a confirmação da catraca tem de mostrar o DESTINO
  // EXATO do egress (não só o hash). Pré-computa o endpoint `…/v1/retrieve` p/ o `display`.
  const endpoint = `${opts.baseUrl.replace(/\/+$/, '')}/v1/retrieve`;

  return {
    name: 'headroom_retrieve',
    effect: 'network',
    description: DESCRIPTION,
    parameters: RETRIEVE_PARAMETERS,
    async run(input, _ports, ctx): Promise<ToolResult> {
      const hash = readHash(input);
      if (hash === undefined) {
        return {
          ok: false,
          observation:
            'headroom_retrieve: `hash` é obrigatório (copie o valor do marcador `… hash=…`).',
        };
      }
      const query = readQuery(input);
      // HR-SEC-4 / CLI-SEC-9 — mostra o destino EXATO (`POST <endpoint>`) + o hash/query.
      const display = `headroom_retrieve POST ${endpoint} hash=${hash}${query ? ` query=${JSON.stringify(query)}` : ''}`;
      // F85 — teto DURO de tempo (anti-hang): AbortController interno que dispara no
      // teto E encaminha o abort externo (ESC). Abortado ⇒ headroomFetch lança ⇒ catch
      // ⇒ ok:false (recuperável, NUNCA estala a loop nem derruba o turno).
      const ac = new AbortController();
      let timedOut = false;
      const timeoutMs = opts.timeoutMs ?? RETRIEVE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        ac.abort();
      }, timeoutMs);
      const onExternalAbort = (): void => ac.abort();
      ctx?.signal?.addEventListener('abort', onExternalAbort, { once: true });
      if (ctx?.signal?.aborted) ac.abort();
      try {
        // EST-1075 · HR-SEC-1 — valida (loopback-only) + pina ANTES de qualquer byte sair.
        const outcome = await headroomFetch(
          opts.baseUrl,
          '/v1/retrieve',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(query !== undefined ? { hash, query } : { hash }),
            signal: ac.signal,
          },
          fetchDeps,
        );
        if (!outcome.ok) {
          return {
            ok: false,
            display,
            observation: `headroom_retrieve: destino recusado (${outcome.reason}).`,
          };
        }
        const res = outcome.response;
        if (res.status === 404) {
          return {
            ok: false,
            display,
            observation:
              `headroom_retrieve: conteúdo do hash "${hash}" EXPIROU (TTL do cache ou ` +
              'reinício do proxy). Não há o que recuperar — RErode o comando/tool original p/ regerar.',
          };
        }
        if (!res.ok) {
          return {
            ok: false,
            display,
            observation: `headroom_retrieve: o proxy respondeu HTTP ${res.status}.`,
          };
        }
        const data = (await res.json()) as RetrieveResponse;
        const content = data.original_content;
        if (typeof content !== 'string' || content === '') {
          return {
            ok: false,
            display,
            observation: 'headroom_retrieve: resposta sem `original_content` utilizável.',
          };
        }
        const tokens = typeof data.original_tokens === 'number' ? data.original_tokens : undefined;
        const tool = typeof data.tool_name === 'string' ? data.tool_name : undefined;
        const header =
          `[headroom_retrieve · hash=${hash}` +
          `${tool ? ` · tool=${tool}` : ''}${tokens !== undefined ? ` · ${tokens} tokens` : ''}]`;
        // HR-SEC-3 (paridade c/ compress/recall) — `content` vem do PROXY (DADO
        // NÃO-CONFIÁVEL, CLI-SEC-4): ENVELOPA, como o compress e o recall fazem.
        // O `buildMessages` já envelopa toda observação ao virar `tool`/`user`, mas
        // a convenção do projeto é DUPLO-ENVELOPE p/ conteúdo de proxy/memória — o
        // bloco fica inequívoco mesmo INSPECIONADO ISOLADO (journal/log/export). O
        // header (metadados gerados pelo aluy) fica fora, legível.
        return { ok: true, display, observation: `${header}\n${wrapUntrusted(content)}` };
      } catch (err) {
        const reason = timedOut
          ? `o proxy não respondeu em ${timeoutMs}ms (timeout)`
          : err instanceof Error
            ? err.message
            : String(err);
        return {
          ok: false,
          display,
          observation: `headroom_retrieve: falha ao falar com o proxy (${reason}).`,
        };
      } finally {
        clearTimeout(timer);
        ctx?.signal?.removeEventListener('abort', onExternalAbort);
      }
    },
  };
}

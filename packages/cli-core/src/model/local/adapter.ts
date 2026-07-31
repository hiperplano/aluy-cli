// ADR-0120 / EST-1113 — o CONTRATO de um adapter de provider local (PORTÁVEL).
//
// Um adapter traduz o `LocalRequest` PORTÁVEL p/ o shape NATIVO de UM provider
// (corpo HTTP + headers + path) e mapeia o SSE do provider de volta p/ o
// `ModelStreamEvent` que o loop já consome. É a mesma normalização que o broker
// faz server-side (`aluy-broker/src/openrouter.py`/`providers.py` = referência de
// DESIGN), mas client-side. SEM I/O: o adapter só monta dados e parseia strings;
// o `LocalModelClient` faz o fetch/stream com estes dados.

import type { ModelStreamEvent } from '../types.js';
import type { LocalRequest, ResolvedCredential } from './types.js';

/** O que o adapter produz p/ o `LocalModelClient` disparar UMA requisição. */
export interface BuiltRequest {
  /** URL completa do endpoint (base_url + path). */
  readonly url: string;
  /** Headers (inclui auth — montada a partir da credencial resolvida). */
  readonly headers: Record<string, string>;
  /** Corpo JÁ serializado (JSON string). */
  readonly body: string;
}

/**
 * Um adapter de provider. `defaultBaseUrl` é o endpoint público fixo (usado quando
 * a config não dá override). `buildRequest` monta a requisição; `mapSse` traduz UM
 * evento SSE bruto (event-name + data) num `ModelStreamEvent` (ou `null` p/ ignorar).
 *
 * O `mapSse` recebe um `SseAccumulator` MUTÁVEL p/ os providers (OpenAI) que
 * fragmentam `tool_calls.function.arguments` por delta — o adapter acumula e emite
 * a call completa no fim do bloco. Mantém o adapter como ÚNICO dono do protocolo SSE
 * do seu provider.
 */
export interface ProviderAdapter {
  readonly kind: string;
  readonly defaultBaseUrl: string;
  /** `true` se o provider tem `base_url` configurável (⇒ anti-SSRF do override). */
  readonly allowsBaseUrlOverride: boolean;
  buildRequest(args: {
    readonly request: LocalRequest;
    readonly baseUrl: string;
    readonly credential: ResolvedCredential;
  }): BuiltRequest;
  /**
   * Mapeia UM evento SSE bruto. `event` é o nome do evento SSE (pode ser '' p/ o
   * estilo OpenAI que só usa `data:`). Retorna os `ModelStreamEvent` a emitir (0+).
   * Estado entre eventos (acumulação de tool-call) vive no `acc` mutável.
   */
  mapSse(event: string, data: string, acc: SseAccumulator): readonly ModelStreamEvent[];
  /**
   * BUG-TRAILER (contabilidade BYO) — eventos de FECHAMENTO quando o corpo do SSE
   * ACABOU sem que um `done` tenha sido emitido. Existe porque o `done` do estilo
   * OpenAI passou a ser ADIADO (ver `openai-adapter.mapSse`): o `usage` real chega
   * num chunk TRAILER **depois** do chunk que traz o `finish_reason`, então emitir
   * `done` na hora do `finish_reason` fazia o `LocalModelClient` encerrar o stream
   * ANTES do trailer — e a sessão inteira (pai E sub-agentes) contabilizava 0 token.
   *
   * Com o adiamento, o `done` sai no sentinela `[DONE]`. Um provider que feche a
   * conexão SEM mandar `[DONE]` deixaria o turno sem `done` (e sem o
   * `finish_reason` REAL, que o loop usa p/ distinguir `tool_calls`/`length`); este
   * gancho é a REDE: o client o chama no fim do corpo e o adapter emite o que ficou
   * pendente. OPCIONAL — adapter que já emite `done` no próprio evento de fim (o
   * Anthropic, em `message_delta`) não precisa implementá-lo.
   */
  finalize?(acc: SseAccumulator): readonly ModelStreamEvent[];
}

/**
 * Estado mutável que o adapter mantém ENTRE eventos SSE de UMA resposta — usado p/
 * acumular tool-calls fragmentadas (OpenAI/openrouter mandam `function.arguments`
 * em pedaços por `index`). O `LocalModelClient` cria um por chamada e o passa a cada
 * `mapSse`; ao final (done) o adapter emite as calls completas.
 */
export interface SseAccumulator {
  /** tool-calls em construção, por `index` (chave do delta OpenAI). */
  readonly toolCalls: Map<number, { id: string; name: string; argsText: string }>;
  /** já emitimos as tool-calls finais? (idempotência no done). */
  emittedToolCalls: boolean;
  /**
   * BUG-TRAILER — `finish_reason` JÁ VISTO mas com o `done` ADIADO (esperando o
   * chunk-trailer de `usage` + o sentinela `[DONE]`). `undefined` ⇒ o turno ainda
   * não fechou. Guardamos o valor REAL (`stop`/`tool_calls`/`length`) p/ que o
   * `done` adiado saia com ele — nunca com um `'stop'` inventado.
   */
  pendingFinish?: string;
  /** BUG-TRAILER — já emitimos o `done` deste turno? (idempotência `[DONE]`×finalize). */
  emittedDone: boolean;
  /**
   * BUG-TRAILER (anti-hang) — quantos eventos SSE já chegaram DEPOIS do
   * `finish_reason`. É o teto do adiamento: o trailer real são 1-2 eventos
   * (`usage` + `[DONE]`); passar de {@link MAX_TRAILER_EVENTS} significa que o
   * provider não vai fechar o turno, e o `done` sai à força (não penduramos o
   * usuário esperando um sentinela que nunca vem).
   */
  afterFinish: number;
}

/**
 * BUG-TRAILER (anti-hang) — teto de eventos SSE tolerados DEPOIS do `finish_reason`
 * antes de o `done` sair à força. O trailer legítimo do estilo OpenAI é curto
 * (chunk de `usage` + `[DONE]`); 8 dá folga p/ `ping`/keep-alive no meio sem nunca
 * virar espera indefinida.
 */
export const MAX_TRAILER_EVENTS = 8;

/** Cria um acumulador SSE vazio (1 por chamada). */
export function newSseAccumulator(): SseAccumulator {
  return { toolCalls: new Map(), emittedToolCalls: false, emittedDone: false, afterFinish: 0 };
}

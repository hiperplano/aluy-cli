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
}

/** Cria um acumulador SSE vazio (1 por chamada). */
export function newSseAccumulator(): SseAccumulator {
  return { toolCalls: new Map(), emittedToolCalls: false };
}

// Composição pronta do cliente de modelo a partir da LoginService (EST-0943).
//
// Liga a auth headless (EST-0942) ao cliente de modelo: o `getAccessToken` da
// LoginService vira o provedor de credencial do `BrokerModelClient`. É o ponto
// de wiring que a EST-0944 (loop) e a EST-0948 (TUI) instanciam — uma vez por
// sessão — para chamar o modelo. PORTÁVEL: não toca keychain (a LoginService
// recebe o store já injetado pelo @aluy/cli).

import type { LoginService } from '../auth/login-service.js';
import { BrokerModelClient, type StreamFetch } from './broker-client.js';
import { TierCatalogClient } from './catalog-client.js';
import { CustomModelClient } from './custom-models-client.js';
import { ProvidersClient } from './providers-client.js';
import { QuotaClient } from './quota-client.js';

export interface BrokerModelClientFactoryOptions {
  /** Base URL do broker — de `ALUY_BROKER_URL`. */
  readonly brokerBaseUrl: string;
  /** Sessão de login (EST-0942) — fornece a credencial headless por chamada. */
  readonly login: LoginService;
  /** `fetch` injetável (default: global). */
  readonly fetch?: StreamFetch;
}

/**
 * Cria um `BrokerModelClient` que autentica com a credencial headless corrente
 * (device JWT refrescado ou PAT) via `LoginService.getAccessToken`. Se não há
 * login, a 1ª chamada falha com `SessionExpiredError` (da LoginService) — o
 * caller pede `aluy login`.
 */
export function createBrokerModelClient(opts: BrokerModelClientFactoryOptions): BrokerModelClient {
  return new BrokerModelClient({
    baseUrl: opts.brokerBaseUrl,
    getAccessToken: () => opts.login.getAccessToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * Cria um `TierCatalogClient` (EST-0962) com a MESMA credencial headless do chat
 * (mesmo padrão do `createBrokerModelClient`). Lê `GET /v1/tiers/catalog` p/ o
 * seletor `/model` mostrar nome amigável + sinal de custo por tier (HG-2 relaxado
 * SÓ p/ nome público; ADR-0030 §3). Sem login ⇒ a 1ª chamada falha com
 * `SessionExpiredError` e a TUI cai no fallback de tiers conhecidos.
 */
export function createTierCatalogClient(opts: BrokerModelClientFactoryOptions): TierCatalogClient {
  return new TierCatalogClient({
    baseUrl: opts.brokerBaseUrl,
    getAccessToken: () => opts.login.getAccessToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * Cria um `CustomModelClient` (EST-0962) com a MESMA credencial headless do chat
 * (mesmo padrão dos demais). Lê `GET /v1/models/custom` — a fonte DEDICADA do modo
 * Custom do `/model` (lista plana de modelos por slug, ADR-0030 §3 / ADR-0065), em
 * vez da composição dos TIERS. Sem login ⇒ a 1ª chamada falha com
 * `SessionExpiredError` e a TUI DEGRADA p/ texto-livre (sem sugestão/aviso).
 */
export function createCustomModelClient(opts: BrokerModelClientFactoryOptions): CustomModelClient {
  return new CustomModelClient({
    baseUrl: opts.brokerBaseUrl,
    getAccessToken: () => opts.login.getAccessToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * Cria um `ProvidersClient` (EST-0962 · ADR-0076) com a MESMA credencial headless do chat
 * (mesmo padrão dos demais). Lê `GET /v1/providers` — a fonte VIVA do seletor `/provider`
 * (NOMES dos providers cadastrados, par da via Custom). Sem login / broker fora ⇒ a 1ª
 * chamada falha (`SessionExpiredError`/`BrokerError`) e a TUI DEGRADA p/ o catálogo
 * estático conhecido (openrouter/deepseek) + nota — nunca lista vazia silenciosa.
 */
export function createProvidersClient(opts: BrokerModelClientFactoryOptions): ProvidersClient {
  return new ProvidersClient({
    baseUrl: opts.brokerBaseUrl,
    getAccessToken: () => opts.login.getAccessToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

/**
 * Cria um `QuotaClient` (EST-0948 · ADR-0069) com a MESMA credencial headless do chat.
 * Lê `GET /v1/quota` p/ o footer do CLI mostrar o SALDO de crédito (dimensão primária) +
 * janelas da PRÓPRIA conta. Sem login / broker fora ⇒ `fetchQuota` devolve `undefined`
 * (degrada silencioso: footer oculto). NÃO derruba o app — o footer é não-crítico.
 */
export function createQuotaClient(opts: BrokerModelClientFactoryOptions): QuotaClient {
  return new QuotaClient({
    baseUrl: opts.brokerBaseUrl,
    getAccessToken: () => opts.login.getAccessToken(),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
}

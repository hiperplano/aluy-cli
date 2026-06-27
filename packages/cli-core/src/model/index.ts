// Barrel do cliente de modelo CLI→broker (EST-0943, CLI-SEC-7).
//
// O caminho de PRODUTO do CLI fala SÓ com o broker, com `tier` como única pista
// (HG-2). ADR-0120 acrescenta o BACKEND LOCAL (BYO) como ESTRATÉGIA alternativa
// opt-in (`./local/`), satisfazendo o MESMO contrato `ModelClient`.
export * from './types.js';
export * from './errors.js';
// ADR-0120 / EST-1113 — backend LOCAL (smallbroker BYO). Default segue `broker`.
export * from './local/index.js';
// EST-0948 · ADR-0069 (footer/quota) — parse tolerante das FONTES REAIS (`GET /v1/quota`
// + campos achatados do `usage`) + crédito + limite SERVER-DRIVEN + display puro. PORTÁVEL:
// sem Ink/IO; a TUI só PINTA estes DADOS. (`parseQuotaHeaders`/`parseQuotaBody` ficam por
// compat — o broker entregou o endpoint dedicado, não usa headers no `/v1/chat`.)
export {
  parseQuotaResponse,
  parseQuotaFromUsage,
  parseQuotaHeaders,
  parseQuotaBody,
  formatQuota,
  formatResetIn,
  windowPct,
  quotaLevel,
  serverWindowLimit,
  findWindow,
  toEpochMs,
  QUOTA_HEADERS,
  QUOTA_WARN_PCT,
  QUOTA_CRIT_PCT,
  type Quota,
  type QuotaCredit,
  type QuotaWindow,
  type QuotaLevel,
  type QuotaSegment,
  type QuotaFooterView,
  type HeaderReader,
} from './quota.js';
// EST-0948 · ADR-0069 — cliente do `GET /v1/quota` (path B): saldo + janelas da PRÓPRIA
// conta, on-demand (boot/refresh). GET SEM body (#123). Degrada silencioso (não-crítico).
export { QuotaClient, type QuotaClientOptions } from './quota-client.js';
// EST-0948 (server-limits / FU-VAU-003) — o LIMITE/QUOTA REAL vindo do SERVER, lido
// do `usage` (o canal que JÁ carrega `balance_after`). Modela a QUOTA DE PRODUTO
// (autoritativa no broker, SEC-19) — DISTINTA do fail-safe LOCAL anti-runaway
// (`DEFAULT_MAX_TOKENS`, CLI-SEC-8, em `agent/limits.ts`). Tolerante a ausência.
export {
  parseServerLimits,
  serverTokenLimit,
  serverUsedPct,
  serverLimitLevel,
  isLowBalance,
  formatBalance,
  formatServerLimits,
  LOW_BALANCE_THRESHOLD,
  SERVER_LIMIT_WARN_PCT,
  SERVER_LIMIT_CRIT_PCT,
  type ServerLimits,
  type ServerLimitUnit,
  type ServerLimitLevel,
  type ServerLimitSegment,
  type ServerLimitsFooterView,
} from './server-limits.js';
export { parseSse, type SseEvent, type ByteSource } from './sse.js';
export {
  BrokerModelClient,
  buildChatBody,
  parseNativeToolCall,
  parseToolCalls,
  pushOrMergeToolCall,
  type ModelClient,
  type BrokerModelClientOptions,
  type StreamCallArgs,
  type StreamFetch,
  type StreamResponse,
  type AccessTokenProvider,
} from './broker-client.js';
export {
  createBrokerModelClient,
  createTierCatalogClient,
  createCustomModelClient,
  createProvidersClient,
  createQuotaClient,
  type BrokerModelClientFactoryOptions,
} from './factory.js';
export {
  TierCatalogClient,
  parseCatalog,
  type TierCatalogClientOptions,
  type TierCatalogEntry,
  type ComposedModel,
  type ComposedRole,
  type CostSignal,
} from './catalog-client.js';
export {
  CustomModelClient,
  parseCustomModels,
  type CustomModelClientOptions,
  type CustomModel,
} from './custom-models-client.js';
export {
  ProvidersClient,
  parseProviders,
  type ProvidersClientOptions,
  type ProviderInfo,
} from './providers-client.js';
// EST-1116 — `aluy models`/`aluy providers`: formatador PURO da listagem de
// providers/modelos (seção LOCAL BYO + seção BROKER do catálogo vivo, fail-soft).
export {
  buildModelsNote,
  type ModelsListNote,
  type ModelsListInput,
  type ModelsScope,
  type LocalProviderListing,
  type BrokerListing,
  type BrokerSource,
} from './models-list.js';
// EST-1117 — `/model` CONJUGADO: lógica PURA do passo de `reasoning_effort` (o 3º do trio
// provider+model+effort). Opções/navegação/validação puras; o hook do CLI detém o estado.
export {
  effortOptions,
  effortOptionCount,
  clampEffortIndex,
  isCanonicalEffort,
  normalizeCustomEffort,
  validateCustomEffort,
  effortChoiceAt,
  effortChoiceFromCustom,
  CANONICAL_EFFORTS,
  MAX_EFFORT_LEN,
  type CanonicalEffort,
  type EffortOption,
  type EffortOptionKind,
  type EffortChoice,
  type CustomEffortValidation,
} from './effort-options.js';

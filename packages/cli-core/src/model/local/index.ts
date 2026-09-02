// Barrel do BACKEND LOCAL (ADR-0120 / EST-1113). PORTÁVEL — sem I/O.
export {
  type LocalProviderKind,
  type LocalAuthKind,
  type ResolvedCredential,
  type CredentialProvider,
  type LocalProviderConfig,
  type LocalRequest,
  type LocalMessage,
} from './types.js';
export { type ModelBackend, DEFAULT_BACKEND, parseBackend, resolveBackend } from './backend.js';
export {
  type ProviderAdapter,
  type BuiltRequest,
  type SseAccumulator,
  newSseAccumulator,
} from './adapter.js';
export { AnthropicAdapter, toAnthropicMessages } from './anthropic-adapter.js';
export { OpenAiCompatAdapter, type OpenAiCompatAdapterOptions } from './openai-adapter.js';
export { LocalModelClient, type LocalModelClientOptions } from './local-client.js';
export {
  validateProviderBaseUrl,
  resolveAndPinHost,
  type BaseUrlCheck,
  type PinResult,
} from './base-url.js';
// ADR-0118 / EST-1118 — catálogo de providers LOCAIS como DADO (default embutido +
// override do usuário). PURO (tipos + DADO + merge/sanitize; o load do JSON mora no
// @hiperplano/aluy-cli). O `wireFormat` escolhe o adapter (código). CLI-SEC-7: só dado público.
export {
  type WireFormat,
  type LocalAuthMode,
  type ProviderWave,
  type LocalProviderEntry,
  type LocalProviderCatalog,
  defaultLocalCatalog,
  sanitizeEntry,
  sanitizeUserEntries,
  mergeLocalCatalog,
  buildLocalCatalog,
  findProvider,
} from './catalog.js';
// F-WIN (descoberta) — PARSE PURO do `GET {baseUrl}/models` p/ DESCOBRIR a janela de
// contexto de um slug BYO (o número que o dono teria de digitar à mão em
// `providers[].contextByModel`). Só tipos + parse de um corpo já lido: o fetch PINADO
// (EST-1115), a credencial e a persistência no `~/.aluy/config.json` moram no `cli`.
export {
  type DiscoveredModelContext,
  MIN_PLAUSIBLE_CONTEXT_TOKENS,
  MAX_PLAUSIBLE_CONTEXT_TOKENS,
  MAX_MODELS_PARSED,
  isPlausibleContextWindow,
  parseContextTokens,
  contextFromEntry,
  parseModelsListContexts,
  findModelContext,
  parseModelsListSlugs,
} from './context-discovery.js';
// F-WIN (embutido) — catálogo ESTÁTICO de janelas de contexto PUBLICAMENTE conhecidas,
// casado por FAMÍLIA de slug (vendor/data-suffix/case-insensitive). Degrau ABAIXO de
// declarado/descoberto e ACIMA do fail-safe `0` na cadeia de `resolveContextWindow`
// (`@hiperplano/aluy-cli/model/catalog.ts`). Ver o comentário de topo de
// `known-context-windows.ts` p/ a fonte de cada valor e o porquê da posição.
export {
  KNOWN_MODEL_CONTEXT_WINDOWS,
  normalizeModelFamily,
  builtinContextWindowForSlug,
} from './known-context-windows.js';

// F-WIN (emenda) — parser da janela DIGITADA pelo dono quando o provider não a anuncia.
export { parseJanelaDigitada, explicaRecusa } from './janela-digitada.js';
export type { JanelaDigitada, MotivoRecusa } from './janela-digitada.js';

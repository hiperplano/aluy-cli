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
// @aluy/cli). O `wireFormat` escolhe o adapter (código). CLI-SEC-7: só dado público.
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

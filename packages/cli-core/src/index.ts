// @hiperplano/aluy-cli-core — engine modular PORTÁVEL do agente Aluy.
// Sem Ink, sem React, sem I/O de terminal (fronteira ADR-0053 §8, travada no
// eslint + teste de fronteira). O que sai daqui roda em qualquer locus.
export { CORE_VERSION } from './version.js';

// Permissão (CLI-SEC-3/4/9 + invariante H1): o SEAM (decide/PermissionEngine/
// denyAllEngine, EST-0941) + a ENGINE CONCRETA (PolicyPermissionEngine, EST-0945:
// allow/ask/deny, categorias sempre-ask não-relaxáveis input-aware, --yolo por
// sessão, hooks, contrato de `ask` p/ a TUI EST-0948, efeito exato CLI-SEC-9).
export * from './permission/index.js';

// Auth headless do CLI (lado cliente — EST-0942 / CLI-SEC-1/2). Lógica PORTÁVEL:
// device-flow/PAT/refresh/revoke + contrato do CredentialStore. A implementação
// do keychain do SO mora em @hiperplano/aluy-cli (dep nativa).
export * from './auth/index.js';

// Cliente de modelo CLI→broker (EST-0943 / CLI-SEC-7). O ÚNICO caminho de modelo:
// fala SÓ com o aluy-broker (POST /v1/chat), `tier` como única pista (HG-2),
// streaming SSE, erros estruturados e cancelamento. NÃO carrega credencial de
// provider, não sabe o provider, não toca quota/ledger/markup.
export * from './model/index.js';

// Engine de agente (EST-0944): loop modular + 4 tools nativas (read/edit/bash/
// grep, I/O injetável) + tetos de sessão (CLI-SEC-8) + montagem de contexto com
// separação de canais (CLI-SEC-4) + Idempotency-Key (nasce no loop). TODO
// tool-call passa pelo ponto único `decide()` (CLI-SEC-H1). PORTÁVEL (sem Ink/IO).
export * from './agent/index.js';
// Fatia 3 (ADR-0137) — re-export EXPLÍCITO do seam de juiz de subciclo. O `export *` acima
// DROPAVA estes nomes (ambiguidade silenciosa do star-export) → ficavam undefined no runtime →
// `applyCycleJudge` quebrava ao chamar `buildSubcycleJudgeInput(undefined)` e fail-open silenciava
// o juiz (nunca consultado). Export NOMEADO vence a ambiguidade: força os símbolos no .d.ts e no .js.
export {
  buildSubcycleJudgeInput,
  judgeResultToContinuation,
  clampReasonToLine,
} from './agent/cycle/index.js';
export type { SubcycleBox, CycleContinuation } from './agent/cycle/index.js';

// Sandbox de SO (EST-1009 · ADR-0065 · CLI-SEC-H1): a FUNDAÇÃO PORTÁVEL do piso de
// SO sob a catraca — tipos da primitiva (SandboxLauncher/Confinement), decisão de
// fail-mode (D-SB-4) e geração do filtro seccomp (bytes). O LANÇADOR concreto
// (`bwrap`/userns + spawn) mora em @hiperplano/aluy-cli; aqui é só o contrato + a lógica pura
// (sem tocar o SO). EST-1010 (bash) e EST-1011 (MCP) consomem esta API.
export * from './sandbox/index.js';

// Cliente MCP (EST-0970 · ADR-0058 · CLI-SEC-12): conecta a servers LOCAIS (stdio)
// declarados em `~/.aluy/mcp.json` (DADO), faz handshake, lista as tools e as
// adapta p/ o toolset ATRÁS da catraca. Toda tool MCP = EFEITO por padrão ⇒
// `decide()` (E-B2: classificação por sinais NÃO-confiáveis do input, nunca pelo
// rótulo `readonly` auto-declarado). Saída = DADO não-confiável (CLI-SEC-4). O
// spawn/stdio concreto (SDK MCP) é injetado pelo @hiperplano/aluy-cli via porta `McpTransport`.
export * from './mcp/index.js';

// EST-1128 · ADR-0123 — portas do Maestro (MemoryEngine + JudgeEngine).
export * from './agent/maestro/index.js';

// Helper PURO de TABELA COM BORDAS (box-drawing) — compartilhado pelos builders de
// listagem (/agents, /skills, /model, /workflows no core; /tools, /mcp re-exportam
// no @hiperplano/aluy-cli). Só formata string (sem Ink/IO) ⇒ portável (ADR-0053 §8).
export * from './util/box-table.js';

// Update-notifier — compare SemVer puro (o fetch/cache vive no @hiperplano/aluy-cli).
export { parseVersion, compareVersions, isNewer } from './version-compare.js';
export type { ParsedVersion } from './version-compare.js';

// Padrão de conectores (ADR-0135) — porta `Connector` portável + a MALHA genérica (a
// fronteira de confiança, single-source). PURO e INERTE (ainda não ligado a `--connector`/
// `--telegram`/boot); o I/O concreto vive no @hiperplano/aluy-cli.
export { classifyConnectorIngress } from './connector/mesh.js';
export type { ConnectorIngress } from './connector/mesh.js';
export type {
  Connector,
  ConnectorMeta,
  IncomingMessage,
  OutgoingMessage,
  SenderId,
  ConversationRef,
  Provenance,
} from './connector/types.js';
// Conector Telegram (ADR-0134) — adaptador de ingresso que DELEGA à malha + parser do
// long-poll `getUpdates` (puro, fail-safe; o I/O HTTP vive no @hiperplano/aluy-cli).
export {
  classifyTelegramIngress,
  telegramUpdateToIncoming,
  telegramConversationRef,
  parseAllowlist,
  TELEGRAM_META,
} from './connector/telegram-ingress.js';
export type { TelegramUpdate, IngressDecision } from './connector/telegram-ingress.js';
export { parseGetUpdates } from './connector/telegram-protocol.js';
export type { ParsedUpdates } from './connector/telegram-protocol.js';
// Teto anti-spam de egresso de conector (TC-6 / CLI-SEC-8) — puro, tempo injetável.
export { EgressRateLimiter } from './connector/egress-limit.js';
// Segredo do conector (TC-3 / CLI-SEC-2): contrato + naming + validadores PUROS; o store
// concreto (keychain) vive no @hiperplano/aluy-cli.
export {
  connectorKeychainAccount,
  isPlausibleTelegramToken,
  redactTelegramToken,
  redactSecretIn,
} from './connector/secret-store.js';
export type { ConnectorSecretStore } from './connector/secret-store.js';

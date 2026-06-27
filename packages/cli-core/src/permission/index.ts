// Barrel do módulo de permissão (CLI-SEC-3/4/9 + invariante H1).
//
// O SEAM (EST-0941): ponto único `decide()`, contrato `PermissionEngine`, tipos
// de veredito, e o `denyAllEngine` (deny-by-default).
// A ENGINE CONCRETA (EST-0945): política allow/ask/deny, categorias sempre-ask
// não-relaxáveis (input-aware), `--unsafe` (BYPASS TOTAL de sessão — EST-0948),
// hooks, contrato de `ask` (que a TUI EST-0948 consome) e o efeito exato p/ a
// confirmação (CLI-SEC-9).
export {
  decide,
  denyAllEngine,
  type PermissionCategory,
  type PermissionDecision,
  type PermissionEngine,
  type PermissionVerdict,
  type SessionMode,
  type ToolCall,
} from './gate.js';

export { PolicyPermissionEngine, type PermissionEngineOptions } from './engine.js';

// EST-0959 · ADR-0055 — allow-list FECHADA de leitura local do modo Plan (R1/R2).
export { PLAN_READ_ALLOWLIST, isPlanReadAllowed, looksRemote } from './plan.js';

export { classifyAlwaysAsk, extractPathsFromCommand, type CategoryMatch } from './categories.js';

export {
  EMPTY_POLICY,
  evaluatePolicyRules,
  globMatch,
  type PermissionPolicy,
  type PolicyEvaluation,
  type PolicyRule,
} from './policy.js';

export { runHooks, type HookOutcome, type PreToolUseHook } from './hooks.js';

export { SessionGrants, type AskRequest, type AskResolution, type AskResolver } from './ask.js';

// EST-0968 · CLI-SEC-3 — API SEGURA do painel interativo `/permissions`: catalogo
// (so-leitura) das categorias TRAVADAS + a guarda anti-injecao do que o painel pode
// mudar. O UNICO bypass total continua sendo `--unsafe` (banner vermelho).
export {
  LOCKED_CATEGORIES,
  SAFE_TOGGLEABLE_TOOLS,
  isSafeToolDefaultChange,
  type LockedCategory,
  type SafeToolDecision,
} from './panel.js';

export {
  commandEffect,
  diffEffect,
  networkEffect,
  networkTargetOf,
  pathEffect,
  type ToolEffectDescriptor,
  type ToolEffectKind,
} from './effect.js';

// EST-0991 · EST-1007 · ADR-0072 · AG-0008 — guarda de ENTRADA do YOLO (`--yolo`):
// opt-in/confirmação (TTY) + entrada DIRETA em headless (a flag é o consentimento) +
// recusa DURA só como ROOT + auditoria com flag de modo. PORTÁVEL.
export {
  YOLO_ENTRY_NOTICE,
  YOLO_WARNING,
  decideYoloEntry,
  yoloAuditEvent,
  type YoloContext,
  type YoloEntryVerdict,
  type YoloRefusalReason,
  type YoloAuditEvent,
} from './yolo-guard.js';

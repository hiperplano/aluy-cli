// Erros tipados da auth headless (lado cliente). Mensagens NUNCA contêm o
// segredo (CLI-SEC-2/CLI-SEC-10): no máximo o código OAuth ou um prefixo.

import type { DeviceOAuthErrorCode } from './types.js';

/** Base de todos os erros de auth do CLI (facilita `instanceof` no wiring). */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** O usuário negou a aprovação no navegador (RFC 8628 `access_denied`). */
export class AccessDeniedError extends AuthError {
  constructor() {
    super('aprovação negada no navegador — login cancelado.');
  }
}

/** O device_code expirou antes da aprovação (`expired_token`). */
export class DeviceCodeExpiredError extends AuthError {
  constructor() {
    super('o código expirou antes da aprovação. Rode `aluy login` de novo.');
  }
}

/** Erro OAuth inesperado do polling (não é pending/slow_down/denied/expired). */
export class DeviceFlowError extends AuthError {
  readonly code: DeviceOAuthErrorCode | string;
  constructor(code: DeviceOAuthErrorCode | string, description?: string) {
    super(`falha no device-flow (${code})${description ? `: ${description}` : ''}`);
    this.code = code;
  }
}

/** O refresh foi rejeitado (rotacionado/revogado/reuse-detection) ⇒ re-login. */
export class SessionExpiredError extends AuthError {
  constructor() {
    super('a sessão expirou ou foi revogada. Rode `aluy login` de novo.');
  }
}

/** Formato de PAT inválido (não casa `pat_<hex>_<secret>`). */
export class InvalidPatError extends AuthError {
  constructor() {
    // NÃO ecoa o token — só o formato esperado.
    super('PAT inválido: esperado o formato `pat_<id>_<segredo>`.');
  }
}

/**
 * O refresh NÃO completou por uma falha TRANSITÓRIA (identity 5xx/429 ou erro de
 * rede/timeout) — distinto da REJEIÇÃO definitiva (`SessionExpiredError`). A
 * credencial NÃO foi apagada: o token pode estar válido; um blip não pode derrubar
 * a sessão. O caller deve TENTAR DE NOVO, não re-logar. `transient` marca p/ o
 * wiring distinguir do "rode aluy login" (nunca apaga o keychain por isto).
 */
export class RefreshUnavailableError extends AuthError {
  readonly transient = true;
  constructor() {
    super(
      'não consegui renovar a sessão agora (identity indisponível) — tente de novo; sua credencial foi preservada.',
    );
  }
}

/** Erro HTTP genérico do identity (status fora do esperado). */
export class IdentityHttpError extends AuthError {
  readonly status: number;
  constructor(status: number, context: string) {
    super(`identity respondeu ${status} em ${context}.`);
    this.status = status;
  }
}

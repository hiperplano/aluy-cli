// Parser de PAT — espelha `parse_pat` do identity (EST-0940 §headless_security).
// Formato canônico: `pat_<lookup_id_hex>_<secret>` (prefixo `pat_` distingue de
// `svc_` M2M e `alk_` api-key). Aqui só validamos FORMATO (o segredo é validado
// server-side no introspect). NUNCA logamos o token.

const PAT_PREFIX = 'pat_';
const PAT_SEP = '_';
// lookup_id é um UUID em hex sem hífens (32 chars). O segredo é o resto.
const HEX32 = /^[0-9a-f]{32}$/;

export interface ParsedPat {
  /** UUID do lookup_id (com hífens, forma canônica). */
  readonly lookupId: string;
  /** Comprimento do segredo (p/ sanidade — NUNCA o segredo em si fora daqui). */
  readonly secretLength: number;
}

function hexToUuid(hex: string): string {
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

/**
 * Valida o FORMATO de um PAT. Retorna `null` se inválido (sem lançar — o caller
 * decide a UX). Não valida o segredo (isso é o introspect server-side).
 */
export function parsePat(token: string): ParsedPat | null {
  if (!token || !token.startsWith(PAT_PREFIX)) return null;
  const body = token.slice(PAT_PREFIX.length);
  const sep = body.indexOf(PAT_SEP);
  if (sep <= 0) return null;
  const idHex = body.slice(0, sep);
  const secret = body.slice(sep + 1);
  if (!HEX32.test(idHex)) return null;
  if (secret.length === 0) return null;
  return { lookupId: hexToUuid(idHex), secretLength: secret.length };
}

/** True se o token tem o formato de um PAT do Aluy (`pat_…`). */
export function isPat(token: string): boolean {
  return parsePat(token) !== null;
}

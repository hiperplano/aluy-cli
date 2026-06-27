// Decodificação de claims de JWT APENAS-PARA-EXIBIÇÃO — PORTÁVEL, sem deps.
//
// CLI-SEC-2: isto NÃO valida assinatura nem confia no conteúdo. A verificação
// real do JWT é SERVER-SIDE (broker/identity). Aqui só lemos o `sub` (identifier
// do usuário) do payload para mostrar no `aluy whoami` — o `HeadlessTokenResponse`
// do identity não devolve `user_id` separado; ele só existe no claim `sub` do
// access JWT (device-flow, subject_type=user). Nunca logamos/retornamos o JWT
// inteiro — só o `sub`, que é um identificador não-sensível por si só.

/** Subconjunto dos claims que nos interessam para exibição. */
interface DisplayClaims {
  /** Subject — identifier do usuário (device-flow, subject_type=user). */
  readonly sub?: string;
}

/** base64url → string UTF-8 (sem depender de `atob`/DOM; Buffer existe no Node). */
function decodeBase64Url(segment: string): string | null {
  try {
    // base64url usa '-'/'_' no lugar de '+'/'/' e omite o padding '='.
    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Extrai o `sub` do payload de um JWT SEM verificar a assinatura (display-only).
 * Retorna `undefined` se o token não for um JWT de 3 partes, o payload não for
 * JSON, ou não houver `sub`. Tolerante a lixo — nunca lança.
 */
export function jwtSubForDisplay(jwt: string | undefined): string | undefined {
  if (!jwt) {
    return undefined;
  }
  const parts = jwt.split('.');
  if (parts.length !== 3) {
    return undefined;
  }
  const payloadJson = decodeBase64Url(parts[1] ?? '');
  if (payloadJson === null) {
    return undefined;
  }
  try {
    const claims = JSON.parse(payloadJson) as DisplayClaims;
    return typeof claims.sub === 'string' && claims.sub.length > 0 ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

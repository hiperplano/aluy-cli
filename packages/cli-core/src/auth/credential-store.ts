// Contrato do armazenamento de credencial — CLI-SEC-2.
//
// PORTÁVEL: aqui é só a INTERFACE + serialização. A implementação concreta é o
// KEYCHAIN do SO (macOS Keychain / Windows Credential Manager / Linux Secret
// Service), que vive em `@aluy/cli` (dep nativa `@napi-rs/keyring`). O core nunca
// grava a credencial em disco em claro; quem implementa o store É o keychain.
//
// CLI-SEC-2 (crítico): NUNCA gravar a credencial em arquivo texto no repo/cwd,
// em `~/.aluy/config.json`, em env persistida, nem em log. Sem fallback
// silencioso para arquivo em claro — se não há keychain, o store DEVE lançar
// `NoKeychainError` (definido em @aluy/cli), e o caller avisa o usuário SEM
// gravar nada em claro.

import { jwtSubForDisplay } from './jwt-claims.js';
import type { StoredCredential } from './types.js';

/**
 * Backend de armazenamento da credencial. A única implementação de produção é o
 * keychain do SO (@aluy/cli). Testes injetam um fake EM MEMÓRIA — nunca disco.
 */
export interface CredentialStore {
  /** Lê a credencial corrente, ou `null` se não há login. */
  get(): Promise<StoredCredential | null>;
  /** Persiste/atualiza a credencial. */
  set(credential: StoredCredential): Promise<void>;
  /** Apaga a credencial (logout). Idempotente. */
  clear(): Promise<void>;
}

/** Chave de serviço/conta no keychain (constante de produto). */
export const KEYCHAIN_SERVICE = 'aluy-cli';
export const KEYCHAIN_ACCOUNT = 'headless-credential';

/**
 * Serializa a credencial para a STRING que entra no keychain. É a forma cifrada-
 * pelo-SO do segredo — só vive DENTRO do keychain, nunca em log/arquivo.
 */
export function serializeCredential(cred: StoredCredential): string {
  return JSON.stringify(cred);
}

/** Desserializa, validando a versão do envelope. */
export function deserializeCredential(raw: string): StoredCredential | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredential>;
    if (parsed.v !== 1 || (parsed.kind !== 'device' && parsed.kind !== 'pat')) {
      return null;
    }
    return parsed as StoredCredential;
  } catch {
    return null;
  }
}

/**
 * Versão SEGURA-PARA-LOG da credencial: sem nenhum segredo. É o que pode ir para
 * `whoami`, telemetria ou auditoria (CLI-SEC-2/CLI-SEC-10). Nunca inclui
 * access/refresh/pat — no máximo um prefixo curto e o comprimento.
 */
export interface RedactedCredential {
  readonly kind: StoredCredential['kind'];
  readonly organization_id: string;
  readonly scopes: readonly string[];
  readonly expires_at?: number;
  /**
   * Validade HONESTA do access local (M-2). `true` quando a credencial device
   * tem `expires_at` no passado — o whoami NÃO pode dizer "autenticado" nesse
   * caso, pois a 1ª chamada estouraria `SessionExpiredError`. PAT é sempre
   * `false` (não tem expiry local; a validade é server-side). Não é segredo.
   */
  readonly expired: boolean;
  /** Prefixo curto não-sensível só p/ correlação humana (ex.: "pat_…"/"jwt"). */
  readonly token_hint: string;
  /**
   * Identifier do usuário, p/ exibição (CA-1: whoami mostra user+org+escopos).
   * Device-flow: vem do claim `sub` do access JWT (display-only, sem verificar
   * assinatura — a verificação é server-side). PAT: `undefined` — o user_id NÃO
   * é conhecido localmente (exigiria introspect M2M, que o CLI não faz; ver nota
   * em `whoami.ts`). Nunca contém segredo — `sub` é um identificador.
   */
  readonly user?: string;
}

export function redactCredential(
  cred: StoredCredential,
  now: () => number = Date.now,
): RedactedCredential {
  const hint = cred.kind === 'pat' ? 'pat_…' : 'jwt';
  // Só device-flow carrega o `sub` do usuário no access JWT. PAT não expõe o
  // user_id localmente — fica undefined e o whoami mostra "—".
  const user = cred.kind === 'device' ? jwtSubForDisplay(cred.access_token) : undefined;
  // M-2: honestidade da validade. PAT não tem expiry local (validade server-side)
  // ⇒ nunca "expirado". Device com `expires_at` no passado JÁ expirou: dizer
  // "autenticado" enganaria — a 1ª chamada estouraria SessionExpiredError.
  const expired =
    cred.kind === 'device' && cred.expires_at !== undefined && cred.expires_at <= now();
  return {
    kind: cred.kind,
    organization_id: cred.organization_id,
    scopes: cred.scopes,
    ...(cred.expires_at !== undefined ? { expires_at: cred.expires_at } : {}),
    expired,
    token_hint: hint,
    ...(user !== undefined ? { user } : {}),
  };
}

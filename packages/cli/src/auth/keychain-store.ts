// CredentialStore concreto = KEYCHAIN do SO (CLI-SEC-2, crítico).
//
// macOS Keychain · Windows Credential Manager · Linux Secret Service — via
// `@napi-rs/keyring` (MIT, mantido; substitui o `keytar` arquivado). Esta é a
// METADE-DE-I/O do armazenamento: a lógica portável (serialização, redação) vive
// em @hiperplano/aluy-cli-core. Aqui só a ponte com a dep nativa.
//
// REGRAS CLI-SEC-2 (não negociáveis):
//   - NUNCA grava a credencial em arquivo texto no repo/cwd, em
//     `~/.aluy/config.json`, em env persistida, nem em log.
//   - SEM fallback silencioso para arquivo em claro: se o keychain do SO não
//     está disponível, lançamos `NoKeychainError` e o caller AVISA o usuário —
//     a credencial NÃO é gravada em claro por default (CA-4).

import { Entry } from '@napi-rs/keyring';
import {
  deserializeCredential,
  serializeCredential,
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_SERVICE,
  type CredentialStore,
} from '@hiperplano/aluy-cli-core';
import type { StoredCredential } from '@hiperplano/aluy-cli-core';

/**
 * Lançado quando NÃO há keychain/secret-store do SO disponível (ex.: Linux sem
 * Secret Service / D-Bus). O caller deve AVISAR e NÃO gravar em claro (CA-4).
 */
export class NoKeychainError extends Error {
  constructor(cause?: unknown) {
    super(
      'keychain do SO indisponível. A credencial não foi gravada — por segurança, ' +
        'ela nunca é guardada em texto em claro. No Linux, instale/ative o Secret ' +
        'Service (gnome-keyring/libsecret) e tente de novo.',
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'NoKeychainError';
  }
}

/**
 * Heurística para distinguir "credencial inexistente" (esperado: get sem login)
 * de "backend ausente" (CA-4). O keyring lança em ambos; o texto/forma difere.
 * Em caso de dúvida, tratamos como ausência-de-backend só nas operações de
 * ESCRITA (onde gravar em claro seria o risco) — no get, ausência ⇒ null.
 *
 * FOLLOW-UP M-3 (registrar no aluy-specs): casar por SUBSTRING da mensagem é
 * frágil entre versões/locales do `@napi-rs/keyring` — risco CONTIDO porque
 * `set()` SEMPRE lança em falha (nunca grava em claro por engano). Considerar,
 * quando o keyring expuser, discriminar por código/tipo de erro em vez de texto.
 */
function isNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes('no matching entry') ||
    msg.includes('not found') ||
    msg.includes('no such') ||
    msg.includes('no entry')
  );
}

export interface KeychainStoreOptions {
  /** Override do serviço/conta (testes). Default: constantes do core. */
  readonly service?: string;
  readonly account?: string;
  /** Fábrica de Entry injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeychainEntry;
}

/** Subset do `Entry` do keyring que usamos (facilita injeção em teste). */
export interface KeychainEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export class KeychainCredentialStore implements CredentialStore {
  private readonly service: string;
  private readonly account: string;
  private readonly makeEntry: (service: string, account: string) => KeychainEntry;

  constructor(opts: KeychainStoreOptions = {}) {
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    this.account = opts.account ?? KEYCHAIN_ACCOUNT;
    this.makeEntry = opts.entryFactory ?? ((s, a) => new Entry(s, a) as unknown as KeychainEntry);
  }

  private entry(): KeychainEntry {
    try {
      return this.makeEntry(this.service, this.account);
    } catch (err) {
      // Falha ao instanciar = backend ausente.
      throw new NoKeychainError(err);
    }
  }

  async get(): Promise<StoredCredential | null> {
    const entry = this.entry();
    let raw: string;
    try {
      raw = entry.getPassword();
    } catch (err) {
      // get sem login ⇒ ausência (não é erro de produto).
      if (isNotFound(err)) return null;
      // Qualquer outra falha de leitura ⇒ tratamos como ausência de credencial
      // utilizável (NÃO vazamos detalhe do backend; o get nunca grava nada).
      return null;
    }
    return deserializeCredential(raw);
  }

  async set(credential: StoredCredential): Promise<void> {
    const entry = this.entry();
    try {
      entry.setPassword(serializeCredential(credential));
    } catch (err) {
      // ESCRITA falhou ⇒ backend ausente. NÃO há fallback em claro (CA-4).
      throw new NoKeychainError(err);
    }
  }

  async clear(): Promise<void> {
    const entry = this.entry();
    try {
      entry.deletePassword();
    } catch (err) {
      // Apagar algo que não existe não é erro (logout idempotente).
      if (isNotFound(err)) return;
      // Backend ausente no logout: nada a apagar em claro, então é seguro
      // considerar o logout local concluído.
      return;
    }
  }
}

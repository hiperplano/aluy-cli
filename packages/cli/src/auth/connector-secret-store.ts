// ConnectorSecretStore concreto = KEYCHAIN do SO (CLI-SEC-2 / ADR-0135 TC-3). Guarda o
// TOKEN do bot de um conector (Telegram etc.) como 1 string por conta de keychain
// (`connector-<id>-token`), serviço `aluy-cli`. Espelha o `KeychainCredentialStore`
// (mesma dep `@napi-rs/keyring`, mesmo NoKeychainError, mesma disciplina CA-4):
//   - SEM fallback em claro: keychain ausente ⇒ NoKeychainError, NÃO grava o token em texto.
//   - get sem login ⇒ null (ausência não é erro).

import { Entry } from '@napi-rs/keyring';
import { KEYCHAIN_SERVICE, connectorKeychainAccount, type ConnectorSecretStore } from '@hiperplano/aluy-cli-core';
import { NoKeychainError, type KeychainEntry } from './keychain-store.js';

function isNotFound(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes('no matching entry') ||
    msg.includes('not found') ||
    msg.includes('no such') ||
    msg.includes('no entry')
  );
}

export interface ConnectorSecretStoreOptions {
  /** Override do serviço (testes). Default: `aluy-cli`. */
  readonly service?: string;
  /** Fábrica de Entry injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeychainEntry;
}

/** Store do token de um conector no keychain do SO. */
export class KeychainConnectorSecretStore implements ConnectorSecretStore {
  private readonly service: string;
  private readonly account: string;
  private readonly makeEntry: (service: string, account: string) => KeychainEntry;

  constructor(connectorId: string, opts: ConnectorSecretStoreOptions = {}) {
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    this.account = connectorKeychainAccount(connectorId);
    this.makeEntry = opts.entryFactory ?? ((s, a) => new Entry(s, a) as unknown as KeychainEntry);
  }

  private entry(): KeychainEntry {
    try {
      return this.makeEntry(this.service, this.account);
    } catch (err) {
      throw new NoKeychainError(err);
    }
  }

  async get(): Promise<string | null> {
    const entry = this.entry();
    try {
      const raw = entry.getPassword();
      return raw !== '' ? raw : null;
    } catch (err) {
      // Ausência (sem login) ou qualquer falha de leitura ⇒ null (get nunca grava nada).
      if (isNotFound(err)) return null;
      return null;
    }
  }

  async set(secret: string): Promise<void> {
    const entry = this.entry();
    try {
      entry.setPassword(secret);
    } catch (err) {
      // ESCRITA falhou ⇒ backend ausente. SEM fallback em claro (CA-4 / CLI-SEC-2).
      throw new NoKeychainError(err);
    }
  }

  async clear(): Promise<void> {
    const entry = this.entry();
    try {
      entry.deletePassword();
    } catch (err) {
      if (isNotFound(err)) return; // apagar o que não existe = logout idempotente.
      // Backend ausente no logout: nada a apagar em claro ⇒ logout local concluído.
    }
  }
}

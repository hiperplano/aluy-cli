// ConnectorSecretStore concreto = KEYCHAIN do SO (CLI-SEC-2 / ADR-0154 TC-3). Guarda o
// TOKEN do bot de um conector (Telegram etc.) como 1 string por conta de keychain
// (`connector-<id>-token`), serviço `aluy-cli`. Espelha o `KeychainCredentialStore`
// (mesma dep `@napi-rs/keyring`, mesmo NoKeychainError, mesma disciplina CA-4):
//   - SEM fallback em claro: keychain ausente ⇒ NoKeychainError, NÃO grava o token em texto.
//   - get sem login ⇒ null (ausência não é erro).
//
// EMENDA ESTENDIDA AO CONECTOR (decisão do dono, 2026-08-31). Antes, o fallback em
// cofre ARQUIVO CIFRADO (`model/local/file-vault.ts`) tinha escopo LOCAL: valia só p/ a
// credencial BYO, e este arquivo dizia "token de conector continua nas regras acima, sem
// exceção". Era decisão deliberada, não descuido — e o dogfooding mostrou que a RAZÃO da
// emenda vale idêntica aqui.
//
// O QUE ACONTECEU: o dono rodou `aluy telegram login`, o `/telegram status` confirmou
// "token: presente", e dias depois a MESMA máquina dizia "token: ausente" sem ele ter
// feito nada. Sem Secret Service, o keyring do kernel é MEMÓRIA — foi exatamente o caso
// que criou a emenda. A ponte então recusava por falta de token, e o motivo ia para um
// stderr que a TUI apaga: ele concluiu, por três sinais errados seguidos, que o conector
// não existia. O conector sempre funcionou (verificado ponta a ponta contra a API real).
//
// O QUE **NÃO** MUDA: nada é gravado em CLARO. O arquivo é AES-256-GCM com chave derivada
// do machine-id + usuário, que NÃO viaja junto — copiado para outra máquina, é um blob
// inútil. O keychain segue sendo o ACELERADOR (usado quando existe e responde); o arquivo
// é a PERSISTÊNCIA de verdade. É a mesma disciplina do cofre BYO, agora com um mecanismo
// só para os dois — em vez de dois cofres com regras diferentes.

import { Entry } from '@napi-rs/keyring';
import {
  KEYCHAIN_SERVICE,
  connectorKeychainAccount,
  type ConnectorSecretStore,
} from '@hiperplano/aluy-cli-core';
import { NoKeychainError, type KeychainEntry } from './keychain-store.js';
import {
  readFileVaultAccount,
  writeFileVaultAccount,
  type FileVaultOptions,
} from '../model/local/file-vault.js';

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
  /** Cofre em arquivo cifrado (injetável p/ teste). Ver a emenda no topo. */
  readonly fileVault?: FileVaultOptions;
}

/** Store do token de um conector no keychain do SO. */
export class KeychainConnectorSecretStore implements ConnectorSecretStore {
  private readonly service: string;
  private readonly account: string;
  private readonly makeEntry: (service: string, account: string) => KeychainEntry;
  private readonly fileVault: FileVaultOptions | undefined;

  constructor(connectorId: string, opts: ConnectorSecretStoreOptions = {}) {
    this.service = opts.service ?? KEYCHAIN_SERVICE;
    this.account = connectorKeychainAccount(connectorId);
    this.makeEntry = opts.entryFactory ?? ((s, a) => new Entry(s, a) as unknown as KeychainEntry);
    this.fileVault = opts.fileVault;
  }

  private entry(): KeychainEntry {
    try {
      return this.makeEntry(this.service, this.account);
    } catch (err) {
      throw new NoKeychainError(err);
    }
  }

  async get(): Promise<string | null> {
    // KEYCHAIN primeiro (acelerador: responde rápido quando existe e está vivo).
    try {
      const raw: unknown = this.entry().getPassword();
      // TEM de ser string NÃO-VAZIA. O guarda anterior era `raw !== ''`, e é aí que o
      // fallback morria: uma entrada AUSENTE devolve `null` (keytar e afins) ou
      // `undefined`, e `null !== ''` é VERDADEIRO — então o `get` retornava `null` na
      // hora e o cofre em arquivo NUNCA era lido. O efeito para o dono: gravávamos o
      // token nos DOIS lugares e líamos de NENHUM; `/telegram status` dizia "ausente"
      // com o token são e salvo em `credentials.enc`. Só o caso `''` caía para o cofre —
      // e é justamente o que os dublês dos testes devolviam, então a suíte passava verde.
      if (typeof raw === 'string' && raw !== '') return raw;
    } catch {
      // Ausente, sem backend, ou chave revogada: cai para o cofre em arquivo. `get` nunca
      // grava nada, então errar aqui não tem custo além de uma leitura a mais.
    }
    // COFRE EM ARQUIVO — a persistência de verdade. É ele que faz o token sobreviver num
    // keyring volátil (o caso que gerou esta emenda: "presente" um dia, "ausente" no outro).
    const doArquivo = readFileVaultAccount(this.account, this.fileVault ?? {});
    return doArquivo.valor !== undefined && doArquivo.valor !== '' ? doArquivo.valor : null;
  }

  async set(secret: string): Promise<void> {
    // GRAVA NOS DOIS. O arquivo cifrado é o que PERSISTE; o keychain é o acelerador. Gravar
    // só no keychain é o que fazia o token evaporar sem aviso numa máquina sem Secret
    // Service. Nada vai em claro nem aqui nem lá (CA-4 / CLI-SEC-2 seguem valendo).
    let erroArquivo: unknown;
    try {
      writeFileVaultAccount(this.account, secret, this.fileVault ?? {});
    } catch (err) {
      // Sem machine-id derivável não escrevemos nada (NUNCA em claro). Guardamos o erro:
      // se o keychain também falhar, o caller precisa saber que NADA foi guardado.
      erroArquivo = err;
    }
    try {
      this.entry().setPassword(secret);
    } catch (err) {
      // Keychain ausente E arquivo falhou ⇒ nada foi guardado: é aí que se recusa.
      if (erroArquivo !== undefined) throw new NoKeychainError(err);
      // Só o keychain falhou: o token ESTÁ no cofre em arquivo, e a sessão seguinte o acha.
      return;
    }
  }

  async clear(): Promise<void> {
    // APAGA DOS DOIS. Desde que o `set` passou a gravar também no cofre em arquivo, um
    // logout que só limpasse o keychain deixaria o token para trás — eu estaria criando um
    // furo ao consertar outro. O arquivo não tem API de remoção; gravar VAZIO equivale,
    // porque o `readFileVaultAccount` já trata `''` como ausente. Sobra uma chave com valor
    // vazio no mapa: não é segredo, e some no próximo login.
    try {
      writeFileVaultAccount(this.account, '', this.fileVault ?? {});
    } catch {
      // Sem machine-id não há o que apagar (nunca houve o que gravar). Segue.
    }
    try {
      this.entry().deletePassword();
    } catch (err) {
      if (isNotFound(err)) return; // apagar o que não existe = logout idempotente.
      // Backend ausente no logout: nada a apagar em claro ⇒ logout local concluído.
    }
  }
}

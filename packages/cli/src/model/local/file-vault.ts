// EMENDA à CLI-SEC-2 — cofre em ARQUIVO CIFRADO, portátil, sem depender de nenhum
// serviço do SO (Secret Service/gnome-keyring/kwallet). Existe porque exigir
// keychain do SO é LOCK-IN de plataforma e, num servidor headless Linux sem
// Secret Service, o único backend que `@napi-rs/keyring` acha é o keyring do
// KERNEL — que é MEMÓRIA (F165): a chave "some" no primeiro reboot.
//
// A doutrina antiga (CLI-SEC-2, ver credential-resolver.ts/keychain-store.ts/
// keychain-volatility.ts/CLAUDE.md Regra 3) sempre disse "NUNCA arquivo em
// claro". Isto não revoga isso — EMENDA: em claro continua proibido; o que
// muda é que agora existe uma alternativa que NUNCA está em claro. O segredo só
// toca o disco como AES-256-GCM. A chave de cifra NUNCA é escrita em lugar
// nenhum — ela é DERIVADA, a cada uso, de:
//   machine-id (identidade da MÁQUINA) + usuário do SO + um contexto fixo (HKDF).
//
// A PROPRIEDADE que isto compra: um `tar` de `~/.aluy`, um snapshot de disco, uma
// imagem de container ou um `scp` levam o arquivo — mas NÃO levam `/etc/machine-id`
// (ou o equivalente de hardware). Sem ele, o blob é opaco. É exatamente o vetor de
// CÓPIA que um arquivo 0600 "pelado" não fecha (a fraqueza identificada antes desta
// emenda: um 0600 comum é só uma promessa de permissão — sai inteiro, útil, em
// qualquer cópia do diretório).
//
// O QUE ISTO **NÃO** PROTEGE — seja honesto, quem ler depois precisa saber:
//   - Outro PROCESSO rodando com o MESMO UID, na MESMA máquina, deriva a MESMA
//     chave e abre o cofre igualzinho. Isto NÃO é uma trava contra um atacante já
//     dentro da conta do usuário — nenhum cofre 100% local resolve essa classe de
//     ameaça (nem o keychain do SO destravado escapa dela: qualquer processo do
//     usuário também consegue pedir a senha ao Secret Service).
//   - O que se compra aqui é SÓ o vetor de CÓPIA (arquivo sai da máquina sem a
//     chave). Não é "mais seguro que o keychain do SO" — é "portátil sem lock-in
//     de SO, sem ser um arquivo em claro".
//
// PORTÁVEL? Não — toca `node:fs`/`node:child_process`/machine-id do SO (I/O
// concreto) ⇒ mora em `@hiperplano/aluy-cli` (ADR-0053 §8), igual ao keychain.

import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  hkdfSync,
} from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  statSync,
  chmodSync,
} from 'node:fs';
import { homedir, userInfo, platform as osPlatform } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** Algoritmo AEAD: AES-256 em modo GCM (cifra + autenticação num passo). */
const ALGORITHM = 'aes-256-gcm';
/** Tamanho da chave derivada (256 bits). */
const KEY_BYTES = 32;
/** Tamanho do IV/nonce do GCM (96 bits — recomendado p/ AES-GCM). */
const IV_BYTES = 12;
/** Tamanho do auth tag do GCM (128 bits). */
const TAG_BYTES = 16;
/** Contexto fixo (não-segredo) da derivação — separa este uso de qualquer outro
 *  HKDF do produto (mesmo IKM, contexto diferente ⇒ chave diferente). */
const HKDF_INFO = 'aluy-cli-local-credential-vault-v1';
const HKDF_SALT = 'aluy-cli-machine-vault';

/** Caminho default do cofre em arquivo: `~/.aluy/credentials.enc`. */
export function defaultVaultPath(): string {
  return join(homedir(), '.aluy', 'credentials.enc');
}

export interface MachineIdOptions {
  /** Plataforma (injetável em teste). Default: `os.platform()`. */
  readonly platform?: NodeJS.Platform;
  /** Leitor injetável (testes) — bypassa fs/child_process reais por completo. */
  readonly reader?: () => string | undefined;
}

/**
 * Lê um identificador ESTÁVEL desta máquina. NUNCA lança — best-effort; qualquer
 * falha (fs sem permissão, plataforma exótica, contêiner sem `/etc/machine-id`,
 * utilitário do SO ausente) devolve `undefined`. O CALLER decide o que fazer;
 * este módulo NUNCA inventa um id nem cai num valor fixo de "consolo" — isso
 * destruiria a propriedade de segurança inteira (a chave viraria previsível/
 * portátil, exatamente o que estamos evitando).
 *
 * Fonte por plataforma (utilitários do PRÓPRIO SO — sem dependência nova):
 *   - Linux: `/etc/machine-id` (fallback `/var/lib/dbus/machine-id`)
 *   - macOS: `IOPlatformUUID`, via `ioreg -rd1 -c IOPlatformExpertDevice`
 *   - Windows: `MachineGuid`, via `reg query .../Cryptography /v MachineGuid`
 */
export function readMachineId(opts: MachineIdOptions = {}): string | undefined {
  if (opts.reader !== undefined) {
    const v = opts.reader();
    return v !== undefined && v !== '' ? v : undefined;
  }
  const platform = opts.platform ?? osPlatform();
  try {
    if (platform === 'linux') {
      for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        try {
          const v = readFileSync(p, 'utf8').trim();
          if (v !== '') return v;
        } catch {
          // tenta o próximo caminho conhecido.
        }
      }
      return undefined;
    }
    if (platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const m = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out);
      return m?.[1];
    }
    if (platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'],
        { encoding: 'utf8', timeout: 3000 },
      );
      const m = /MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/.exec(out);
      return m?.[1];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function safeUsername(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}

/**
 * Deriva a chave de 32 bytes via HKDF-SHA256 a partir de `machineId + usuário`
 * (o "IKM" — não-segredo, mas não viaja com o arquivo) + um contexto fixo (`info`,
 * separação de domínio). HKDF (não scrypt): este resolvedor é chamado A CADA
 * requisição de modelo (ADR-0120) — um KDF lento demais aqui seria uma regressão
 * de latência por chamada. A propriedade que importa (chave não coloca no arquivo)
 * não depende de o KDF ser lento; HKDF é o padrão pra "espalhar" material já
 * razoavelmente único, não pra resistir a força-bruta sobre um PIN curto.
 */
function deriveVaultKey(machineId: string, username: string): Buffer {
  const ikm = Buffer.from(`${machineId}:${username}`, 'utf8');
  const salt = Buffer.from(HKDF_SALT, 'utf8');
  const info = Buffer.from(HKDF_INFO, 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, KEY_BYTES));
}

/** Sela `plaintext`: AES-256-GCM, IV aleatório por chamada. Blob opaco em base64. */
function seal(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Formato do arquivo corrompido/truncado — nem chega a tentar decifrar. */
class VaultCorruptError extends Error {}
/** GCM recusou o auth tag — chave errada (outra máquina) OU blob adulterado. As
 *  duas causas são indistinguíveis por design do AEAD; a mensagem ao usuário
 *  cobre as duas sem afirmar qual foi, com certeza. */
class VaultAuthError extends Error {}

/** Abre um blob selado por `seal`. Lança `VaultCorruptError`/`VaultAuthError`. */
function open(sealed: string, key: Buffer): string {
  const raw = Buffer.from(sealed, 'base64');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new VaultCorruptError('cabeçalho cifrado inválido (arquivo truncado ou não é o formato esperado)');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (e) {
    throw new VaultAuthError(e instanceof Error ? e.message : String(e));
  }
}

export interface FileVaultOptions {
  /** Caminho do arquivo (testes). Default: `~/.aluy/credentials.enc`. */
  readonly vaultPath?: string;
  /** Identidade de máquina injetável (testes). */
  readonly machineId?: MachineIdOptions;
  /** Usuário do SO injetável (testes). Default: `os.userInfo().username`. */
  readonly username?: string;
}

export interface FileVaultReadResult {
  readonly valor?: string;
  /** Mensagem HUMANA, acionável, NUNCA contém o segredo. Ausente ⇒ leu (ou o
   *  arquivo simplesmente não existe — não é erro, é "nunca usado aqui"). */
  readonly erro?: string;
  readonly motivo?:
    | 'permissao-aberta'
    | 'maquina-diferente'
    | 'corrompido'
    | 'machine-id-indisponivel';
}

interface VaultMapRead {
  readonly map?: Record<string, string>;
  readonly erro?: string;
  readonly motivo?: FileVaultReadResult['motivo'];
}

/** Lê e decifra o mapa `conta → segredo` inteiro do cofre. NUNCA lança. */
function readVaultMap(opts: FileVaultOptions): VaultMapRead {
  const path = opts.vaultPath ?? defaultVaultPath();
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return {}; // arquivo ausente — não é erro; é "nunca gravado nesta máquina".
  }
  // PERMISSÃO VERIFICADA NA LEITURA — mais aberta que 0600 ⇒ RECUSA usar (mesmo
  // que a decifra funcionasse). Um segredo cifrado, mas legível por outros UID,
  // ainda é pior que a ausência de segredo: o arquivo pode ter sido criado/tocado
  // por algo fora do nosso controle. Nunca "consertamos" a permissão sozinhos
  // aqui no caminho de LEITURA (isso seria agir silenciosamente sobre algo
  // potencialmente comprometido); avisamos alto e paramos.
  const mode = stat.mode & 0o777;
  if ((mode & 0o077) !== 0) {
    return {
      erro:
        `cofre em arquivo (${path}) está com permissão ${mode.toString(8).padStart(3, '0')} ` +
        `— mais aberta que 0600. RECUSANDO usar (um segredo legível por outros é pior que ` +
        `nenhum). Rode: chmod 600 ${path}`,
      motivo: 'permissao-aberta',
    };
  }
  const machineId = readMachineId(opts.machineId);
  if (machineId === undefined) {
    return {
      erro:
        'não foi possível identificar esta máquina (machine-id ilegível) — cofre em arquivo ' +
        'indisponível nesta leitura.',
      motivo: 'machine-id-indisponivel',
    };
  }
  const key = deriveVaultKey(machineId, safeUsername(opts.username));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8').trim();
  } catch (e) {
    return { erro: `falha ao ler o cofre em arquivo (${path}): ${errMsg(e)}` };
  }
  let plaintext: string;
  try {
    plaintext = open(raw, key);
  } catch (e) {
    if (e instanceof VaultCorruptError) {
      return {
        erro: `cofre em arquivo (${path}) corrompido (${errMsg(e)}) — ignorando. Refaça o login.`,
        motivo: 'corrompido',
      };
    }
    // VaultAuthError (ou qualquer outra falha de decifra): chave errada. A causa
    // mais comum É outra máquina (arquivo copiado — tar/scp/snapshot/imagem); a
    // outra possibilidade é adulteração. Não afirmamos qual com certeza.
    return {
      erro: `credencial cifrada para outra máquina (ou arquivo adulterado) — refaça o login.`,
      motivo: 'maquina-diferente',
    };
  }
  try {
    const map = JSON.parse(plaintext) as Record<string, string>;
    return { map };
  } catch {
    return {
      erro: `cofre em arquivo (${path}) corrompido (conteúdo decifrado não é o formato esperado) — ignorando. Refaça o login.`,
      motivo: 'corrompido',
    };
  }
}

/** Lê UMA conta do cofre em arquivo. NUNCA lança; NUNCA loga o valor. */
export function readFileVaultAccount(
  account: string,
  opts: FileVaultOptions = {},
): FileVaultReadResult {
  const { map, erro, motivo } = readVaultMap(opts);
  if (erro !== undefined) return motivo !== undefined ? { erro, motivo } : { erro };
  const valor = map?.[account];
  return valor !== undefined && valor !== '' ? { valor } : {};
}

/**
 * Lançado quando a máquina não pôde ser identificada na hora de GRAVAR. NUNCA
 * cai para gravar em claro como consolo — sem chave derivável, não escrevemos
 * nada; o caller decide o próximo passo (tipicamente: instrui a usar env var).
 */
export class MachineIdUnavailableError extends Error {
  constructor() {
    super(
      'não foi possível identificar esta máquina (machine-id ilegível) — o cofre em arquivo ' +
        'não pode ser gravado com segurança aqui. Use uma variável de ambiente como alternativa.',
    );
    this.name = 'MachineIdUnavailableError';
  }
}

/**
 * Grava/atualiza UMA conta no cofre em arquivo (mescla com as demais contas já
 * presentes). Atômico (`tmp` + rename); nasce 0600. Lança `MachineIdUnavailableError`
 * quando a máquina não pôde ser identificada, ou o erro de `fs` que impedir a
 * escrita — nunca grava nada em claro como fallback.
 */
export function writeFileVaultAccount(
  account: string,
  secret: string,
  opts: FileVaultOptions = {},
): void {
  const path = opts.vaultPath ?? defaultVaultPath();
  const machineId = readMachineId(opts.machineId);
  if (machineId === undefined) throw new MachineIdUnavailableError();
  const key = deriveVaultKey(machineId, safeUsername(opts.username));

  const existing = readVaultMap(opts);
  if (existing.motivo === 'permissao-aberta') {
    // Não sobrescrevemos às cegas um arquivo com permissão suspeita (pode ter
    // sido tocado por algo fora do nosso controle) — recusa explícita, mesma
    // mensagem que a leitura já deu.
    throw new Error(existing.erro);
  }
  const map = { ...(existing.map ?? {}), [account]: secret };
  const sealed = seal(JSON.stringify(map), key);

  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, sealed, { mode: 0o600 });
  chmodSync(tmpPath, 0o600); // defesa extra: independe do umask do processo.
  renameSync(tmpPath, path);
  chmodSync(path, 0o600);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

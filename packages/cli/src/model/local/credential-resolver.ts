// ADR-0120 / EST-1113 — resolvedor de CREDENCIAL BYO do backend local (I/O concreto).
//
// Resolve a credencial de um provider local (API key OU access token OAuth) por
// provider, na ordem **keychain (acelerador) → cofre em arquivo cifrado → env**.
// PORTÁVEL? Não: toca o keychain do SO (dep nativa), o cofre em arquivo (fs/crypto)
// e `process.env` ⇒ mora no `@hiperplano/aluy-cli` (ADR-0053 §8). O core só recebe a
// `CredentialProvider` (função injetada) que devolve a credencial CORRENTE.
//
// CLI-SEC-7 / CLI-SEC-2 (DUROS, EMENDADO) — a chave NUNCA está no repo/binário;
// NUNCA é gravada em CLARO (texto legível), nunca logada. A doutrina original só
// tinha DOIS lugares pro segredo: keychain do SO OU env var — e exigir keychain
// do SO é LOCK-IN de plataforma (e, num Linux headless sem Secret Service, o único
// backend que existe é o keyring do KERNEL, que é MEMÓRIA — F165: a chave "some"
// no primeiro reboot). A EMENDA (ver `file-vault.ts` p/ o raciocínio completo, e
// CLAUDE.md Regra 3): "em claro" continua proibido — o que muda é que agora existe
// um TERCEIRO lugar que nunca é em claro: `~/.aluy/credentials.enc`, cifrado
// AES-256-GCM com chave derivada da identidade da MÁQUINA (nunca escrita em lugar
// nenhum). O keychain do SO passa a ser ACELERADOR (usado quando existe e não é
// volátil), NUNCA requisito — sua ausência não bloqueia mais o login.
//
// Reusa o MESMO `@napi-rs/keyring` do PAT do broker, sob um SERVIÇO/CONTA distinto
// (`aluy-cli-local` / `<provider>:apikey`).

import { Entry } from '@napi-rs/keyring';
import type {
  CredentialProvider,
  ResolvedCredential,
  LocalProviderKind,
  LocalAuthKind,
} from '@hiperplano/aluy-cli-core';
import {
  keychainIsVolatile,
  type VolatileKeychainProbeOptions,
} from '../../auth/keychain-volatility.js';
import {
  readFileVaultAccount,
  writeFileVaultAccount,
  type FileVaultOptions,
  type FileVaultReadResult,
} from './file-vault.js';

/** Serviço do keychain p/ as credenciais BYO do backend local (≠ do PAT do broker). */
export const LOCAL_KEYCHAIN_SERVICE = 'aluy-cli-local';

/** A env var de API key por provider (a via "limpa" — paga-por-uso). */
const ENV_API_KEY: Record<LocalProviderKind, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/** Conta do keychain p/ a API key de um provider. */
export function apiKeyAccount(provider: LocalProviderKind): string {
  return `${provider}:apikey`;
}

/**
 * Nome da env var GENÉRICA de API key de um provider (`ALUY_<PROVIDER>_API_KEY`) —
 * o fallback que o resolvedor consulta p/ QUALQUER provider (incl. custom). Exportado
 * p/ o aviso F165 (cofre volátil) citar exatamente a env que o resolvedor lê.
 */
export function genericApiKeyEnvName(provider: string): string {
  return `ALUY_${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/** Conta do keychain p/ os tokens OAuth de um provider (EST-1114). */
export function oauthAccount(provider: LocalProviderKind): string {
  return `${provider}:oauth`;
}

/**
 * Lançado quando NÃO há credencial p/ o provider no modo escolhido. Mensagem
 * acionável; NUNCA cita segredo.
 */
export class MissingLocalCredentialError extends Error {
  constructor(
    provider: LocalProviderKind,
    auth: LocalAuthKind,
    erroDoKeychain?: string,
    erroDoArquivo?: string,
  ) {
    // CREDENCIAL-INTERMITENTE — quando o keychain FALHOU (≠ "nunca foi configurada"), o
    // conselho "configure a chave" é ERRADO e faz o dono reconfigurar o que já está
    // certo. O sintoma real é o Secret Service (DBus/keyring trancado/fora), e é ISSO
    // que ele precisa ler. Motivo do keychain/arquivo vem CRU do backend — nunca contém
    // segredo (é diagnóstico do backend), ao contrário do valor que ele guarda.
    const hint =
      erroDoKeychain !== undefined
        ? `o keychain do SO NÃO respondeu (${erroDoKeychain}) — a chave pode estar lá e inacessível.` +
          ` Verifique o Secret Service/DBus da sessão, ou passe \`${ENV_API_KEY[provider]}=...\` no ambiente.`
        : erroDoArquivo !== undefined
          ? `o cofre em arquivo NÃO pôde ser usado (${erroDoArquivo})`
          : auth === 'apikey'
            ? `configure a chave: \`${ENV_API_KEY[provider]}=...\` (env) ou \`aluy login --provider ${provider}\` (keychain/cofre em arquivo)`
            : `faça login por assinatura: \`aluy login --provider ${provider} --oauth\``;
    super(`backend local: sem credencial ${auth} p/ "${provider}". ${hint}`);
    this.name = 'MissingLocalCredentialError';
  }
}

/** Subset do `Entry` do keyring (injeção em teste). */
export interface KeyringEntry {
  getPassword(): string;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

export interface LocalCredentialResolverOptions {
  readonly provider: LocalProviderKind;
  /** `apikey` (default) ou `oauth` (EST-1114). */
  readonly auth?: LocalAuthKind;
  readonly env?: NodeJS.ProcessEnv;
  /** Fábrica de Entry injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeyringEntry;
  /**
   * EST-1114 — provedor de access token OAuth (refrescado). Quando `auth==='oauth'`,
   * o resolvedor usa ISTO (não a env/keychain de API key). Injetado pelo locus que
   * detém o store de tokens OAuth (com refresh single-flight). Ausente + oauth ⇒ erro.
   */
  readonly oauthAccessToken?: () => Promise<string | undefined>;
  /** Opções do cofre em arquivo cifrado injetáveis (testes: `vaultPath` num tmpdir,
   *  `machineId` determinístico). Default: `~/.aluy/credentials.enc` + machine-id real. */
  readonly fileVault?: FileVaultOptions;
}

function makeEntry(
  factory: ((service: string, account: string) => KeyringEntry) | undefined,
  service: string,
  account: string,
): KeyringEntry {
  if (factory !== undefined) return factory(service, account);
  return new Entry(service, account) as unknown as KeyringEntry;
}

/**
 * CREDENCIAL-INTERMITENTE (dogfooding real) — última credencial que o keychain
 * ENTREGOU DE VERDADE nesta sessão, por conta. Vive só em MEMÓRIA do processo (nunca
 * em disco/log — CLI-SEC-7 intacto); é a MESMA exposição que já existe enquanto a
 * chave viaja em cada requisição.
 *
 * Por que existe: o serviço 24/7 do dono morria com `sem credencial apikey p/
 * "openrouter"` — com a chave PRESENTE no keychain o tempo todo (73 chars, lida sem
 * erro no mesmo ambiente, segundos depois). A leitura é feita a CADA requisição (por
 * design, p/ pegar rotação de chave sem reiniciar) e o Secret Service falha de vez em
 * quando; UM blip derrubava o turno inteiro. E a mensagem mandava "configure a chave",
 * conselho ERRADO — ele iria reconfigurar algo que já estava certo.
 *
 * A rotação continua soberana: o cache só é CONSULTADO quando a leitura falha e não há
 * env. Uma leitura bem-sucedida sempre ATUALIZA o cache (chave nova entra na hora).
 */
const ultimaCredencialBoa = new Map<string, string>();

/** Resultado de uma leitura do keychain — distingue AUSENTE de ERRO (antes: iguais). */
interface LeituraKeychain {
  readonly valor?: string;
  /** Motivo do FALHO de leitura (backend fora/DBus/locked). Ausente ⇒ leu, só não tinha. */
  readonly erro?: string;
}

/**
 * Lê uma senha do keychain. NUNCA lança. Diferencia "não tem entrada" de "não consegui
 * ler" — antes os dois viravam `undefined` e o diagnóstico perdia a informação que
 * importava (o dono via "configure a chave" quando o problema era o Secret Service).
 */
function readKeychain(
  factory: ((service: string, account: string) => KeyringEntry) | undefined,
  account: string,
): LeituraKeychain {
  try {
    const entry = makeEntry(factory, LOCAL_KEYCHAIN_SERVICE, account);
    const v = entry.getPassword();
    // AUSÊNCIA tem DUAS formas, e só uma era tratada. O código assumia que uma conta
    // inexistente sempre LANÇA (o `catch` abaixo cobre isso) — mas o `@napi-rs/keyring`
    // sobre o Secret Service do Linux devolve `null` SEM lançar. Como o teste era
    // `v !== ''`, `null` passava como "achei": `{valor: null}`.
    //
    // MEDIDO pelo QA num HOME limpo, sem credencial em lugar nenhum: `hasStoredApiKey`
    // devolvia `true` para TODO provider. Dois estragos em cima disso — o aviso de
    // credencial faltando no `/provider` nunca aparecia, e o `/login` afirmava "já existe
    // uma chave guardada — reusar?" para um provider que nunca teve chave. Pior ainda no
    // resolvedor: `secret` podia sair `null` e viajar como credencial.
    //
    // Agora só string NÃO-VAZIA conta como presença. `null`/`undefined`/`''` são a MESMA
    // coisa aqui — ausência — e a distinção que importa (ausência × avaria) continua
    // sendo feita pelo `catch`.
    return typeof v === 'string' && v !== '' ? { valor: v } : {};
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // "no entry"/"not found" é AUSÊNCIA legítima (nunca foi configurada), não avaria.
    if (/no entry|not found|no such|no matching/i.test(msg)) return {};
    return { erro: msg };
  }
}

/**
 * Cria a `CredentialProvider` que o `LocalModelClient` chama por requisição. Resolve
 * na ordem keychain → env (apikey) ou via `oauthAccessToken` (oauth). Resolve a CADA
 * chamada ⇒ pega rotação de chave / refresh de token sem reiniciar a sessão.
 */
export function createLocalCredentialProvider(
  opts: LocalCredentialResolverOptions,
): CredentialProvider {
  const provider = opts.provider;
  const auth: LocalAuthKind = opts.auth ?? 'apikey';
  const env = opts.env ?? process.env;

  return async (): Promise<ResolvedCredential> => {
    if (auth === 'none') {
      // Provider SEM credencial (ex.: Ollama local no loopback): nada a resolver, NÃO lança.
      // O adapter omite o Authorization quando o kind é 'none'.
      return { kind: 'none', secret: '' };
    }
    if (auth === 'oauth') {
      const token = opts.oauthAccessToken !== undefined ? await opts.oauthAccessToken() : undefined;
      if (token === undefined || token === '') {
        throw new MissingLocalCredentialError(provider, 'oauth');
      }
      return { kind: 'oauth', secret: token };
    }
    // apikey: keychain primeiro (ACELERADOR — usado quando responde, nunca requisito),
    // depois o cofre em arquivo cifrado (persistência de verdade, sem lock-in de SO),
    // depois env como último fallback (CI/dogfood/containers). Ordem do env: var
    // canônica do provider (built-ins) → genérica por provider (`ALUY_<PROVIDER>_API_KEY`,
    // p/ custom) → catch-all (`ALUY_LOCAL_API_KEY`, p/ o provider local ATIVO). Assim
    // provider CUSTOM (ex.: tokenrouter) também tem env.
    const conta = apiKeyAccount(provider);
    const doKeychain = readKeychain(opts.entryFactory, conta);
    // CREDENCIAL-INTERMITENTE — leitura BOA sempre atualiza o cache (rotação entra na hora).
    if (doKeychain.valor !== undefined) ultimaCredencialBoa.set(conta, doKeychain.valor);
    // COFRE-EM-ARQUIVO — só entra em jogo quando o keychain NÃO respondeu (ausente OU
    // erro). Ele nunca é preferido sobre um keychain que está funcionando AGORA; só
    // substitui a ausência dele (é o "nunca requisito" da emenda: o keychain some, o
    // cofre em arquivo assume — sem exigir Secret Service em lugar nenhum).
    let doFileVault: FileVaultReadResult = {};
    if (doKeychain.valor === undefined) {
      doFileVault = readFileVaultAccount(conta, opts.fileVault);
      if (doFileVault.valor !== undefined) ultimaCredencialBoa.set(conta, doFileVault.valor);
    }
    const provEnvName = ENV_API_KEY[provider];
    const genericEnvName = genericApiKeyEnvName(provider);
    const fromEnv =
      (provEnvName !== undefined ? env[provEnvName] : undefined) ??
      env[genericEnvName] ??
      env.ALUY_LOCAL_API_KEY;
    const secret =
      doKeychain.valor ??
      doFileVault.valor ??
      (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ??
      // Só chega aqui se keychain E cofre em arquivo FALHARAM (não apenas "ausentes")
      // e não há env: um blip não pode derrubar um serviço que roda 24/7 com a chave
      // configurada.
      (doKeychain.erro !== undefined || doFileVault.erro !== undefined
        ? ultimaCredencialBoa.get(conta)
        : undefined);
    if (secret === undefined) {
      throw new MissingLocalCredentialError(provider, 'apikey', doKeychain.erro, doFileVault.erro);
    }
    return { kind: 'apikey', secret };
  };
}

/** Resultado de `storeApiKey` — QUAL backend acabou guardando a chave. */
export interface StoreApiKeyResult {
  readonly backend: 'keychain' | 'file-vault';
  /**
   * `true` quando o keychain do SO respondeu, mas só tem o cofre VOLÁTIL do kernel
   * (sem Secret Service — F165): o cofre em arquivo foi escrito TAMBÉM, como a
   * cópia durável. Quando isto é `true`, o aviso antigo "sua chave some no reboot"
   * deixaria de ser verdade — o caller NÃO deve mais imprimi-lo.
   */
  readonly volatileKeychainBackedByFile?: boolean;
}

export interface StoreApiKeyOptions {
  /** Fábrica de Entry do keychain injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeyringEntry;
  /** Opções do cofre em arquivo cifrado injetáveis (testes). */
  readonly fileVault?: FileVaultOptions;
  /** F165 — sonda de cofre volátil injetável (testes): platform/leitor de /proc/keys. */
  readonly volatileProbe?: Omit<VolatileKeychainProbeOptions, 'service'>;
}

/**
 * Grava uma API key BYO (usado por `aluy login --provider <p>`). Ordem: tenta o
 * keychain do SO primeiro; se ele respondeu E não é volátil, ACABOU — ele é o
 * ACELERADOR (mais rápido, nativo do SO). Em QUALQUER outro caso — keychain
 * ausente, keychain com erro, OU keychain só disponível no cofre volátil do
 * kernel (F165) — o cofre em arquivo cifrado assume a persistência de verdade
 * (nunca requisito de SO). Nunca cai pra gravar em claro como consolo: se o
 * cofre em arquivo também falhar (ex.: machine-id ilegível), LANÇA — o caller
 * decide como reportar (tipicamente: instrui a usar env var).
 */
export function storeApiKey(
  provider: LocalProviderKind,
  key: string,
  opts: StoreApiKeyOptions = {},
): StoreApiKeyResult {
  const conta = apiKeyAccount(provider);

  let keychainOk = false;
  let keychainVolatile = false;
  try {
    const entry = makeEntry(opts.entryFactory, LOCAL_KEYCHAIN_SERVICE, conta);
    entry.setPassword(key);
    keychainOk = true;
    keychainVolatile = keychainIsVolatile({
      service: LOCAL_KEYCHAIN_SERVICE,
      ...(opts.volatileProbe ?? {}),
    });
  } catch {
    keychainOk = false;
  }

  if (keychainOk && !keychainVolatile) {
    // CREDENCIAL-INTERMITENTE — gravou, o cache anti-blip acompanha na hora: nunca
    // serve uma chave velha depois de uma troca deliberada.
    ultimaCredencialBoa.set(conta, key);
    return { backend: 'keychain' };
  }

  // Keychain ausente, com erro, OU só no cofre volátil do kernel: em qualquer um
  // destes três casos ele é "acelerador, nunca requisito" — o cofre em arquivo
  // cifrado assume. Deixa `writeFileVaultAccount` lançar (`MachineIdUnavailableError`
  // ou erro de fs) — NUNCA cai pra gravar em claro como consolo.
  writeFileVaultAccount(conta, key, opts.fileVault);
  ultimaCredencialBoa.set(conta, key);
  return {
    backend: 'file-vault',
    ...(keychainOk && keychainVolatile ? { volatileKeychainBackedByFile: true } : {}),
  };
}

export interface HasStoredApiKeyOptions {
  /** Fábrica de Entry do keychain injetável (testes). Default: `@napi-rs/keyring`. */
  readonly entryFactory?: (service: string, account: string) => KeyringEntry;
  /** Opções do cofre em arquivo cifrado injetáveis (testes). */
  readonly fileVault?: FileVaultOptions;
}

/**
 * ADR-0120 (retomada, `/login` da sessão) — existe uma API key JÁ PERSISTIDA (keychain
 * OU cofre em arquivo) p/ este provider? NÃO consulta env: uma env var não foi "gravada"
 * por nós (não há o que REUSAR — ela já funciona sozinha a cada requisição via
 * `createLocalCredentialProvider`), e confundir as duas faria o `/login` oferecer
 * "reusar" uma chave que na verdade não está em NENHUM cofre nosso.
 *
 * Só checa PRESENÇA — o valor lido é descartado na hora, nunca retornado nem logado
 * (CLI-SEC-2/7). É o dado que falta pra decidir sem digitar de novo (`decideLocalLogin`
 * em `slash/handlers.ts`): sem isto o `/login` sempre reexigiria colar a chave, mesmo
 * quando ela já está guardada (de um `aluy login --provider` anterior, por exemplo).
 */
export function hasStoredApiKey(
  provider: LocalProviderKind,
  opts: HasStoredApiKeyOptions = {},
): boolean {
  const conta = apiKeyAccount(provider);
  if (readKeychain(opts.entryFactory, conta).valor !== undefined) return true;
  return readFileVaultAccount(conta, opts.fileVault).valor !== undefined;
}

/**
 * CREDENCIAL-INTERMITENTE — ESQUECE a credencial memorizada de um provider. É o ponto
 * de invalidação para um logout/revogação: sem isto, o cache anti-blip seguiria
 * atendendo com a chave revogada até o processo morrer. Usado também pelos testes p/
 * isolar casos (o cache é módulo-global, como a sessão do processo).
 */
export function forgetCachedApiKey(provider?: LocalProviderKind): void {
  if (provider === undefined) ultimaCredencialBoa.clear();
  else ultimaCredencialBoa.delete(apiKeyAccount(provider));
}

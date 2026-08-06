// ADR-0120 / EST-1113 — resolvedor de CREDENCIAL BYO do backend local (I/O concreto).
//
// Resolve a credencial de um provider local (API key OU access token OAuth) por
// provider, na ordem **keychain → env**. PORTÁVEL? Não: toca o keychain do SO (dep
// nativa) e `process.env` ⇒ mora no `@hiperplano/aluy-cli` (ADR-0053 §8). O core só recebe a
// `CredentialProvider` (função injetada) que devolve a credencial CORRENTE.
//
// CLI-SEC-7 / CLI-SEC-2 (DUROS): a chave NUNCA está no repo/binário; vem do
// keychain do SO (cifrada pelo SO) OU de uma env var que o usuário exporta. NUNCA
// é gravada em arquivo texto, nunca logada. Reusa o MESMO `@napi-rs/keyring` do PAT
// do broker, sob um SERVIÇO/CONTA distinto (`aluy-cli-local` / `<provider>:apikey`).

import { Entry } from '@napi-rs/keyring';
import type {
  CredentialProvider,
  ResolvedCredential,
  LocalProviderKind,
  LocalAuthKind,
} from '@hiperplano/aluy-cli-core';

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
  constructor(provider: LocalProviderKind, auth: LocalAuthKind, erroDoKeychain?: string) {
    // CREDENCIAL-INTERMITENTE — quando o keychain FALHOU (≠ "nunca foi configurada"), o
    // conselho "configure a chave" é ERRADO e faz o dono reconfigurar o que já está
    // certo. O sintoma real é o Secret Service (DBus/keyring trancado/fora), e é ISSO
    // que ele precisa ler. Motivo do keychain vem CRU do backend — nunca contém segredo
    // (é diagnóstico do daemon), ao contrário do valor que ele guarda.
    const hint =
      erroDoKeychain !== undefined
        ? `o keychain do SO NÃO respondeu (${erroDoKeychain}) — a chave pode estar lá e inacessível.` +
          ` Verifique o Secret Service/DBus da sessão, ou passe \`${ENV_API_KEY[provider]}=...\` no ambiente.`
        : auth === 'apikey'
          ? `configure a chave: \`${ENV_API_KEY[provider]}=...\` (env) ou \`aluy login --provider ${provider}\` (keychain)`
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
    return v !== '' ? { valor: v } : {};
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
    // apikey: keychain primeiro (mais seguro), env como fallback (CI/dogfood/containers
    // sem Secret Service). Ordem do env: var canônica do provider (built-ins) → genérica
    // por provider (`ALUY_<PROVIDER>_API_KEY`, p/ custom) → catch-all (`ALUY_LOCAL_API_KEY`,
    // p/ o provider local ATIVO). Assim provider CUSTOM (ex.: tokenrouter) também tem env.
    const conta = apiKeyAccount(provider);
    const doKeychain = readKeychain(opts.entryFactory, conta);
    // CREDENCIAL-INTERMITENTE — leitura BOA sempre atualiza o cache (rotação entra na hora).
    if (doKeychain.valor !== undefined) ultimaCredencialBoa.set(conta, doKeychain.valor);
    const provEnvName = ENV_API_KEY[provider];
    const genericEnvName = genericApiKeyEnvName(provider);
    const fromEnv =
      (provEnvName !== undefined ? env[provEnvName] : undefined) ??
      env[genericEnvName] ??
      env.ALUY_LOCAL_API_KEY;
    const secret =
      doKeychain.valor ??
      (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined) ??
      // Só chega aqui se o keychain FALHOU (ou esvaziou) e não há env: um blip do Secret
      // Service não pode derrubar um serviço que roda 24/7 com a chave configurada.
      (doKeychain.erro !== undefined ? ultimaCredencialBoa.get(conta) : undefined);
    if (secret === undefined) {
      throw new MissingLocalCredentialError(provider, 'apikey', doKeychain.erro);
    }
    return { kind: 'apikey', secret };
  };
}

/** Grava uma API key BYO no keychain (usado por `aluy login --provider <p>`). */
export function storeApiKey(
  provider: LocalProviderKind,
  key: string,
  factory?: (service: string, account: string) => KeyringEntry,
): void {
  const conta = apiKeyAccount(provider);
  const entry = makeEntry(factory, LOCAL_KEYCHAIN_SERVICE, conta);
  entry.setPassword(key);
  // CREDENCIAL-INTERMITENTE — gravou, o cache anti-blip acompanha na hora: nunca serve
  // uma chave velha depois de uma troca deliberada.
  ultimaCredencialBoa.set(conta, key);
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

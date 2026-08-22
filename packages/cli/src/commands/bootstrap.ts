// EST-1133 / ADR-0130 — `aluy bootstrap`: provisionamento explícito de sidecars user-space.
//
// Dispara o provisionamento de runtimes (Ollama, Mem0) em ~/.aluy/
// quando o perfil é TURBO (default). LEVE não provisiona nada.
// Passo EXPLÍCITO — NUNCA roda no boot automático (CA-G2-11).
//
// EST-1133-wizard — wizard de 1ª execução: antes de provisionar, verifica se há
// provider+modelo+chave configurados (necessários p/ o `--agent` usar o LLM). Se
// faltar, entra num wizard interativo que pergunta provider, chave e modelo.

import { Entry } from '@napi-rs/keyring';
import { UserConfigStore, resolveEmbedderModel } from '../io/user-config.js';
import { runProvisioner } from '../provisioner/sidecar-provisioner.js';
import {
  storeApiKey,
  apiKeyAccount,
  createLocalCredentialProvider,
  LOCAL_KEYCHAIN_SERVICE,
  type KeyringEntry,
} from '../model/local/credential-resolver.js';
import type { VolatileKeychainProbeOptions } from '../auth/keychain-volatility.js';
import type { FileVaultOptions } from '../model/local/file-vault.js';
import { resolveLocalProviderConfig, resolveModelBackend } from '../model/local/config.js';
import { loadLocalProviderCatalog } from '../io/providers-config.js';
import { loadBrokerConfig } from '../model/config.js';
import { loadAuthConfig } from '../auth/config.js';
import { KeychainCredentialStore } from '../auth/keychain-store.js';
import {
  defaultLocalCatalog,
  findProvider,
  LoginService,
  type LocalProviderKind,
} from '@hiperplano/aluy-cli-core';

/**
 * Função de fetch injetável (testes) — assinatura mínima usada pelo preflight.
 *
 * `method`/`headers` entraram com o preflight de AUTENTICAÇÃO (`probeModelUsable`): a sonda
 * antiga era um GET ANÔNIMO, e um GET anônimo NÃO consegue distinguir "a chave é ruim" de
 * "eu não mandei chave nenhuma" — todo provider remoto responderia 401 do mesmo jeito.
 * Ambos os campos são opcionais: os fakes antigos (`async (url) => ({ status }))`) seguem
 * válidos.
 */
export type FetchLike = (
  url: string,
  init?: { signal?: AbortSignal; method?: string; headers?: Record<string, string> },
) => Promise<{ status: number }>;

/**
 * Preflight de ACESSIBILIDADE do modelo local (BYO) p/ o caminho via AGENTE — que PRECISA de
 * um modelo pra "pensar". ACHADO DO DONO (máquina do zero): `aluy bootstrap` parou em
 * "verificando ollama" porque o instalador-agente (`aluy -p`) não conseguiu falar com o
 * provider ("erro de broker: provider local") — circular: o agente precisa do modelo que ele
 * ainda ia instalar. Aqui checamos o endpoint efetivo ANTES; inacessível ⇒ o caller cai no
 * caminho DIRETO (`--no-agent`), que não usa modelo.
 *
 * NÃO infere (não gasta token): só um GET curto em `<baseUrl>/models` — qualquer resposta HTTP
 * (mesmo 401) = alcançável. Sem baseUrl efetivo (provider remoto default) ⇒ devolve `true`
 * (não bloqueia: a falha de chave de um provider remoto é assunto do wizard, não daqui).
 * Fail-safe: SÓ erro de REDE (ECONNREFUSED/timeout/DNS) conta como inacessível.
 *
 * ⚠ ESCOPO (não use isto como preflight sozinho): esta função responde ALCANCE, e ALCANCE
 * NÃO É USABILIDADE. ACHADO DO DONO (instalação no Windows): as três instalações via agente
 * morreram com "erro de broker: credencial inválida ou expirada (401)" e o preflight tinha
 * passado — porque um broker que devolve 401 está alcançável e inútil ao mesmo tempo, e
 * porque a sonda cai no `baseUrl` do provider LOCAL mesmo quando o backend efetivo é o
 * BROKER (aí devolvia `true` por "sem endpoint p/ sondar"). Quem decide se o agente pode
 * rodar é o `probeModelUsable` abaixo, que distingue os dois casos. Esta continua exportada
 * porque a pergunta "a porta responde?" ainda é útil isolada (e é o que os testes fixam).
 */
export async function probeModelReachable(opts: {
  config: ReturnType<UserConfigStore['load']>;
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<boolean> {
  const { config, env } = opts;
  const resolved = resolveLocalProviderConfig({ env, config, catalog: loadLocalProviderCatalog() });
  // baseUrl EFETIVO: o explícito do usuário OU o default do catálogo p/ o provider.
  const catalogBaseUrl = findProvider(defaultLocalCatalog(), resolved.provider)?.baseUrl;
  const baseUrl = resolved.baseUrl ?? catalogBaseUrl;
  if (baseUrl === undefined || baseUrl === '') return true; // sem endpoint p/ sondar ⇒ não bloqueia
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const timeoutMs = opts.timeoutMs ?? 4000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, { signal: ctrl.signal });
    return true; // QUALQUER resposta HTTP = endpoint alcançável (mesmo 401/404)
  } catch {
    return false; // erro de rede ⇒ inacessível
  } finally {
    clearTimeout(timer);
  }
}

// ─── Preflight de USABILIDADE do modelo (alcance + AUTENTICAÇÃO) ─────────────
//
// DEFEITO OBSERVADO (log real da instalação no Windows do dono): `aluy bootstrap` rodou o
// agente embutido p/ os três complementos, os três morreram em
// `erro de broker: credencial inválida ou expirada — rode aluy login. (401)`,
// e o instalador seguiu como se nada tivesse acontecido. O preflight que deveria ter
// evitado isso (`probeModelReachable`) errava por DOIS motivos independentes:
//
//   1. Sondava sempre o `baseUrl` do provider LOCAL, mesmo quando o backend EFETIVO era o
//      broker — e, quando não achava baseUrl, devolvia `true` ("não bloqueia").
//   2. Tratava QUALQUER resposta HTTP como sucesso, 401 inclusive, e sondava ANÔNIMO (sem
//      mandar credencial), o que torna o 401 ambíguo por construção.
//
// A correção resolve os dois: o preflight agora resolve o MESMO backend que o agente vai
// usar e faz uma sonda AUTENTICADA — com a MESMA credencial que o agente usaria. Assim
// "não alcancei" e "a credencial não serve" viram estados DISTINTOS, cada um com sua saída.

/** Veredito do preflight — ALCANCE e AUTENTICAÇÃO são falhas diferentes, com saídas diferentes. */
export type ModelPreflightStatus = 'ok' | 'unreachable' | 'unauthorized';

export interface ModelPreflight {
  readonly status: ModelPreflightStatus;
  /** Detalhe ACIONÁVEL p/ o usuário. NUNCA contém segredo (CLI-SEC-2/7). */
  readonly detail?: string;
}

/** Path do broker que EXIGE auth e NÃO gasta modelo (o mesmo que o `aluy login` usa p/ validar). */
const QUOTA_PATH = '/v1/quota';

/** Timeout curto: o preflight não pode pendurar a instalação esperando um endpoint fora. */
const PREFLIGHT_TIMEOUT_MS = 4000;

export interface ModelUsableProbeOptions {
  config: ReturnType<UserConfigStore['load']>;
  env: NodeJS.ProcessEnv;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  /**
   * Resolve o PAT/token do BROKER (testes injetam). Default: keychain + `ALUY_TOKEN` —
   * exatamente a mesma resolução que o agente embutido faria, senão o preflight provaria
   * uma credencial que não é a usada.
   */
  brokerToken?: () => Promise<string>;
  /** Resolve a chave BYO do provider local (testes injetam). Default: keychain → cofre → env. */
  localKey?: () => Promise<string>;
}

/**
 * PREFLIGHT do caminho via AGENTE: o instalador-agente precisa de um modelo que RESPONDA e
 * que ACEITE a credencial. Devolve `ok` / `unreachable` / `unauthorized`.
 *
 * Roteia pelo backend EFETIVO (`resolveModelBackend`, flag>env>config>default), porque é ele
 * que decide quem atende o agente: broker (conta) ou provider local (BYO). Sondar o lado
 * errado foi metade do defeito original.
 *
 * NÃO gasta token: os dois lados usam um GET que exige auth mas não chama modelo.
 * FAIL-SAFE: só o que PROVA o problema vira veredito negativo. Status inesperado (5xx/404)
 * ⇒ `ok` — não temos direito de bloquear a instalação por um erro que não é do usuário.
 */
export async function probeModelUsable(opts: ModelUsableProbeOptions): Promise<ModelPreflight> {
  const backend = resolveModelBackend({ env: opts.env, config: opts.config });
  return backend === 'local' ? probeLocalProviderUsable(opts) : probeBrokerUsable(opts);
}

/** `fetch` + timeout comuns aos dois lados do preflight. Lança em erro de REDE (o caller trata). */
async function probeGet(
  opts: ModelUsableProbeOptions,
  url: string,
  headers: Record<string, string>,
): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? PREFLIGHT_TIMEOUT_MS);
  try {
    // SEM `body`: um GET com body (mesmo `''`) faz o fetch do Node LANÇAR antes da rede.
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json', ...headers },
      signal: ctrl.signal,
    });
    return res.status;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Backend BROKER (o default, e o caso do log do dono): valida a credencial com `GET /v1/quota`
 * — MESMO toque que o `aluy login` usa p/ recusar um PAT ruim ANTES de gravar.
 *
 * 401 ⇒ `unauthorized` (é literalmente o erro que derrubou as três instalações).
 * 403 ⇒ `ok`: 403 significa AUTENTICOU mas não tem o escopo `quota:read` (opt-in) — um PAT
 * normal de chat recebe 403 aqui e é PERFEITAMENTE bom p/ o agente (mesma decisão já tomada
 * em `validatePatOnBroker`; tratá-lo como falha bloquearia login VÁLIDO).
 */
async function probeBrokerUsable(opts: ModelUsableProbeOptions): Promise<ModelPreflight> {
  const { brokerBaseUrl } = loadBrokerConfig(opts.env);
  let token: string;
  try {
    token = await (opts.brokerToken ?? (() => defaultBrokerToken(opts.env)))();
  } catch {
    // Sem credencial no keychain / sessão expirada: o agente NEM chegaria à rede.
    return {
      status: 'unauthorized',
      detail: 'não há credencial válida do broker nesta máquina — rode `aluy login`.',
    };
  }
  if (token === '') {
    return {
      status: 'unauthorized',
      detail: 'não há credencial válida do broker nesta máquina — rode `aluy login`.',
    };
  }
  let status: number;
  try {
    status = await probeGet(opts, `${brokerBaseUrl}${QUOTA_PATH}`, {
      authorization: `Bearer ${token}`,
    });
  } catch {
    return { status: 'unreachable', detail: 'o broker não respondeu (rede/endpoint fora).' };
  }
  if (status === 401) {
    return {
      status: 'unauthorized',
      detail:
        'o broker RECUSOU a credencial (401) — ela expirou ou foi revogada; rode `aluy login`.',
    };
  }
  return { status: 'ok' };
}

/**
 * Backend LOCAL (BYO): `GET <baseUrl>/models` AUTENTICADO com a chave do provider. A composição
 * da URL e dos headers espelha `checkModelConnectivity`/`fetchModelsBody` (o `baseUrl` do
 * catálogo já traz o `/v1` de quem usa; o wire `anthropic` é a exceção, com `x-api-key`), então
 * um provider que funciona p/ chat funciona aqui.
 *
 * `auth:'none'` (ex.: Ollama no loopback) ⇒ sonda ANÔNIMA de propósito: não há credencial p/
 * estar errada, e aí 401 realmente não é o nosso caso.
 */
async function probeLocalProviderUsable(opts: ModelUsableProbeOptions): Promise<ModelPreflight> {
  const resolved = resolveLocalProviderConfig({
    // F-CATALOGO-DO-DONO — sem o catálogo do USUÁRIO, `parseProvider` valida contra o
    // EMBUTIDO e descarta em silêncio qualquer provider declarado em `providers[]`: o
    // `localProvider: "tokenrouter"` do config vira o default, e o bootstrap vai sondar e
    // instalar contra um provider que o dono nunca escolheu. Foi o que fez a tela mostrar
    // um provider diferente do que estava gravado.
    env: opts.env,
    config: opts.config,
    catalog: loadLocalProviderCatalog(),
  });
  const entry = findProvider(defaultLocalCatalog(), resolved.provider);
  const baseUrl = resolved.baseUrl ?? entry?.baseUrl;
  if (baseUrl === undefined || baseUrl === '') return { status: 'ok' }; // sem endpoint p/ sondar
  let key = '';
  if (resolved.auth !== 'none') {
    try {
      key = await (opts.localKey ?? (() => defaultLocalKey(opts)))();
    } catch {
      return {
        status: 'unauthorized',
        detail:
          `sem chave de API resolvível p/ o provider local "${resolved.provider}" — ` +
          `grave com \`aluy login --provider ${resolved.provider}\` ou exporte a env do provider.`,
      };
    }
  }
  const base = baseUrl.replace(/\/+$/, '');
  const anthropicWire = (entry?.wireFormat ?? 'openai-compat') === 'anthropic';
  const url = anthropicWire ? `${base}/v1/models` : `${base}/models`;
  // A credencial só entra quando EXISTE: mandar `Bearer ` vazio faz alguns servers
  // responderem 401 à toa — e um 401 fabricado por nós seria um falso "credencial ruim".
  const headers: Record<string, string> =
    key === ''
      ? {}
      : anthropicWire
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${key}` };
  let status: number;
  try {
    status = await probeGet(opts, url, headers);
  } catch {
    return {
      status: 'unreachable',
      detail: `o endpoint do provider local "${resolved.provider}" não respondeu.`,
    };
  }
  if (key !== '' && (status === 401 || status === 403)) {
    return {
      status: 'unauthorized',
      detail:
        `o provider local "${resolved.provider}" RECUSOU a chave (${status}) — ` +
        `regrave com \`aluy login --provider ${resolved.provider}\`.`,
    };
  }
  return { status: 'ok' };
}

/** Token do broker pela MESMA via do resto do CLI (keychain do SO + `ALUY_TOKEN`). */
function defaultBrokerToken(env: NodeJS.ProcessEnv): Promise<string> {
  const cfg = loadAuthConfig(env);
  const store = new KeychainCredentialStore();
  const login = new LoginService(
    { ...cfg, baseUrl: cfg.identityBaseUrl, store },
    { envToken: () => env.ALUY_TOKEN },
  );
  return login.getAccessToken();
}

/** Chave BYO pela MESMA via do resto do CLI (keychain → cofre em arquivo → env). */
async function defaultLocalKey(opts: ModelUsableProbeOptions): Promise<string> {
  const resolved = resolveLocalProviderConfig({
    // F-CATALOGO-DO-DONO — sem o catálogo do USUÁRIO, `parseProvider` valida contra o
    // EMBUTIDO e descarta em silêncio qualquer provider declarado em `providers[]`: o
    // `localProvider: "tokenrouter"` do config vira o default, e o bootstrap vai sondar e
    // instalar contra um provider que o dono nunca escolheu. Foi o que fez a tela mostrar
    // um provider diferente do que estava gravado.
    env: opts.env,
    config: opts.config,
    catalog: loadLocalProviderCatalog(),
  });
  const provider = createLocalCredentialProvider({
    provider: resolved.provider,
    auth: resolved.auth,
    env: opts.env,
  });
  return (await provider()).secret;
}

const VALID_PROVIDERS: readonly LocalProviderKind[] = ['anthropic', 'openrouter', 'openai'];

/** Interface de prompt injetável (testes). Espelha o `TerminalIO` de auth/io.ts. */
export interface WizardPrompt {
  (question: string, opts?: { secret?: boolean }): Promise<string>;
}

/**
 * Wizard de 1ª execução: garante provider + chave + modelo LOCAIS configurados.
 *
 * Verifica:
 *  - `config.localProvider` presente?
 *  - `config.localModel` presente?
 *  - chave de API no keychain p/ o provider?
 *
 * Se TUDO presente ⇒ no-op (idempotente).
 * Se NÃO-interativo (sem TTY, `--yes`, headless) ⇒ reporta o que falta e instrui,
 *   sem pendurar.
 * Se interativo ⇒ pergunta provider → chave → modelo, grava no keychain + config.
 *
 * @returns `true` se o wizard seguiu p/ provisionamento; `false` se o usuário
 *          desistiu / não-interativo sem config completa.
 */
export async function runFirstRunWizard(opts: {
  config: ReturnType<UserConfigStore['load']>;
  configStore: UserConfigStore;
  prompt: WizardPrompt;
  out: (line: string) => void;
  err: (line: string) => void;
  entryFactory?: (service: string, account: string) => KeyringEntry;
  /** F165 — sonda de cofre volátil injetável (testes): platform/leitor de /proc/keys. */
  volatileProbe?: Omit<VolatileKeychainProbeOptions, 'service'>;
  /** Opções do cofre em arquivo cifrado injetáveis (testes). */
  fileVault?: FileVaultOptions;
  isInteractive: boolean;
}): Promise<boolean> {
  const { config, configStore, prompt, out, err, entryFactory, isInteractive } = opts;

  const hasProvider = config.localProvider !== undefined;
  const hasModel = config.localModel !== undefined;

  // Verifica se há chave no keychain.
  let hasKey = false;
  let currentProvider: LocalProviderKind | undefined = config.localProvider;
  if (currentProvider) {
    try {
      const e = (entryFactory ?? defaultEntryFactory)(
        LOCAL_KEYCHAIN_SERVICE,
        apiKeyAccount(currentProvider),
      );
      const v = e.getPassword();
      hasKey = v !== '' && v !== undefined;
    } catch {
      // chave não encontrada ou keychain indisponível
    }
  }

  if (hasProvider && hasModel && hasKey) {
    return true; // tudo pronto, segue p/ provisionamento
  }

  if (!isInteractive) {
    // Não-interativo: reporta e instrui, sem pendurar.
    err('aluy bootstrap: configuração de 1ª execução necessária (provider + chave + modelo).');
    if (!hasProvider) err('  ✗ Falta provider local em ~/.aluy/config.json.');
    if (!hasModel) err('  ✗ Falta modelo local em ~/.aluy/config.json.');
    if (!hasKey) err('  ✗ Falta chave de API no keychain do SO.');
    err('');
    err('  Rode `aluy bootstrap` interativamente (num terminal com TTY) para o wizard,');
    err('  ou configure manualmente:');
    err(
      '    1. `aluy login --provider <anthropic|openrouter|openai>`  (grava a chave no keychain)',
    );
    err('    2. Edite ~/.aluy/config.json e adicione:');
    err('       "localProvider": "<provider>",');
    err('       "localModel": "<modelo-nativo>"');
    err('');
    return false;
  }

  // ── Wizard interativo ──────────────────────────────────────────────────────
  out('');
  out('╔══════════════════════════════════════════════════════════════╗');
  out('║  Configuração de 1ª execução — provider + chave + modelo   ║');
  out('╚══════════════════════════════════════════════════════════════╝');
  out('');
  out('O `aluy bootstrap --agent` usa um modelo de linguagem para instalar');
  out('dependências. Precisamos de provider, chave de API e modelo.');
  out('(As credenciais ficam no keychain do SO — nunca em texto.)');
  out('');

  // Passo 1 — Provider.
  if (!hasProvider) {
    const answer = (await prompt(`Provider (${VALID_PROVIDERS.join('/')}): `)).trim().toLowerCase();
    if (!(VALID_PROVIDERS as readonly string[]).includes(answer)) {
      err(`Provider inválido "${answer}". Use: ${VALID_PROVIDERS.join(', ')}.`);
      return false;
    }
    currentProvider = answer as LocalProviderKind;
    out('');
  } else {
    out(`Provider: ${currentProvider} (já configurado)`);
  }

  // Passo 2 — Chave de API.
  if (!hasKey) {
    // currentProvider é garantido não-undefined após passo 1 ou config.
    const provider = currentProvider!;
    const key = (await prompt(`API key de ${provider}: `, { secret: true })).trim();
    if (key === '') {
      err('Chave vazia — abortando.');
      return false;
    }
    try {
      const result = storeApiKey(provider, key, {
        ...(entryFactory ? { entryFactory } : {}),
        ...(opts.volatileProbe ? { volatileProbe: opts.volatileProbe } : {}),
        ...(opts.fileVault ? { fileVault: opts.fileVault } : {}),
      });
      if (result.backend === 'keychain') {
        out('✓ Chave guardada no keychain do SO.');
      } else {
        out('✓ Chave guardada no cofre local cifrado (~/.aluy/credentials.enc).');
        if (result.volatileKeychainBackedByFile === true) {
          // F165, emendado — keychain só tem cofre volátil (sem Secret Service); o
          // cofre em arquivo garante persistência real, então o aviso antigo ("some
          // no reboot") deixaria de ser verdade — não o repetimos.
          out('  (o cofre em arquivo cifrado garante que a chave sobrevive a um reboot.)');
        }
      }
    } catch (e) {
      err(`Falha ao gravar a credencial: ${e instanceof Error ? e.message : String(e)}`);
      err(
        '(Por segurança, a credencial nunca é gravada em texto. Use uma variável de ambiente como alternativa.)',
      );
      return false;
    }
    out('');
  } else {
    out('✓ Chave já está no keychain.');
  }

  // Passo 3 — Modelo.
  if (!hasModel) {
    const provider = currentProvider!;
    const model = (await prompt(`Modelo nativo (ex.: claude-sonnet-4-8): `)).trim();
    if (model === '') {
      err('Modelo vazio — abortando.');
      return false;
    }
    configStore.save({
      localProvider: provider as 'anthropic' | 'openrouter' | 'openai',
      localModel: model,
    });
    out(`✓ Provider "${provider}" + modelo "${model}" salvos em ~/.aluy/config.json.`);
    out('');
  }

  out('Configuração concluída. Seguindo para o provisionamento…');
  out('');
  return true;
}

/** Fábrica padrão de Entry do keychain (produção). */
function defaultEntryFactory(service: string, account: string): KeyringEntry {
  return new Entry(service, account) as unknown as KeyringEntry;
}

/**
 * Roda o `aluy bootstrap`.
 *
 * 1. Wizard de 1ª execução (provider+chave+modelo), SE necessário.
 * 2. Lê perfil/toggles de ~/.aluy/config.json.
 * 3. Se LEVE ⇒ informa e sai (sem provisionar).
 * 4. Se TURBO ⇒ provisiona sidecars conforme toggles.
 * 5. Reporta resultado ao usuário.
 *
 * @param out - Função de saída (stdout).
 * @param err - Função de erro (stderr).
 * @returns Exit code (0 = sucesso, 1 = falha total).
 */
export async function runInit(opts: {
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * EST-1133-bis — habilita a DELEGAÇÃO ao agente (`--agent`) quando o SO não tem
   * artefato pinado (não-Linux). Sem isso, em SO não-Linux o provisionador instrui
   * em vez de tentar baixar o artefato Linux errado.
   */
  agent?: boolean;
  /**
   * Prompt interativo p/ o wizard (testes injetam mock). Ausente ⇒ wizard
   * roda em modo NÃO-interativo (reporta e instrui).
   */
  prompt?: WizardPrompt;
  /**
   * Fábrica de Entry do keychain (testes). Default: `@napi-rs/keyring`.
   */
  entryFactory?: (service: string, account: string) => KeyringEntry;
  /** F165 — sonda de cofre volátil injetável (testes): platform/leitor de /proc/keys. */
  volatileProbe?: Omit<VolatileKeychainProbeOptions, 'service'>;
  /** Opções do cofre em arquivo cifrado injetáveis (testes). */
  fileVault?: FileVaultOptions;
  /**
   * Override do config store (testes). Default: `~/.aluy/config.json` real.
   */
  configStore?: UserConfigStore;
  /**
   * Força modo interativo/não-interativo (default: `process.stdin.isTTY`).
   */
  isInteractive?: boolean;
  /** Ambiente (default: `process.env`) — usado pelo preflight de acessibilidade do modelo. */
  env?: NodeJS.ProcessEnv;
  /**
   * Preflight injetável (testes): dado config+env, devolve se o modelo está USÁVEL pelo
   * agente. Default: `probeModelUsable`. Só é consultado no caminho via agente.
   *
   * Aceita `boolean` (forma antiga: `true`=ok, `false`=inacessível) OU um `ModelPreflight`,
   * que é o que distingue "não alcancei" de "a credencial não serve" — a distinção que
   * faltava quando os três complementos falharam com 401 e a instalação declarou sucesso.
   */
  modelProbe?: (
    config: ReturnType<UserConfigStore['load']>,
    env: NodeJS.ProcessEnv,
  ) => Promise<boolean | ModelPreflight>;
}): Promise<number> {
  const { out, err } = opts;

  // Lê config (fail-safe: ausente/corrompido ⇒ defaults).
  const configStore = opts.configStore ?? new UserConfigStore();
  let profile: 'turbo' | 'leve' | undefined;
  let sidecarToggles: { ollama?: boolean; mem0?: boolean } | undefined;
  let config: ReturnType<UserConfigStore['load']>;
  try {
    config = configStore.load();
    profile = config.profile;
    sidecarToggles = config.sidecarToggles;
  } catch {
    config = {};
    // fail-safe: defaults
  }

  // ── Wizard de 1ª execução ─────────────────────────────────────────────────
  const isInteractive =
    opts.isInteractive !== undefined
      ? opts.isInteractive
      : process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (opts.prompt !== undefined || !isInteractive) {
    // Só roda o wizard com prompt explícito OU em não-interativo (p/ reportar).
    const promptFn = opts.prompt ?? (async () => '');
    const ok = await runFirstRunWizard({
      config,
      configStore,
      prompt: promptFn,
      out,
      err,
      ...(opts.entryFactory !== undefined ? { entryFactory: opts.entryFactory } : {}),
      ...(opts.volatileProbe !== undefined ? { volatileProbe: opts.volatileProbe } : {}),
      ...(opts.fileVault !== undefined ? { fileVault: opts.fileVault } : {}),
      isInteractive,
    });
    if (!ok) {
      return 0; // wizard reportou o que falta (não-interativo) ou usuário desistiu
    }
  }

  out('O Aluy CLI já está instalado e pronto para uso.');
  out('');
  out('Esta etapa instala os COMPLEMENTOS opcionais (modo turbo): memória, modelos');
  out('locais e gestão de contexto. Eles enriquecem a experiência, mas não são');
  out('obrigatórios — se algum não instalar, você usa o Aluy CLI normalmente sem ele.');
  out('');
  out(`  Perfil escolhido: ${profile ?? 'turbo'}`);

  if (profile === 'leve') {
    out('  Perfil LEVE: nenhum complemento será instalado — o Aluy CLI já está pronto.');
    out('  Para instalá-los depois, rode `aluy bootstrap` ou troque para o perfil turbo.');
    return 0;
  }

  // O AGENTE EMBUTIDO instala os complementos em QUALQUER SO (decisão do dono): detecta a
  // distro/gerenciador, instala os PRÉ-REQUISITOS que faltam (python/pip/venv, zstd/tar — com
  // sudo) e o sidecar, e ACOMPANHA/trata os problemas. ⚠ Roda em --yolo (acesso total à
  // máquina) — optar pelo TURBO é o consentimento. `--no-agent` força o caminho direto (tarball
  // pinado, só Linux com python já pronto), para quem prefere não rodar o agente.
  let useAgent = opts.agent !== false;
  // PREFLIGHT (só p/ o caminho via agente): o instalador-agente PRECISA falar com o modelo.
  // DUAS falhas distintas o impedem, e antes só UMA era vista:
  //   • INACESSÍVEL — o endpoint não responde (típico em máquina do zero, inclusive quando o
  //     próprio modelo seria o ollama local que ainda não subiu). Achado do dono.
  //   • NÃO-AUTORIZADO — o endpoint responde, mas RECUSA a credencial (401). Achado do dono
  //     na instalação do Windows: as três delegações ao agente morreram em
  //     "erro de broker: credencial inválida ou expirada (401)" e o preflight tinha passado,
  //     porque a sonda antiga tratava QUALQUER resposta HTTP como "alcançável ⇒ pode rodar".
  // Nos dois casos caímos no caminho DIRETO em vez de "polir no vazio" — mas o 401 ganha uma
  // mensagem ACIONÁVEL (`aluy login`), senão o usuário fica sem saber o que consertar.
  // Injetável p/ teste.
  if (useAgent) {
    const probe = opts.modelProbe ?? ((c, e) => probeModelUsable({ config: c, env: e }));
    const verdict = await probe(config, opts.env ?? process.env);
    const preflight: ModelPreflight =
      typeof verdict === 'boolean' ? { status: verdict ? 'ok' : 'unreachable' } : verdict;
    if (preflight.status !== 'ok') {
      if (preflight.status === 'unauthorized') {
        out('  ⚠ A credencial do modelo NÃO foi aceita — o instalador via agente não pode rodar.');
        if (preflight.detail !== undefined) out(`    ${preflight.detail}`);
      } else {
        out('  ⚠ O modelo não respondeu — o instalador via agente precisa dele para rodar.');
        if (preflight.detail !== undefined) out(`    ${preflight.detail}`);
      }
      out('  Caindo no caminho DIRETO (--no-agent), que provisiona sem usar modelo.');
      out('');
      useAgent = false;
    }
  }
  if (useAgent) {
    out('  Instalando os complementos com o próprio aluy — ele detecta o sistema, instala o que');
    out(
      '  faltar (Python, pip, etc.) e os complementos. ⚠ Acesso total à máquina (com sudo quando',
    );
    out('  preciso). Você verá o progresso de cada um abaixo.');
  } else {
    out(
      '  Instalando os complementos pelo caminho direto (--no-agent; requer Python já pronto)...',
    );
  }
  out('');

  // Embedder ESCOLHIDO (config-driven) p/ o provisioner puxar+verificar o modelo certo
  // (env > config.embedder > default bge-m3). Exposto via env, lido por `provisionEmbedderModel`.
  process.env.ALUY_MEM0_EMBEDDER = resolveEmbedderModel(config);

  const result = await runProvisioner(profile, sidecarToggles, { useAgent });

  // ÍCONE pela AFIRMAÇÃO, não só pela saúde. `installed` responde "está saudável AGORA" — e um
  // sidecar que já existia responde `true` mesmo quando o provisionamento não chegou a rodar
  // (o 401 do dono). ⚠ marca exatamente esse caso; ✓ fica para o que instalamos ou verificamos
  // sem falha. Alvo sem `outcome` (caminhos que ainda não classificam) cai no critério antigo.
  for (const t of result.targets) {
    const icon = t.outcome === 'failed-but-present' ? '⚠' : t.installed ? '✓' : '✗';
    out(`  ${icon} ${t.target}: ${t.message}`);
  }

  out('');

  // "Complementos instalados." era uma AFIRMAÇÃO CEGA: saía sempre que ALGUM alvo estivesse
  // saudável, inclusive quando nada tinha sido instalado nesta execução — foi a linha que
  // fechou com sucesso a instalação em que os três complementos falharam com 401. E a ressalva
  // estava pendurada em `allFailed`, que é MUTUAMENTE EXCLUSIVO com `anySuccess`
  // (`some(installed)` vs `every(!installed)`) ⇒ era código morto, nunca imprimia.
  const instalouAgora = result.targets.some(
    (t) => t.outcome === 'installed' || (t.outcome === undefined && t.installed),
  );
  const provisionamentoFalhou = result.targets.some((t) => t.outcome === 'failed-but-present');
  const algumFalhou = result.targets.some((t) => !t.installed);

  if (result.anySuccess) {
    out(
      instalouAgora
        ? 'Complementos instalados. O Aluy CLI está pronto, agora com o modo turbo.'
        : 'Nada novo foi instalado — os complementos já estavam presentes. O Aluy CLI está ' +
            'pronto, agora com o modo turbo.',
    );
    if (provisionamentoFalhou) {
      out(
        '⚠ Atenção: o instalador via agente NÃO rodou para pelo menos um complemento (veja acima).',
      );
      out('  O que responde é a instalação anterior; resolva a falha e re-rode `aluy bootstrap`.');
    }
    if (algumFalhou) {
      out('Observação: alguns complementos não instalaram — o Aluy CLI funciona sem eles.');
    }
    return 0;
  }

  if (result.targets.length === 0) {
    out('Nenhum complemento a instalar — o Aluy CLI já está pronto.');
    return 0;
  }

  err('Nenhum complemento foi instalado agora — sem problema, o Aluy CLI funciona');
  err('normalmente. Você pode tentar de novo depois com `aluy bootstrap`.');
  return 1;
}

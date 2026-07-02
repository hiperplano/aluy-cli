// ADR-0120 / EST-1113/1114 — `aluy login --provider <p> [--oauth]` (backend LOCAL).
//
// Dois caminhos, escolha do usuário:
//   · API KEY (default): grava a chave BYO do provider no KEYCHAIN (lê de `--token`
//     ou de um prompt secreto). Via "limpa" (paga-por-uso, suportada oficialmente).
//   · OAUTH-PKCE (`--oauth`): login por ASSINATURA (Claude Pro/Max, ChatGPT). Gera
//     PKCE, ABRE O BROWSER no authorize URL (loopback redirect), recebe o `code`,
//     troca por tokens e os grava no keychain (refresh automático no uso). ⚠ ZONA
//     CINZENTA DE ToS (aviso explícito antes de abrir o browser).
//
// I/O concreto (keychain, browser, loopback server) ⇒ @hiperplano/aluy-cli (ADR-0053 §8). A
// lógica PKCE/troca é PURA no core. CLI-SEC-2: segredo só no keychain, nunca em claro.

import { createServer } from 'node:http';
import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import {
  generatePkcePair,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  type PkceCrypto,
  type OAuthFetch,
  type LocalProviderKind,
} from '@hiperplano/aluy-cli-core';
import { realTerminalIO, type TerminalIO } from '../auth/io.js';
import {
  storeApiKey,
  genericApiKeyEnvName,
  LOCAL_KEYCHAIN_SERVICE,
  type KeyringEntry,
} from '../model/local/credential-resolver.js';
import {
  keychainIsVolatile,
  volatileKeychainWarning,
  type VolatileKeychainProbeOptions,
} from '../auth/keychain-volatility.js';
import { loadLocalProviderCatalog } from '../io/providers-config.js';
import { UserConfigStore } from '../io/user-config.js';
import { OAuthTokenStore } from '../model/local/oauth-store.js';
import {
  resolveOAuthProviderConfig,
  DEFAULT_LOOPBACK_PORT,
} from '../model/local/oauth-providers.js';

/** Aviso de ToS exibido antes do OAuth de assinatura (ADR-0120). */
const TOS_WARNING =
  '⚠ AVISO: usar token de ASSINATURA (Claude Pro/Max, ChatGPT) em cliente não-oficial é\n' +
  '  zona cinzenta dos Termos do provider. É uma opção consciente sua. A via API key\n' +
  '  (`aluy login --provider <p>` sem --oauth) é paga-por-uso e não tem essa ressalva.';

export interface LocalLoginOptions {
  readonly provider: string;
  readonly oauth?: boolean;
  /** API key inline (`--token`). Sem ele (modo apikey) ⇒ prompt secreto. */
  readonly token?: string;
}

export interface LocalLoginDeps {
  readonly io?: TerminalIO;
  readonly env?: NodeJS.ProcessEnv;
  /** Fábrica de Entry do keychain (testes). */
  readonly entryFactory?: (service: string, account: string) => KeyringEntry;
  /** `fetch` p/ a troca de token OAuth (testes). */
  readonly fetch?: OAuthFetch;
  /** Abridor de browser (testes). Default: tenta abrir; em CI imprime a URL. */
  readonly openBrowser?: (url: string) => Promise<void>;
  /** Crypto PKCE (testes determinísticos). Default: node:crypto. */
  readonly crypto?: PkceCrypto;
  readonly now?: () => number;
  /** F165 — sonda de cofre volátil injetável (testes): platform/leitor de /proc/keys. */
  readonly volatileProbe?: Omit<VolatileKeychainProbeOptions, 'service'>;
}

/** Crypto PKCE real (node:crypto). */
const nodeCrypto: PkceCrypto = {
  randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
  sha256: (input) => new Uint8Array(createHash('sha256').update(input).digest()),
};

/**
 * Valida o provider contra o CATÁLOGO (ADR-0118): built-ins + `~/.aluy/providers.json`.
 * Aceita qualquer id conhecido — incl. custom OpenAI-compatível (ex.: `tokenrouter`) que
 * o `aluy onboard`/`provider add` tenham registrado. (Antes travava nos 3 hardcoded ⇒
 * `aluy login --provider tokenrouter` era rejeitado mesmo com o provider no catálogo.)
 * Retorna `undefined` + erro impresso (com a lista conhecida) se desconhecido.
 */
function validateProvider(io: TerminalIO, raw: string): LocalProviderKind | undefined {
  const p = raw.trim().toLowerCase();
  const catalog = loadLocalProviderCatalog();
  if (catalog.entries.some((e) => e.id === p)) return p as LocalProviderKind;
  const known = catalog.entries.map((e) => e.id).join(', ');
  io.err(
    `login: provider desconhecido "${raw}". Conhecidos: ${known}.\n` +
      '  Custom (OpenAI-compatível)? Registre antes: `aluy onboard` (ou edite ~/.aluy/providers.json).',
  );
  return undefined;
}

/** `aluy login --provider <p> [--oauth]`. Retorna o exit code. */
export async function runLocalLogin(
  opts: LocalLoginOptions,
  deps: LocalLoginDeps = {},
): Promise<number> {
  const io = deps.io ?? realTerminalIO();
  const provider = validateProvider(io, opts.provider);
  if (provider === undefined) return 2;

  if (opts.oauth === true) {
    return await runOAuthLogin(provider, io, deps);
  }
  return await runApiKeyLogin(provider, opts.token, io, deps);
}

/** Caminho API key: lê a chave (flag/prompt secreto) e grava no keychain. */
async function runApiKeyLogin(
  provider: LocalProviderKind,
  inlineToken: string | undefined,
  io: TerminalIO,
  deps: LocalLoginDeps,
): Promise<number> {
  let key = inlineToken?.trim();
  if (key === undefined || key === '') {
    key = (await io.prompt(`Cole a API key de ${provider}: `, { secret: true })).trim();
  }
  if (key === '') {
    io.err('login: nenhuma chave informada.');
    return 1;
  }
  try {
    storeApiKey(provider, key, deps.entryFactory);
  } catch (err) {
    io.err(`login: falha ao gravar no keychain do SO: ${errMsg(err)}`);
    io.err(
      '  (Por segurança, a credencial nunca é gravada em texto em claro. Instale/ative o Secret Service no Linux.)',
    );
    return 1;
  }
  io.out(`✓ API key de ${provider} guardada no keychain do SO.`);
  // F165 — sem Secret Service, o write acima caiu no keyring do KERNEL (memória):
  // a chave "some" no próximo reboot e o dono redescobre na pior hora. Avisa AGORA,
  // com o caminho de correção (Secret Service ou a env que o resolvedor lê).
  if (keychainIsVolatile({ service: LOCAL_KEYCHAIN_SERVICE, ...(deps.volatileProbe ?? {}) })) {
    for (const line of volatileKeychainWarning(genericApiKeyEnvName(provider))) io.err(line);
  }
  // DETERMINÍSTICO — configura `backend:local` + provider de uma vez. Assim
  // `aluy login --provider X --token Y` deixa TUDO pronto (a sessão já abre em local com
  // este provider), sem depender do onboard nem de editar config à mão. Best-effort: uma
  // falha de escrita do config não derruba o login (a chave já está no keychain).
  try {
    new UserConfigStore().save({ backend: 'local', localProvider: provider });
    io.out(`  backend local + provider "${provider}" configurados. Rode:  aluy`);
  } catch {
    io.out(`  Use: aluy --backend local --local-provider ${provider}  (ou ALUY_BACKEND=local)`);
  }
  return 0;
}

/** Caminho OAuth-PKCE: abre o browser, recebe o code (loopback), troca por tokens. */
async function runOAuthLogin(
  provider: LocalProviderKind,
  io: TerminalIO,
  deps: LocalLoginDeps,
): Promise<number> {
  const env = deps.env ?? process.env;
  io.err(TOS_WARNING);

  let config;
  try {
    config = resolveOAuthProviderConfig(provider, env);
  } catch (err) {
    io.err(`login: ${errMsg(err)}`);
    return 2;
  }

  const crypto = deps.crypto ?? nodeCrypto;
  const pkce = generatePkcePair(crypto);
  const state = base64Url(crypto.randomBytes(16));
  const authorizeUrl = buildAuthorizeUrl(config, pkce, state);

  // Recebe o `code` via loopback redirect (ou colar-código se o server não subir).
  let code: string;
  try {
    code = await receiveCode({ authorizeUrl, state, io, deps });
  } catch (err) {
    io.err(`login: ${errMsg(err)}`);
    return 1;
  }

  const fetchFn = deps.fetch ?? (globalThis.fetch as unknown as OAuthFetch);
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({
      config,
      code,
      codeVerifier: pkce.codeVerifier,
      fetch: fetchFn,
      ...(deps.now ? { now: deps.now } : {}),
    });
  } catch (err) {
    io.err(`login: troca de token falhou: ${errMsg(err)}`);
    return 1;
  }

  try {
    const store = new OAuthTokenStore({
      provider,
      config,
      ...(deps.entryFactory ? { entryFactory: deps.entryFactory } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    });
    store.write(tokens);
  } catch (err) {
    io.err(`login: falha ao gravar tokens no keychain: ${errMsg(err)}`);
    return 1;
  }
  io.out(`✓ login OAuth de ${provider} concluído (token no keychain; refresh automático).`);
  io.out(`  Use: aluy --backend local --local-provider ${provider} --local-auth oauth`);
  return 0;
}

/**
 * Abre o browser no authorize URL e espera o redirect loopback com o `code`. Se o
 * server loopback não subir (ambiente sem rede/permite), CAI p/ colar-código.
 */
async function receiveCode(args: {
  authorizeUrl: string;
  state: string;
  io: TerminalIO;
  deps: LocalLoginDeps;
}): Promise<string> {
  const { authorizeUrl, state, io, deps } = args;
  // Tenta o fluxo loopback (melhor UX). Falha ⇒ colar-código.
  try {
    return await loopbackFlow(authorizeUrl, state, io, deps);
  } catch {
    io.out('Não foi possível abrir o servidor loopback — modo colar-código.');
    io.out(`Abra esta URL no navegador e autorize:\n  ${authorizeUrl}`);
    const pasted = await io.prompt('Cole o código de autorização: ');
    if (pasted.trim() === '') throw new Error('nenhum código colado');
    return pasted.trim();
  }
}

/**
 * EST-1115 (ressalva #3) — guarda de MÉTODO do callback loopback do OAuth: aceita só
 * GET (o redirect do browser). Qualquer outro método ⇒ responde 405 e devolve `true`
 * (o chamador para). Exportado p/ teste sem subir o fluxo OAuth inteiro.
 */
export function rejectNonGetCallback(
  method: string | undefined,
  res: { statusCode: number; setHeader(n: string, v: string): void; end(b: string): void },
): boolean {
  if ((method ?? 'GET').toUpperCase() === 'GET') return false;
  res.statusCode = 405;
  res.setHeader('allow', 'GET');
  res.end('method not allowed');
  return true;
}

/** Sobe um server loopback efêmero, abre o browser e resolve com o `code` do redirect. */
function loopbackFlow(
  authorizeUrl: string,
  expectedState: string,
  io: TerminalIO,
  deps: LocalLoginDeps,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      // EST-1115 (ressalva #3 do seguranca) — o callback do OAuth-PKCE é um redirect
      // do browser ⇒ SEMPRE GET. Recusar qualquer outro método fecha o vetor de um
      // POST forjado (CSRF/abuso do endpoint loopback) atingir o handler.
      if (rejectNonGetCallback(req.method, res)) return;
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${DEFAULT_LOOPBACK_PORT}`);
      if (url.pathname !== '/callback') {
        res.statusCode = 404;
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      if (gotState !== expectedState || code === null || code === '') {
        res.statusCode = 400;
        res.end('<h3>Falha na autorização (state inválido ou sem código). Volte ao terminal.</h3>');
        server.close();
        reject(new Error('redirect sem código válido (state mismatch)'));
        return;
      }
      res.end('<h3>Autorizado. Pode fechar esta aba e voltar ao terminal.</h3>');
      server.close();
      resolve(code);
    });
    server.on('error', (err) => reject(err));
    server.listen(DEFAULT_LOOPBACK_PORT, '127.0.0.1', () => {
      io.out(`Aguardando autorização no navegador (loopback :${DEFAULT_LOOPBACK_PORT})…`);
      const open = deps.openBrowser ?? defaultOpenBrowser(io);
      void open(authorizeUrl).catch(() => {
        io.out(`Abra manualmente:\n  ${authorizeUrl}`);
      });
    });
    // Anti-hang: timeout de 5 min (não pendura o processo p/ sempre).
    const timer = setTimeout(
      () => {
        server.close();
        reject(new Error('tempo esgotado aguardando a autorização (5 min)'));
      },
      5 * 60 * 1000,
    );
    timer.unref?.();
  });
}

/** Abre o browser do SO (best-effort, multiplataforma). */
function defaultOpenBrowser(io: TerminalIO): (url: string) => Promise<void> {
  return async (url: string) => {
    const { spawn } = await import('node:child_process');
    const platform = process.platform;
    const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.unref();
    } catch {
      io.out(`Abra manualmente:\n  ${url}`);
    }
  };
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

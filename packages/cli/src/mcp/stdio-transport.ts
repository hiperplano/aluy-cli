// EST-0970 · ADR-0058 · CLI-SEC-12 — TRANSPORTE STDIO CONCRETO (SDK MCP oficial).
//
// Implementa a porta `McpTransport` (cli-core) lançando o server LOCAL com o SDK
// oficial `@modelcontextprotocol/sdk` (TS, MIT — registrado em docs/licencas-
// referencia.md, Q9). Lança o processo (command/args/env), faz o handshake
// (`Client.connect` → initialize), lista as tools (`listTools`) e chama
// (`callTool`). A LÓGICA portável (descoberta/adaptação/classificação) mora no
// core; AQUI é só o I/O de processo + a tradução do shape do SDK.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ EST-1010 — TIMEOUT + CAP no `callTool` (fail-soft, anti-hang/anti-OOM).      ║
// ║ Um server MCP PENDURADO (callTool que nunca resolve) NÃO pode congelar o     ║
// ║ loop do agente: toda chamada tem TETO de tempo (`ALUY_MCP_TIMEOUT_MS`, 60s   ║
// ║ default). No estouro: a chamada devolve `{ ok:false }` com observação clara   ║
// ║ ("MCP não respondeu em Ns") e RESETA o transport daquele server (mata o       ║
// ║ processo) — degrada SÓ aquele server, NÃO derruba a sessão. Dupla cinta:      ║
// ║ (a) o `timeout` NATIVO do SDK (cancela o request internamente) +              ║
// ║ (b) um watchdog `Promise.race` HARD aqui — caso o promise do SDK nunca         ║
// ║ assente (stall que o timer interno não pegue), o loop ainda destrava.         ║
// ║ Além disso, `extractTextContent` trunca CADA bloco por BYTES ANTES de          ║
// ║ concatenar: um bloco de vários GB NÃO é materializado inteiro (OOM upstream    ║
// ║ do clip de 20K do adapter). Ver `tool-adapter.ts` (clip agregado).            ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ CLI-SEC-7 / E-B1 — A CREDENCIAL HEADLESS DO CLI NUNCA VAI AO ENVIRON DO     ║
// ║ SERVER. O environ do processo-server parte de um conjunto MÍNIMO (NÃO        ║
// ║ `process.env`) — só PATH/HOME/etc. de SO + o `env` DECLARADO POR-SERVER no   ║
// ║ `mcp.json` (escopo mínimo). `ALUY_TOKEN`/refresh/qualquer segredo do CLI     ║
// ║ JAMAIS é repassado: um server que faça `echo $ALUY_TOKEN` vê vazio (testado).║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ EST-1011 · ADR-0065 §11.2 (E-B3 / FU-VAU-11-bis) — o processo-server MCP      ║
// ║ AGORA RODA DENTRO DO SANDBOX DE SO quando há um `sandboxLauncher` (gate atrás  ║
// ║ do opt-in `ALUY_SANDBOX_MCP`, default-OFF — irmão do `ALUY_SANDBOX_BASH`). O   ║
// ║ `connect()` reescreve o `command`/`args`/`cwd` p/ o invólucro `bwrap` do MESMO  ║
// ║ `BwrapSandboxLauncher` que o bash usa: o filho só vê o WORKSPACE, NUNCA          ║
// ║ `~/.ssh`/`~/.aws`/`~/.aluy`/`$HOME` (invariante a), net-deny por default          ║
// ║ (invariante d — server sem aprovação NÃO conecta), seccomp nega fuga (c). O      ║
// ║ handshake `initialize` + `callTool` fluem ATRAVÉS do sandbox pois os fds 0/1/2   ║
// ║ do SDK passam intocados ao bwrap (→ ao server). SEM `sandboxLauncher` (default)   ║
// ║ ⇒ caminho ATUAL intocado (server cru, cwd=workspace, environ mínimo). Fail-mode   ║
// ║ D-SB-4: sem `bwrap` ⇒ degrade/refuse como o bash, NUNCA finge confinamento.       ║
// ╚══════════════════════════════════════════════════════════════════════════╝

import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { delimiter, isAbsolute, join as pathJoin } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type {
  McpCallResult,
  McpServerConfig,
  McpToolDescriptor,
  McpTransport,
} from '@hiperplano/aluy-cli-core';
import { CORE_VERSION } from '@hiperplano/aluy-cli-core';
import type { BwrapSandboxLauncher, ConfinedInvocation } from '../sandbox/index.js';

/** Sentinela do watchdog de `callTool` (EST-1010): distingue "estourou o teto" de
 *  um resultado real do server (que é um objeto). */
const CALL_TIMED_OUT = Symbol('mcp-call-timed-out');

/** BUG-0028 — sentinela do race de ABORT: o usuário cancelou (ESC/Ctrl-C) a chamada
 *  EM VOO. Distinto do teto (CALL_TIMED_OUT) e de um resultado real (objeto). */
const CALL_ABORTED = Symbol('mcp-call-aborted');

/**
 * EST-1011 — PATHS DE LANÇAMENTO a RO-bindar no sandbox p/ o server poder EXECUTAR.
 *
 * O confinamento monta o WORKSPACE + o mínimo de sistema (`/usr`,`/bin`,...), mas o
 * BINÁRIO do server (ex.: `node` de um nvm em `~/.nvm/...`, `npx`, um intérprete fora
 * de `/usr`) e o SCRIPT do server (ex.: `/path/server.mjs`) podem viver FORA disso —
 * e o `bwrap` falharia com "execvp: No such file or directory". Estes paths NÃO são
 * segredos: vêm do `mcp.json` (DADO de config que o DONO declarou) e são NECESSIDADE
 * de partida. RO-bindamos NARROW (só o arquivo exato, read-only) — o binário e o
 * script, nunca um diretório de `$HOME` inteiro. O lançador ainda REJEITA qualquer um
 * que alcance `~/.aluy/` (assertNoAluyHome) — defesa em profundidade preservada.
 *
 * Resolve:
 *  - `command`: se absoluto e existe ⇒ ele mesmo; senão procura no PATH (como o
 *    `cross-spawn`/SO fariam) e bindeia o resultado. Não-encontrado ⇒ omitido (o
 *    `bwrap` reporta o erro de exec honestamente; não inventamos um bind).
 *  - `args`: cada arg que seja um PATH ABSOLUTO de arquivo EXISTENTE (o script do
 *    server). Args que não são arquivo (flags, nomes de tool) são ignorados.
 *
 * NUNCA bindeia paths sob system (já montados) p/ não duplicar; o `--ro-bind-try` do
 * lançador ignoraria, mas evitamos o ruído. Puro/best-effort: erro de `stat` ⇒ omite.
 */
export function resolveLaunchBinds(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const binds = new Set<string>();
  const bin = resolveExecutablePath(command, env);
  if (bin && !isUnderSystemPath(bin)) binds.add(bin);
  for (const a of args) {
    if (isAbsolute(a) && isExistingFile(a) && !isUnderSystemPath(a)) binds.add(a);
  }
  return [...binds];
}

/** Paths já montados pelo lançador (SYSTEM_RO_PATHS) — não precisam de bind extra. */
const SYSTEM_PREFIXES: readonly string[] = ['/usr/', '/bin/', '/sbin/', '/lib', '/etc/'];
function isUnderSystemPath(p: string): boolean {
  return SYSTEM_PREFIXES.some((pre) => p === pre.replace(/\/$/, '') || p.startsWith(pre));
}

function isExistingFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Resolve um executável: absoluto-existente ⇒ ele; senão varre o PATH. */
function resolveExecutablePath(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (isAbsolute(command)) return isExistingFile(command) ? command : undefined;
  // sem separador de diretório ⇒ procura no PATH (igual ao SO/cross-spawn).
  if (command.includes('/')) return undefined; // relativo com '/' — não resolvemos (raro)
  const pathVar = env['PATH'] ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    const candidate = pathJoin(dir, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      /* não executável aqui; tenta o próximo */
    }
  }
  return undefined;
}

/** Chaves de ambiente de SO MÍNIMAS herdadas (NUNCA segredo do CLI). */
const SAFE_INHERITED_ENV_KEYS: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  // EST-1011 — necessárias p/ o `systemd-run --user` (cgroup §13.2) alcançar o BUS do
  // systemd do usuário quando o server roda confinado. NÃO são segredos (caminhos de
  // socket de sessão); sem elas o cgroup degrada com "Failed to connect to user bus".
  // Dentro do sandbox o path é inalcançável (namespace), então é inócuo o server vê-las.
  'XDG_RUNTIME_DIR',
  'DBUS_SESSION_BUS_ADDRESS',
  // GUI/display — necessárias p/ ferramentas MCP gráficas (ex.: Playwright em modo HEADED)
  // acharem a tela do usuário. São caminhos de SESSÃO (X/Wayland), NÃO segredos: sem elas,
  // o server cai em headless mesmo num desktop (achado do dono). `XAUTHORITY` é o PATH do
  // cookie de auth do X (o arquivo em si é access-controlled). Num servidor sem GUI ficam
  // ausentes e é inócuo. (Headed continua impossível onde não há display — ex.: SSH puro.)
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  // Windows
  'SystemRoot',
  'SystemDrive',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'PATHEXT',
  'COMSPEC',
];

/**
 * Prefixos de variável que JAMAIS vão ao server, mesmo se viessem do `env`
 * declarado por engano. Defesa-em-profundidade sobre o environ mínimo (CLI-SEC-7):
 * a credencial do Aluy e segredos óbvios de provider são barrados explicitamente.
 */
const FORBIDDEN_ENV_PATTERNS: readonly RegExp[] = [
  /^ALUY_/i,
  /TOKEN$/i,
  /SECRET$/i,
  /_KEY$/i,
  /APIKEY$/i,
  /PASSWORD$/i,
  /REFRESH/i,
  /OPENAI|ANTHROPIC|OPENROUTER/i,
];

/**
 * Constrói o environ MÍNIMO do processo-server (CLI-SEC-7). Parte das chaves de SO
 * seguras herdadas de `parentEnv` + o `env` DECLARADO no `mcp.json` (escopo
 * mínimo, por-server). NUNCA repassa a credencial headless do CLI nem segredos
 * óbvios. Exportada p/ teste: `buildServerEnv(server, { ALUY_TOKEN: 's' })` ⇒ sem
 * `ALUY_TOKEN`.
 */
export function buildServerEnv(
  server: McpServerConfig,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  // 1) só as chaves de SO seguras do pai (NÃO o environ inteiro).
  for (const k of SAFE_INHERITED_ENV_KEYS) {
    const v = parentEnv[k];
    if (typeof v === 'string' && !isForbiddenEnvKey(k)) out[k] = v;
  }
  // 2) o `env` declarado por-server (DADO de config). Barrado se casar um padrão
  //    proibido (um `mcp.json` que tente injetar `ALUY_TOKEN` não passa).
  for (const [k, v] of Object.entries(server.env)) {
    if (!isForbiddenEnvKey(k)) out[k] = v;
  }
  return out;
}

function isForbiddenEnvKey(key: string): boolean {
  return FORBIDDEN_ENV_PATTERNS.some((re) => re.test(key));
}

/**
 * Teto de tempo (ms) de UMA chamada `callTool` ao server MCP (EST-1010). Default
 * 60s (igual ao `DEFAULT_REQUEST_TIMEOUT_MSEC` do SDK). Configurável por env
 * `ALUY_MCP_TIMEOUT_MS` (clamp em [1s, 10min] — valor lixo/0/negativo ⇒ default).
 * Exportado p/ teste.
 */
export const DEFAULT_MCP_CALL_TIMEOUT_MS = 60_000;
const MIN_MCP_CALL_TIMEOUT_MS = 1_000;
const MAX_MCP_CALL_TIMEOUT_MS = 600_000;

/** Resolve o teto de `callTool` a partir do env (clamp + fallback ao default). */
export function resolveMcpCallTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ALUY_MCP_TIMEOUT_MS'];
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MCP_CALL_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MCP_CALL_TIMEOUT_MS;
  return Math.min(MAX_MCP_CALL_TIMEOUT_MS, Math.max(MIN_MCP_CALL_TIMEOUT_MS, Math.round(n)));
}

/**
 * HUNT-IO-NET — TETO de tempo do HANDSHAKE (`connect`+`initialize`+`listTools`) de UM
 * server na DESCOBERTA. ANTI-HANG DE BOOT: a descoberta é SEQUENCIAL (discovery.ts) e
 * roda no STARTUP; um server que SPAWNA mas trava no `initialize`/`listTools` (server
 * bugado/hostil) penduraria a descoberta — e logo o boot inteiro — PARA SEMPRE (o
 * watchdog do EST-1010 só cobria `callTool`, NÃO o connect). Com o teto, o handshake
 * lento vira FALHA (fail-soft: discovery.ts registra `ok:false` e segue p/ o próximo
 * server). Default 20s; `ALUY_MCP_CONNECT_TIMEOUT_MS` (clamp [1s, 2min]).
 */
export const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 20_000;
const MIN_MCP_CONNECT_TIMEOUT_MS = 1_000;
const MAX_MCP_CONNECT_TIMEOUT_MS = 120_000;

/** Resolve o teto do handshake a partir do env (clamp + fallback ao default). */
export function resolveMcpConnectTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['ALUY_MCP_CONNECT_TIMEOUT_MS'];
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MCP_CONNECT_TIMEOUT_MS;
  return Math.min(MAX_MCP_CONNECT_TIMEOUT_MS, Math.max(MIN_MCP_CONNECT_TIMEOUT_MS, Math.round(n)));
}

/**
 * Contrato MÍNIMO do cliente MCP que o transport consome (EST-1010). É o subconjunto
 * de `@modelcontextprotocol/sdk` `Client` que usamos — declarado AQUI para poder
 * INJETAR um fake nos testes (ex.: um `callTool` que nunca resolve, p/ provar que o
 * watchdog destrava). A produção usa o `Client` real via `defaultClientFactory`.
 */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: { name: string; description?: unknown; inputSchema?: unknown }[] }>;
  callTool(
    params: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/** Cria o `Client` real do SDK. Substituível em teste pela opção `clientFactory`. */
function defaultClientFactory(): McpClientLike {
  return new Client({ name: 'aluy-cli', version: CORE_VERSION }) as unknown as McpClientLike;
}

export interface StdioMcpTransportOptions {
  /** `cwd` do processo-server: a raiz do workspace confinado. Default: process.cwd(). */
  readonly cwd?: string;
  /** Environ do pai (injetável p/ teste). Default: process.env. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /**
   * Teto de tempo (ms) de cada `callTool` (EST-1010). Default: `resolveMcpCallTimeoutMs`
   * (env `ALUY_MCP_TIMEOUT_MS` ou 60s). Injetável p/ teste (ex.: 30ms p/ provar o
   * fail-soft sem esperar).
   */
  readonly callTimeoutMs?: number;
  /**
   * HUNT-IO-NET — teto do HANDSHAKE (connect+listTools) na descoberta. Default:
   * `resolveMcpConnectTimeoutMs` (env ou 20s). Injetável p/ teste (ex.: 30ms p/
   * provar que um server que trava no `connect`/`listTools` NÃO pendura o boot).
   */
  readonly connectTimeoutMs?: number;
  /**
   * Fábrica do cliente MCP (EST-1010). Default: o `Client` real do SDK. Injetável
   * p/ teste — um fake cujo `callTool` nunca resolve prova que o watchdog destrava
   * o loop e reseta o transport.
   */
  readonly clientFactory?: () => McpClientLike;
  /**
   * EST-1011 · ADR-0065 §11.2 — o LANÇADOR do sandbox de SO. Quando presente, o
   * processo-server roda DENTRO do `bwrap` (o `connect` reescreve o `command`/`args`
   * p/ o invólucro confinado via `buildConfinedInvocation`). AUSENTE (default) ⇒
   * caminho atual intocado (server cru). É o MESMO `BwrapSandboxLauncher` do bash —
   * net-deny default, FS só-workspace, seccomp; fail-mode D-SB-4 (degrade/refuse).
   */
  readonly sandboxLauncher?: BwrapSandboxLauncher;
  /**
   * EST-1011 — raízes do WORKSPACE montadas RW no sandbox (o server opera em arquivos).
   * Default: `[cwd]`. NUNCA inclui `~/.aluy/`/segredos (o lançador rejeita binds que os
   * alcancem). Só tem efeito sob `sandboxLauncher`.
   */
  readonly workspaceRoots?: readonly string[];
  /**
   * EST-1011 · ADR-0065 §6 — REDE do server confinado. Default `false` (net-deny,
   * invariante d): um server SEM aprovação de rede roda SEM socket — `playwright`/`fetch`
   * degradam/falham honestamente. A abertura segue a MESMA política de egress-sob-`ask`
   * do bash (#223): só `true` quando a catraca/allowlist aprovou. Só tem efeito sob
   * `sandboxLauncher` E em `confine`. NÃO damos `--share-net` incondicional.
   */
  readonly network?: boolean;
}

/**
 * Transport stdio concreto. Uma instância = UM server. Implementa `McpTransport`:
 * `connect()` lança+handshake+listTools; `callTool()` chama; `close()` mata o
 * processo. Erros viram exceções (o core os trata: server caído ⇒ fail-soft na
 * descoberta, ou observação de erro na chamada).
 */
export class StdioMcpTransport implements McpTransport {
  private client: McpClientLike | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly cwd: string;
  private readonly parentEnv: NodeJS.ProcessEnv;
  private readonly callTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly clientFactory: () => McpClientLike;
  // EST-1011 — sandbox de SO do processo-server (opt-in via wiring). Ausente ⇒ cru.
  private readonly sandboxLauncher: BwrapSandboxLauncher | undefined;
  private readonly workspaceRoots: readonly string[];
  private readonly network: boolean;
  // Limpeza do filtro seccomp temporário do confinamento ativo (chamada no `close`).
  private confinementCleanup: (() => void) | undefined;

  constructor(opts: StdioMcpTransportOptions = {}) {
    this.cwd = opts.cwd ?? process.cwd();
    this.parentEnv = opts.parentEnv ?? process.env;
    this.callTimeoutMs = opts.callTimeoutMs ?? resolveMcpCallTimeoutMs(this.parentEnv);
    this.connectTimeoutMs = opts.connectTimeoutMs ?? resolveMcpConnectTimeoutMs(this.parentEnv);
    this.clientFactory = opts.clientFactory ?? defaultClientFactory;
    this.sandboxLauncher = opts.sandboxLauncher;
    this.workspaceRoots = opts.workspaceRoots ?? [this.cwd];
    this.network = opts.network ?? false;
  }

  async connect(server: McpServerConfig): Promise<readonly McpToolDescriptor[]> {
    const env = buildServerEnv(server, this.parentEnv);

    // EST-1011 · ADR-0065 §11.2 — CONFINAMENTO de SO do processo-server. Quando há um
    // `sandboxLauncher`, o server roda DENTRO do `bwrap` (só o workspace visível;
    // `~/.ssh`/`~/.aws`/`~/.aluy`/`$HOME` barrados por NAMESPACE; net-deny default). O
    // `decide()` do lançador (D-SB-4) escolhe confine/degrade/unsafe/refuse — NÃO esta
    // porta. SEM lançador ⇒ caminho atual (server cru). O environ MÍNIMO (CLI-SEC-7) é
    // preservado em AMBOS os caminhos.
    const { command, args, refused, warning } = this.resolveSpawnTarget(server);
    if (refused) {
      // (e) REFUSE — prod sem piso de SO e sem flag: NÃO conecta o server. LANÇA p/
      // que a descoberta (discovery.ts) registre `ok:false` (fail-soft) com o motivo.
      throw new Error(
        warning ??
          '[sandbox MCP: conexão recusada — sem piso de SO de confinamento nesta máquina (prod)]',
      );
    }
    if (warning) {
      // DEGRADE/UNSAFE ⇒ aviso INEQUÍVOCO não-suprimível (D-SB-4): o server rodou SEM
      // piso (ou COM fuga confinada mas SEM teto de recurso). Vai ao stderr do CLI.
      process.stderr.write(`aluy: MCP "${server.name}" — ${warning}\n`);
    }

    this.transport = new StdioClientTransport({
      command,
      args: [...args],
      env, // environ MÍNIMO (CLI-SEC-7) — SEM a credencial do CLI.
      // CONFINADO ⇒ o `bwrap` já faz `--chdir` p/ o workspace DENTRO do sandbox; o cwd
      // do PROCESSO bwrap na mãe é o workspace mesmo (paths relativos batem). CRU ⇒ o
      // cwd é o workspace (best-effort, como antes).
      cwd: this.cwd,
      stderr: 'ignore',
    });
    this.client = this.clientFactory();
    // HUNT-IO-NET — ANTI-HANG DE BOOT: o handshake (connect+initialize+listTools) corre
    // sob um TETO de tempo. Um server que spawna mas trava no initialize/listTools NÃO
    // pendura a descoberta (sequencial, no startup). No estouro: mata o processo e LANÇA
    // — discovery.ts trata (fail-soft: `ok:false`, segue p/ o próximo server).
    const client = this.client;
    const listed = await this.withConnectTimeout(async () => {
      await client.connect(this.transport); // handshake (initialize).
      return client.listTools();
    });
    return listed.tools.map((t) => ({
      name: t.name,
      // a descrição é DADO NÃO-CONFIÁVEL do server (E-B2/CLI-SEC-4) — o adapter a
      // marca como tal. NÃO lemos nenhum campo de "efeito/readonly" do descritor.
      description: typeof t.description === 'string' ? t.description : '',
      // EST-0970 (E-B2) — `inputSchema` declarado pelo server. DADO NÃO-CONFIÁVEL,
      // repassado COMO ESTÁ (shape arbitrário): o core o lê defensivamente
      // (paramsFromJsonSchema) só p/ DERIVAR os parâmetros que o prompt mostra. Sem
      // isto, o modelo não enxerga os campos obrigatórios de tools MCP complexas.
      inputSchema: t.inputSchema,
    }));
  }

  /**
   * EST-1011 — resolve o ALVO de spawn (programa + args) do server, aplicando o
   * sandbox de SO quando há `sandboxLauncher`. SEM lançador ⇒ o server cru (caminho
   * atual). COM lançador ⇒ o `buildConfinedInvocation` reescreve p/ o invólucro `bwrap`
   * (confine) ou devolve o server cru + aviso (degrade/unsafe) ou `refused` (refuse).
   * Guarda o `cleanup()` do filtro temporário p/ o `close()` chamar quando o server
   * morrer.
   */
  private resolveSpawnTarget(server: McpServerConfig): {
    command: string;
    args: readonly string[];
    refused: boolean;
    warning?: string;
  } {
    if (!this.sandboxLauncher) {
      // caminho atual intocado (flag OFF): server cru, cwd=workspace, environ mínimo.
      return { command: server.command, args: server.args, refused: false };
    }
    // RO-binds de LANÇAMENTO: o binário do server + seu script (paths do `mcp.json`,
    // DADO de config, NÃO segredos) p/ o `bwrap` poder EXECUTAR o server quando ele
    // vive fora de `/usr` (ex.: `node` de um nvm). Narrow (só os arquivos exatos). O
    // lançador ainda rejeita qualquer um sob `~/.aluy/` (defesa em profundidade).
    const launchBinds = resolveLaunchBinds(server.command, server.args, this.parentEnv);
    const invocation: ConfinedInvocation = this.sandboxLauncher.buildConfinedInvocation(
      [server.command, ...server.args],
      {
        workspaceRoots: this.workspaceRoots,
        cwd: this.cwd,
        ...(launchBinds.length > 0 ? { roBinds: launchBinds } : {}),
        // (d) net-deny default — só abre sob a política de egress-sob-`ask` (#223).
        network: this.network,
      },
    );
    // guarda a limpeza do filtro seccomp temporário (removido no `close()`).
    this.confinementCleanup = invocation.cleanup;
    if (!invocation.command) {
      // refuse: sem command ⇒ não conecta. Limpa já (nada foi spawnado).
      this.runConfinementCleanup();
      return {
        command: '',
        args: [],
        refused: true,
        ...(invocation.decision.warning ? { warning: invocation.decision.warning } : {}),
      };
    }
    // degrade/unsafe ⇒ aviso do piso (decision.warning); confine-sem-cgroup ⇒ aviso
    // aditivo de recurso (invocation.warning). Ortogonais; só um existe por vez.
    const warning = invocation.decision.warning ?? invocation.warning;
    return {
      command: invocation.command,
      args: invocation.args ?? [],
      refused: false,
      ...(warning ? { warning } : {}),
    };
  }

  /** Roda (uma vez) a limpeza do filtro seccomp temporário do confinamento ativo. */
  private runConfinementCleanup(): void {
    const cleanup = this.confinementCleanup;
    this.confinementCleanup = undefined;
    if (cleanup) {
      try {
        cleanup();
      } catch {
        /* best-effort — o dir temporário pode já ter sumido */
      }
    }
  }

  /**
   * HUNT-IO-NET — corre o handshake sob um teto de tempo (watchdog HARD via
   * `Promise.race`). No estouro: mata o processo-server (best-effort) e LANÇA — quem
   * chama (discovery.ts) registra `ok:false` e segue. Mantém o transport ZERADO no
   * timeout (o próximo uso falha limpo, não empilha sobre um handshake travado).
   */
  private async withConnectTimeout<T>(fn: () => Promise<T>): Promise<T> {
    const timeoutMs = this.connectTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<typeof CALL_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(CALL_TIMED_OUT), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
    });
    let res: T | typeof CALL_TIMED_OUT;
    try {
      res = await Promise.race([fn(), watchdog]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (res === CALL_TIMED_OUT) {
      // server PENDURADO no handshake: mata o processo e zera o estado, depois lança.
      const client = this.client;
      this.client = null;
      this.transport = null;
      try {
        await client?.close();
      } catch {
        // já podia estar morto/travado; estado já zerado.
      }
      // EST-1011 — server morto ⇒ remove o filtro seccomp temporário (não vaza).
      this.runConfinementCleanup();
      throw new Error(
        `handshake MCP não respondeu em ${Math.round(timeoutMs / 1000)}s (anti-hang de boot).`,
      );
    }
    return res;
  }

  async callTool(
    toolName: string,
    input: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const client = this.client;
    if (!client) {
      return { ok: false, content: `server não conectado` };
    }
    // BUG-0028 — abort do ESC/Ctrl-C ANTES de iniciar ⇒ não chama nada (curto-circuito).
    if (signal?.aborted) {
      return {
        ok: false,
        content: `MCP tool "${toolName}" cancelada pelo usuário (ESC/Ctrl-C) antes de iniciar.`,
      };
    }
    // EST-1010 — DUPLA CINTA contra server pendurado:
    //  (a) `timeout` NATIVO do SDK: o `Client` cancela o request internamente e
    //      rejeita com McpError(RequestTimeout). Limpo (não deixa request pendente).
    //  (b) watchdog HARD via `Promise.race`: caso o promise do SDK NUNCA assente
    //      (um fake/stall que ignore o timer interno), o loop do agente AINDA
    //      destrava no nosso teto — NUNCA congela.
    const timeoutMs = this.callTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<typeof CALL_TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(CALL_TIMED_OUT), timeoutMs);
      // não segura o event-loop vivo só por causa do watchdog.
      (timer as { unref?: () => void }).unref?.();
    });
    // BUG-0028 — TERCEIRA cinta: o abort do ESC/Ctrl-C cancela a chamada EM VOO. O
    // `signal` vai TAMBÉM ao SDK (cancelamento nativo do request); este race garante
    // que o `await` DESTRAVE NA HORA mesmo que o SDK ignore o signal — o ESC nunca
    // mais espera o teto de 60s numa tool MCP travada (o caso real do RPA).
    let onAbort: (() => void) | undefined;
    const abortRace = signal
      ? new Promise<typeof CALL_ABORTED>((resolve) => {
          onAbort = (): void => resolve(CALL_ABORTED);
          signal.addEventListener('abort', onAbort, { once: true });
        })
      : undefined;

    let res: Record<string, unknown> | typeof CALL_TIMED_OUT | typeof CALL_ABORTED;
    try {
      res = await Promise.race([
        client.callTool({ name: toolName, arguments: { ...input } }, undefined, {
          timeout: timeoutMs,
          ...(signal ? { signal } : {}),
        }),
        watchdog,
        ...(abortRace ? [abortRace] : []),
      ]);
    } catch (e) {
      // erro do SDK (incl. McpError RequestTimeout do teto NATIVO, ou AbortError do
      // signal) ⇒ observação de erro (o adapter/loop trata; NÃO lança). Mantém o
      // transport vivo: um erro de chamada não é necessariamente um server pendurado.
      return {
        ok: false,
        content: `chamada falhou: ${e instanceof Error ? e.message : String(e)}`,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }

    // BUG-0028 — usuário CANCELOU (ESC/Ctrl-C) com a chamada em voo. O server pode
    // estar pendurado (ignorando o cancel) ⇒ RESETA o transport (mata o processo) p/
    // não vazar request pendente nem zumbi, e devolve observação de CANCELAMENTO (não
    // erro de server). É o que destrava o ESC na hora numa tool MCP travada.
    if (res === CALL_ABORTED) {
      await this.resetAfterTimeout();
      return {
        ok: false,
        content: `MCP tool "${toolName}" cancelada pelo usuário (ESC/Ctrl-C) — server reiniciado.`,
      };
    }

    if (res === CALL_TIMED_OUT) {
      // server PENDURADO: o promise do SDK não assentou no teto. Fail-soft — RESETA
      // o transport (mata o processo) p/ não vazar processo zumbi nem deixar o
      // request pendente, e devolve observação clara. NÃO derruba a sessão.
      await this.resetAfterTimeout();
      return {
        ok: false,
        content: `MCP tool "${toolName}" não respondeu em ${Math.round(
          timeoutMs / 1000,
        )}s — o server foi reiniciado (fail-soft).`,
      };
    }

    const content = extractTextContent(res['content']);
    const isError = res['isError'] === true;
    return { ok: !isError, content };
  }

  /**
   * Reseta o transport após um timeout de `callTool` (EST-1010): mata o processo-
   * server pendurado e zera o estado, p/ que o próximo `callTool` falhe limpo
   * ("server não conectado") em vez de empilhar em cima de um request travado.
   * Defensivo: nunca lança (o `close` pode falhar se o processo já morreu).
   */
  private async resetAfterTimeout(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    try {
      await client?.close();
    } catch {
      // o server já podia estar morto/pendurado; ignoramos — o estado já está zerado.
    }
    // EST-1011 — server morto ⇒ remove o filtro seccomp temporário (não vaza).
    this.runConfinementCleanup();
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } finally {
      this.client = null;
      this.transport = null;
      // EST-1011 — server encerrado ⇒ remove o filtro seccomp temporário do confinamento.
      this.runConfinementCleanup();
    }
  }
}

/**
 * Teto de BYTES por BLOCO de texto MCP (EST-1010). Um único bloco `text` pode vir
 * com vários GB (server hostil/bugado); cortamos CADA bloco ANTES de concatenar p/
 * NÃO materializar o monstro na memória (OOM upstream do clip de 20K do adapter).
 * Igual ao teto agregado do adapter (`MAX_MCP_OBSERVATION_CHARS`): nenhum bloco
 * sozinho ultrapassa a observação inteira, então o clip a jusante nunca vê o GB.
 */
export const MAX_MCP_BLOCK_BYTES = 20_000;

/** Total agregado (soma dos blocos já cortados) que paramos de acumular (EST-1010).
 *  Folga sobre o teto por-bloco p/ caber marcadores; o clip do adapter dá o corte
 *  final exato. Evita que MILHÕES de blocos pequenos somem GB mesmo com cada um
 *  abaixo do teto. */
const MAX_MCP_AGGREGATE_BYTES = MAX_MCP_BLOCK_BYTES * 4;

/**
 * Trunca uma string por BYTES (UTF-8) sem cortar no meio de um code point. NÃO
 * codifica a string inteira p/ medir (isso já materializaria o GB): mede e fatia
 * por caracteres, com o pior caso de 4 bytes/char como cota conservadora — assim
 * uma string de 1GB é cortada cedo, sem nunca alocar 1GB de Buffer. Exportada p/ teste.
 */
export function clipBytes(text: string, maxBytes: number): { text: string; truncated: number } {
  // Atalho barato: se o nº de chars * 1 (mínimo 1 byte/char) já couber, nada a fazer
  // quando ASCII; senão checamos o real. Limite de chars seguro = maxBytes (1 byte é
  // o mínimo por char), então só medimos bytes na janela [0, maxBytes].
  if (text.length <= maxBytes) {
    // até `maxBytes` chars ⇒ no máximo 4*maxBytes bytes; só precisa de corte fino se
    // exceder em bytes. Mede só esta janela curta (≤ maxBytes chars), não o GB.
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= maxBytes) return { text, truncated: 0 };
  }
  // Corta por caracteres até caber em `maxBytes` bytes. Itera a janela inicial
  // (no máx `maxBytes` chars, pois cada char ≥ 1 byte) — NUNCA toca o resto do GB.
  let lo = 0;
  let hi = Math.min(text.length, maxBytes);
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const kept = text.slice(0, lo);
  return { text: kept, truncated: text.length - lo };
}

/**
 * Extrai o TEXTO do `content` do resultado MCP (DADO não-confiável). O MCP devolve
 * blocos tipados (`text`/`image`/…); concatenamos os de texto. Imagens/blobs viram
 * um placeholder (não injetamos binário no contexto). Defensivo: `content` vem do
 * server (não-confiável), então validamos o shape.
 *
 * EST-1010 — CAP POR-BLOCO ANTES de concatenar: cada bloco de texto é cortado por
 * BYTES (`MAX_MCP_BLOCK_BYTES`) e o agregado tem teto (`MAX_MCP_AGGREGATE_BYTES`) —
 * um bloco de vários GB (ou milhões de blocos) NÃO materializa a memória. O clip do
 * adapter (20K chars) dá o corte final p/ o contexto; aqui é a barreira de OOM.
 */
export function extractTextContent(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  let aggregateBytes = 0;
  for (const block of content) {
    if (aggregateBytes >= MAX_MCP_AGGREGATE_BYTES) {
      parts.push('…[conteúdo MCP truncado: limite agregado de bytes atingido]');
      break;
    }
    if (block !== null && typeof block === 'object') {
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        const { text: clipped, truncated } = clipBytes(b['text'], MAX_MCP_BLOCK_BYTES);
        const piece =
          truncated > 0
            ? `${clipped}\n…[bloco MCP truncado: ${truncated} chars omitidos por exceder o teto de bytes]`
            : clipped;
        parts.push(piece);
        aggregateBytes += Buffer.byteLength(piece, 'utf8');
      } else if (typeof b['type'] === 'string') {
        parts.push(`[conteúdo MCP "${b['type']}" omitido]`);
      }
    }
  }
  return parts.join('\n');
}

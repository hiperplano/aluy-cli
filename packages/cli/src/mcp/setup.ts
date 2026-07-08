// EST-0970 · ADR-0058 · CLI-SEC-12 — SETUP do MCP: lê a config, descobre, adapta.
//
// Ponto de entrada do wiring de MCP no `@hiperplano/aluy-cli`. Junta:
//   1. McpConfigStore — lê `~/.aluy/mcp.json` confinado (DADO; write-deny pelo
//      agente — E-B1).
//   2. StdioMcpTransport — lança cada server local com environ MÍNIMO (CLI-SEC-7:
//      sem a credencial do CLI) e cwd no workspace (FU-VAU-11-bis p/ sandbox de SO).
//   3. discoverMcpTools (core) — handshake + listTools, resiliente (fail-soft).
//   4. adaptMcpTools (core) — cada tool vira NativeTool ATRÁS da catraca (E-B2:
//      efeito por padrão, classificada por sinais do input).
//
// É ASSÍNCRONO e OPCIONAL: sem `mcp.json`, devolve zero tools (o agente segue
// idêntico). Falha de um server NÃO derruba o startup (a descoberta é fail-soft).

import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  adaptMcpTools,
  closeMcpTransports,
  discoverMcpTools,
  mergeMcpConfigs,
  type McpConfig,
  type McpDiscoveryResult,
  type McpServerConfig,
  type McpServerDiscovery,
  type McpSource,
  type McpTransport,
  type NativeTool,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import type { BwrapSandboxLauncher } from '../sandbox/index.js';
import { McpConfigStore } from './mcp-config-store.js';
import {
  StdioMcpTransport,
  resolveMcpCallTimeoutMs,
  resolveMcpConnectTimeoutMs,
} from './stdio-transport.js';
import type { UserMcpConfig } from '../io/user-config.js';

/**
 * AVISO DE CONFIANÇA (E-B3 / FU-VAU-11-bis) — exibido no `--help`/docs do MCP. Por
 * default o processo-server roda com OS TEUS privilégios; o sandbox de SO
 * (`ALUY_SANDBOX_MCP`, EST-1011) o confina ao workspace (opt-in nesta fase — a decisão
 * de default-on é Q-A1 do ADR-0065: Tiago + seguranca).
 */
export const MCP_TRUST_WARNING =
  'Servers MCP rodam como processos LOCAIS com os TEUS privilégios de usuário. Por ' +
  'default NÃO são isolados em sandbox de SO — só ligue servers que você confia: um ' +
  'server malicioso lê o teu filesystem direto (~/.ssh, ~/.aws, ~/.aluy, .env). As ' +
  'tools deles passam pela catraca de permissão (efeito ⇒ confirmação). Para confinar ' +
  'o processo-server ao workspace (FS só-workspace, rede negada por default, seccomp), ligue ' +
  '`ALUY_SANDBOX_MCP=1` (sandbox de SO via bwrap).';

export interface SetupMcpOptions {
  /** Raiz do workspace confinado (cwd dos servers). Default: process.cwd(). */
  readonly workspaceRoot?: string;
  /** Raiz do `~/.aluy/` (default `<home>/.aluy`). Injetável p/ teste. */
  readonly aluyHome?: string;
  /** Environ do pai (injetável p/ teste do escopo de env). Default: process.env. */
  readonly parentEnv?: NodeJS.ProcessEnv;
  /**
   * Fábrica de transport (injetável p/ teste — substitui o stdio real por mock).
   * Default: `StdioMcpTransport` (SDK MCP oficial). Mantém o setup testável sem
   * lançar processos de verdade.
   */
  readonly makeTransport?: (server: McpServerConfig) => McpTransport;
  /**
   * EST-0979 — provedor da config MCP do PROJETO (`.mcp.json` no workspace confinado).
   * Quando presente, é MESCLADO ao `~/.aluy/mcp.json` global com **projeto > global**
   * (server homônimo do projeto vence). É config de PROJETO = DADO confinado — NÃO
   * relaxa a catraca (conectar cada server segue `ask`). Ausente ⇒ só o global (sem
   * regressão da EST-0970). Resolve assíncrono p/ a leitura confinada do disco.
   */
  readonly loadProjectConfig?: () => Promise<{ config: McpConfig; error?: string }>;
  /**
   * EST-0979 (FU-S3-CODEX-TOML) — provedor da config MCP do CODEX GLOBAL
   * (`~/.codex/config.toml`, seção `[mcp_servers]`). Quando presente, é MESCLADO como a
   * fonte MENOS específica: **`.aluy` global > Codex global** (e projeto vence todos).
   * É config GLOBAL do dono = DADO — passa pela MESMA catraca (conectar = `ask`,
   * credencial do CLI fora do environ, saída = dado). Ausente ⇒ cadeia idêntica à
   * EST-0979 (sem regressão). Síncrono no locus (leitura `fs` direta), mas aceito como
   * provedor p/ injeção em teste.
   */
  readonly loadCodexConfig?: () => { config: McpConfig; error?: string };
  /**
   * EST-1011 · ADR-0065 §11.2 (E-B3 / FU-VAU-11-bis) — o LANÇADOR do sandbox de SO.
   * Quando presente, CADA processo-server MCP local roda DENTRO do `bwrap` (o MESMO
   * `BwrapSandboxLauncher` do bash): o server só vê o WORKSPACE, NUNCA `~/.ssh`/
   * `~/.aws`/`~/.aluy`/`$HOME` (invariante a), net-deny por default (d), seccomp (c).
   * AUSENTE (default — gate atrás do opt-in `ALUY_SANDBOX_MCP`) ⇒ caminho atual
   * intocado (server cru). O wiring o injeta a partir de `createSandbox()`.
   */
  readonly sandboxLauncher?: BwrapSandboxLauncher;
  /**
   * ADR-0150 (balde b) — seção `mcp` do config único (`~/.aluy/config.json`):
   * timeouts de handshake/chamada dos servers locais. Precedência env > este campo >
   * default, MESMO teto-teto hardcoded já existente (`resolveMcpConnectTimeoutMs`/
   * `resolveMcpCallTimeoutMs`, intocado por este ADR).
   */
  readonly mcpConfig?: UserMcpConfig;
  /**
   * EST-BOOT-DECOUPLE — dispara ASSIM QUE a config (global+projeto+Codex) foi lida e
   * MESCLADA — ANTES do handshake (lançar processo + `initialize` + `listTools`) dos
   * servers, que é a parte LENTA. Dá ao caller (run.tsx) a CONTAGEM de servers ativos
   * cedo o bastante p/ mostrar "conectando N servers…" sem esperar nenhum handshake.
   * Ausente ⇒ sem efeito (comportamento idêntico).
   */
  readonly onConfigResolved?: (info: { readonly activeServerNames: readonly string[] }) => void;
  /**
   * EST-BOOT-DECOUPLE — dispara p/ CADA server assim que ELE conecta (ou falha),
   * incrementalmente — não espera os outros servers mais lentos. As tools JÁ vêm
   * adaptadas (mesma `adaptMcpTools`, mesmo teto por-server/HUNT-CAP). O caller usa
   * isto p/ ANEXAR as tools daquele server ao toolset AO VIVO (ex.:
   * `controller.refreshMcpTools(tools, server)`) sem esperar `setupMcp` inteiro
   * terminar. Os avisos (HUNT-CAP) deste caminho NÃO entram no `McpSetup.warnings`
   * final (evita aviso duplicado — o array final já recalcula tudo de uma vez).
   * Ausente ⇒ sem efeito (comportamento idêntico ao boot síncrono de sempre).
   */
  readonly onServerReady?: (result: {
    readonly server: string;
    readonly ok: boolean;
    readonly tools: readonly NativeTool<ToolPorts>[];
    readonly error?: string;
  }) => void;
}

/** Resultado do setup: tools adaptadas (p/ o registro) + transports (p/ fechar). */
export interface McpSetup {
  /** Tools MCP adaptadas como NativeTool, prontas p/ entrar no toolset do agente. */
  readonly tools: NativeTool<ToolPorts>[];
  /** Transports vivos (chamar `close()` no fim da sessão). */
  readonly transports: readonly McpTransport[];
  /** Diagnóstico da descoberta (por-server, p/ a UX listar o que subiu/falhou). */
  readonly discovery: McpDiscoveryResult;
  /**
   * EST-0970 — as fontes de config, na ORDEM de precedência (menos → mais específica:
   * Codex < `.aluy` global < projeto). Alimenta o `/mcp` (origem por server) sem o slash
   * re-ler disco. Cada item é `{ origin, config }`; vazio quando a fonte não contribuiu.
   */
  readonly sources: readonly McpSource[];
  /** Erro de leitura do `mcp.json` (formato inválido), quando houver. */
  readonly configError?: string;
  /**
   * HUNT-CAP (#266) — avisos HONESTOS do setup (ex.: um server que excedeu o teto de
   * `MAX_MCP_TOOLS_PER_SERVER` tools e teve o excesso cortado). NÃO vazam segredo (só
   * nome do server + contagens). A UX os exibe no boot (stderr). Ausente quando vazio.
   */
  readonly warnings?: readonly string[];
  /** Fecha todos os transports (cleanup). */
  close(): Promise<void>;
}

/**
 * Lê o `mcp.json`, descobre as tools de cada server (handshake) e as adapta p/ o
 * toolset. Sem `mcp.json` ⇒ `tools` vazio (sem MCP). NUNCA lança: a config inválida
 * vira `configError`; um server caído some do toolset (registrado em `discovery`).
 */
export async function setupMcp(opts: SetupMcpOptions = {}): Promise<McpSetup> {
  const cwd = opts.workspaceRoot ?? process.cwd();
  const aluyHome = opts.aluyHome ?? join(homedir(), '.aluy');

  const store = new McpConfigStore({ baseDir: aluyHome });
  const { config: globalConfig, error: globalError } = store.load();

  // EST-0979 (FU-S3-CODEX-TOML) — config MCP do CODEX GLOBAL (`~/.codex/config.toml`,
  // `[mcp_servers]`), se houver. Fonte MENOS específica: `.aluy` global VENCE o Codex.
  // Mesma catraca (conectar = `ask`); DADO de config do dono. Ausente ⇒ cadeia idêntica.
  const codex = opts.loadCodexConfig ? opts.loadCodexConfig() : undefined;

  // EST-0979 — config MCP do PROJETO (`.mcp.json` confinado ao workspace), se houver.
  // É DADO confinado; mesclada com **projeto > global** (server homônimo do projeto
  // vence). Ausente ⇒ só o global (comportamento idêntico ao da EST-0970).
  const project = opts.loadProjectConfig ? await opts.loadProjectConfig() : undefined;

  // PRECEDÊNCIA (última fonte VENCE em colisão de nome) — do MENOS p/ o MAIS específico:
  //   Codex global  <  `.aluy` global  <  projeto `.mcp.json`
  // Coerente com EST-0979 (projeto especializa o global); o Codex entra como fallback
  // de mais baixa precedência (compat de outro ecossistema). `mergeMcpConfigs` é puro.
  const config: McpConfig = mergeMcpConfigs(
    ...(codex ? [codex.config] : []),
    globalConfig,
    ...(project ? [project.config] : []),
  );
  // Erros das TRÊS fontes, agregados (a UX avisa de cada arquivo inválido).
  const configError =
    [codex?.error, globalError, project?.error]
      .filter((e): e is string => typeof e === 'string')
      .join(' | ') || undefined;

  // EST-BOOT-DECOUPLE — a config JÁ ESTÁ PRONTA aqui (só leitura de disco — rápida); o
  // handshake (lento) começa DEPOIS. Dispara ANTES da parte lenta p/ o caller mostrar
  // "conectando N servers…" sem esperar nenhum processo subir.
  if (opts.onConfigResolved) {
    const activeServerNames = config.servers.filter((s) => s.disabled !== true).map((s) => s.name);
    opts.onConfigResolved({ activeServerNames });
  }

  // ADR-0150 (balde b) — resolve os timeouts JÁ COM o config (env > config > default),
  // clampados ao MESMO teto-teto hardcoded (intocado). Env explícito continua vencendo.
  const mcpEnv = opts.parentEnv ?? process.env;
  const callTimeoutMs = resolveMcpCallTimeoutMs(mcpEnv, opts.mcpConfig?.callTimeoutMs);
  const connectTimeoutMs = resolveMcpConnectTimeoutMs(mcpEnv, opts.mcpConfig?.connectTimeoutMs);

  const makeTransport =
    opts.makeTransport ??
    ((): McpTransport =>
      new StdioMcpTransport({
        cwd,
        ...(opts.parentEnv ? { parentEnv: opts.parentEnv } : {}),
        callTimeoutMs,
        connectTimeoutMs,
        // EST-1011 — sandbox de SO do processo-server (opt-in `ALUY_SANDBOX_MCP`). O
        // workspace montado RW é o `cwd` (o server opera em arquivos do projeto). A
        // rede fica net-deny por default (sem aprovação ⇒ server sem socket). AUSENTE
        // ⇒ caminho atual (server cru).
        ...(opts.sandboxLauncher
          ? { sandboxLauncher: opts.sandboxLauncher, workspaceRoots: [cwd] }
          : {}),
      }));

  const discovery = await discoverMcpTools(
    config,
    makeTransport,
    opts.onServerReady
      ? {
          onServerResult: (result: McpServerDiscovery) => {
            // Adapta SÓ as tools DESTE server (mesma função pura do array agregado
            // abaixo) — os avisos deste caminho são DESCARTADOS (o array final
            // recalcula tudo; evita o mesmo aviso HUNT-CAP entrar duas vezes no log).
            const tools = adaptMcpTools(result.tools);
            opts.onServerReady!({
              server: result.server,
              ok: result.ok,
              tools,
              ...(result.error !== undefined ? { error: result.error } : {}),
            });
          },
        }
      : undefined,
  );
  // HUNT-CAP (classe "recurso sem teto", #266) — coleta os AVISOS honestos do teto de
  // tools por server (`MAX_MCP_TOOLS_PER_SERVER`). Os avisos NÃO vazam segredo (só nome
  // do server + contagens) e sobem no `McpSetup.warnings` p/ a UX exibir (stderr no boot,
  // junto do `configError`). Sem isto, o corte do excesso seria silencioso.
  const warnings: string[] = [];
  const tools = adaptMcpTools(discovery.tools, (w) => warnings.push(w));

  // EST-0970 — fontes na ordem de precedência (menos → mais específica), p/ o `/mcp`
  // resolver a ORIGEM de cada server. Espelha EXATAMENTE a ordem do merge acima.
  const sources: McpSource[] = [
    ...(codex ? [{ origin: 'codex' as const, config: codex.config }] : []),
    { origin: 'aluy-global' as const, config: globalConfig },
    ...(project ? [{ origin: 'project' as const, config: project.config }] : []),
  ];

  return {
    tools,
    transports: discovery.transports,
    discovery,
    sources,
    ...(configError ? { configError } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    close: () => closeMcpTransports(discovery.transports),
  };
}

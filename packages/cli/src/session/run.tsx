// EST-0948 — entrypoint de RENDER da TUI: monta a sessão (wiring.ts) e a renderiza
// com Ink. Trata o modo NÃO-TTY (saída piped/CI) com render LINEAR sem ANSI (§6/§9),
// e roteia os comandos nativos que precisam de efeito (/quit, /clear).
//
// `aluy "objetivo"` ⇒ submete o objetivo direto após montar; `aluy` sem objetivo
// ⇒ onboarding (sessão vazia). O login device-flow é apresentado quando a 1ª
// chamada de modelo descobre que não há credencial (SessionExpiredError) — em v1,
// orientamos o `aluy login` (o fluxo device-flow interativo dentro da TUI é a
// evolução natural; o I/O do device-flow já está pronto em commands/login.ts).

import { render } from 'ink';
import {
  wrapStdoutWithSync,
  syncOutputEnabled,
  overwriteRenderEnabled,
} from './synchronized-output.js';
import { enableBracketedPaste } from './bracketed-paste.js';
import { resolveTheme } from '../ui/theme/index.js';
import type { RewindChoice } from '../ui/hooks/useRewindPicker.js';
import {
  queryTerminalBrightness,
  themeNameForBrightness,
  resolveThemeName,
  themeByName,
  BackgroundController,
  DEFAULT_THEME,
  SESSION_COLOR_NAMES,
  type ThemeName,
} from '../ui/theme/index.js';
import { routeRename, runRenameLinear } from './rename.js';
import { setWindowTitle } from '../ui/window-title.js';
import { resolveHeadroomUrl } from '../maestro/sidecar-urls.js';
import { CLI_VERSION } from '../version.js';
import { readUpdateNote, refreshUpdateCheck } from '../io/update-check.js';
import { ThemeRoot } from './ThemeRoot.js';
import { buildSession, type BuildSessionOptions } from './wiring.js';
// ADR-0120 / EST-1113 — backend LOCAL (BYO): resolve a config e monta o LocalModelClient
// (atrás do MESMO contrato `ModelClient`) p/ injetar no wiring quando `backend:'local'`.
import { resolveModelBackend, resolveLocalProviderConfig } from '../model/local/config.js';
import { buildLocalModelClient } from '../model/local/factory.js';
import { loadLocalProviderCatalog } from '../io/providers-config.js';
import { createOAuthAccessTokenProvider } from '../model/local/oauth-store.js';
import { setupMcp, ProjectMcpConfigStore, CodexMcpConfigStore } from '../mcp/index.js';
import { createSandbox } from '../sandbox/index.js';
import {
  runLinear,
  runHeadlessPrint,
  runHeadlessStreamJson,
  runModelLinear,
  runUndoLinear,
  runThemeLinear,
  runLangLinear,
  runProviderLinear,
  runMemoryLinear,
  runTodoLinear,
  runClearLinear,
  runCycleLinear,
  streamBlocksLinear,
} from './linear.js';
import { NATIVE_COMMANDS, buildSessionCommandsNote, type SlashCommand } from '../slash/commands.js';
import {
  applySlashEffect,
  buildSlashEffect,
  buildMcpNote,
  buildNotifyEffect,
  buildThemeEffect,
  buildProviderEffect,
  parseMcpSlash,
  parseMcpRefresh,
  mcpSearchUsageNote,
  mcpSearchPendingNote,
  runMcpSearchSlash,
  runAsyncSlash,
  runTelegramSlash,
  runAddDir,
} from '../slash/handlers.js';
import { KeychainConnectorSecretStore } from '../auth/connector-secret-store.js';
import { activateTelegram } from '../connector/telegram-activation.js';
import type { IngressSink, TelegramBridge } from '../connector/telegram-bridge.js';
import type { SessionController } from './controller.js';
import { createRegistryFetch } from '../mcp/registry-search.js';
import { runDoctorLive } from '../doctor/slash.js';
import { buildRepairGoal, gatherLogTails, SIDECAR_KINDS } from '../doctor/repair.js';
import { testTierLive } from '../doctor/tier-test.js';
import { StdioMcpTransport } from '../mcp/stdio-transport.js';
import { parseMcpAdminSlash, runMcpAdminSlash } from '../slash/mcp-admin.js';
import {
  buildMcpListing,
  buildAgentsNote,
  buildWorkflowsNote,
  buildSkillsNote,
  buildAvailableAgentsNote,
  type NativeTool,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { applyTierLiteral } from '../model/catalog.js';
import { TerminalNotificationPort, loadNotifyConfig } from '../io/notify-port.js';
import { attachNotifyObserver } from './notify-observer.js';
import { UndoController, type UndoOutcome } from './undo-controller.js';
import {
  NodeWorkspace,
  NodeFileSystemPort,
  loadProjectInstructions,
  UserConfigStore,
  SessionStore,
  // ADR-0150 (balde b) — resolve `session.gcMaxAgeMs`/`gcMaxCount` do config único.
  resolveSessionGcOptions,
  blocksToHistory,
  UserCommandsLoader,
  ProjectCommandsLoader,
  mergeUserCommands,
  UserAgentsLoader,
  ProjectAgentsLoader,
  UserWorkflowsLoader,
  ProjectWorkflowsLoader,
  UserSkillsLoader,
  ProjectSkillsLoader,
  NodeMemoryStore,
  HooksConfigStore,
  ExportStore,
} from '../io/index.js';
import type { ProjectInstructionsLoad } from '../io/index.js';
import { attachHooksObserver } from './hooks-observer.js';
import { makeToolHooksObserver } from './tool-hooks-observer.js';
import {
  resolveInitialTier,
  resolveInitialSplitView,
  resolveInitialFullscreen,
  resolveInitialSuggestions,
  configuredLang,
  type UserConfig,
} from '../io/user-config.js';
import { enterAltScreen, registerRestoreHandlers } from './alt-screen.js';
import { installSignalReset } from './signal-reset.js';
import { resolveCockpitLayout } from './cockpit-layout.js';
import { buildTranscript } from './export-transcript.js';
import { resolveInitialLang, resolveLang, langByCode, i18n as makeI18n } from '../i18n/index.js';
import {
  decideBootResume,
  resolveResumedModel,
  resolvePreferredModel,
  // ADR-0150 (balde b) — resolve `session.autoResumeWindowMs` do config único.
  resolveAutoResumeWindowMs,
  type ResumeRequest,
  type ResumeResolution,
} from './resume.js';
import { formatSessionList, autoSaveSession, hasResumableContent } from './session-persist.js';
import { applyResumeRecord, runHistoryLinear } from './history.js';
import { createBootSplash, resolveSplashMinMs, type BootSplash } from './splash-controller.js';
import { emitBootClear } from './run-clear.js';
import { rearmStdinForInk } from './stdin-rearm.js';
import { installCsiUGuard } from './csi-u-guard.js';
import {
  newSessionId,
  expandUserCommand,
  selectHooks,
  AgentRegistry,
  resolveHeapLimitMb,
  parseDuration,
  parseCycleInput,
  resolveCycleCeilings,
  NoCeilingError,
  CycleParseError,
  type HistoryItem,
  type UserCommand,
  type LoginService,
  type RegistryFetch,
} from '@hiperplano/aluy-cli-core';
import { DEFAULT_TIER } from './wiring.js';
import { runInit, buildScaffoldSystemPrompt } from '../slash/init.js';
import { parseMemoryCommand, runMemoryCommand } from '../slash/memory.js';
import { parseTodoCommand, runTodoCommand } from '../slash/todo.js';
import { runCron } from '../commands/cron.js';
import {
  parseClearCommand,
  runClearCommand,
  clearArmTransition,
  type ClearArmedVerb,
} from '../slash/clear.js';
import { basename } from 'node:path';

export interface RunSessionOptions extends BuildSessionOptions {
  /** Objetivo inicial (`aluy "objetivo"`). */
  readonly goal?: string;
  /** Densidade compacta (`--dense`). */
  readonly dense?: boolean;
  /**
   * EST-0984 — perfil SEGURO de glifos (`--ascii` / ALUY_SAFE_GLYPHS). Força o
   * conjunto de cobertura ampla mesmo em UTF-8 (terminal/fonte teimosos).
   */
  readonly safeGlyphs?: boolean;
  /**
   * EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG) LIGADO na largada (`--split`).
   * `undefined` quando a flag não veio ⇒ cai na pref salva (`ui.splitView`). A flag só
   * LIGA (não há `--no-split`). Precedência resolvida por `resolveInitialSplitView`.
   */
  readonly split?: boolean;
  /**
   * EST-1000 · ADR-0076 §1 — MODO COCKPIT (tela cheia, alt-screen) LIGADO na largada
   * (`--fullscreen`/`--cockpit`). `undefined` quando a flag não veio ⇒ cai na pref salva
   * (`ui.fullscreen`). A flag só LIGA. Precedência por `resolveInitialFullscreen`. INLINE
   * é o DEFAULT do ADR. Só vale em TTY interativo (o não-TTY/CI ignora — segue inline).
   */
  readonly fullscreen?: boolean;

  /**
   * EST-1112 · ADR-0119 — BUDGET de sessão no backend LOCAL. `--budget` LIGA,
   * `--no-budget` DESLIGA. `undefined` quando flag não veio (cai p/ env > config >
   * default). MAPEIA p/ a pref persistida `localBudget`.
   */
  readonly budget?: boolean;
  /**
   * ADR-0134/0135 — `--telegram`: ATIVA a bridge Telegram no boot (long-poll do dono
   * allowlistado + tool `telegram_send`). DORMENTE: sem token no keychain a bridge NÃO sobe
   * (avisa `aluy telegram login`, zero egress). Ausente/`false` ⇒ inerte (como hoje).
   * Injetável p/ teste via `telegramActivate` (sem keychain/rede real).
   */
  readonly telegram?: boolean;
  /**
   * Override da ATIVAÇÃO do Telegram (teste) — recebe o sink e devolve o resultado, sem
   * tocar keychain/rede. Default: `activateTelegram` (keychain + connector reais). Só é
   * chamado quando `telegram` é `true`.
   */
  readonly telegramActivate?: typeof activateTelegram;
  /**
   * EST-1000 · ADR-0076 §4 — store do `/export` (grava o transcript redigido em
   * `~/.aluy/exports/`). Injetável p/ teste (baseDir tmpdir), sem tocar o `~/.aluy/` real.
   * Default: o store real.
   */
  readonly exportStore?: ExportStore;
  /**
   * EST-0989 (i18n) — idioma da TUI (`--lang pt-BR|en`). Cru (string) do parser; a
   * resolução (flag > config > auto-detect > pt-BR) é por `resolveInitialLang`. Ausente
   * ⇒ cai na pref salva / auto-detect do locale.
   */
  readonly lang?: string;
  /**
   * ADR-0120 / EST-1113 — BACKEND de modelo (`broker` default | `local` BYO),
   * cru da flag `--backend`. `undefined` ⇒ cai em env `ALUY_BACKEND` > config >
   * default broker. Sob `local`, o modelo é chamado DIRETO no provider com
   * credencial BYO (keychain→env); o footer de quota/crédito do broker degrada.
   */
  readonly backend?: string;
  /**
   * ADR-0120 / EST-1113 — config do PROVIDER do backend local (só sob `backend:local`),
   * cru das flags `--local-*`. O wiring resolve flag>env(ALUY_LOCAL_*)>config>default.
   * NÃO credencial (a chave vem do keychain/env por provider).
   */
  readonly localProvider?: string;
  readonly localModel?: string;
  readonly localAuth?: string;
  readonly localBaseUrl?: string;
  /** stdout/stdin p/ injeção (testes). Default: process. */
  readonly stdout?: NodeJS.WriteStream;
  /**
   * EST-0969 — store da config persistente de preferências (`~/.aluy/config.json`).
   * Injetável p/ teste (tmpdir), sem tocar o `~/.aluy/` real do dev. Default: o
   * store real (`<home>/.aluy/config.json`).
   */
  readonly configStore?: UserConfigStore;
  /**
   * EST-0972 — pedido de retomada de sessão (`--continue`/`--resume [<id>]`).
   * Ausente ⇒ sessão nova. Vem do parser (cli.ts) via o binário.
   */
  readonly resume?: ResumeRequest;
  /**
   * EST-0972 (BUG 2) — `--new`: começa do ZERO, ignorando a auto-oferta de retomar a
   * sessão recente do cwd. Sem `--new` (e sem `--resume`/`--continue`), o boot OFERECE
   * retomar a conversa anterior do mesmo diretório (se houver uma recente).
   */
  readonly fresh?: boolean;
  /**
   * EST-0972 (BUG 2) — prompt de SIM/NÃO do boot (auto-oferta de retomada). Injetável
   * p/ teste (sem TTY real). Recebe a linha do prompt; resolve `true` (retomar) /
   * `false` (sessão nova). Default: lê uma linha do stdin (Enter/`s` ⇒ sim).
   */
  readonly promptYesNo?: (prompt: string) => Promise<boolean>;
  /**
   * EST-0991 · EST-1007 · ADR-0072 · AG-0008 — aviso/CONFIRMAÇÃO de entrada do YOLO
   * (one-shot, ADR-0072 §3b). Presente SÓ quando o binário resolveu entrar em YOLO num
   * TTY (`requiresConfirmation:true`). Em TTY, o boot PEDE confirmação com este texto
   * (reusa `promptYesNo`): recusar CAI p/ `normal`. Ausente ⇒ sem confirmação: ou é
   * não-YOLO, ou é HEADLESS — onde a flag `--yolo` JÁ é o consentimento (entra direto)
   * e o BANNER de aviso é emitido pelo binário no stderr (não pela TUI).
   */
  readonly yoloEntryNotice?: string;
  /**
   * EST-0972 — store das sessões persistidas (`~/.aluy/sessions/`). Injetável p/
   * teste (tmpdir), sem tocar o `~/.aluy/` real do dev. Default: o store real.
   */
  readonly sessionStore?: SessionStore;
  /**
   * EST-0974 — loader dos comandos customizados (`~/.aluy/commands/*.md`). Injetável
   * p/ teste (baseDir tmpdir), sem tocar o `~/.aluy/` real do dev. Default: o real.
   */
  readonly userCommandsLoader?: UserCommandsLoader;
  /**
   * EST-0979 — loader dos comandos do PROJETO (`.claude/commands/*.md`, confinado ao
   * workspace). Injetável p/ teste. Default: o real (workspace da sessão). Os comandos
   * do projeto são MESCLADOS aos do `~/.aluy/commands/` com projeto > global.
   */
  readonly projectCommandsLoader?: ProjectCommandsLoader;
  /**
   * EST-0977 — loader dos agentes GLOBAIS (`~/.aluy/agents/*.md`). Injetável p/ teste
   * (baseDir tmpdir), sem tocar o `~/.aluy/` real do dev. Default: o real.
   */
  readonly userAgentsLoader?: UserAgentsLoader;
  /**
   * EST-0977 — loader dos agentes de PROJETO (`.claude/agents/*.md` + `.aluy/agents/`,
   * confinado ao workspace). Injetável p/ teste. Default: o real (workspace da sessão).
   */
  readonly projectAgentsLoader?: ProjectAgentsLoader;
  /**
   * EST-0974 — leitor da config de hooks (`~/.aluy/hooks.json`). Injetável p/ teste.
   * Default: o real (`<home>/.aluy/hooks.json`).
   */
  readonly hooksConfigStore?: HooksConfigStore;
  /**
   * EST-0979 (FU-S3-CODEX-TOML) — leitor da config MCP do CODEX GLOBAL
   * (`~/.codex/config.toml`, `[mcp_servers]`). Injetável p/ teste (baseDir tmpdir),
   * sem tocar o `~/.codex/` real do dev. Default: o real (`<home>/.codex/config.toml`).
   * Os servers do Codex são MESCLADOS como a fonte de MENOR precedência (`.aluy` > Codex).
   */
  readonly codexMcpConfigStore?: CodexMcpConfigStore;
  /**
   * EST-0970 (search na sessão) — porta de busca no registro oficial aberto p/ o
   * `/mcp search <termo>`. Injetável p/ teste (socket mockado, sem rede real).
   * Default: `createRegistryFetch()` — egress FIXO no registro oficial + anti-SSRF
   * do #80 (sem key, DADO, só lê). NÃO cria egress novo.
   */
  readonly mcpRegistryFetch?: RegistryFetch;
  /**
   * EST-1007 — MODO HEADLESS one-shot (`-p`/`--print`/`--exec`). Quando presente, força
   * o caminho não-TTY (mesmo em terminal interativo) e imprime SÓ o resultado final do
   * assistente (sem o chrome rotulado do `runLinear`), saindo em seguida. O `goal` já vem
   * resolvido (printArg > posicional > stdin) pelo binário. `outputFormat` controla
   * text|json. O ask-resolver é posto em não-interativo (fail-closed) ANTES do loop —
   * idêntico ao não-TTY (CLI-SEC-H1; sinalizado ao `seguranca`).
   */
  readonly headless?: {
    readonly print: true;
    readonly outputFormat?: string;
    readonly quiet?: boolean;
    // EST-XXXX · ADR-0062 — `--cycle`: (com -p) Roda o objetivo em CICLOS autônomos
    // (como /cycle), sem interação. `true` quando a flag veio; `undefined` (default)
    // ⇒ comportamento headless normal (one-shot).
    readonly cycle?: boolean;
    // EST-1019 · ADR-0062 §Addendum 1 (APR-0086) — TETO do CICLO via flags de boot:
    // `--cycles N` (nº de iterações) / `--cycle-for <dur>` (duração total). Cru aqui
    // (string); o wiring resolve/valida e a flag VENCE o teto embutido no goal. `undefined`
    // quando a flag não veio. DISTINTAS de `maxIterations` (teto do LOOP, não do ciclo).
    readonly cycles?: string;
    readonly cycleFor?: string;
  };
  /**
   * EST-1007 — sink do EXIT CODE do headless (o binário liga em `process.exitCode`).
   * 0 = sucesso; ≠0 = erro (broker fora / objetivo sem resposta). Só chamado no headless.
   * Default: no-op (a TUI/linear normal não tem exit code próprio).
   */
  readonly onExitCode?: (code: number) => void;
}

/**
 * EST-1019 · ADR-0062 §Addendum 1 (APR-0086 §A1.2/A1.3) — mensagem de recusa do `--cycle`
 * HEADLESS sem teto. Sugere APENAS as flags de boot (`--cycles N` / `--cycle-for <dur>`),
 * que vivem FORA do goal e que o parser do `-p` aceita ⇒ copiar a dica LITERALMENTE inicia
 * o ciclo. PROIBIDO sugerir `--max-iter N` embutido no goal (caso F10: `-p "--max-iter 2
 * tarefa"` → "aluy: -p sem prompt"). NÃO menciona `--max-iterations` (teto do LOOP, não do
 * ciclo). A invariante anti-runaway (CLI-SEC-14) é a razão da recusa.
 */
export const NO_CYCLE_CEILING_MESSAGE =
  'aluy: --cycle exige um teto do ciclo — sem teto NÃO inicia (proteção contra ' +
  'execução sem fim). Use --cycles N (nº de ciclos) e/ou --cycle-for <dur> ' +
  '(duração total). Ex.: aluy -p "diga oi" --cycle --cycles 2 — ou ' +
  'aluy -p "diga oi" --cycle --cycle-for 30m.';

/**
 * EST-1019 (APR-0086 §A1.1) — resolve as flags de boot do TETO do CICLO (`--cycles`/
 * `--cycle-for`) num override de ceilings p/ o `controller.cycle`. PURO: só parse/validação
 * (sem I/O). `--cycles` = inteiro > 0 (nº de iterações/ciclos); `--cycle-for` = duração
 * (`30s`/`30m`/`2h`, via `parseDuration` do core). Valor inválido/≤0 é IGNORADO (cai p/ o
 * teto embutido no goal; se não houver, o `controller.cycle` recusa por no-ceiling →
 * exit 2). Devolve `undefined` quando nenhuma flag de boot veio (só o goal-embutido decide).
 */
export function resolveCycleBootCeilings(headless: {
  readonly cycles?: string;
  readonly cycleFor?: string;
}): { maxIterations?: number; maxDurationMs?: number } | undefined {
  const out: { maxIterations?: number; maxDurationMs?: number } = {};
  if (headless.cycles !== undefined) {
    const n = Number(headless.cycles);
    // HUNT-CYCLE — exige inteiro ≥ 1 (não `n > 0` + `Math.floor`): `--cycles 0.5` virava
    // `0` (floor) e era passado como override `maxIterations: 0`, que `isPositive(0)`
    // rejeita no `resolveCycleCeilings` ⇒ recaía SILENCIOSO no DEFAULT de 20 ciclos (o
    // usuário pedia < 1 e ganhava 20). Inteiro-only ⇒ inválido é IGNORADO (cai no teto
    // embutido no goal; sem ele, o pré-check recusa por no-ceiling → exit 2), nunca um
    // teto frouxo mascarado.
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 1) out.maxIterations = n;
  }
  if (headless.cycleFor !== undefined) {
    const ms = parseDuration(headless.cycleFor);
    if (ms !== undefined && ms > 0) out.maxDurationMs = ms;
  }
  if (out.maxIterations === undefined && out.maxDurationMs === undefined) return undefined;
  return out;
}

/**
 * EST-1019 (APR-0086 §A1.2) — PRÉ-CHECK do teto do `--cycle` HEADLESS, ANTES de iniciar
 * qualquer ciclo. Reusa a MESMA porta `resolveCycleCeilings` (fonte única do "sem teto ⇒
 * NÃO inicia", CLI-SEC-14) com o teto EMBUTIDO no goal FUNDIDO com a FLAG DE BOOT (a flag
 * vence — explícito > embutido, A1.1). Mantém o stdout LIMPO no no-cap (não streama a nota
 * da TUI). `ok` ⇒ pode iniciar; `no-ceiling` ⇒ exit 2; `parse-error` ⇒ exit 2 + msg.
 */
export function preflightCycleCeiling(
  goal: string,
  overrides: { maxIterations?: number; maxDurationMs?: number } | undefined,
): { kind: 'ok' } | { kind: 'no-ceiling' } | { kind: 'parse-error'; message: string } {
  try {
    const parsed = parseCycleInput(goal);
    const request = {
      ...parsed.request,
      ...(overrides?.maxIterations !== undefined ? { maxIterations: overrides.maxIterations } : {}),
      ...(overrides?.maxDurationMs !== undefined ? { maxDurationMs: overrides.maxDurationMs } : {}),
    };
    resolveCycleCeilings(request);
    return { kind: 'ok' };
  } catch (err) {
    if (err instanceof NoCeilingError) return { kind: 'no-ceiling' };
    if (err instanceof CycleParseError) return { kind: 'parse-error', message: err.message };
    throw err;
  }
}

/**
 * Renderiza a TUI interativa (ou roda linear se não há TTY). Resolve quando o app
 * sai. É o que o binário `aluy` chama na invocação default/com objetivo.
 */
export async function runSession(opts: RunSessionOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  // EST-1007 — MODO HEADLESS (`-p`/`--print`/`--exec`): força o caminho NÃO-TTY mesmo
  // num terminal interativo (EXPLÍCITO, não depende de pipe). Sem splash, sem render
  // Ink, sem auto-detecção OSC/notify: roda o loop e imprime SÓ o resultado final.
  const headless = opts.headless !== undefined;
  const isTty = !headless && (opts.stdout ?? process.stdout).isTTY === true;

  // ── EST-1000 · ADR-0076 §2 — ALT-SCREEN / STDIN safety net — INÍCIO DO BOOT ─────────
  // `baseStdout` e `registerRestoreHandlers` vivem AQUI (antes do splash) para que
  // QUALQUER crash/sinal durante o boot — incluindo o prompt YOLO no splash, o drain do
  // stdin e o queryTerminalBrightness (que chama setRawMode) — encontre os handlers de
  // restauração já registrados. Antes, só eram registrados na linha ~1837 (antes do render),
  // deixando a janela splash → detectInitialTheme sem cobertura: stdin ficava em raw-mode
  // e bloqueava todos os terminais que compartilham o mesmo conhost no Windows (BUG-WIN).
  // A restauração escreve no `baseStdout` CRU (não pelo sync — bytes de controle de terminal,
  // não frames de render). IDEMPOTENTE: o dispose() posterior e o finally são no-op se já rodou.
  const baseStdout = opts.stdout ?? process.stdout;
  const altScreen = registerRestoreHandlers(baseStdout, process);

  // EST-0989 — SPLASH de boot (TTY-only). Mostra o wordmark `Λluy` centralizado + um
  // "carregando…" calmo ENQUANTO o boot trabalha (config/MCP/recall/sessão/perfis), e
  // apresenta as perguntas de boot (retomar `[S/n]`, confirmar YOLO) numa CAIXA
  // formatada e centralizada — no lugar das frases soltas no meio da tela (o pedido do
  // Tiago). Só monta quando:
  //   · há TTY (sem TTY/linear/CI ⇒ comportamento intacto, sem splash, sem clear); E
  //   · o caller NÃO injetou `promptYesNo` (testes/headless dirigem o prompt direto —
  //     não montamos o Ink do splash, que penduraria em waitUntilExit num headless).
  // A 1ª coisa é o BOOT-CLEAR (tela limpa); então montamos o splash sobre ela. O tema
  // do splash é a fotografia ENV (resolveTheme): suficiente p/ a marca; a auto-detecção
  // OSC 11 completa (detectInitialTheme) roda depois, p/ a App — sem competir com o
  // stdin do prompt do splash aqui.
  const useSplash = isTty && opts.promptYesNo === undefined;
  let splash: BootSplash | undefined;
  if (useSplash) {
    const splashOut = opts.stdout ?? process.stdout;
    emitBootClear(splashOut, true);
    const splashTheme = resolveTheme({
      env,
      ...(opts.dense ? { density: 'compact' as const } : {}),
      ...(opts.safeGlyphs ? { safeGlyphs: true as const } : {}),
    });
    splash = createBootSplash({ theme: splashTheme, stdout: splashOut });
    // Piso de exibição (feedback Tiago): segura o quip do splash por >= minMs antes
    // do prompt/cockpit (o Ink anima durante o await). Override ALUY_SPLASH_MIN_MS.
    // EST-BOOT-DECOUPLE — "pular o splash": corre o piso em PARALELO com
    // `splash.whenSkip()` (resolve na 1ª tecla, fora de um S/N pendente) — quem
    // resolver primeiro libera o boot. Sem tecla, o piso normal segue valendo
    // (comportamento idêntico a antes).
    const splashMinMs = resolveSplashMinMs(env);
    if (splashMinMs > 0) {
      await Promise.race([new Promise<void>((r) => setTimeout(r, splashMinMs)), splash.whenSkip()]);
    }
  }
  // O prompt sim/não do boot: a CAIXA do splash (TTY) OU o `defaultBootPrompt`/injetado
  // (não-TTY/teste). MESMO contrato `(prompt) => Promise<boolean>` nos dois — entra
  // direto no YOLO/`decideBootResume` sem mudar assinatura.
  const bootPrompt = splash?.promptYesNo ?? opts.promptYesNo ?? defaultBootPrompt(opts.stdout);

  // EST-0991 · EST-1007 · ADR-0072 · AG-0008 — CONFIRMAÇÃO de entrada do YOLO (one-shot,
  // §3b). A guarda do binário (`decideYoloEntry`) já abortou como root e só repassa
  // `yoloEntryNotice` quando vai entrar em YOLO num TTY (headless entra direto, banner no
  // binário). Aqui pedimos a confirmação:
  // recusar CAI p/ `normal` (catraca/cerca/anti-SSRF restaurados). É a fricção de UMA
  // vez (não por-ação) que torna o YOLO um opt-in BARULHENTO, espelhando o Claude Code.
  // EST-0989 — a confirmação agora aparece na CAIXA do splash (não mais linha solta).
  let effectiveMode = opts.mode;
  let yoloCancelled = false;
  if (opts.yoloEntryNotice !== undefined && isTty) {
    const proceed = await bootPrompt(opts.yoloEntryNotice);
    if (!proceed) {
      effectiveMode = 'normal';
      yoloCancelled = true;
      // Sem o splash (caller injetou prompt), ecoa o cancelamento em texto; com o
      // splash a transição limpa já não deixa frase solta — vira uma nota de boot
      // (empurrada após o controller existir, no ramo TTY).
      if (!useSplash) {
        (opts.stdout ?? process.stderr).write?.(
          'aluy: YOLO cancelado — seguindo em modo normal.\n',
        );
      }
    }
  }

  // EST-0964/0979 — STARTUP: lê as INSTRUÇÕES DE PROJETO (AGENT.md nativo + AGENTS.md
  // Codex + CLAUDE.md Claude Code) do workspace confinado ANTES de fiar a sessão. É
  // config CONFIÁVEL do dono do repo (≠ `@arquivo`): vai p/ o canal `system`. Leitura
  // confinada/path-deny/teto + composição com precedência cravada em
  // `loadProjectInstructions`; nenhuma fonte ⇒ undefined (prompt baseline).
  // `projectInstructions` explícito (teste) tem precedência sobre a leitura do disco
  // (e, nesse caso, não há fontes a indicar).
  const instructionsLoad: ProjectInstructionsLoad =
    opts.projectInstructions !== undefined
      ? { instructions: opts.projectInstructions, sources: [] }
      : await readProjectInstructions(opts);
  const projectInstructions = instructionsLoad.instructions;
  const instructionSources = instructionsLoad.sources;

  // EST-0969 — CONFIG PERSISTENTE de preferências de UI (tema/tier). Lida no startup
  // (fail-safe: ausente/corrompido ⇒ {} ⇒ defaults, nunca quebra). Precedência do
  // TIER: `--tier` (flag, opts.tier) > config salva > DEFAULT_TIER. O TEMA aplica a
  // config DENTRO do `detectInitialTheme` (override de env/flag ainda vence). A troca
  // em sessão (`/model`/`/theme`) grava de volta aqui p/ a próxima sessão reabrir nela.
  const configStore = opts.configStore ?? new UserConfigStore();
  const savedConfig: UserConfig = configStore.load();
  // Piso de recall do mem0 CONFIG-DRIVEN: o loop lê `ALUY_MEM_MIN_SCORE` do env da sessão.
  // Expõe o `config.recallMinScore` nessa env — SÓ se a env não fixa já (precedência env >
  // config > default 0.6). Assim o dono calibra no config.json sem precisar exportar env.
  if (env['ALUY_MEM_MIN_SCORE'] === undefined && savedConfig.recallMinScore !== undefined) {
    env['ALUY_MEM_MIN_SCORE'] = String(savedConfig.recallMinScore);
  }
  // EST-0989 (i18n) — IDIOMA inicial da TUI. Precedência: `--lang` (flag) > config salva
  // (`~/.aluy/config.json`) > auto-detect do locale do SO (LANG/LC_*; só promove en se
  // for claramente inglês) > pt-BR default. Puro/testável (resolveInitialLang). Resolvido
  // CEDO (antes do branch não-TTY, que já precisa do idioma p/ o `/lang` linear); o
  // <ThemeRoot> monta com ele e o troca AO VIVO no /lang (paralelo ao /theme).
  const initialLang = resolveInitialLang(opts.lang, configuredLang(savedConfig), env);
  // EST-0990 — estado INICIAL do MODO VIEW AVANÇADO (split). Precedência `--split` (flag,
  // opts.split) > `ui.splitView` (config salva) > default OFF (TUI de hoje). O toggle em
  // sessão (Ctrl+L / /split) grava de volta aqui p/ a próxima sessão reabrir no mesmo modo.
  const initialSplitView = resolveInitialSplitView(opts.split, savedConfig);
  // EST-1000 · ADR-0076 §1 — estado INICIAL do MODO COCKPIT. Precedência `--fullscreen`
  // (flag) > `ui.fullscreen` (config) > default INLINE. Só vale em TTY interativo (o ramo
  // não-TTY abaixo retorna antes de montar o Ink ⇒ o cockpit nunca entra em pipe/CI). O
  // toggle `/fullscreen` em sessão grava de volta aqui p/ a próxima sessão reabrir nele.
  // Tela cheia (cockpit) DESATIVADA nesta versão — ainda em ajustes (decisão do dono).
  // FORÇAMOS inline no boot: `--fullscreen`/`ui.fullscreen` são ignorados e o `/fullscreen`
  // em sessão só avisa. Escape hatch `ALUY_FULLSCREEN=1` religa (QA/testes; reativar depois).
  const initialFullscreen =
    process.env.ALUY_FULLSCREEN === '1'
      ? resolveInitialFullscreen(opts.fullscreen, savedConfig)
      : false;
  // F197 — estado INICIAL da SUGESTÃO DE PRÓXIMO PROMPT. Precedência: `ALUY_SUGGESTIONS`
  // (env, 0/1) > `config.suggestions` (pref do `/suggest`) > default ON. É uma OPÇÃO
  // default-LIGADA (decisão do dono); o toggle em sessão grava de volta p/ a próxima.
  const initialSuggestions = resolveInitialSuggestions(savedConfig, env);

  // EST-0972 — PERSISTÊNCIA de SESSÃO (`--continue`/`--resume`). Resolve a retomada
  // ANTES de fiar a sessão (precisa do id p/ reusar o MESMO arquivo de sessão E o
  // mesmo subdir do journal). O cwd da retomada é o workspace ABSOLUTO (a raiz
  // confinada), não o `process.cwd()` cru — casa `--continue` ao diretório real.
  // GC best-effort no start (idade/teto) — nunca bloqueia. Fail-safe: nada casa ⇒
  // sessão nova (resolução `none`), sem id forçado.
  const sessionStore = opts.sessionStore ?? new SessionStore();
  // best-effort: limpa sessões antigas/excedentes (unlink real). Não derruba nada.
  // ADR-0150 (balde b) — `session.gcMaxAgeMs`/`gcMaxCount` do config único, com a
  // sanidade MÍNIMA aplicada por `resolveSessionGcOptions` (idade ≥1 dia, contagem ≥1).
  try {
    sessionStore.gc(resolveSessionGcOptions(savedConfig.session));
  } catch {
    /* GC é QoL — silêncio em falha */
  }
  // Workspace confinado da sessão (raiz canonicalizada). Reusado p/ o cwd absoluto da
  // retomada E p/ a leitura confinada do `.mcp.json` do projeto (EST-0979).
  const cwdWorkspace = new NodeWorkspace(
    opts.workspaceRoot !== undefined ? { root: opts.workspaceRoot } : {},
  );
  const cwdAbs = cwdWorkspace.root;
  // EST-0972 (BUG 2) — pedidos EXPLÍCITOS (`--resume`/`--continue`) seguem o caminho
  // de sempre. Sem flag (e sem `--new`), o boot AUTO-OFERECE retomar a sessão recente
  // do MESMO cwd — corrigindo o "voltou do zero" (o auto-save gravava por-turno, mas
  // reabrir sem flag começava nova). Só no TTY interativo: sem TTY não há prompt
  // possível, então não auto-retomamos (fail-safe ⇒ sessão nova; `--continue` segue
  // valendo p/ pipes/CI). A decisão é orquestrada em `decideBootResume` (testável sem
  // Ink); aqui só aplicamos o resultado. A oferta restaura SÓ os blocos estáticos
  // (sanitizeBlocks já descarta streaming/running) — idêntico ao `--continue`.
  const resumed: ResumeResolution = await decideBootResume({
    request: opts.resume,
    fresh: opts.fresh === true,
    isTty,
    store: sessionStore,
    cwd: cwdAbs,
    // EST-0989 — a auto-oferta de retomada agora aparece na CAIXA do splash (TTY),
    // não mais como `↻ … [S/n]` solto no meio da tela.
    promptYesNo: bootPrompt,
    // ADR-0150 (balde b) — janela de "recente" p/ a auto-oferta, config-driven
    // (clampada a 7 dias por `resolveAutoResumeWindowMs`; ausente ⇒ 24h de sempre).
    windowMs: resolveAutoResumeWindowMs(savedConfig.session?.autoResumeWindowMs),
  });
  // F110 — `--resume <id>` pedido mas o id não existe: AVISA (não cai calado numa sessão
  // nova). Espelha o `/resume <id>` em-sessão (history.ts) e a filosofia do F109 (não
  // dropar a intenção do usuário em silêncio). Segue p/ sessão nova (id novo) após o aviso.
  if (resumed.kind === 'not-found') {
    process.stderr.write(
      `aluy: sessão "${resumed.requestedId}" não encontrada — iniciando uma nova.\n`,
    );
  }
  // Retomamos o id (e a transcrição) só no caso `resumed`. `pick`/`none`/`not-found` ⇒ id novo.
  const resumedRecord = resumed.kind === 'resumed' ? resumed.record : null;

  // TIER + MODEL: precedência `--tier` (flag) > TIER+slug da sessão retomada > PREF salva
  // (`~/.aluy/config.json`) > DEFAULT_TIER. A sessão retomada carrega o tier que estava em
  // uso (continuidade).
  // EST-0972 (BUG Custom — RESUME) — resolve TIER **e** o slug Custom juntos: sem o slug,
  // retomar uma sessão Custom mandava `tier:custom` SEM model ⇒ 422. Record Custom LEGADO
  // (sem slug salvo) ⇒ fallback p/ o canônico default + aviso (nunca custom-sem-model).
  const resumedModel = resumedRecord ? resolveResumedModel(resumedRecord, DEFAULT_TIER) : undefined;
  // EST-0962 (BUG Custom — PREFERÊNCIA) — a pref agora carrega o slug junto (quando Custom),
  // então a sessão NOVA reabre no Custom+slug salvos SEM re-input. Pref LEGADA (custom sem
  // slug, gravada antes deste fix) ⇒ MESMA decisão do resume: fallback canônico + aviso.
  const preferredModel = resolvePreferredModel(savedConfig, DEFAULT_TIER);
  const tierFromResume =
    resumedModel && resumedModel.tier.trim() !== '' ? resumedModel.tier : undefined;
  // A pref entra na precedência como o `tier` resolvido dela (legado já tratado acima): o
  // resume (se houve) VENCE a pref; a flag vence ambos; sem nada, cai no DEFAULT_TIER.
  const tierFromPref = preferredModel.tier.trim() !== '' ? preferredModel.tier : undefined;
  const resolvedTier = resolveInitialTier(
    opts.tier,
    {
      ...savedConfig,
      ...(tierFromPref !== undefined ? { tier: tierFromPref } : {}),
      ...(tierFromResume !== undefined ? { tier: tierFromResume } : {}),
    },
    DEFAULT_TIER,
  );
  // EST-0972/0962 (BUG Custom) — o slug só vale se a precedência DEIXOU o tier em `custom`
  // (uma flag `--tier` canônica vence ⇒ sem slug, sem 422). A FONTE do slug segue a fonte
  // que ganhou o tier: resume VENCE pref. Vai p/ o buildSession (caller + meta) p/ a 1ª
  // chamada já levar o model — sem `tier:custom` sem model na sessão nova.
  // EST-1007 · EST-0962 · HG-2 — `--model <slug>` passa o SLUG Custom DIRETO (espelha o
  // `/model` custom da TUI): quando o caller envia `opts.model` (do `--model`), ele é a
  // FONTE de MAIOR precedência do slug sob `tier:'custom'`. É o nome curado do modelo no
  // catálogo do broker (DADO, não credencial — CLI-SEC-7). Sem `opts.model`, a fonte
  // segue a do tier (resume vence pref); flag `--tier custom` nua continua sem slug.
  const resolvedCustomModel =
    resolvedTier !== 'custom'
      ? undefined
      : opts.model !== undefined && opts.model.trim() !== ''
        ? opts.model.trim() // EST-1007 — `--model <slug>` direto (HG-2: só o slug).
        : opts.tier !== undefined && opts.tier.trim() !== ''
          ? undefined // flag --tier custom explícita SEM --model não tem slug de origem
          : (resumedModel?.model ?? preferredModel.model);
  // HUNT-PERSIST — o PROVIDER Custom resolvido segue a MESMA fonte/precedência do slug
  // (flag `--provider` > resume > pref). Só vale sob `tier:'custom'` COM slug resolvido.
  // Sem isto, retomar/reabrir uma sessão Custom no boot (`--continue`/`--resume`/auto-
  // oferta/pref) perdia o provider escolhido (caía no default do slug ⇒ provider errado
  // ou 422 quando o slug existe em vários providers). O par `(provider, model)` é DADO
  // de catálogo (HG-2), nunca credencial — o broker resolve server-side.
  const resolvedCustomProvider =
    resolvedTier !== 'custom' || resolvedCustomModel === undefined
      ? undefined
      : opts.model !== undefined && opts.model.trim() !== ''
        ? // a flag `--model` ganhou o slug: o provider de boot vem do `--provider` (par
          // da CLI), tratado no spread do buildSession abaixo — aqui não duplicamos.
          undefined
        : opts.tier !== undefined && opts.tier.trim() !== ''
          ? undefined // `--tier custom` nua não tem provider de origem.
          : // o slug veio do resume/pref ⇒ o provider acompanha a MESMA fonte.
            (resumedModel?.provider ?? preferredModel.provider);

  // EST-0962 — aviso de pref LEGADA (custom sem slug): só quando a pref É a fonte efetiva
  // (sem resume e sem flag) e ela caiu no fallback. No não-TTY o aviso vai p/ o stdout; no
  // TTY entra como nota de boot (empurrada após o controller existir, abaixo).
  const preferenceWarning =
    resumedModel === undefined &&
    (opts.tier === undefined || opts.tier.trim() === '') &&
    preferredModel.warning !== undefined
      ? preferredModel.warning
      : undefined;

  // EST-0970/0979 · ADR-0058 · CLI-SEC-12 — STARTUP do MCP: lê `~/.aluy/mcp.json`
  // (global, nativo) E `.mcp.json` (projeto, padrão Claude Code, CONFINADO ao
  // workspace), MESCLADOS com **projeto > global**. Lança os servers LOCAIS (stdio)
  // com environ MÍNIMO (sem a credencial do CLI — CLI-SEC-7) e cwd no workspace, faz
  // o handshake e lista as tools. As tools entram no toolset ATRÁS da catraca (efeito
  // por padrão — E-B2): conectar cada server é `ask`, venha do global ou do projeto —
  // config de projeto = DADO, NÃO relaxa a catraca. Fail-soft: sem config ⇒ zero
  // tools; um server caído some do toolset (registrado). `opts.mcpTools` explícito
  // (teste) tem precedência sobre a descoberta de disco.
  const projectMcpFs = new NodeFileSystemPort({ workspace: cwdWorkspace });
  const projectMcpStore = new ProjectMcpConfigStore({
    workspace: cwdWorkspace,
    readFile: (p) => projectMcpFs.readFile(p),
    exists: (p) => projectMcpFs.exists(p),
  });
  // EST-0979 (FU-S3-CODEX-TOML) — leitor do `~/.codex/config.toml` (Codex GLOBAL). Fonte
  // de MENOR precedência (`.aluy` global > Codex); DADO do dono; mesma catraca MCP.
  const codexMcpStore = opts.codexMcpConfigStore ?? new CodexMcpConfigStore();
  // Captura se cada fonte compat contribuiu servers (p/ o indicador de fontes).
  let projectMcpHadServers = false;
  let codexMcpHadServers = false;
  // EST-1015 (pedido do dono) — o splash agora rotaciona FRASES DIVERTIDAS (não-produto) durante
  // o boot inteiro (ver SplashScreen/splash-quips). Antes trocávamos p/ "descobrindo MCP" aqui
  // (o passo mais lento); o dono preferiu as frases leves. Mantemos o status GENÉRICO p/ a
  // rotação seguir — sem cravar um verbo de produto no meio das piadinhas.
  // EST-1011 · ADR-0065 §11.2 (E-B3 / FU-VAU-11-bis) — sandbox de SO do PROCESSO-SERVER
  // MCP. OPT-IN nesta fase (`ALUY_SANDBOX_MCP`, irmão do `ALUY_SANDBOX_BASH`, default-OFF):
  // o mecanismo (confinar via bwrap) está pronto e provado, mas confinar por default é a
  // decisão Q-A1 (Tiago + seguranca) — net-deny default quebraria servers que precisam de
  // rede (playwright/fetch) sem a integração de egress-sob-`ask`. Ligado ⇒ todo server MCP
  // roda confinado (só o workspace visível; `~/.ssh`/`~/.aws`/`~/.aluy`/`$HOME` barrados por
  // namespace; degrade-com-aviso onde não há piso; refuse em prod sem piso). Desligado
  // (default) ⇒ comportamento atual intocado.
  const mcpSandboxLauncher = env['ALUY_SANDBOX_MCP']
    ? createSandbox({ processEnv: env })
    : undefined;

  // EST-BOOT-DECOUPLE (OPÇÃO 2) — no ramo TTY interativo, o HANDSHAKE MCP (lançar
  // processo + `initialize` + `listTools` — a parte LENTA; `npx`/`uvx` frios levam
  // segundos) NÃO segura mais o boot: o composer aparece assim que o resto do boot
  // (config/resume/backend) termina, e cada server MCP ANEXA suas tools ao toolset
  // AO VIVO (`controller.refreshMcpTools`) assim que CONECTA — sem esperar os mais
  // lentos. A CONFIG (só leitura de disco — rápida) ainda é resolvida CEDO via
  // `onConfigResolved`, a tempo de entrar em `buildSession` (nomes PENDENTES: uma
  // chamada a uma tool MCP ainda conectando vira observação HONESTA "ainda
  // conectando", não trava — ver `ToolRegistry.markMcpServerPending`/`loop.ts`).
  //
  // O não-TTY/headless mantém o boot SÍNCRONO de sempre (mesmo `await setupMcp`
  // cheio, ANTES de qualquer trabalho): não há composer a "liberar mais cedo", e o
  // `-p`/posicional já depende da MCP estar pronta antes do 1º turno (paridade com o
  // objetivo do usuário rodando JÁ). `opts.mcpTools` injetado (teste) também segue
  // 100% síncrono — sem chamar `setupMcp` de verdade, igual a antes.
  const mcpDecoupled = isTty && opts.mcpTools === undefined;
  const mcpSetupOpts = {
    workspaceRoot: cwdAbs,
    parentEnv: env,
    ...(mcpSandboxLauncher ? { sandboxLauncher: mcpSandboxLauncher } : {}),
    // ADR-0150 (balde b) — seção `mcp` do config único (connectTimeoutMs/callTimeoutMs).
    ...(savedConfig.mcp ? { mcpConfig: savedConfig.mcp } : {}),
    loadProjectConfig: async () => {
      const loaded = await projectMcpStore.load();
      projectMcpHadServers = loaded.config.servers.length > 0;
      return loaded;
    },
    loadCodexConfig: () => {
      const loaded = codexMcpStore.load();
      codexMcpHadServers = loaded.config.servers.length > 0;
      return loaded;
    },
  };
  /** Resultado por-server já adaptado (ver `SetupMcpOptions.onServerReady`). */
  type McpServerReady = {
    readonly server: string;
    readonly ok: boolean;
    readonly tools: readonly NativeTool<ToolPorts>[];
    readonly error?: string;
  };
  let mcpSetup: Awaited<ReturnType<typeof setupMcp>> | undefined;
  // A promise da descoberta (fase LENTA) — só existe no ramo decoupled; o cleanup de
  // saída a espera antes de fechar (nunca deixa processo-server órfão, mesmo se o
  // usuário sair ANTES de qualquer server terminar de conectar).
  let mcpConnectPromise: ReturnType<typeof setupMcp> | undefined;
  // Nomes ativos (config já lida) — semeia `pendingMcpServers` do `buildSession` E a
  // nota "conectando N…". Populado pelo `onConfigResolved` (rápido: só disco).
  let pendingMcpServerNames: readonly string[] = [];
  // Resultados por-server que chegam ANTES do controller existir (defensivo — a
  // descoberta é sempre mais lenta que o resto do boot síncrono até `buildSession`,
  // mas um server LOCAL raríssimo poderia, em teoria, vencer a corrida). Drenada
  // assim que `built.controller` nasce, abaixo.
  const mcpServerReadyQueue: McpServerReady[] = [];
  let onMcpServerReady: (r: McpServerReady) => void = (r) => mcpServerReadyQueue.push(r);

  if (opts.mcpTools !== undefined) {
    // Teste/injeção: `mcpSetup` fica ausente, `mcpToolsBase` usa `opts.mcpTools`
    // direto (comportamento IDÊNTICO a antes — nada muda neste ramo).
  } else if (mcpDecoupled) {
    // EST-BOOT-DECOUPLE — dispara o setup INTEIRO (config+handshake) mas só ESPERA a
    // fase RÁPIDA (config): o `onConfigResolved` resolve este gate ANTES do handshake
    // começar (setup.ts dispara o hook logo após ler+mesclar a config, ver
    // `mcp/setup.ts`). O handshake (lento) segue rodando por trás — `mcpConnectPromise`
    // não é esperado aqui.
    let releaseConfigGate: (() => void) | undefined;
    const configGate = new Promise<void>((resolve) => {
      releaseConfigGate = resolve;
    });
    mcpConnectPromise = setupMcp({
      ...mcpSetupOpts,
      onConfigResolved: ({ activeServerNames }) => {
        pendingMcpServerNames = activeServerNames;
        releaseConfigGate?.();
      },
      onServerReady: (result) => onMcpServerReady(result),
    }).then((result) => {
      mcpSetup = result;
      return result;
    });
    await configGate;
  } else {
    mcpSetup = await setupMcp(mcpSetupOpts);
  }
  const mcpToolsBase = opts.mcpTools ?? mcpSetup?.tools ?? [];
  if (mcpSetup?.configError) {
    process.stderr.write(`aluy: MCP — ${mcpSetup.configError}\n`);
  }
  /**
   * EST-BOOT-DECOUPLE — fecha os processos-server MCP em QUALQUER saída, síncrona
   * (`mcpSetup` já populado — o caso comum: headless, ou decoupled já terminou) OU
   * ainda em voo (`mcpConnectPromise` — decoupled, handshake ainda rolando). Espera
   * a conexão terminar ANTES de fechar (nunca deixa processo-server órfão mesmo se o
   * usuário sair no primeiro segundo, antes de qualquer server conectar). Idempotente
   * (chamada em múltiplos `finally`/cleanup — `close()` do McpSetup já é best-effort).
   */
  const closeMcpSetup = async (): Promise<void> => {
    if (mcpSetup) {
      await mcpSetup.close();
      return;
    }
    if (mcpConnectPromise) {
      const settled = await mcpConnectPromise.catch(() => undefined);
      await settled?.close();
    }
  };

  // ADR-0134/0135 — ATIVAÇÃO da bridge Telegram (`--telegram`). Roda ANTES do `buildSession`
  // p/ a tool `telegram_send` entrar no toolset (`mcpTools`, síncrono no build). O SINK é
  // DEFERIDO: o pump injeta no `SessionController` que só existe APÓS o build — então o sink
  // guarda uma ref mutável ao controller, preenchida logo depois. DORMENTE (C6): sem token,
  // `activateTelegram` devolve `active:false` (nenhum client/egress) e só avisamos no stderr.
  let telegramController: SessionController | undefined; // preenchido após o build (deferido).
  const telegramSink: IngressSink = {
    // INSTRUÇÃO do dono ⇒ canal `user` (MESMA via do "btw"; a catraca re-decide qualquer efeito).
    injectInstruction: (text) => {
      telegramController?.injectInput('root', text);
    },
    // DADO não-confiável ⇒ canal `observation` (envelopado DADO_NAO_CONFIAVEL, CLI-SEC-4).
    injectData: (label, text) => {
      telegramController?.ingestExternalData(label, text);
    },
  };
  let telegramBridge: TelegramBridge | undefined;
  if (opts.telegram === true) {
    const activate = opts.telegramActivate ?? activateTelegram;
    const result = await activate({ sink: telegramSink });
    if (result.active) {
      telegramBridge = result.bridge;
      if (result.allowlistSize === 0) {
        process.stderr.write(
          'aluy: telegram — bridge ativa mas allowlist VAZIA (fechada): autorize seu chat com ' +
            '`aluy telegram allow <chat-id>` para receber mensagens.\n',
        );
      }
    } else {
      // C6 — não ativou: avisa por que (sem token etc.) e segue SEM bridge (zero egress).
      process.stderr.write(`aluy: telegram — ${result.reason}\n`);
    }
  }
  // O `telegram_send` (gateado, alvo travado) entra no toolset SÓ quando a bridge subiu.
  const mcpTools = telegramBridge ? [...mcpToolsBase, telegramBridge.sendTool()] : mcpToolsBase;
  // HUNT-CAP (#266) — avisos honestos do setup (ex.: server que estourou o teto de tools
  // por server e teve o excesso cortado). Não vazam segredo (nome + contagens).
  for (const w of mcpSetup?.warnings ?? []) {
    process.stderr.write(`aluy: MCP — ${w}\n`);
  }
  // EST-0970 (search na sessão) — porta de busca do `/mcp search <termo>`: egress FIXO
  // no registro oficial aberto + anti-SSRF do #80 (sem key, DADO, só lê). Injetável p/
  // teste (socket mockado). NÃO cria egress novo — reusa `createRegistryFetch`.
  const mcpRegistryFetch: RegistryFetch = opts.mcpRegistryFetch ?? createRegistryFetch();

  // EST-0977/0978 · ADR-0061 — AGENTES definidos em `.md`: lê o DADO de DUAS camadas
  // CONFINADAS — `~/.aluy/agents/*.md` (GLOBAL, dono=confiável → entra na auto-seleção)
  // e `.claude/agents/*.md` (PROJETO, no workspace → DADO, FORA da auto-seleção
  // R-S3-3). Monta o `AgentRegistry` (precedência projeto>global §4;
  // anti-spoofing cross-camada RES-MD-1; auto-seleção só-globais). Malformado/`tools`
  // ilegível = FALHA FECHADA (RES-MD-3): coletado em `errors` (carga visível), NÃO entra.
  // O registro só tem efeito com sub-agentes habilitados; `spawn_agent({ agent })` o usa.
  const userAgentsLoader = opts.userAgentsLoader ?? new UserAgentsLoader();
  const projectAgentsLoader =
    opts.projectAgentsLoader ?? new ProjectAgentsLoader({ workspace: cwdWorkspace });
  const globalAgents = userAgentsLoader.load();
  const projectAgents = projectAgentsLoader.load();
  const agentRegistry = new AgentRegistry(globalAgents.profiles, projectAgents.profiles);
  const agentLoadErrors = [...globalAgents.errors, ...projectAgents.errors];

  // ADR-0145 (frente d/e) — SKILLS carregadas AQUI (antes do `buildSession`) p/ ir ao
  // menu de `capabilities` (DESCOBERTA-APENAS — a invocação de skill NÃO é desta onda).
  // Reusa os MESMOS loaders confinados do `/skills` (global `~/.aluy/skills/` + projeto
  // `.claude/skills/`/`.aluy/skills/`); o array é reaproveitado abaixo p/ a contagem de
  // governança (`setGovernanceCounts`), sem reler o filesystem duas vezes.
  const loadedSkills = [
    ...new UserSkillsLoader().load().skills,
    ...new ProjectSkillsLoader({ workspace: cwdWorkspace }).load().skills,
  ];

  // ── ADR-0120 / EST-1113 — BACKEND LOCAL (BYO) ─────────────────────────────────
  // Resolve o backend (flag>env>config>default broker). Sob `local`, MONTA o
  // LocalModelClient (provider direto + credencial BYO + anti-SSRF do base_url) e o
  // injeta no wiring via `brokerClient` (que aceita QUALQUER `ModelClient`). O loop/
  // callers não distinguem — é troca de estratégia no *seam*. Default `broker` ⇒
  // não-regressão (nem toca este caminho). Um `opts.brokerClient` injetado (teste)
  // VENCE — não sobrescrevemos. Falha ao montar o local ⇒ erro CLARO (não cai mudo
  // no broker: o usuário pediu local explicitamente).
  const resolvedBackend = resolveModelBackend({ flag: opts.backend, env, config: savedConfig });

  // EST-1112 · ADR-0119 — BUDGET LOCAL. Precedência: flag `--budget`/`--no-budget` >
  // env `ALUY_BUDGET` > config `localBudget` > default (OFF local, ON broker).
  const localBudget = ((): boolean => {
    // 1. flag vence
    if (opts.budget !== undefined) return opts.budget;
    // 2. env
    if (env.ALUY_BUDGET !== undefined && env.ALUY_BUDGET.trim() !== '') {
      const v = env.ALUY_BUDGET.trim().toLowerCase();
      if (v === '1' || v === 'true' || v === 'on') return true;
      if (v === '0' || v === 'false' || v === 'off') return false;
    }
    // 3. config
    if (savedConfig.localBudget !== undefined) return savedConfig.localBudget;
    // 4. default: OFF no local, ON no broker
    return resolvedBackend === 'local' ? false : true;
  })();

  // EST-1113 (display) — o provider LOCAL resolvido (ex.: `tokenrouter`), p/ o `meta`
  // mostrar `◷ local · tokenrouter · <modelo>` e não o provider do tier (ex.: `openai`).
  let localProviderForMeta: string | undefined;
  let localModelClient: import('@hiperplano/aluy-cli-core').ModelClient | undefined;
  if (resolvedBackend === 'local' && opts.brokerClient === undefined) {
    // ADR-0118 — o catálogo EFETIVO (built-ins + `~/.aluy/providers.json`). SEM isto, a
    // resolução cairia no `defaultLocalCatalog()` (só built-ins) e um provider CUSTOM
    // (ex.: tokenrouter) não seria achado ⇒ resolvia pro provider/baseURL errado ⇒
    // "provider local indisponível". Passa o MESMO catálogo p/ a config e a factory.
    const localCatalog = loadLocalProviderCatalog();
    const localCfg = resolveLocalProviderConfig({
      catalog: localCatalog,
      // (capturado abaixo p/ o meta/display)
      flags: {
        ...(opts.localProvider !== undefined ? { localProvider: opts.localProvider } : {}),
        ...(opts.localModel !== undefined ? { localModel: opts.localModel } : {}),
        ...(opts.localAuth !== undefined ? { localAuth: opts.localAuth } : {}),
        ...(opts.localBaseUrl !== undefined ? { localBaseUrl: opts.localBaseUrl } : {}),
      },
      env,
      config: savedConfig,
    });
    localProviderForMeta = localCfg.provider; // p/ o `meta`/status mostrar o provider LOCAL
    localModelClient = await buildLocalModelClient({
      catalog: localCatalog,
      provider: localCfg.provider,
      model: localCfg.model,
      auth: localCfg.auth,
      ...(localCfg.baseUrl !== undefined ? { baseUrl: localCfg.baseUrl } : {}),
      env,
      // EST-1114 — sob `auth:'oauth'`, o access token (refrescado) vem do store OAuth.
      ...(localCfg.auth === 'oauth'
        ? { oauthAccessToken: createOAuthAccessTokenProvider(localCfg.provider) }
        : {}),
    });
  }

  // EST-0962 (`--provider`) — TIRA `provider` do spread cru de `opts`: ele só entra ABAIXO,
  // re-travado em par com o `--model` (custom + slug da CLI). Sem isto, `...opts` vazaria o
  // `--provider` colado a um slug de resume/pref que não é o seu (exactOptionalPropertyTypes
  // ainda impede passar `provider: undefined`, então omitimos do spread).
  const {
    provider: _optsProvider,
    backend: _optsBackend,
    localProvider: _lp,
    localModel: _lm,
    localAuth: _la,
    localBaseUrl: _lbu,
    ...optsForBuild
  } = opts;
  void _optsProvider;
  void _optsBackend;
  void _lp;
  void _lm;
  void _la;
  void _lbu;
  const built = buildSession({
    ...optsForBuild,
    // ADR-0120 / EST-1113 — sob `backend:'local'`, injeta o LocalModelClient como o
    // `ModelClient` da sessão (mesmo contrato do broker). O wiring o usa p/ o caller
    // de stream/loop sem mudar nada. `undefined` (modo broker) ⇒ o wiring cria o
    // BrokerModelClient de sempre (não-regressão). Um teste que já injetou
    // `opts.brokerClient` o preserva (localModelClient fica undefined acima).
    ...(localModelClient !== undefined ? { brokerClient: localModelClient } : {}),
    // EST-0991 · ADR-0072 — modo EFETIVO: cai p/ `normal` se a confirmação de YOLO
    // foi recusada no boot. Vence o `opts.mode` cru (e a cerca/anti-SSRF do wiring
    // derivam DESTE modo — então recusar o YOLO também restaura a cerca/SSRF).
    ...(effectiveMode !== undefined ? { mode: effectiveMode } : {}),
    // EST-0977/0978 — registro de agentes-`.md` (só usado com sub-agentes habilitados).
    agentRegistry,
    // ADR-0145 (frente d/e) — skills já carregadas, p/ o menu de `capabilities` (descoberta).
    ...(loadedSkills.length > 0 ? { skills: loadedSkills } : {}),
    // GS-MD7 (fix registry-cwd) — relê os agentes de PROJETO do cwd CORRENTE no spawnNamed. O
    // `projectAgentsLoader` está ancorado no `cwdWorkspace` (= cwdPort), cujo `load()` resolve
    // `.claude/agents/` relativo ao sessionCwd — então segue o `cd`. Globais ficam fixos do boot.
    reloadProjectAgents: () => projectAgentsLoader.load().profiles,
    // tier resolvido pela precedência (flag > sessão retomada > pref salva > default).
    tier: resolvedTier,
    // ADR-0120 — backend EFETIVO (flag>env>config>default) p/ a StatusBar indicar o modo.
    effectiveBackend: resolvedBackend,
    // ADR-0150 §8/§9 — seção `services` (porta/host dos sidecars) p/ o judge/recall AO VIVO.
    ...(savedConfig.services ? { services: savedConfig.services } : {}),
    // headroom CONFIG-DRIVEN (não env-only): liga por profile:turbo + sidecarToggles.headroom
    // (default on) OU services.headroom; env ALUY_HEADROOM_URL = override, ALUY_HEADROOM_OFF = kill.
    ...(() => {
      const hru = resolveHeadroomUrl({
        env,
        profile: savedConfig.profile ?? 'turbo', // default real do sistema (boot-trigger)
        ...(savedConfig.sidecarToggles?.headroom !== undefined
          ? { headroomToggle: savedConfig.sidecarToggles.headroom }
          : {}),
        ...(savedConfig.services ? { services: savedConfig.services } : {}),
      });
      return hru !== undefined ? { headroomUrl: hru } : {};
    })(),
    // ADR-0150 §5 — limits do config (maxTokens/maxOutputTokens/maxIterations); flag/env vencem.
    ...(savedConfig.limits ? { limits: savedConfig.limits } : {}),
    // ADR-0150 §5 — context do config (window/autocompactAt/autocompactMax); flag/env vencem.
    ...(savedConfig.context ? { context: savedConfig.context } : {}),
    // ADR-0146 (D4) — dial GLOBAL `subAgent.model` (default dos FILHOS quando nem o
    // spawn nem o `.md` setam `model`). MERGE explícito sobre `opts.subAgents` (já veio
    // via `...optsForBuild` com `{ enabled }` de `aluy.ts`) — preserva os campos
    // existentes e SOMA o `defaultModel`; `enabled` cai em `false` só no caso
    // defensivo em que `opts.subAgents` não veio (sub-agentes OFF ⇒ o dial é inerte
    // de qualquer jeito). Ausente no config ⇒ não sai (cai no default `same-as-parent`).
    ...(savedConfig.subAgent?.model !== undefined
      ? {
          subAgents: {
            enabled: opts.subAgents?.enabled ?? false,
            ...(opts.subAgents?.maxConcurrency !== undefined
              ? { maxConcurrency: opts.subAgents.maxConcurrency }
              : {}),
            ...(opts.subAgents?.timeoutMs !== undefined
              ? { timeoutMs: opts.subAgents.timeoutMs }
              : {}),
            ...(opts.subAgents?.env !== undefined ? { env: opts.subAgents.env } : {}),
            defaultModel: savedConfig.subAgent.model,
          },
        }
      : {}),
    // ADR-0150 (balde b) — subagents do config (maxPerCall/maxConcurrency/idleTimeoutMs).
    ...(savedConfig.subagents ? { subagentsConfig: savedConfig.subagents } : {}),
    // ADR-0150 (balde b) — cycle do config (defaultDurationMs/defaultIterations/defaultIntervalMs).
    ...(savedConfig.cycle ? { cycleConfig: savedConfig.cycle } : {}),
    // ADR-0150 (Tier 2) — advanced do config (self-check/mem-pressure/web-fetch).
    ...(savedConfig.advanced ? { advanced: savedConfig.advanced } : {}),
    // EST-1112 · ADR-0119 — budget local resolvido (flag>env>config>default).
    localBudget,
    // EST-0972/0962 (BUG Custom) — slug Custom resolvido (só sob `tier:'custom'`): da
    // sessão retomada OU da pref salva (resume vence pref). A 1ª chamada já leva o model
    // ⇒ sem `tier:custom` sem model (422). undefined fora de Custom.
    ...(resolvedCustomModel !== undefined ? { model: resolvedCustomModel } : {}),
    // EST-0962 (`--provider`) — NOME do provider em PAR com `--model` (`--provider X
    // --model Y`). Só viaja quando o slug Custom resolvido VEIO do `--model` (a flag
    // venceu resume/pref): casa com o par `--provider`+`--model` da CLI, nunca colado a
    // um slug de resume/pref. Sob `tier:'custom'` + com `model`; a wiring + o caller +
    // o `buildChatBody` re-travam. É só o NOME (DADO, não credencial — HG-2/CLI-SEC-7);
    // o broker resolve (provider,model)→credencial server-side. Sem o par ⇒ NÃO sai
    // (sobrescreve o `...opts` p/ não vazar `--provider` colado a um slug que não é o seu).
    // BACKEND LOCAL: o provider do `meta` é o LOCAL resolvido (`tokenrouter`), não o do
    // tier/`--provider` — senão o status mostra `◷ local · openai · …` (o wireFormat/tier)
    // em vez do provider real. Pro broker, mantém a lógica do tier custom abaixo.
    ...(resolvedBackend === 'local' &&
    localProviderForMeta !== undefined &&
    localProviderForMeta !== ''
      ? { provider: localProviderForMeta }
      : resolvedTier === 'custom' &&
          opts.provider !== undefined &&
          opts.provider.trim() !== '' &&
          opts.model !== undefined &&
          opts.model.trim() !== '' &&
          resolvedCustomModel === opts.model.trim()
        ? { provider: opts.provider.trim() }
        : // HUNT-PERSIST — sem o par `--provider`/`--model` da CLI, herda o provider do
          // resume/pref (mesma fonte do slug). Só sob `custom` + slug presente.
          resolvedCustomProvider !== undefined && resolvedCustomProvider.trim() !== ''
          ? { provider: resolvedCustomProvider.trim() }
          : {}),
    // EST-0972 — REUSA o id da sessão retomada p/ o journal/record continuarem no
    // mesmo lugar (a sessão "é a mesma"). Sem retomada ⇒ buildSession gera id novo.
    ...(resumedRecord !== null ? { sessionId: resumedRecord.id } : {}),
    ...(projectInstructions !== undefined ? { projectInstructions } : {}),
    // EST-1109 — agentes DISPONÍVEIS no contexto do modelo (nota COMPACTA p/ o system).
    ...(() => {
      const note = buildAvailableAgentsNote(agentRegistry.list());
      return note !== undefined ? { availableAgents: note } : {};
    })(),
    // EST-1149 · ADR-0127 — COMANDOS DA SESSÃO no contexto (auto-conhecimento): o agente
    // RECOMENDA o `/cycle` etc. em vez de inventar. Gerada do registro (single-source).
    ...(() => {
      const note = buildSessionCommandsNote();
      return note !== undefined ? { sessionCommands: note } : {};
    })(),
    // EST-0970 — tools MCP já descobertas (handshake feito acima) → registro/catraca.
    // No boot desacoplado (`mcpDecoupled`), `mcpTools` está VAZIO aqui de propósito —
    // cada server ainda está conectando e ANEXA suas tools depois (ver
    // `controller.refreshMcpTools` mais abaixo, pós-`splash.finish()`).
    ...(mcpTools.length > 0 ? { mcpTools } : {}),
    // EST-BOOT-DECOUPLE — servers MCP configurados mas ainda conectando: marca os
    // PENDENTES no toolRegistry (mensagem honesta "ainda conectando" em vez de "tool
    // desconhecida" p/ uma chamada precoce). Vazio (sem MCP configurado, ou boot
    // síncrono) ⇒ sem efeito.
    ...(pendingMcpServerNames.length > 0 ? { pendingMcpServers: pendingMcpServerNames } : {}),
    // EST-1012 — ROBUSTEZ DE MEMÓRIA · MONITOR DE PRESSÃO de heap (backstop de OOM). O
    // `heapLimitMb` é o MESMO `--max-old-space-size` que o launcher aplicou (resolvido
    // de `ALUY_MAX_HEAP_MB`/default); o amostrador lê o heap usado. A config escalonada
    // (compactar→avisar→encerrar) é resolvida no controller (env). A porta de
    // encerramento-limpo (que SALVA a sessão + desmonta a TUI) é injetada DEPOIS do
    // `render` (setMemoryShutdown + startMemoryMonitor). Desligável por `ALUY_MEM_PRESSURE_OFF`.
    memoryMonitor: {
      heapLimitMb: resolveHeapLimitMb(env),
      sampleHeapUsed: () => process.memoryUsage().heapUsed,
    },
  });

  // EST-BOOT-DECOUPLE/EST-MCP-STATUSBAR — `built.controller` já existe: a partir de
  // agora, um server MCP que conecta ANEXA suas tools direto no toolset AO VIVO (não
  // precisa mais da fila) E avança o progresso da StatusBar (`mcpProgress` —
  // `startMcpProgress`/`reportMcpServerReady`). ANTES isto empurrava uma NOTA na
  // conversa ("conectando N…" → "M/N conectados") — pedido do dono: tirar isso da
  // tela principal, deixar só uma barrinha discreta no rodapé + um ✓ rápido que some
  // sozinho. `mcpConnectPromise` só existe no ramo TTY decoupled (nunca no headless) —
  // seguro chamar aqui sem checar `isTty` de novo. Drena qualquer resultado que tenha
  // chegado ANTES deste ponto (defensivo — ver comentário acima da fila), p/ nenhum
  // server escapar da contagem.
  {
    const mcpTotal = pendingMcpServerNames.length;
    onMcpServerReady = (r) => {
      built.controller.refreshMcpTools(r.tools, r.server);
      if (mcpConnectPromise && mcpTotal > 0) {
        built.controller.reportMcpServerReady(r.ok);
      }
    };
    if (mcpConnectPromise && mcpTotal > 0) {
      built.controller.startMcpProgress(mcpTotal);
      // HUNT-CAP (#266) — avisos honestos (teto de tools por server) só ficam
      // conhecidos quando TODO o setup termina (o array agregado, não o por-server).
      void mcpConnectPromise.then((setup) => {
        for (const w of setup.warnings ?? []) {
          process.stderr.write(`aluy: MCP — ${w}\n`);
        }
      });
    }
    for (const r of mcpServerReadyQueue.splice(0, mcpServerReadyQueue.length)) {
      onMcpServerReady(r);
    }
  }

  // EST-0972 — ALVO efetivo do auto-save: o id+cwd da sessão CORRENTE. Começa no
  // retomado (boot) ou num id novo. É MUTÁVEL pois o `/history` (retomada AO VIVO,
  // dentro da sessão) TROCA o alvo p/ a sessão escolhida — a partir daí o auto-save
  // grava no arquivo dela. `id` é a chave de `~/.aluy/sessions/<id>.json`.
  const activeSession = {
    id: resumedRecord?.id ?? newSessionId(),
    cwd: cwdAbs,
  };

  // RESTAURA a transcrição visível (se retomou) e SEMEIA o contexto do modelo. O
  // histórico volta como a PRÓPRIA conversa; o conteúdo de tool/`!`/arquivo dentro
  // dele mantém o envelope (blocksToHistory → observation, envelopada por
  // buildMessages como DADO_NAO_CONFIAVEL). NADA ingerido vira instrução (CLI-SEC-4).
  const resumedHistory: HistoryItem[] = resumedRecord ? blocksToHistory(resumedRecord.blocks) : [];
  if (resumedRecord) built.controller.restoreBlocks(resumedRecord.blocks);
  // EST-0972 (rename) — RESTAURA o RÓTULO + COR de identificação da sessão retomada
  // (boot via --continue/--resume/auto-oferta) ⇒ o ●+nome reaparece no composer de cara.
  // DADO DE UI (HG-2). Só quando há rótulo (sem label ⇒ controller fica sem rótulo).
  if (resumedRecord?.label !== undefined) {
    built.controller.setLabel(resumedRecord.label, resumedRecord.labelColor);
  }
  // EST-0972 (BUG Custom) — record Custom LEGADO (salvo antes do fix, sem o slug): a
  // resolução caiu no tier canônico default. Avisa o usuário (uma nota honesta) — a
  // sessão volta funcional, sem 422 e sem surpresa muda.
  if (resumedModel?.warning) built.controller.pushNote('model', [resumedModel.warning]);
  // EST-0962 (BUG Custom) — pref LEGADA (Custom salvo antes do fix, SEM o slug): a
  // resolução da preferência caiu no canônico default em vez de "custom sem modelo".
  // Avisa (mesma nota honesta do resume) — a sessão nova abre funcional, sem re-input
  // mudo nem 422. Só quando a pref É a fonte efetiva (sem resume, sem flag --tier).
  if (preferenceWarning !== undefined) built.controller.pushNote('model', [preferenceWarning]);

  // Helper de auto-save (best-effort): grava a transcrição corrente no store. Falha
  // de escrita NUNCA derruba a sessão (autoSaveSession engole o erro).
  const saveNow = (): void => {
    // F190 — o gate de "tem o que retomar" vive no autoSaveSession (fonte única, testável).
    autoSaveSession(sessionStore, {
      id: activeSession.id,
      cwd: activeSession.cwd,
      tier: built.controller.tier,
      // EST-0972 (BUG Custom) — persiste o slug Custom corrente (o store só o grava sob
      // `tier:'custom'`). Sem isto, retomar a sessão perdia o model ⇒ `tier:custom` sem
      // model ⇒ 422. undefined fora de Custom (nunca slug fantasma).
      ...(built.controller.model !== undefined ? { model: built.controller.model } : {}),
      // HUNT-PERSIST — persiste o PROVIDER Custom corrente (o store só o grava em par
      // com o slug sob `tier:'custom'`). Sem isto, retomar perdia o provider escolhido.
      ...(built.controller.provider !== undefined ? { provider: built.controller.provider } : {}),
      // EST-0972 (rename) — persiste o RÓTULO + COR correntes (DADO DE UI; o store só
      // grava a cor quando há rótulo). Sem rótulo ⇒ os campos somem do record.
      ...(built.controller.label !== undefined ? { label: built.controller.label } : {}),
      ...(built.controller.labelColor !== undefined
        ? { labelColor: built.controller.labelColor }
        : {}),
      blocks: built.controller.blocks,
    });
  };

  // EST-0974/0979 — COMANDOS CUSTOMIZADOS: lê o DADO de DUAS fontes — `~/.aluy/
  // commands/*.md` (global, nativo) e `.claude/commands/*.md` (projeto, padrão Claude
  // Code, CONFINADO ao workspace) — e MESCLA com **projeto > global** (nome colidente:
  // a definição do projeto vence). Constrói os `SlashCommand` (source `user`) p/ o
  // menu/palette E o mapa name→template p/ a expansão. O `.md` é config do dono; o
  // resultado da expansão é um OBJETIVO submetido pelo usuário (passa pela catraca
  // normal) — config de projeto NÃO relaxa a catraca. Idempotente: relê a cada boot.
  const commandsLoader = opts.userCommandsLoader ?? new UserCommandsLoader();
  const projectCommandsLoader =
    opts.projectCommandsLoader ?? new ProjectCommandsLoader({ workspace: cwdWorkspace });
  const globalUserCommands = commandsLoader.load();
  const projectUserCommands = projectCommandsLoader.load();
  const loadedUserCommands = mergeUserCommands(globalUserCommands, projectUserCommands);
  const userCommandList: readonly SlashCommand[] = loadedUserCommands.map((c) => ({
    name: c.name,
    summary: c.summary,
    source: 'user' as const,
    section: 'usuário' as const,
  }));
  // Mapa name→template p/ resolver a expansão quando um `/<nome>` do usuário é
  // invocado. Os nativos NÃO entram aqui (têm efeito próprio em onCommand).
  const userTemplates = new Map<string, UserCommand>(loadedUserCommands.map((c) => [c.name, c]));

  // LOTE-2 (governança .aluy/ — pedido do dono "mostrar quantos agentes/workflows/… carregados")
  // — CONTA o que foi carregado da `.aluy/` (+ `~/.aluy/` global) e espelha na StatusBar como
  // `⌁ Na·Cc·Ss·Ww·Mm`. Skills/workflows são carregados AQUI no boot (antes só sob demanda no
  // `/skills`/`/workflows`). Memória de projeto = fatos com escopo `projeto` no `.aluy/memory/`.
  // Fail-safe: qualquer fonte ausente ⇒ 0 (nunca derruba o boot).
  {
    // ADR-0145 — reusa `loadedSkills` (já carregado acima p/ o `capabilities`), sem
    // reler o filesystem de skills uma 2ª vez.
    const skills = loadedSkills;
    const workflows = [
      ...new UserWorkflowsLoader().load().workflows,
      ...new ProjectWorkflowsLoader({ workspace: cwdWorkspace }).load().workflows,
    ];
    let memory = 0;
    try {
      const facts = await new NodeMemoryStore({ workspace: cwdWorkspace }).readAll();
      memory = facts.filter((f) => f.scope === 'projeto').length;
    } catch {
      /* memória ausente/ilegível ⇒ 0 */
    }
    built.controller.setGovernanceCounts({
      agents: globalAgents.profiles.length + projectAgents.profiles.length,
      commands: globalUserCommands.length + projectUserCommands.length,
      skills: skills.length,
      workflows: workflows.length,
      memory,
    });
  }

  // EST-0974/0980 — HOOKS de ciclo-de-vida: o `buildSession` já leu o DADO
  // (`~/.aluy/hooks.json` + settings do Claude), montou o `HookRunner` (ATRÁS da MESMA
  // catraca + shell confinado) e plugou o GATE de pre-tool no loop (`preToolGate`).
  // Aqui REUSAMOS o MESMO runner/config p/ os disparos OBSERVE-ONLY (session-start /
  // turn-end / pre-tool / post-tool / ...) — sem um segundo motor de hooks.
  const hookRunner = built.hookRunner;
  const hooksConfig = built.hooksConfig;

  // EST-0972 — `--resume` SEM id: lista as sessões salvas p/ o usuário escolher e
  // retomar com `aluy --resume <id>`. Aplica-se a TTY e não-TTY: imprime a lista
  // (só metadados, nunca o corpo — CLI-SEC-6) e retorna sem montar a TUI. Um picker
  // interativo é evolução natural; o contrato do DoD é "lista e deixa escolher".
  if (resumed.kind === 'pick') {
    const out = opts.stdout ?? process.stdout;
    out.write(formatSessionList(resumed.choices).join('\n') + '\n');
    return;
  }

  // ── modo NÃO-TTY (piped/CI): texto linear sem ANSI (§9) ─────────────────────
  // EST-0957 — sem TTY não há picker; `@path` LITERAL no objetivo é resolvido pelo
  // reader confinado/path-deny (fallback do DoD). O reader é passado p/ o linear.
  if (!isTty) {
    const out = opts.stdout ?? process.stdout;
    // EST-0958 — sem TTY não há UI de ask: o resolver NEGA todo ask por fail-safe
    // (deny por inação). Sem isto, um `!comando` (ou tool do agente) que cai em ask
    // PENDURARIA o processo aguardando uma confirmação impossível. A catraca segue
    // intacta: o efeito não-aprovado simplesmente não roda.
    built.askResolver.setNonInteractive(true);
    // EST-1110 · ADR-0114 — MESMA razão p/ a tool `perguntar`: sem TTY não há UI de
    // pergunta, então o resolver resolve `unavailable` de imediato (fail-safe não-
    // pendura) e a tool devolve um erro acionável p/ o modelo seguir sozinho.
    built.questionResolver.setNonInteractive(true);
    // EST-1007 (HANG) — MESMA razão p/ a pausa-pede-direção do watchdog: sem TTY não há
    // como responder `[r]/[c]/[n]`, então a pausa resolve `end` de imediato (deny-por-
    // inação) em vez de pendurar o processo esperando a tecla impossível. Liga junto.
    built.controller.setNonInteractive(true);

    // EST-1007 (HANG) — o modo NÃO-TTY (headless `-p` E posicional piped) tem MUITOS
    // pontos de `return` (slash-commands literais, one-shot, runLinear). Se algum sair
    // sem fechar o MCP, os processos-server stdio (`~/.aluy/mcp.json`: npx everything/
    // playwright) ficam VIVOS e PINAM o event-loop ⇒ o processo NUNCA encerra (trava
    // pós-trabalho, mesmo com o objetivo já respondido e impresso). O ramo TTY já fecha
    // o MCP no `finally` do `waitUntilExit` (L~1667); o não-TTY NÃO tinha esse cleanup.
    // Aqui um `try/finally` ÚNICO garante o `mcpSetup.close()` em TODA saída do não-TTY
    // (todos os `return` abaixo, sucesso OU erro) ⇒ event-loop drena ⇒ EXIT limpo. Sem
    // isto, `aluy -p "x"` (e o posicional) penduram quando há server MCP configurado.
    try {
      // BUG-0020 — session-start hooks devem disparar também no não-TTY/headless (antes
      // ausente: o caminho TTY faz no boot do Ink; o não-TTY/headless pulava em silêncio).
      // O await é seguro aqui — não há render a não-bloquear; garante que o hook roda
      // ANTES da 1ª tool (paridade com o TTY, que dispara antes do submit do goal).
      const sessionStartHooks = selectHooks(hooksConfig, 'session-start');
      if (sessionStartHooks.length > 0) {
        await hookRunner.runAll(sessionStartHooks);
      }

      // EST-1007 — MODO HEADLESS one-shot (`-p`/`--print`/`--exec`): roda o objetivo pelo
      // MESMO loop/catraca e imprime SÓ o RESULTADO final do assistente (sem o chrome
      // rotulado do `runLinear`). FAIL-CLOSED já garantido: `setNonInteractive(true)` acima
      // faz toda categoria sempre-ask NEGAR por inação (sem TTY p/ confirmar) — a catraca
      // `decide()` NÃO é relaxada (CLI-SEC-H1; sinalizado ao `seguranca`). Diagnóstico vai
      // p/ o STDERR; o stdout fica LIMPO p/ script. Exit code via `onExitCode` (0/≠0).
      if (headless) {
        const goal = (opts.goal ?? '').trim();
        const exit = opts.onExitCode ?? (() => {});
        if (goal === '') {
          // Sem prompt (arg/posicional/stdin vazios): erro de uso p/ o stderr, exit≠0.
          process.stderr.write('aluy: -p sem prompt — passe via arg, posicional ou stdin.\n');
          exit(2);
          return;
        }
        // Semente de memória (paridade com o não-TTY): fatos lembrados entram como DADO
        // ENVELOPADO. Best-effort — falha de leitura não derruba o one-shot.
        let memorySeed: HistoryItem[] = [];
        try {
          memorySeed = [...(await built.memory.recall())];
        } catch {
          memorySeed = [];
        }
        const seed = [...memorySeed, ...resumedHistory];
        const format = opts.headless?.outputFormat ?? 'text';
        // BUG-0020 — turn-end hooks no headless: subscreve o observer ANTES do turno
        // e solta DEPOIS (try/finally). O observer dispara quando a fase transiciona
        // de ATIVA (thinking/streaming/asking) → done/budget — exatamente como na TUI.
        const detachHeadlessHooks = attachHooksObserver((o) => built.controller.subscribe(o), {
          runner: hookRunner,
          config: hooksConfig,
        });
        // EST-1018 (BUG-0021) — RESÍDUO do #204: session-start+turn-end já disparam no
        // headless, mas pre-tool/post-tool não, porque o disparo deles vem do toolObserver
        // do loop — fiado só na TUI. Aqui registramos o observador de tool-hooks no MESMO
        // caminho headless (espelha o turn-end logo acima): cada tool-call do loop dispara
        // `pre-tool` (onToolStart, antes do efeito) e `post-tool` (onToolEnd, depois) via o
        // `hookRunner` já criado em run.tsx:666 — ATRÁS da catraca, best-effort, sem bloquear.
        // Sem hooks de pre/post-tool ⇒ `undefined` (no-op: nada registrado).
        const toolHooksObserver = makeToolHooksObserver({
          runner: hookRunner,
          config: hooksConfig,
        });
        const detachHeadlessToolHooks = toolHooksObserver
          ? built.controller.addToolObserver(toolHooksObserver)
          : () => {};
        let res;
        try {
          if (format === 'stream-json') {
            // EST-XXXX · ADR-0062 — `--cycle` + `stream-json`: avisa que o stream-json
            // não cobre o cycle, mas roda o cycle mesmo assim (o stdout fica com a saída
            // linear do cycle, não NDJSON).
            if (opts.headless?.cycle) {
              process.stderr.write(
                'aluy: aviso: --cycle ignora --output-format stream-json (saída linear)\n',
              );
            }
            res = await runHeadlessStreamJson(
              built.controller,
              goal,
              {
                write: (c) => {
                  process.stdout.write(c);
                },
              },
              {
                attachReader: built.attachReader,
                ...(seed.length > 0 ? { seedHistory: seed } : {}),
              },
            );
          } else if (opts.headless?.cycle) {
            // EST-XXXX · ADR-0062 — `--cycle`: roda o objetivo em CICLOS autônomos
            // via controller.cycle (mesma mecânica do /cycle).
            //
            // EST-1019 · ADR-0062 §Addendum 1 (APR-0086) — TETO do CICLO via flags de boot
            // dedicadas: `--cycles N` (iterações) / `--cycle-for <dur>` (duração total). A
            // flag de boot VENCE o teto embutido no goal quando divergem; o goal-embutido
            // (`-p "1m tarefa"`/`--por`) segue válido (paridade com o /cycle da TUI).
            const cycleOverrides = resolveCycleBootCeilings(opts.headless);
            // APR-0086 §A1.2 — PRÉ-CHECK do NO-CAP ANTES de iniciar (stdout fica LIMPO; a
            // nota da TUI nunca é streamada no headless). A invariante "sem teto ⇒ NÃO
            // inicia" (CLI-SEC-14) é REAVALIADA pela MESMA porta `resolveCycleCeilings`
            // (fonte única): se ela lança `NoCeilingError`, recusamos com exit 2 + a
            // mensagem que SÓ sugere as flags de boot (A1.3 — copiada literalmente FUNCIONA;
            // nunca `--max-iter` embutido no goal, caso F10). Erro de SINTAXE ⇒ exit 2 com a
            // mensagem do parser. O `controller.cycle` abaixo re-trava o mesmo invariante.
            const preflight = preflightCycleCeiling(goal, cycleOverrides);
            if (preflight.kind === 'no-ceiling') {
              process.stderr.write(NO_CYCLE_CEILING_MESSAGE + '\n');
              exit(2);
              return;
            }
            if (preflight.kind === 'parse-error') {
              process.stderr.write(`aluy: ${preflight.message}\n`);
              exit(2);
              return;
            }
            // Teto OK (boot e/ou embutido) — INICIA o ciclo pela MESMA mecânica do TTY.
            let startResult: Awaited<ReturnType<typeof built.controller.cycle>> | undefined;
            let cycleErr: string | undefined;
            try {
              await streamBlocksLinear(
                built.controller,
                {
                  write: (c) => {
                    process.stdout.write(c);
                  },
                },
                async () => {
                  startResult = await built.controller.cycle(goal, cycleOverrides);
                },
              );
            } catch (e) {
              cycleErr = String(e);
            }
            // Defesa-em-profundidade: se o controller AINDA recusar (no-ceiling/parse),
            // o pré-check já cobriu — mas mapeamos p/ exit 2 por segurança (nunca exit 0).
            if (startResult !== undefined && startResult.started === false) {
              process.stderr.write(
                startResult.refused === 'no-ceiling'
                  ? NO_CYCLE_CEILING_MESSAGE + '\n'
                  : `aluy: ${startResult.message ?? 'ciclo não iniciado'}\n`,
              );
              exit(2);
              return;
            }
            // started:true ⇒ o ciclo rodou; `ran:false` ⇒ erro de EXECUÇÃO do motor.
            const ok =
              cycleErr === undefined &&
              startResult !== undefined &&
              startResult.started === true &&
              startResult.ran;
            res = { result: '', ok, diagnostic: cycleErr };
          } else {
            res = await runHeadlessPrint(built.controller, goal, {
              attachReader: built.attachReader,
              ...(seed.length > 0 ? { seedHistory: seed } : {}),
              quiet: opts.headless?.quiet ?? false,
            });
          }
        } finally {
          detachHeadlessHooks();
          detachHeadlessToolHooks(); // EST-1018 — solta o observador de pre/post-tool.
        }
        saveNow(); // grava a transcrição do one-shot (auto-save best-effort).
        // Diagnóstico (anexos recusados, falha) → STDERR; nunca polui o stdout scriptável.
        if (res.diagnostic !== undefined) process.stderr.write(`aluy: ${res.diagnostic}\n`);
        if (format === 'json') {
          // `--output-format json`: 1 linha parseável com o resultado + metadados (HG-2:
          // tier/slug, NUNCA provider/credencial). `result` vazio em falha (ok:false).
          const payload = {
            result: res.result,
            ok: res.ok,
            tier: built.controller.tier,
            ...(built.controller.model !== undefined ? { model: built.controller.model } : {}),
          };
          out.write(JSON.stringify(payload) + '\n');
        } else if (format === 'text' && res.result !== '') {
          // `text` (default): SÓ o resultado final, sem rótulo/ANSI. Uma quebra final.
          // EST-1017/BUG-0018: guard restrito a `text` — em `stream-json` o
          // `runHeadlessStreamJson` JÁ emitiu o evento `result`; reimprimir a resposta
          // crua aqui contaminaria o NDJSON (contrato linear.ts:228 = stdout só NDJSON).
          out.write(res.result + '\n');
        }
        // F78 (opção (a)) — o store de memória é FIRE-AND-FORGET no loop (não bloqueia a
        // resposta). A resposta já foi impressa acima; AGORA, antes do exit, drenamos os
        // writes em background p/ que o store COMPLETE — senão o headless perderia a
        // memória no exit rápido. Best-effort (allSettled, não trava se o mem0 cair).
        await built.controller.drainMemoryWrites();
        exit(res.ok ? 0 : 1);
        return;
      }

      // EST-0966 — `/theme`/`/theme <nome>` LITERAL no não-TTY (sem picker; sem OSC 11):
      // lista os temas ou registra a troca pretendida e retorna. O tema ativo não-TTY é
      // o resolvido do env (COLORFGBG/--theme) — sem auto-detecção (não há terminal a
      // quem perguntar). Tratado ANTES do /model (ambos são comandos, não objetivos).
      const themeHandled = runThemeLinear(opts.goal, out, {
        currentTheme: themeNameForBrightness(resolveTheme({ env }).brightness),
      });
      if (themeHandled) {
        // EST-0969 — no não-TTY o tema não re-renderiza, mas a PREFERÊNCIA persiste:
        // `aluy "/theme light"` deixa a próxima sessão interativa abrir em light. Só
        // persiste nome VÁLIDO (resolveThemeName) — lixo/lista (sem arg) não grava.
        const themeArg = themeArgOf(opts.goal);
        const entry = themeArg ? resolveThemeName(themeArg) : undefined;
        if (entry) configStore.saveTheme(entry.name);
        return;
      }
      // EST-0989 (i18n) — `/lang`/`/lang <code>` LITERAL no não-TTY (sem picker): lista os
      // idiomas ou registra a troca + persiste a pref e retorna. O idioma ativo não-TTY é
      // o `initialLang` resolvido no boot (flag>config>auto-detect>pt-BR). Espelha o /theme.
      const langHandled = runLangLinear(opts.goal, out, { currentLang: initialLang });
      if (langHandled) {
        // No não-TTY a TUI não re-renderiza, mas a PREFERÊNCIA persiste: `aluy "/lang en"`
        // deixa a próxima sessão interativa abrir em en. Só persiste código VÁLIDO
        // (resolveLang) — lixo/lista (sem arg) não grava.
        const langArg = langArgOf(opts.goal);
        const entry = langArg ? resolveLang(langArg) : undefined;
        if (entry) configStore.saveLang(entry.code);
        return;
      }
      // EST-0962 — `/model`/`/model <tier>` LITERAL no não-TTY (sem picker): lista ou
      // troca o tier e retorna (não é um objetivo p/ o loop).
      // EST-0969 — o setTier do não-TTY também persiste (wrap do controller).
      const handled = await runModelLinear(opts.goal, out, {
        catalog: built.catalogClient,
        tier: {
          setTier: (t, m) => {
            built.controller.setTier(t, m);
            configStore.saveTier(t, m);
          },
        },
        currentTier: built.controller.tier,
      });
      if (handled) return;
      // EST-0962 (/provider) — `/provider`/`/provider <name>` LITERAL no não-TTY (sem
      // picker): lista os providers ou SETA o provider do modo Custom e retorna (não é um
      // objetivo p/ o loop). Só o NOME — o broker resolve `(provider, model)` server-side.
      const providerHandled = runProviderLinear(opts.goal, out, {
        currentProvider: built.controller.provider,
        setProvider: (name) => built.controller.setProvider(name),
      });
      if (providerHandled) return;
      // EST-0960b — `/undo`/`/redo` LITERAL no não-TTY (sem prompt): reverte/reaplica e
      // retorna (não é objetivo p/ o loop). Concorrência ⇒ avisa e não sobrescreve.
      const undoHandled = await runUndoLinear(
        opts.goal,
        out,
        new UndoController({ journal: built.journal }),
      );
      if (undoHandled) return;
      // EST-0983 — `/memory` LITERAL no não-TTY (sem TTY ⇒ sem o roteamento da App):
      // vê/edita/esquece/fixa pela MESMA mecânica interna do TTY (parseMemoryCommand/
      // runMemoryCommand sobre `built.memory`), NUNCA cai no agente como objetivo. As
      // mutações são NEGADAS em Plan (idêntico ao TTY). Tratado ANTES do `runLinear`.
      const memoryHandled = await runMemoryLinear(opts.goal, out, {
        memory: built.memory,
        isPlan: built.engine.isPlan,
      });
      if (memoryHandled) return;
      // EST-1108 — `/todo` LITERAL no não-TTY (§9): roteia pela MESMA mecânica do TTY
      // (`parseTodoCommand`/`runTodoCommand` sobre o `TodoStorePort`). As mutações
      // (done/clear) são NEGADAS em Plan. NUNCA cai no agente como objetivo.
      const todoHandled = await runTodoLinear(opts.goal, out, {
        store: built.todoStore,
        isPlan: built.engine.isPlan,
      });
      if (todoHandled) return;
      // EST-0983 — `/clear [full|memory]` LITERAL no não-TTY: roteia pela MESMA mecânica do
      // TTY (parseClearCommand/runClearCommand). Os destrutivos são FAIL-CLOSED no pipe
      // (sem 2ª invocação a confirmar ⇒ só avisam, NÃO apagam). NUNCA cai no agente.
      const clearHandled = await runClearLinear(opts.goal, out, {
        memory: built.memory,
        clearSession: () => built.controller.clear(),
      });
      if (clearHandled) return;
      // EST-0972 (rename) — `/rename` LITERAL no não-TTY: aplica o nome+cor (set/clear),
      // PERSISTE e ecoa a confirmação — NUNCA cai no agente como objetivo (mesmo bug que o
      // `/memory`/`/cycle` tiveram). Cor inválida ⇒ erro listando as válidas. DADO DE UI.
      const renameHandled = runRenameLinear(opts.goal, out, {
        setLabel: (label, color) => built.controller.setLabel(label, color),
        currentLabel: built.controller.label,
        currentColor: built.controller.labelColor,
        persist: () => saveNow(),
      });
      if (renameHandled) return;
      // EST-0972 — `/history` LITERAL no não-TTY (sem picker): SEM id ⇒ LISTA as sessões
      // anteriores (id + metadados, recente-first); COM id (`/history <id>`) ⇒ TROCA o
      // alvo do auto-save p/ aquela sessão E semeia o contexto (mesma ação do TTY, via
      // applyResumeRecord), p/ um objetivo subsequente continuar a conversa. NUNCA cai no
      // agente como objetivo. Só metadados na listagem (CLI-SEC-6). Tratado ANTES do
      // runLinear — devolve true se tratou a linha.
      const historyHandled = runHistoryLinear(opts.goal, out, {
        store: sessionStore,
        resume: (record) => {
          activeSession.id = record.id;
          activeSession.cwd = record.cwd;
          // EST-0972 (BUG Custom) — restaura TIER **e** slug Custom juntos (record Custom
          // legado sem slug ⇒ fallback canônico + aviso; nunca `tier:custom` sem model).
          const rm = resolveResumedModel(record, DEFAULT_TIER);
          if (rm.tier.trim() !== '') built.controller.setTier(rm.tier, rm.model);
          // HUNT-PERSIST — `setTier` zera o provider; reaplica o provider Custom salvo.
          if (rm.tier === 'custom' && rm.model) built.controller.setProvider(rm.provider);
          if (rm.warning) out.write(`[history] ${rm.warning}\n`);
          // HUNT-RESUME — zera o contexto de continuação da sessão de onde se SAIU
          // ANTES de semear a retomada (a conversa anterior não vaza na retomada).
          built.controller.resetResumeContext();
          built.controller.restoreBlocks(record.blocks);
          const seed = blocksToHistory(record.blocks);
          if (seed.length > 0) built.controller.seedHistory(seed);
          saveNow();
        },
      });
      if (historyHandled) return;
      // EST-0981 · ADR-0062 · CLI-SEC-14 — `/cycle` LITERAL no não-TTY (mesmo bug que o
      // `/memory` teve): sem este roteamento, `aluy "/cycle rode para sempre"` piped
      // mandava o texto como OBJETIVO p/ o modelo (a LLM criava um forever-script) em vez
      // de RECUSAR por falta de teto. Roteia pela MESMA mecânica do TTY (controller.cycle
      // → CycleEngine), com as paradas DURAS idênticas (sem-teto⇒NÃO inicia; tetos;
      // anti-loop-vazio). Tratado ANTES do `runLinear` — NUNCA cai no agente. Os asks
      // por-ciclo já auto-negam (askResolver não-interativo, setado acima). Auto-save
      // best-effort cobre os ciclos como qualquer outro turno.
      {
        let cycleHandled = false;
        const unsubCycleSave = built.controller.subscribe(() => saveNow());
        try {
          cycleHandled = await runCycleLinear(built.controller, opts.goal, out);
        } finally {
          unsubCycleSave();
          if (cycleHandled) saveNow();
        }
        if (cycleHandled) return;
      }
      // EST-0983 — RECALL no não-TTY (paridade com o boot do TTY): os fatos lembrados
      // de sessões anteriores entram como DADO ENVELOPADO (observation, GS-M3) no
      // contexto do objetivo deste turno — junto do histórico de uma sessão retomada.
      // Sem isto, a sessão piped NUNCA relembrava (o write ia pro disco, mas o read
      // nunca rodava). Best-effort: uma falha de leitura não derruba a sessão.
      let memorySeedLinear: HistoryItem[] = [];
      try {
        memorySeedLinear = [...(await built.memory.recall())];
      } catch {
        memorySeedLinear = [];
      }
      const linearSeed = [...memorySeedLinear, ...resumedHistory];
      // EST-0972 — auto-save no não-TTY: assina o estado e grava a transcrição a cada
      // mudança (best-effort). `seedHistory` semeia o contexto (recall + retomada).
      const unsubSave = built.controller.subscribe(() => saveNow());
      // BUG-0020 — turn-end hooks no não-TTY (runLinear): mesmo wiring da TUI.
      const detachLinearHooks = attachHooksObserver((o) => built.controller.subscribe(o), {
        runner: hookRunner,
        config: hooksConfig,
      });
      try {
        await runLinear(built.controller, opts.goal, out, {
          attachReader: built.attachReader,
          ...(linearSeed.length > 0 ? { seedHistory: linearSeed } : {}),
        });
      } finally {
        detachLinearHooks();
        unsubSave();
        saveNow(); // gravação final garantida ao encerrar.
      }
      return;
    } finally {
      // EST-1007 (HANG) — fecha os processos-server MCP em TODA saída do não-TTY
      // (best-effort, idempotente com o cleanup do ramo TTY). É o que destrava o EXIT:
      // sem isto os child-servers stdio pinam o event-loop e o `-p`/posicional travam.
      await closeMcpSetup();
    }
  }

  // ── modo TTY: render Ink ────────────────────────────────────────────────────
  // EST-0989 — TRANSIÇÃO LIMPA splash→TUI. O trabalho de boot acabou; encerra o
  // splash: desmonta o Ink dele E re-emite o boot-clear (tela+scrollback) p/ a App
  // montar do ZERO, sem deixar fantasma do splash no scrollback (anti-flicker #118).
  // Feito ANTES da auto-detecção OSC 11 (que lê stdin) — o splash solta o raw-mode do
  // stdin ao desmontar, então não há disputa de stdin.
  if (splash) {
    await splash.finish();
  } else {
    // EST-0948 — sem splash (caller injetou prompt): mantém o clear INICIAL de sempre,
    // ANTES de montar o Ink da App, p/ o boot começar do zero.
    emitBootClear(opts.stdout ?? process.stdout, isTty);
  }
  // BUG-WIN — No Windows, o prompt YOLO usa stdin em raw-mode seguido de uma chamada
  // SÍNCRONA ao Credential Manager (keychain). Essa chamada bloqueia o event loop e
  // deixa o stdin com eventos pendentes na fila (teclas do prompt, key-up do Windows).
  // Quando o loop é libertado, esses eventos disparam fora de ordem e o Ink falha a
  // montar (setRawMode lança ou a stream fica num estado inconsistente). O drain aqui:
  // 1) resume o stdin p/ escoar os eventos pendentes do buffer do OS;
  // 2) aguarda dois ticks p/ o event loop processar tudo;
  // 3) pausa de volta — estado limpo e conhecido antes do OSC 11 e do render do Ink.
  if (isTty) {
    try {
      process.stdin.resume();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      process.stdin.pause();
    } catch {
      /* best-effort — stdin já pode estar num estado válido */
    }
  }
  // EST-0966 — AUTO-DETECÇÃO do fundo via OSC 11 (best-effort, só TTY, NO_COLOR
  // respeitado, timeout curto). Terminal de fundo claro ⇒ tema light; sem resposta/
  // sem suporte ⇒ default dark. Um override explícito do env (COLORFGBG/--theme) NÃO
  // é sobreposto pela heurística (preferência do usuário > auto-detecção).
  const initialTheme = await detectInitialTheme(env, opts.stdout, savedConfig);
  // O `theme` resolvido (p/ animate + notify port). O <ThemeRoot> re-resolve a partir
  // do `initialTheme` ao montar e a cada troca do `/theme` — esta é a fotografia 1.
  // EST-0984 — o `--ascii` (opts.safeGlyphs) entra como override do perfil seguro
  // em TODA resolução de tema (fotografia 1 e re-resoluções do <ThemeRoot>).
  const safeGlyphsOverride = opts.safeGlyphs ? { safeGlyphs: true as const } : {};
  const denseOverride = opts.dense ? { density: 'compact' as const } : {};
  const theme = resolveThemeName(initialTheme)
    ? resolveTheme({
        env,
        theme: resolveThemeName(initialTheme)!.brightness,
        ...denseOverride,
        ...safeGlyphsOverride,
      })
    : resolveTheme({ env, ...denseOverride, ...safeGlyphsOverride });

  // ── EST-1010: FUNDO do terminal por tema (OSC 11) ───────────────────────────
  // O pedido central: ao aplicar um tema, SETAR o fundo do terminal (creme/quase-
  // preto/terra) p/ casar com o web — e RESETAR no exit p/ não deixar o terminal do
  // usuário bagunçado. Best-effort: só TTY, opt-out `ALUY_SET_BG=0`, NO_COLOR
  // respeitado, terminal sem suporte ignora (degrada em silêncio). UMA sequência no
  // apply/troca e UMA no reset — nunca por frame (não regride o flicker #95/#118).
  const bgController = new BackgroundController({ stdout: opts.stdout ?? process.stdout, env });
  // Aplica o fundo do tema INICIAL (boot). A troca em runtime (`/theme`) reaplica no
  // `onThemeChanged`. O reset vai no `finally`/sinal (junto do cleanup do sync).
  {
    const initialEntry = themeByName(initialTheme);
    if (initialEntry) bgController.apply(initialEntry.bg);
  }

  // ── EST-0963: porta de NOTIFICAÇÃO (sino de atenção) ────────────────────────
  // Só construída no ramo TTY ⇒ pipe/CI nunca emite BEL/OSC (o ramo não-TTY acima
  // já retornou). O config vem do env (ALUY_NOTIFY/NO_COLOR). A escrita vai p/ o
  // MESMO stdout do render — sequências de controle curtas, nunca conteúdo.
  const notifyOut = opts.stdout ?? process.stdout;
  const notifyConfig = loadNotifyConfig(env);
  const notifyPort = new TerminalNotificationPort({
    write: (s) => notifyOut.write(s),
    isTty: true, // este ramo só roda com TTY (o não-TTY retornou acima).
    enabled: notifyConfig.enabled,
    desktop: notifyConfig.desktop,
  });
  // Gancho ESTREITO: observa as transições de fase do controller (stream público)
  // e dispara o sino em ask-pendente / done-após-longo. Não toca o controller.
  const detachNotify = attachNotifyObserver((o) => built.controller.subscribe(o), {
    port: notifyPort,
  });

  // EST-0974 — OBSERVADOR de HOOKS de `turn-end`: dispara (atrás da catraca) quando o
  // agente conclui um turno. Cada comando passa pela MESMA `decide()` (não-bypass).
  // No-op se não há hooks de turn-end na config. Soltamos junto com o notify ao sair.
  const detachHooks = attachHooksObserver((o) => built.controller.subscribe(o), {
    runner: hookRunner,
    config: hooksConfig,
  });

  // EST-0989 — YOLO CANCELADO na caixa do splash: vira uma NOTA de boot (formatada,
  // no chrome do DS) em vez da linha solta que ia p/ o stderr. Só com splash (sem ele
  // o eco em texto já saiu acima).
  if (yoloCancelled && useSplash) {
    built.controller.pushNote('yolo', ['YOLO cancelado — seguindo em modo normal.']);
  }

  // EST-0979 — INDICADOR DISCRETO de quais FONTES de config carregaram (instruções
  // nativo/compat, comandos global/projeto, MCP global/projeto). Nota informativa no
  // boot — sem cor crua (usa o canal de nota do controller/DS). Só quando há ALGO a
  // indicar (sem fontes ⇒ silêncio, prompt baseline). Não muda comportamento.
  {
    const lines = describeConfigSources({
      instructionSources,
      globalCommands: globalUserCommands.length,
      projectCommands: projectUserCommands.length,
      // EST-BOOT-DECOUPLE — no boot desacoplado `mcpSetup` ainda não existe aqui (o
      // handshake segue em background); `pendingMcpServerNames` (config já lida) dá
      // a contagem CORRETA de servers CONFIGURADOS mesmo antes de qualquer um
      // conectar. `mcpSetup?.discovery` vence quando já disponível (boot síncrono,
      // ou decoupled que por acaso já terminou).
      mcpServers: mcpSetup?.discovery.servers.length ?? pendingMcpServerNames.length,
      projectMcp: projectMcpHadServers,
      codexMcp: codexMcpHadServers,
    });
    if (lines.length > 0) built.controller.pushNote('config', lines);
  }

  // EST-BOOT-DECOUPLE/EST-MCP-STATUSBAR — o progresso da conexão MCP já foi fiado logo
  // após `buildSession` (ver comentário lá): `startMcpProgress`/`reportMcpServerReady`
  // alimentam `state.mcpProgress`, que a StatusBar exibe como barrinha + ✓ transiente —
  // NADA disso vira nota na conversa. Nada aqui; só um lembrete de onde procurar.

  // Update-notifier — nota discreta no boot se o cache já viu uma versão mais nova; em
  // paralelo refresca o cache (1x/dia, fail-soft) p/ o próximo boot. Off via
  // ALUY_NO_UPDATE_CHECK=1 / NO_UPDATE_NOTIFIER=1 / CI=true. Nunca trava nem usa rede aqui.
  {
    const upd = readUpdateNote(CLI_VERSION, env);
    if (upd !== undefined) built.controller.pushNote('update', [upd]);
    void refreshUpdateCheck(CLI_VERSION, env);
  }

  // EST-0942 — CHECK DE CREDENCIAL no boot. Se NÃO há credencial alguma (keychain
  // vazio E sem ALUY_TOKEN no ambiente), AVISA AGORA com a ação clara — sem esperar
  // a 1ª chamada virar um "broker indisponível" genérico (o bug que enganou o Tiago).
  // É só PRESENÇA: não valida o token na rede (caro/lento) — a validade vira erro
  // específico (401 ⇒ "credencial inválida/expirada") na 1ª chamada (classifyBrokerError).
  // SÓ no backend BROKER: o check de credencial é do broker (PAT/ALUY_TOKEN). Sob
  // `backend:'local'` (BYO), a credencial é a chave do provider no keychain/env — avisar
  // "rode aluy login (broker)" aqui é uma MENTIRA que faz um setup local funcionando
  // parecer quebrado (achado do dono). No local, a falta de chave vira erro específico
  // do provider na 1ª chamada, não um aviso de broker no boot.
  if (resolvedBackend === 'broker' && (await isLoggedOut({ login: built.login, env }))) {
    built.controller.pushNote('login', [
      'sem credencial — rode `aluy login` (ou defina ALUY_TOKEN).',
    ]);
  }

  // EST-0977 — NOTA dos agentes-`.md` descobertos + erros de carga (RES-MD-3, FALHA
  // FECHADA visível). Os perfis válidos viram delegáveis por nome; os malformados/
  // `tools` ilegíveis NÃO entram (rejeitados) e aparecem aqui p/ o usuário corrigir —
  // nunca silenciosamente "viram agente sem restrição".
  {
    const lines: string[] = [];
    const valid = agentRegistry.list().length;
    if (valid > 0) {
      const names = agentRegistry
        .list()
        .map((a) => `${a.name} (${a.origin === 'global' ? 'global' : 'projeto'})`)
        .join(' · ');
      lines.push(`${valid} agente(s) .md: ${names}`);
    }
    // RES-MD-1 (anti-spoofing cross-camada) — AVISA no boot dos HOMÔNIMOS projeto↔global.
    // É só o aviso de superfície; a TRAVA real é no locus (controller.spawnNamed exige
    // confirmação com origem visível e, sem TTY, NEGA fail-closed). Aqui o usuário fica
    // ciente de que delegar por esse nome usa o de PROJETO (DADO), não o global confiável.
    for (const c of agentRegistry.crossLayerConflicts) {
      lines.push(
        `⚠ "${c.name}": há um .md de PROJETO homônimo de um agente GLOBAL confiável — ` +
          `delegar por nome pedirá CONFIRMAÇÃO (sem TTY ⇒ negado).`,
      );
    }
    for (const e of agentLoadErrors) {
      lines.push(`⚠ ${e.reason}`);
    }
    if (lines.length > 0) built.controller.pushNote('agentes', lines);
  }

  // EST-0960b — controlador de `/undo`/`/redo` da sessão (consome o journal 0960a).
  // O cursor undo/redo é estado de interação; a restauração CONFINADA é do journal.
  const undoController = new UndoController({ journal: built.journal });
  // Pedido de confirmação PENDENTE de edição concorrente (CA-3). Enquanto setado, o
  // próximo /undo confirma a reversão (re-invoca `proceed`) em vez de re-checar.
  let pendingUndoConfirm: (() => Promise<UndoOutcome>) | null = null;
  // Aplica um UndoOutcome: empurra a nota; se for `confirm`, arma o pendente.
  const applyUndoOutcome = (outcome: UndoOutcome): void => {
    built.controller.pushNote(outcome.note.title, outcome.note.lines);
    pendingUndoConfirm = outcome.kind === 'confirm' ? outcome.proceed : null;
  };

  // EST-0983 — a LIMPEZA VISUAL do terminal (clear de tela+scrollback + remonta do
  // <Static>) é da App; o wiring a dispara via este holder QUANDO a sessão de fato zera
  // (`/clear`, e `/clear full` SÓ na confirmação). A App o registra no mount. No não-TTY
  // (linear) o /clear nem passa por aqui; em teste fica undefined ⇒ no-op honesto.
  let clearScreenFn: (() => void) | null = null;
  // EST-1010 (BUG-0022) — handle do Ink declarado no escopo da função (o `onCommand`
  // o usa p/ `instance.unmount()`); a ATRIBUIÇÃO vem após o `render` mais abaixo, já
  // dentro do `try` que garante a remoção dos handlers de sinal em toda saída.
  let instance: ReturnType<typeof render>;
  // EST-0983 — confirmação ARMADA de um `/clear full|memory`? (mecânica do /undo: a 2ª
  // invocação consecutiva confirma). Qualquer outro comando/cancelar a desarma.
  // HUNT-SLASH: guardamos QUAL verbo foi armado (não só um booleano): a confirmação só
  // vale p/ a invocação seguinte do MESMO destrutivo. Sem isso, armar `/clear memory` e
  // depois `/clear full` executaria `full` (mais amplo: zera a sessão também) com uma
  // confirmação que o usuário deu p/ `memory` — bypass de gate destrutivo.
  let pendingClearVerb: ClearArmedVerb;

  /**
   * EST-0970 — RECARREGA os servers MCP AO VIVO (p/ `/mcp reload` e
   * `/mcp reconnect`). Fecha os transports antigos, re-roda `setupMcp` com as
   * mesmas opções do boot, e troca as tools no registry do controller.
   *
   * @param scope `'all'` p/ todos os servers, ou o nome de um server específico.
   * @param _rereadConfig ambas as vias re-leem a config (setupMcp sempre lê disco).
   */
  const refreshMcp = async (scope: string): Promise<{ ok: string[]; failed: string[] }> => {
    // Fecha os transports ANTIGOS (CRÍTICO: não fechar orfana os servers — bug #158/#189).
    // `closeMcpSetup` também cobre o caso RARO de `/mcp reload` disparado ENQUANTO o
    // boot desacoplado ainda conecta (EST-BOOT-DECOUPLE): espera o handshake em voo
    // terminar antes de fechar, em vez de arriscar fechar um transport que nem
    // terminou de nascer.
    await closeMcpSetup();

    // Re-roda a descoberta com as MESMAS opções do boot (config de disco — reusa
    // `mcpSetupOpts`, o MESMO objeto do boot). Tanto `reconnect` quanto `reload`
    // chamam `setupMcp` — a diferença na v1 é semântica (reload re-lê os arquivos,
    // reconnect re-handshake a mesma config; `setupMcp` sempre re-lê os arquivos de
    // config de qualquer jeito).
    const next = await setupMcp(mcpSetupOpts);

    // v1 — o LIFECYCLE é all-or-nothing: `mcpSetup.close()` fecha TODOS os transports e
    // `setupMcp` relança TODOS. Logo o SWAP também tem que ser de TODAS as tools — se
    // trocássemos só as do server nomeado, as tools dos OUTROS servers ficariam apontando
    // pro transport que acabamos de fechar ⇒ "Not connected" silencioso neles. Por isso
    // `refreshMcpTools(next.tools)` SEM escopo (substitui todas as `mcp__*`). O `scope`
    // por-server só foca a MENSAGEM (abaixo); reconnect/reload granular por server é
    // follow-up (exige `setupMcp` por-server). `replaceMcpTools(scope)` fica pronto p/ lá.
    built.controller.refreshMcpTools(next.tools);

    // Atualiza o holder p/ o cleanup de saída fechar os transports NOVOS.
    mcpSetup = next;

    // Coleta ok/failed da descoberta.
    const ok: string[] = [];
    const failed: string[] = [];
    for (const s of next.discovery.servers) {
      if (scope !== 'all' && s.server !== scope) continue;
      if (s.ok) ok.push(s.server);
      else failed.push(`${s.server} (${s.error ?? 'desconhecido'})`);
    }
    return { ok, failed };
  };

  // Roteia CADA slash-command nativo a um efeito REAL (corrige o bug do no-op:
  // antes só /quit e /clear funcionavam; o resto caía em `default: break`).
  const onCommand = (command: SlashCommand, args = ''): void => {
    // EST-0983 — qualquer comando que NÃO seja o `/clear` consecutivo DESARMA uma
    // confirmação de `/clear full|memory` pendente (a confirmação só vale p/ a invocação
    // imediatamente seguinte do MESMO destrutivo). O próprio `/clear` é tratado abaixo
    // (lê o `armed` ANTES de reavaliar); todo o resto cai aqui e desarma.
    if (command.id !== 'clear') pendingClearVerb = undefined;
    if (command.source === 'user' || command.id === undefined) {
      // EST-0974 — COMANDO CUSTOMIZADO (`~/.aluy/commands/<nome>.md`): expande o
      // TEMPLATE com os args e SUBMETE como OBJETIVO do usuário. O resultado NÃO
      // bypassa nada: é o mesmo caminho de quando o usuário digita o texto — as tools
      // que o objetivo dispara passam por `decide()` normal (CLI-SEC-H1). Um comando
      // AUSENTE não chega aqui (routeInput devolve `unknown-command`).
      const tpl = userTemplates.get(command.name);
      if (!tpl) {
        // Defesa: comando `user` sem template (não deveria ocorrer — a lista e o mapa
        // vêm da MESMA fonte). Nota honesta em vez de submeter vazio.
        built.controller.pushNote(`/${command.name}`, ['comando do usuário sem corpo — ignorado.']);
        return;
      }
      const goal = expandUserCommand(tpl.template, args);
      if (goal.trim() === '') {
        built.controller.pushNote(`/${command.name}`, [
          'comando do usuário expandiu p/ vazio — nada a fazer.',
        ]);
        return;
      }
      void built.controller.submit(goal);
      return;
    }
    // EST-0962 — `/model <tier>` LITERAL: troca direto, sem o seletor (forma do não-
    // TTY / atalho). Sem arg, o seletor (picker) é aberto pela App; cair aqui com
    // arg vazio só acontece quando não há catálogo injetado ⇒ a nota informativa.
    if (command.id === 'model' && args.trim() !== '') {
      const note = applyTierLiteral((t, m) => {
        built.controller.setTier(t, m);
        // EST-0969 — persiste o tier p/ a próxima sessão (best-effort; não bloqueia).
        configStore.saveTier(t, m);
      }, args.trim());
      built.controller.pushNote(note.title, note.lines);
      return;
    }
    // EST-0966 — `/theme <nome>` aqui só com NOME INVÁLIDO (o válido troca direto pela
    // App via onSelectTheme; o vazio abre o picker). Empurra a nota honesta de
    // "tema desconhecido" (buildThemeEffect com tema ativo só p/ contexto da lista).
    if (command.id === 'theme') {
      const effect = buildThemeEffect(args, themeNameForBrightness(theme.brightness));
      if (effect.kind === 'theme') built.controller.pushNote(effect.note.title, effect.note.lines);
      return;
    }
    // EST-0962 (/provider) — `/provider [<name>]` no onCommand: o VÁLIDO já trocou direto
    // pela App (onSelectProvider) e o vazio abriu o picker; aqui cai SÓ o NOME INVÁLIDO (ou
    // o vazio sem handler). `buildProviderEffect` emite a nota honesta (lista + "desconhecido")
    // e, quando válido (caminho do não-TTY/sem-App), SETA o provider. Espelha o /theme.
    if (command.id === 'provider') {
      const effect = buildProviderEffect(args, built.controller.provider);
      if (effect.kind === 'provider') {
        if (effect.provider !== undefined) built.controller.setProvider(effect.provider);
        built.controller.pushNote(effect.note.title, effect.note.lines);
      }
      return;
    }
    // EST-0962 (/effort) — `/effort [<valor>]`: sozinho ⇒ mostra o valor atual; com valor ⇒
    // seta o `reasoning_effort` (PASSTHROUGH, qualquer string ≤32 chars). SEM tier-gate.
    if (command.id === 'effort') {
      if (!args || args.trim() === '') {
        built.controller.pushNote('effort', [
          `atual: ${built.controller.effort ?? '(default do modelo)'}`,
        ]);
      } else {
        const v = args.trim();
        if (v.length > 32) {
          built.controller.pushNote('effort', [
            `erro: "effort" aceita no máximo 32 caracteres (recebeu ${v.length})`,
          ]);
        } else {
          built.controller.setEffort(v);
          built.controller.pushNote('effort', [`definido para: ${v}`]);
        }
      }
      return;
    }
    // EST-0972 — `/rename <nome> [--cor <cor>]`: dá um RÓTULO + COR de identificação à
    // sessão corrente. É ATO DO USUÁRIO no composer (slash NÃO é tool — o agente não o
    // alcança). Aplica no controller (espelha em meta.label/labelColor ⇒ o ●+nome no
    // composer re-renderiza) e PERSISTE no record (saveNow grava label+cor — DADO DE UI,
    // HG-2: não credencial). `routeRename` é puro: resolve a cor (default determinística
    // pelo nome OU `--cor` validada na paleta do DS; inválida ⇒ erro listando as válidas).
    // EST-ASK · ADR-0080 — `/ask <pergunta>`: pergunta PARALELA read-only. FIRE-AND-FORGET
    // (`void` — NÃO aguarda): o trabalho em curso segue enquanto a resposta chega num note.
    // A side-query roda num caller PRÓPRIO sem tools (read-only); o loop/histórico não é
    // tocado (a resposta nunca re-entra — invariante §11.1).
    if (command.id === 'ask') {
      void built.controller.askParallel(args);
      return;
    }
    // EST-ROOMS-3 · ADR-0081 — `/rooms new|list|read <code>`: salas de conversa entre agentes.
    // Criar a sala é a porta GATEADA do consentimento (§13.1); o agente posta/lê via os tools.
    if (command.id === 'rooms') {
      const [sub, ...rest] = args.trim().split(/\s+/);
      // ADR-0126(B) — sem args ⇒ LIST (descoberta); criar é explícito (`/rooms new`).
      if (sub === '' || sub === undefined || sub === 'list') void built.controller.roomList();
      else if (sub === 'new') void built.controller.roomNew();
      // `read <código>` lê direto; `read` SEM código abre o PICKER (escolhe a sala).
      else if (sub === 'read') {
        const code = rest.join(' ').trim();
        if (code === '') void built.controller.roomReadPick();
        else void built.controller.roomRead(code);
      } else if (sub === 'watch') void built.controller.roomWatch(rest.join(' '));
      else
        built.controller.pushNote('/rooms', [
          `subcomando "${sub}" — use list | new | read <código> | watch <código>.`,
        ]);
      return;
    }
    // ADR-0126(A) — `/subagent <nome>` abre o foco 1:1; sem nome volta ao principal.
    if (command.id === 'subagent') {
      const name = args.trim();
      if (name === '') built.controller.exitFocus();
      else built.controller.enterSubagentFocus(name);
      return;
    }
    // ADR-0126(A) — `/back` sai do foco 1:1.
    if (command.id === 'back') {
      built.controller.exitFocus();
      return;
    }
    if (command.id === 'rename') {
      const result = routeRename(args);
      switch (result.kind) {
        case 'set':
          built.controller.setLabel(result.label.label, result.label.color);
          setWindowTitle(`aluy · ${result.label.label}`); // título da janela = o nome
          saveNow(); // consolida o rótulo+cor no arquivo da sessão JÁ.
          built.controller.pushNote('rename', [
            // F176 — aviso não-fatal PRIMEIRO (ex.: cor inválida → cor automática), p/
            // o usuário ver que a cor caiu MAS o nome aplicou.
            ...(result.notice !== undefined ? [result.notice] : []),
            `sessão: ● ${result.label.label}`,
            `cor: ${result.label.color}`,
            'o ●+nome aparece no composer e no /history. troque a cor com `--cor <cor>`;',
            'limpe com `/rename --limpar`. é só identificação local (dado de UI).',
          ]);
          return;
        case 'clear':
          built.controller.setLabel(undefined);
          setWindowTitle(undefined); // reseta o título da janela
          saveNow();
          built.controller.pushNote('rename', ['rótulo removido — a sessão volta sem nome.']);
          return;
        case 'show': {
          const cur = built.controller.label;
          built.controller.pushNote(
            'rename',
            cur !== undefined
              ? [
                  `sessão: ● ${cur}${built.controller.labelColor ? ` (${built.controller.labelColor})` : ''}`,
                  'troque com `/rename <nome> [--cor <cor>]` · limpe com `/rename --limpar`.',
                ]
              : [
                  'esta sessão não tem rótulo.',
                  'dê um: `/rename <nome>` (cor automática) ou `/rename <nome> --cor <cor>`.',
                  `cores: ${SESSION_COLOR_NAMES.join(', ')}.`,
                ],
          );
          return;
        }
        case 'error':
          built.controller.pushNote('rename', [result.message]);
          return;
      }
    }
    // EST-0964 — `/init`: analisa o repo e ESCREVE o AGENT.md PELA CATRACA (decide →
    // ask → edit_file), com o mesmo confinamento de qualquer edição. Mostra o que
    // criou (ou por que não). É async (lê o repo + confirma o diff) — empurra a nota
    // ao concluir, sem bloquear o render.
    if (command.id === 'init') {
      const force = /(?:^|\s)--force\b/.test(args) || args.trim() === '--force';
      const desc = args.replace(/--force\b/, '').trim();

      // EST-INIT-02 — PROMPT-DRIVEN: /init <descricao> gera a config .aluy/ SOB MEDIDA
      // via um TURNO guiado: o agente recebe o system-prompt-de-scaffold (que embute os
      // formatos de agente/workflow/comando/AGENT.md) + a descricao do usuario, e ESCREVE
      // os arquivos pelas tools normais (write_file → catraca). ZERO motor novo.
      if (desc !== '' && !force) {
        const goal = buildScaffoldSystemPrompt(desc);
        built.controller.pushNote('init', [
          `gerando scaffold sob medida para: ${desc}`,
          'o agente vai analisar a descrição e criar os arquivos em .aluy/…',
        ]);
        void built.controller.submit(goal);
        return;
      }

      // EST-INIT-01 — scaffold ESTÁTICO: /init sem descrição (ou --force).
      void runInit({
        ports: built.ports,
        permission: built.engine,
        askResolver: built.askResolver,
        rootName: basename(built.workspace.root),
        overwrite: force,
      }).then((r) => built.controller.pushNote(r.note.title, r.note.lines));
      return;
    }
    // EST-0963 — `/notify on|off|toggle`: aplica o estado na porta e empurra a nota.
    if (command.id === 'notify') {
      const effect = buildNotifyEffect(args, { enabled: notifyPort.enabled, tty: true });
      if (effect.kind === 'notify') {
        notifyPort.setEnabled(effect.enable);
        built.controller.pushNote(effect.note.title, effect.note.lines);
      }
      return;
    }
    // EST-0960b — `/undo`/`/redo`: assíncronos (restauração confinada) + a confirmação
    // de edição concorrente (CA-3). O 2º `/undo` consecutivo confirma a divergência.
    if (command.id === 'undo') {
      const run = pendingUndoConfirm ?? (() => undoController.undo());
      pendingUndoConfirm = null;
      void run().then(applyUndoOutcome);
      return;
    }
    if (command.id === 'redo') {
      pendingUndoConfirm = null;
      void undoController.redo().then(applyUndoOutcome);
      return;
    }

    // EST-0973 — `/compact`: resume a conversa até aqui (via broker, CLI-SEC-7) e
    // continua a sessão com o contexto reduzido. Assíncrono (chamada de modelo); o
    // controller empurra a nota "contexto compactado: N turnos → sumário" ao concluir.
    if (command.id === 'compact') {
      void built.controller.compact();
      return;
    }

    // EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — `/cycle <intervalo|--por dur> "tarefa"`:
    // autonomia REPETIDA. Roda a tarefa em ciclos, cada ciclo pela MESMA catraca (NÃO é
    // bypass), cercado por PARADAS DURAS (duração/iterações/budget agregado/conclusão) e
    // PARÁVEL pelo MESMO freio (esc → interrupt). Sem teto ⇒ NÃO inicia (nota honesta).
    // Em Plan, cada ciclo só lê (a `decide()` nega efeito por-ciclo). Async; o controller
    // empurra a nota do motivo de parada ao concluir.
    if (command.id === 'cycle') {
      const cycleSub = args.trim().split(/\s+/)[0]?.toLowerCase();
      // EST-1158 — lifecycle do /cycle EM EXECUÇÃO (pause/resume/edit roteiam ao engine
      // ativo; NÃO iniciam um novo ciclo).
      if (cycleSub === 'pause') {
        built.controller.cyclePause();
        return;
      }
      if (cycleSub === 'resume') {
        built.controller.cycleResume();
        return;
      }
      if (cycleSub === 'stop') {
        built.controller.cycleStop();
        return;
      }
      if (cycleSub === 'status') {
        built.controller.cycleStatus();
        return;
      }
      if (cycleSub === 'edit') {
        const rest = (args.trim().match(/^edit\b\s*(.*)$/i)?.[1] ?? '').trim();
        const tokens = rest.match(/"[^"]*"|\S+/g) ?? [];
        const patch: { task?: string; intervalMs?: number; maxIterations?: number } = {};
        const taskParts: string[] = [];
        for (let i = 0; i < tokens.length; i += 1) {
          const tk = tokens[i]!;
          if (tk === '--max-iter' || tk === '--iter') {
            const n = Number(tokens[i + 1]);
            i += 1;
            if (Number.isInteger(n)) patch.maxIterations = n;
            continue;
          }
          const xm = tk.match(/^(\d+)x$/i);
          if (xm) {
            patch.maxIterations = Number(xm[1]);
            continue;
          }
          const im = tk.match(/^(\d+)(s|m|h)$/i);
          if (im && patch.intervalMs === undefined && taskParts.length === 0) {
            const n = Number(im[1]);
            const u = im[2]!.toLowerCase();
            patch.intervalMs = n * (u === 's' ? 1000 : u === 'm' ? 60_000 : 3_600_000);
            continue;
          }
          taskParts.push(tk.replace(/^"|"$/g, ''));
        }
        const task = taskParts.join(' ').trim();
        if (task) patch.task = task;
        built.controller.cycleEdit(patch);
        return;
      }
      if (args.trim() === '') {
        built.controller.pushNote('/cycle', [
          'uso: `/cycle <intervalo|--por dur> "tarefa"` — ex.: `/cycle 5m "rode os testes e corrija o que quebrar"`.',
          'sem teto (duração/iterações/intervalo), o /cycle NÃO inicia — é uma proteção contra execução sem fim.',
        ]);
        return;
      }
      void built.controller.cycle(args);
      return;
    }

    // EST-0983 — `/clear [full|memory]`: o pedido do Tiago — `/clear` puro limpa SÓ a
    // sessão (contexto da conversa; memória INTACTA — comportamento certo, inalterado);
    // `/clear full` limpa a sessão E APAGA a memória (global + projeto); `/clear memory`
    // só apaga a memória. Os destrutivos (full/memory) são IRREVERSÍVEIS ⇒ confirmação de
    // 2 passos (mesma mecânica do /undo: a 2ª invocação consecutiva confirma). O `clearAll`
    // da memória é AÇÃO DO USUÁRIO (este slash) — NUNCA uma tool: o agente não chega aqui
    // (slash não é tool; a path-deny de `~/.aluy/memory/` é mantida). A LIMPEZA VISUAL do
    // terminal (clearScreenFn) só dispara quando a SESSÃO de fato zera.
    if (command.id === 'clear') {
      const cmd = parseClearCommand(args);
      // HUNT-SLASH: a confirmação de `/clear full|memory` só vale p/ a próxima invocação
      // do MESMO verbo. `clearArmTransition` decide se ESTA invocação confirma (armed) e
      // qual verbo fica pendente. Sem o match de verbo, armar `memory` e repetir `full`
      // executaria o `full` (mais amplo — zera a sessão também) com a confirmação do
      // `memory`. O `nextArmed` calculado AQUI já é o estado-base; se o `runClearCommand`
      // não chegou a armar (ex.: memória vazia ⇒ no-op), a checagem do outcome corrige.
      const { armed, nextArmed } = clearArmTransition(pendingClearVerb, cmd);
      pendingClearVerb = nextArmed;
      void runClearCommand(
        cmd,
        { clearSession: () => built.controller.clear(), memory: built.memory },
        armed,
      ).then((outcome) => {
        // `outcome.armed` reflete se a confirmação ficou de fato pendente (false quando
        // não havia o que confirmar — memória vazia). Sincroniza o estado guardado.
        if (!outcome.armed) pendingClearVerb = undefined;
        if (outcome.note.lines.length > 0) {
          built.controller.pushNote(outcome.note.title, outcome.note.lines);
        }
        if (outcome.cleared) clearScreenFn?.();
      });
      return;
    }

    // EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M6) — `/memory`: vê/edita/esquece/fixa a
    // memória pela MECÂNICA INTERNA (built.memory), NUNCA por `cat`. As mutações
    // (esquecer/editar/fixar) são NEGADAS em Plan (efeito; ADR-0055); a LISTA é
    // leitura (permitida em Plan). FIXAR é retenção — não promove a memória a system.
    if (command.id === 'memory') {
      const cmd = parseMemoryCommand(args);
      void runMemoryCommand(cmd, built.memory, built.engine.isPlan).then((note) =>
        built.controller.pushNote(note.title, note.lines),
      );
      return;
    }
    // EST-1108 — `/todo`: vê/gerencia o backlog (done/clear) pela MECÂNICA INTERNA
    // (built.todoStore), NUNCA por `cat`. As mutações (done/clear) são NEGADAS em
    // Plan (read-only). A listagem é leitura pura (permitida em Plan).
    if (command.id === 'todo') {
      const cmd = parseTodoCommand(args);
      void runTodoCommand(cmd, built.todoStore, built.engine.isPlan).then((note) =>
        built.controller.pushNote(note.title, note.lines),
      );
      return;
    }

    // EST-1158 — `/cron`: gerência dos jobs PERSISTENTES na sessão (espelha o CLI
    // `aluy cron`). Reusa o MESMO `runCron` com a saída redirecionada p/ uma nota.
    // Sem args ⇒ `list` (o mais útil). Tokeniza respeitando aspas.
    if (command.id === 'cron') {
      const collected: string[] = [];
      const io = {
        out: (l: string) => collected.push(l),
        err: (l: string) => collected.push(l),
      };
      const tokens = args.match(/"[^"]*"|\S+/g)?.map((t) => t.replace(/^"|"$/g, '')) ?? [];
      const argv = tokens.length === 0 ? ['list'] : tokens;
      void runCron(argv, { io }).then(() =>
        built.controller.pushNote('cron', collected.length > 0 ? collected : ['(sem saída)']),
      );
      return;
    }

    // EST-0982 · /add-dir — ATO DO USUÁRIO que AMPLIA o confinamento p/ um diretório
    // EXTRA (multi-raiz; gate FORTE do `seguranca`). Opera DIRETO no workspace da
    // sessão (`built.workspace` — a MESMA instância que fs/shell/search/cwd usam),
    // então read_file/edit_file/change_dir passam a aceitar a nova raiz na hora.
    // NÃO é tool: o agente não tem caminho p/ chegar aqui (sem auto-ampliação, nem
    // em --unsafe). Sem args ⇒ lista as raízes. Escopo = SESSÃO (não persiste).
    if (command.id === 'add-dir') {
      const note = runAddDir(args, built.workspace);
      built.controller.pushNote(note.title, note.lines);
      return;
    }

    // EST-0977 · ADR-0061 — `/agents`: lista os perfis de sub-agente .md que o aluy
    // MAPEOU. Read-only, sem modelo, sem rede: reusa o resultado dos MESMOS loaders do
    // boot (`globalAgents`/`projectAgents` já carregados acima, idênticos ao que o
    // `/doctor` conta) — não relê o filesystem nem re-parseia. Mostra os VÁLIDOS (nome ·
    // escopo global/projeto · tools ⊆ pai · persona) e os REJEITADOS (RES-MD-3) com o
    // motivo exato + a dica de conserto. Pasta ausente ⇒ "nenhum" (loader fail-safe).
    if (command.id === 'agents') {
      const note = buildAgentsNote({
        profiles: [...globalAgents.profiles, ...projectAgents.profiles],
        errors: agentLoadErrors,
      });
      built.controller.pushNote(note.title, note.lines);
      return;
    }

    // EST-1105 — `/workflows`: lista os fluxos de ATIVIDADE .md MAPEADOS (global
    // `~/.aluy/workflows/` = config do dono + projeto `.aluy/workflows/` = dado do repo),
    // válidos + rejeitados (RES-MD-3) com o motivo. Read-only, sem modelo, sem rede; carga
    // fail-safe (pasta ausente ⇒ "nenhum", nunca lança). Espelha o `/agents`. Fatia 1 — o
    // `run` (dirigir o agente pelas atividades) é a fatia 2.
    if (command.id === 'workflows') {
      // EST-1106 — `/workflows run <nome>`: DIRIGE o agente pelas atividades do workflow.
      const runMatch = /^\s*run\s+(\S+)/.exec(args);
      if (runMatch) {
        const wfName = runMatch[1]!;
        void built.controller.workflowRun(wfName);
        return;
      }
      // EST-1107 — `/workflows use <nome>`: ATIVA o modo de workflow (submissões
      // subsequentes são direcionadas pelo fluxo). `none`/`off` ⇒ desativa.
      const useMatch = /^\s*use\s+(\S+)/.exec(args);
      if (useMatch) {
        const wfName = useMatch[1]!;
        void built.controller.workflowsUse(wfName);
        return;
      }
      // `/workflows` puro: LISTA.
      const globalWf = new UserWorkflowsLoader().load();
      const projectWf = new ProjectWorkflowsLoader({ workspace: built.workspace }).load();
      const note = buildWorkflowsNote({
        workflows: [...globalWf.workflows, ...projectWf.workflows],
        errors: [...globalWf.errors, ...projectWf.errors],
      });
      built.controller.pushNote(note.title, note.lines);
      return;
    }

    // EST-1112 · ADR-0116 — `/skills`: lista as SKILLS (SKILL.md) MAPEADAS (global
    // `~/.aluy/skills/` = config do dono + projeto `.claude/skills/` = dado do repo),
    // válidas + rejeitadas (RES-MD-3) com o motivo. Read-only, sem modelo, sem rede; carga
    // fail-safe (pasta ausente ⇒ "nenhuma", nunca lança). Espelha o `/agents`/`/workflows`.
    // Fatia 1 — a INVOCAÇÃO (`/skill <nome>`, injetar as instruções no contexto) é a fatia 2.
    if (command.id === 'skills') {
      const globalSk = new UserSkillsLoader().load();
      const projectSk = new ProjectSkillsLoader({ workspace: built.workspace }).load();
      const note = buildSkillsNote({
        skills: [...globalSk.skills, ...projectSk.skills],
        errors: [...globalSk.errors, ...projectSk.errors],
      });
      built.controller.pushNote(note.title, note.lines);
      return;
    }

    // LOTE-2 — `/inventory`: INVENTÁRIO do que a sessão carregou da `.aluy/` (+ `~/.aluy/`): ALUY.md,
    // agentes, comandos, skills, workflows e memória — com as CONTAGENS e os NOMES. A StatusBar
    // mostra só os números (`⌁ Na·Cc·Ss·Ww·Mm`); aqui vêm os nomes + a legenda. Read-only (uma
    // nota), reusa os loaders confinados; espelha o `/skills`/`/workflows`.
    if (command.id === 'inventory') {
      const sk = [
        ...new UserSkillsLoader().load().skills,
        ...new ProjectSkillsLoader({ workspace: built.workspace }).load().skills,
      ];
      const wf = [
        ...new UserWorkflowsLoader().load().workflows,
        ...new ProjectWorkflowsLoader({ workspace: built.workspace }).load().workflows,
      ];
      const agentNames = [...globalAgents.profiles, ...projectAgents.profiles].map((p) => p.name);
      const cmdNames = loadedUserCommands.map((c) => `/${c.name}`);
      const gov = built.controller.current.governance;
      const join = (xs: readonly string[]): string => (xs.length > 0 ? xs.join(', ') : '—');
      const aluyMd =
        instructionSources.length > 0 ? `✓ ${instructionSources.join(' › ')}` : '✗ ausente';
      built.controller.pushNote('inventário · .aluy/', [
        `instruções de projeto: ${aluyMd}`,
        `agentes (${agentNames.length}): ${join(agentNames)}`,
        `comandos do usuário (${cmdNames.length}): ${join(cmdNames)}`,
        `skills (${sk.length}): ${join(sk.map((s) => s.name))}`,
        `workflows (${wf.length}): ${join(wf.map((w) => w.name))}`,
        `memória de projeto: ${gov?.memory ?? 0} fato(s)`,
      ]);
      return;
    }

    // EST-0970 — `/doctor`: health-check read-only da sessão, com VALIDAÇÃO ATIVA e ticks
    // AO VIVO. Cada check nasce `pending` (spinner ⠋) e "acende" ✓/⚠/✗ quando o probe
    // resolve aquele item. VALIDA de verdade: conecta os servers MCP (handshake real →
    // conta tools), valida a credencial via GET `/v1/quota` (sem modelo), valida os VALORES
    // de config (tema/tier no catálogo). `--deep`/`--test` ADICIONA o teste do tier ao vivo
    // (gasta 1 chamada mínima ao modelo — opt-in explícito). Sem `--deep`, NÃO chama o modelo.
    if (command.id === 'doctor') {
      // `/doctor fix` — AUTO-REPARO agente-dirigido: em vez de só apontar "rode aluy bootstrap",
      // o agente se conserta. Lê a cauda dos logs, monta um objetivo focado e o SUBMETE ao loop
      // (o agente roda `aluy bootstrap --no-agent`, instala o que falta, re-tenta). Decisão do
      // dono: o reparo tem que ser o próprio agente — há modos de falha demais p/ roteiro fixo.
      if (/(^|\s)fix(\s|$)/.test(args)) {
        const logTails = gatherLogTails(SIDECAR_KINDS);
        const goal = buildRepairGoal({ logTails });
        built.controller.pushNote('doctor fix', [
          'tentando consertar os complementos do turbo — vou diagnosticar pelos logs, rodar o',
          'bootstrap e reparar. Acompanhe abaixo.',
        ]);
        void built.controller.submit(goal);
        return;
      }
      const deep = /(^|\s)--(deep|test)(\s|$)/.test(args);
      const workspaceRoot = built.workspace.root;
      void runDoctorLive(
        {
          login: built.login,
          memory: { count: async () => (await built.memory.list()).length },
          workspaceRoot,
          unsafe: built.engine.isUnsafe,
          env,
          probeOverride: {
            // CONECTA de verdade cada server MCP (mesmo transport stdio do boot, environ
            // mínimo + cwd confinado — CLI-SEC-7/FU-VAU-11-bis). Timeout curto por server.
            makeMcpTransport: () => new StdioMcpTransport({ cwd: workspaceRoot, parentEnv: env }),
            // --deep (opt-in que GASTA modelo): testa o tier corrente ao vivo. Sem a flag,
            // `tierTester` fica ausente ⇒ o probe NÃO chama o modelo.
            ...(deep
              ? {
                  tierTester: () =>
                    testTierLive({
                      tier: built.controller.tier,
                      ...(built.controller.model !== undefined
                        ? { model: built.controller.model }
                        : {}),
                      login: built.login,
                      env,
                    }),
                }
              : {}),
          },
        },
        (state) => built.controller.upsertDoctor(state.checks, state.summary),
      ).then((final) => {
        // Pedido do dono: não só APONTAR — PERGUNTAR. Se algum sidecar do turbo está fora,
        // oferece o auto-reparo agente-dirigido (`/doctor fix`). Só quando há o que consertar.
        const sidecars = final.checks.find((c) => c.id === 'sidecars');
        if (sidecars?.status === 'fail') {
          built.controller.pushNote('doctor', [
            'Há complemento(s) do turbo fora. Quer que eu tente consertar?',
            'Digite  /doctor fix  — eu leio os logs, rodo o bootstrap e reparo sozinho.',
          ]);
        }
      });
      return;
    }

    // EST-0970 — `/mcp`: lista os servers (config das fontes + estado da descoberta AO
    // VIVO desta sessão) com origem e tools (`mcp__<server>__`). PURO: a config já foi lida
    // no boot (mcpSetup.sources) e a descoberta já rodou (mcpSetup.discovery); aqui só
    // formatamos. Sem wiring de MCP (mcpTools injetadas em teste) ⇒ a nota fallback explica.
    if (command.id === 'mcp') {
      // EST-0970 — `/mcp reload|reconnect [all|<nome>]`: recarrega os servers MCP AO
      // VIVO, sem reiniciar a sessão. `reconnect` re-handshake a config JÁ carregada;
      // `reload` re-lê o `~/.aluy/mcp.json` + `.mcp.json` e aplica as diferenças
      // (novos sobem, removidos descem, mudados reiniciam). Ambos fecham os transports
      // antigos e re-descobrem as tools. Roteado ANTES do admin/search.
      const refresh = parseMcpRefresh(args);
      if (refresh) {
        const { kind, scope } = refresh;
        const label = kind === 'reload' ? 'reload' : 'reconnect';
        built.controller.pushNote('mcp', [
          `/${label} ${scope === 'all' ? 'todos' : scope}: recarregando…`,
        ]);
        void refreshMcp(scope).then(({ ok, failed }) => {
          const lines: string[] = [];
          if (ok.length > 0) lines.push(`✓ ${ok.join(', ')}`);
          if (failed.length > 0) lines.push(`✗ ${failed.join(', ')}`);
          if (ok.length === 0 && failed.length === 0) lines.push('nenhum server afetado.');
          built.controller.pushNote(`mcp ${label}`, lines);
        });
        return;
      }
      // EST-0970 (ciclo MCP na sessão) — `/mcp add|remove|disable|enable`: gerencia a
      // config SEM sair da sessão, reusando o MESMO McpConfigWriter do `aluy mcp` shell
      // (#81 — atômico, merge, 0600, aviso de segredo). E-B1: o slash é ATO DO USUÁRIO
      // (ele digitou na composer; slash NÃO é tool — o agente não o alcança); a catraca
      // segue negando o agente em `~/.aluy/` (aluy-config-write-deny, intocada). A
      // gravação NÃO conecta/derruba server nesta sessão — use `/mcp reload` p/ aplicar.
      const admin = parseMcpAdminSlash(args);
      if (admin) {
        const note = runMcpAdminSlash(admin);
        built.controller.pushNote(note.title, note.lines);
        return;
      }
      // EST-0970 (search na sessão) — `/mcp search <termo>`: busca no registro oficial
      // ABERTO (egress FIXO + anti-SSRF do #80 — `createRegistryFetch`/`runMcpSearch`;
      // sem key, DADO, só LÊ) e mostra os servers + a linha `→ aluy mcp add …`. NÃO
      // instala nada (instalar é `aluy mcp add`, atrás da catraca). A busca faz rede ⇒
      // empurra "buscando…" e a nota do resultado quando volta; registro fora ⇒ a
      // própria runMcpSearch degrada gracioso (a sessão segue viva).
      const search = parseMcpSlash(args);
      if (search) {
        if (search.query === '') {
          const u = mcpSearchUsageNote();
          built.controller.pushNote(u.title, u.lines);
          return;
        }
        const pending = mcpSearchPendingNote(search.query);
        built.controller.pushNote(pending.title, pending.lines);
        void runMcpSearchSlash(search.query, mcpRegistryFetch).then((note) =>
          built.controller.pushNote(note.title, note.lines),
        );
        return;
      }
      // `/mcp` sem args (ou arg desconhecido) ⇒ LISTA os configurados (inalterado, #81).
      if (mcpSetup) {
        const listing = buildMcpListing(mcpSetup.sources, mcpSetup.discovery);
        const note = buildMcpNote(listing, mcpSetup.configError);
        built.controller.pushNote(note.title, note.lines);
        return;
      }
      // cai no fallback honesto do buildSlashEffect (sem descoberta nesta sessão).
    }

    // ADR-0134/0135 — `/telegram` (setup do conector na sessão): async (config + keychain),
    // com `args` (subcomando + chat-id). Empurra a nota ao concluir. O token NUNCA é digitado
    // aqui — `login` aponta p/ o terminal; allow/deny/status/logout rodam in-session.
    if (command.id === 'telegram') {
      void runTelegramSlash(args, {
        configStore,
        secretStore: new KeychainConnectorSecretStore('telegram'),
      }).then((note) => built.controller.pushNote(note.title, note.lines));
      return;
    }

    const effect = buildSlashEffect(command.id, {
      usage: built.controller.usage,
      unsafe: built.engine.isUnsafe,
    });
    if (effect.kind === 'quit') {
      instance.unmount();
      return;
    }
    if (effect.kind === 'async') {
      // whoami/logout consomem EST-0942 (LoginService) — empurram a nota ao concluir.
      void runAsyncSlash(effect.id as 'whoami' | 'logout', built.login).then((note) =>
        built.controller.pushNote(note.title, note.lines),
      );
      return;
    }
    applySlashEffect(effect, built.controller);
  };

  // EST-0972 — RETOMA uma sessão escolhida no `/history` AO VIVO (dentro da sessão, sem
  // sair p/ `aluy --resume`). Carrega o record pelo id e aplica `applyResumeRecord` — o
  // MESMO par do boot (restoreBlocks + seedHistory(blocksToHistory)) — e TROCA o alvo do
  // auto-save (`activeSession`) p/ a sessão escolhida continuar gravando no SEU arquivo.
  // O `clearScreen` já foi feito pela App (tem stdout + a key do <Static>) antes de
  // chamar aqui ⇒ no-op deste lado. Fail-safe: id que não casa ⇒ nota honesta, sessão
  // atual intacta. O tier da sessão retomada é aplicado p/ a próxima chamada continuar
  // no modelo que estava em uso (continuidade). NÃO dispara loop nem chamada de modelo.
  const onResumeSession = (id: string): void => {
    const record = sessionStore.load(id);
    if (!record) {
      built.controller.pushNote('history', [`sessão não encontrada: ${id} — nada mudou.`]);
      return;
    }
    // EST-0972 (BUG Custom) — restaura TIER **e** o slug Custom juntos. Record Custom
    // LEGADO (sem slug salvo) ⇒ fallback p/ o tier canônico default + aviso (nunca
    // `tier:custom` sem model ⇒ 422). O `switchSession` aplica o `{tier, model}` resolvido.
    const rm = resolveResumedModel(record, DEFAULT_TIER);
    applyResumeRecord(record, {
      restoreBlocks: (blocks) => built.controller.restoreBlocks(blocks),
      seedHistory: (items) => built.controller.seedHistory(items),
      // HUNT-RESUME — zera o contexto de continuação da sessão de onde se SAIU (a atual,
      // que pode já ter turnos) p/ a conversa anterior NÃO vazar na sessão retomada.
      resetContinuation: () => built.controller.resetResumeContext(),
      switchSession: (target) => {
        activeSession.id = target.id;
        activeSession.cwd = target.cwd;
        // continuidade do tier + slug Custom: a próxima chamada usa o modelo que a
        // sessão tinha (sob `custom`, com o slug; senão só o tier — sem slug fantasma).
        if (rm.tier.trim() !== '') built.controller.setTier(rm.tier, rm.model);
        // HUNT-PERSIST — `setTier` ZERA o provider; reaplica o provider Custom salvo
        // DEPOIS (só sob `custom` com slug; `undefined` ⇒ volta ao default do broker).
        if (rm.tier === 'custom' && rm.model) built.controller.setProvider(rm.provider);
      },
      // a App já limpou a tela antes de invocar a retomada — aqui é no-op.
      clearScreen: () => {},
    });
    // EST-0972 (rename) — adota o RÓTULO + COR da sessão retomada AO VIVO (o ●+nome do
    // composer passa a ser o da sessão escolhida). Sem rótulo na escolhida ⇒ LIMPA o da
    // atual (a sessão "é" a retomada — não herda o rótulo da anterior). DADO DE UI.
    built.controller.setLabel(record.label, record.labelColor);
    // grava JÁ no arquivo da sessão retomada (consolida o alvo trocado) e confirma.
    saveNow();
    if (rm.warning) built.controller.pushNote('model', [rm.warning]);
    built.controller.pushNote('history', [`sessão retomada: ${id} — continue de onde parou.`]);
  };

  // EST-XXXX (CHECKPOINTS / REWIND) — APLICA a escolha do `/rewind`/Esc-Esc. A App só
  // repassa `{ checkpointId, action }`; aqui orquestramos as DUAS primitivas (sem
  // reinventar): restaurar CÓDIGO (via o registry, que reverte as edições posteriores
  // ao ponto pela escrita confinada do journal) e/ou rebobinar a CONVERSA (via o
  // controller, que trunca a transcrição + re-semeia o contexto, igual ao /history).
  // Limpa a tela quando a transcrição muda (some o lixo já commitado no <Static>).
  const onRewind = (choice: RewindChoice): void => {
    const cp = built.checkpoints.get(choice.checkpointId);
    if (!cp) {
      built.controller.pushNote('rewind', ['ponto não encontrado — nada mudou.']);
      return;
    }
    const lines: string[] = [`voltando ao ponto #${cp.ordinal}: ${cp.label}`];

    // (1) CÓDIGO — reverte os arquivos editados depois do ponto (não desfaz shell).
    if (choice.action === 'both' || choice.action === 'code') {
      void built.checkpoints.restoreCode(cp.id).then((res) => {
        const codeLines: string[] = [];
        if (res.written.length > 0) codeLines.push(`arquivos restaurados: ${res.written.length}`);
        if (res.removed.length > 0)
          codeLines.push(`arquivos removidos (eram novos): ${res.removed.length}`);
        if (res.written.length === 0 && res.removed.length === 0)
          codeLines.push('nenhuma edição de arquivo posterior ao ponto — código intacto.');
        for (const f of res.failed) codeLines.push(`⚠ falhou: ${f.path} — ${f.reason}`);
        // barreiras de run_command depois do ponto (REDIGIDAS) — não desfeitas.
        if (res.barrierWarnings.length > 0) {
          codeLines.push('comando(s) rodaram depois do ponto (efeito de shell NÃO desfeito):');
          for (const cmd of res.barrierWarnings) codeLines.push(`  · ${cmd}`);
        }
        built.controller.pushNote('rewind — código', codeLines);
      });
    }

    // (2) CONVERSA — trunca a transcrição visível + o contexto do modelo ao ponto.
    if (choice.action === 'both' || choice.action === 'conversation') {
      const dropped = built.controller.rewindConversation(cp.blockCount, blocksToHistory);
      lines.push(
        dropped > 0
          ? `conversa rebobinada — ${dropped} bloco(s) posterior(es) descartado(s).`
          : 'conversa já estava neste ponto.',
      );
      // a transcrição mudou ⇒ limpa a tela (some o que foi commitado no Static).
      clearScreenFn?.();
      saveNow();
    }

    built.controller.pushNote('rewind', lines);
  };

  // EST-0965 — ACABAMENTO DE RENDER, duas camadas no fio do stdout do Ink:
  //  · OVERWRITE-IN-PLACE (`ALUY_OVERWRITE_RENDER`, default ON): transforma o erase do
  //    Ink (apaga-tudo-depois-escreve) em SOBRESCREVE-no-lugar ⇒ ZERO flicker em
  //    QUALQUER terminal (não depende do Mode 2026). É o que mata o flicker de verdade.
  //  · SYNCHRONIZED OUTPUT (`ALUY_SYNC_OUTPUT`, default ON): envolve cada frame em
  //    BSU…ESU (`?2026`) — atômico onde o terminal honra; inócuo onde ignora.
  // Só TTY (este ramo). O `cleanup` emite o ESU final no exit/sinal — NUNCA deixa o
  // terminal preso em modo sync. Acabamento de RENDER (≠ engine/catraca).
  // `baseStdout` e `altScreen` foram movidos para antes do splash (linha ~360) — os
  // crash/sinal handlers precisam estar ativos desde o início do boot (BUG-WIN).
  const syncOn = syncOutputEnabled(env);
  const overwriteOn = overwriteRenderEnabled(env);
  // Só envelopa se ALGUMA camada está ligada (ambas off ⇒ stdout cru, sem custo).
  const sync =
    syncOn || overwriteOn
      ? wrapStdoutWithSync(baseStdout, {
          sync: syncOn,
          overwrite: overwriteOn,
          // F198 — quando a região viva SAI do regime clearTerminal (a resposta LONGA finaliza
          // e encolhe abaixo de `rows`), o Ink deixa o `previousLineCount` do `log-update`
          // obsoleto ⇒ o próximo `eraseLines` apaga ~1 tela de scrollback JÁ COMMITADO (o bloco
          // gigante de linhas em branco entre `▌ você` e `Λ aluy`). A App re-emite o histórico
          // limpo via clearScreen (cursor ao HOME ⇒ o eraseLines obsoleto fica inócuo). O
          // holder `clearScreenFn` é preenchido no `registerClearScreen` da App (após o mount).
          onOverflowRegimeExit: () => clearScreenFn?.(),
        })
      : undefined;
  const renderStdout = sync?.stdout ?? baseStdout;

  // EST-1001 · ADR-0076 §2/§5 — ENTRA no alt-screen ANTES de o Ink pintar o 1º frame
  // (FIX do #144: tela preta no `--fullscreen`). DIAGNÓSTICO provado por bytes sob PTY
  // real: o cockpit enche `rows` ⇒ o Ink usa o caminho `outputHeight>=rows`, que escreve
  // `clearTerminal`+frame. No boot, o `enter()` (`?1049h`) vivia num `useEffect` da App —
  // que dispara DEPOIS do 1º commit do Ink. Logo o frame pintava na TELA PRIMÁRIA; o
  // `?1049h` entrava no alt-screen DEPOIS, VAZIO, e o Ink (frame == lastOutput) nunca
  // repintava ⇒ preto até o Ctrl+C restaurar. O fix é de ORDEM: emitir `?1049h` AQUI
  // (antes do `render`) quando o boot pede cockpit E a tela CABE — assim o 1º `clearTerminal`
  // +frame do Ink já cai DENTRO do alt-screen. Também liga o modo cockpit no envelope
  // (EST-0965 (cockpit): o transform do alt-screen troca o `\x1b[2J` por `\x1b[H` ⇒ sem flicker — §5).
  // Se NÃO cabe (narrow/short), NÃO entramos: a App degrada
  // pro inline com aviso (decisão (a) do ADR). Só TTY (este ramo). `cockpitEnteredAtBoot`
  // diz à App que o boot já entrou ⇒ ela NÃO re-emite `?1049h` (evita duplo enter).
  const bootCockpitFits =
    initialFullscreen &&
    resolveCockpitLayout(baseStdout.rows ?? 0, baseStdout.columns ?? 0).kind === 'cockpit';
  if (bootCockpitFits) {
    enterAltScreen(baseStdout);
    sync?.setCockpit(true);
  }

  // EST-0948 — BRACKETED PASTE MODE (`?2004`): liga o envelope `\x1b[200~`…`\x1b[201~` em
  // torno do conteúdo COLADO, p/ o `\n` do paste virar newline LITERAL no composer
  // (multi-linha) em vez de Enter/submit. Emitido CRU no `baseStdout` (não pelo `sync` —
  // é byte de controle de terminal, não frame de render). Só TTY (este ramo). A DETECÇÃO
  // dos marcadores no input vive na App (canal cru `'data'`, via `bracketed-paste.ts`).
  // O DESLIGAR (`?2004l`) é garantido em TODO caminho de término abaixo: no `onSignal`
  // (SIGINT/SIGTERM), no `finally` do `waitUntilExit` (unmount/crash) e num `process.once
  // ('exit')` (defesa p/ exit abrupto). O `enableBracketedPaste` LIGA o `?2004h` já e dá um
  // `disable()` IDEMPOTENTE (só escreve `?2004l` uma vez) — espelha o alt-screen.
  const pasteMode = enableBracketedPaste(baseStdout);
  const disableBracketedPaste = (): void => pasteMode.disable();
  // Defesa: garante o `?2004l` mesmo num `process.exit` que pule o `finally` (ex.: um
  // caminho de saída abrupto). Idempotente com o `onSignal`/`finally`.
  process.once('exit', disableBracketedPaste);

  // EST-1000 · ADR-0076 §4 / CLI-SEC-6 / RES-C-1 — store do `/export`: grava o transcript
  // REDIGIDO em `~/.aluy/exports/` (0600). É ato do USUÁRIO (slash/ctrl+s; o agente não o
  // alcança). O corpo passa pela redação CLI-SEC-6 ANTES (buildTranscript) — o store só
  // escreve bytes. Injetável p/ teste via baseDir (não toca o `~/.aluy/` real).
  const exportStore = opts.exportStore ?? new ExportStore();
  const exportTranscript = async (
    fileName?: string,
  ): Promise<{
    ok: boolean;
    path?: string;
    error?: string;
  }> => {
    // Monta o transcript JÁ REDIGIDO (RES-C-1) e grava. Async p/ casar a assinatura da
    // App (não bloqueia o render); a montagem/escrita são síncronas, mas envelopadas.
    const body = buildTranscript(built.controller.blocks, {
      sessionId: activeSession.id,
      ...(built.controller.label !== undefined ? { label: built.controller.label } : {}),
      tier: built.controller.tier,
    });
    return exportStore.write(body, {
      sessionId: activeSession.id,
      ...(fileName !== undefined ? { fileName } : {}),
    });
  };

  // Sinais: garante o ESU final se o processo for interrompido no meio de um frame
  // (Ctrl-C/SIGTERM) — o terminal sai do sync e o cursor reaparece. Best-effort e
  // idempotente (o `cleanup` tem flag); NÃO engole o sinal: o Ink instala o próprio
  // handler de SIGINT (exitOnCtrlC) que desmonta e encerra — aqui só soltamos o sync.
  // EST-1010 — no sinal, além de soltar o sync, RESETA o fundo do terminal (OSC 11)
  // p/ não deixar o terminal do usuário com o fundo do tema grudado num Ctrl-C. Ambos
  // best-effort e idempotentes (o reset só emite se algum apply ocorreu, e uma vez só).
  const onSignal = (): void => {
    sync?.cleanup();
    bgController.reset();
    // EST-0948 — desliga o bracketed paste no Ctrl-C/SIGTERM p/ não deixar o terminal do
    // usuário em modo `?2004` (que envolveria pastes futuros em marcadores visíveis).
    disableBracketedPaste();
  };
  // Instala SEMPRE: mesmo sem `sync`, o fundo precisa ser resetado num sinal.
  // EST-1010 (BUG-0022) — via `installSignalReset`: os handlers são SEMPRE soltos no
  // `finally` externo abaixo, mesmo se o `render`/boot LANÇAR antes do `waitUntilExit`.
  // Antes, a remoção morava só no `finally` do `waitUntilExit`: uma exceção entre o
  // registro e aquele `try` (ou re-entrância de `runSession` em teste/harness) VAZAVA
  // os listeners ⇒ `MaxListenersExceededWarning` e acúmulo entre sessões. `dispose` é
  // idempotente (chamá-lo no `finally` interno E externo é seguro).
  const signalReset = installSignalReset(process, onSignal);

  // EST-0962 (/provider) — provider Custom do BOOT (do `--provider`, espelhado no
  // controller). Passa o NOME cru (DADO de catálogo) p/ o picker pré-marcar o ● ativo; o
  // picker o casa contra a lista VIVA que carregar. O App deriva o ativo REATIVO de
  // `state.meta.provider`; esta prop é o fallback do valor inicial.
  // `exactOptionalPropertyTypes`: só inclui a chave se definida.
  const bootProvider = built.controller.provider;
  const bootProviderProp: { currentProvider?: string } =
    bootProvider !== undefined && bootProvider !== '' ? { currentProvider: bootProvider } : {};

  // EST-1117 — o effort ATIVO no boot (`--effort`), p/ o passo de effort do `/model`
  // conjugado marcar o ● "atual". `exactOptionalPropertyTypes`: só inclui se definido.
  const bootEffort = built.controller.effort;
  const bootEffortProp: { currentEffort?: string } =
    bootEffort !== undefined && bootEffort !== '' ? { currentEffort: bootEffort } : {};

  // EST-1015 (🔴 fix do composer "morto" no Linux/Mac) — RE-ARMA o stdin antes do Ink da App
  // montar. Ao chegar aqui o stdin já passou por pausas (em especial o cleanup do
  // `queryTerminalBrightness`/osc11 = `setRawMode(false)`+`pause()`), deixando o reader do
  // libuv DORMENTE; o Ink lê via `readable`+`read()` sem `resume()`, então sem reatar NENHUMA
  // tecla chega ao composer. O fix antigo era SÓ win32 (a suposição "Linux/Mac se recupera
  // sozinho" é FALSA — repro real no Linux). Agora vale TODO TTY — lógica PURA/testada em
  // `stdin-rearm.ts` (guarda a regressão do gate de plataforma).
  rearmStdinForInk(process.stdin);

  // task #18 (🔴 CRASH — DERRUBA o app) — INSTALA o guard de CSI-u ANTES de o Ink montar.
  // Uma sequência CSI-u de tecla FUNCIONAL do kitty keyboard protocol (ex.: `\x1b[57414u`)
  // faz o `parseKeypress` do Ink devolver `ctrl=true`+`name=undefined`, e o `use-input.js`
  // crasha em `input.startsWith(undefined)`. O guard FILTRA essas sequências do chunk que o
  // Ink lê via `stdin.read()` — elas NUNCA chegam ao parse (crash some na origem). Escopo
  // mínimo, não mascara (≠ engolir uncaughtException). Best-effort: sem `read` ⇒ no-op. O
  // `restore()` é encadeado no cleanup junto dos outros (raw-mode/paste) p/ não vazar o wrap.
  const restoreCsiUGuard = installCsiUGuard(process.stdin);

  try {
    // Anti "dois splashes" (feedback Tiago): o run.tsx JÁ mostrou o SplashScreen
    // (marca + quip). A fase 'boot' da App renderiza um <Boot> ("conectando")
    // cosmético por bootMs — uma SEGUNDA tela de marca. Como o splash já cumpriu
    // esse papel, dispensamos a fase boot ANTES de montar: splash → cockpit direto,
    // sem flash. (Sem splash — headless/no-TTY — a fase boot segue intacta.)
    if (useSplash) built.controller.dismissBoot();
    instance = render(
      // EST-0966 — <ThemeRoot> é a raiz STATEFUL do tema: monta com o `initialTheme`
      // (auto-detectado) e re-resolve+re-renderiza a árvore a cada troca do `/theme`.
      <ThemeRoot
        initialTheme={initialTheme}
        env={env}
        {...denseOverride}
        {...safeGlyphsOverride}
        onThemeChanged={(name) => {
          // O seletor/atalho confirmou: a paleta já trocou (ThemeRoot re-renderizou);
          // registra a nota honesta do tema novo.
          const entry = resolveThemeName(name);
          // EST-1010 — REAPLICA o fundo do terminal (OSC 11) p/ o `bg` do tema novo.
          // 1 sequência por troca (não por frame). Reset garantido no exit (finally/sinal).
          if (entry) bgController.apply(entry.bg);
          // EST-0969 — persiste o tema p/ a próxima sessão (best-effort; o nome
          // canônico do catálogo). Só persiste nome conhecido (o saveTheme sanea).
          if (entry) configStore.saveTheme(entry.name);
          built.controller.pushNote('theme', [
            `tema trocado para: ${entry ? entry.label : name} (${name})`,
          ]);
        }}
        initialLang={initialLang}
        onLangChanged={(next) => {
          // EST-0989 (i18n) — o /lang confirmou: a árvore já re-renderizou no idioma novo
          // (ThemeRoot trocou o I18n). Persiste a preferência p/ a próxima sessão
          // (best-effort; o saveLang sanea contra o catálogo) e empurra a nota honesta NO
          // IDIOMA NOVO (feedback imediato no idioma escolhido).
          const entry = langByCode(next);
          configStore.saveLang(next);
          const tNext = makeI18n(next).t;
          built.controller.pushNote('lang', [
            tNext('lang.changed', { label: entry ? entry.label : next }),
          ]);
        }}
        controller={built.controller}
        egress={built.egress}
        userCommands={userCommandList}
        animate={theme.animate}
        // EST-0965 — frame FLICKER-FREE? `sync` é definido quando ALGUMA das camadas de
        // acabamento está ligada: overwrite-in-place (default ON, mata o flicker em
        // QUALQUER terminal) OU synchronized-output `?2026` (default ON, atômico onde há
        // suporte). Com o frame flicker-free, a App RELIGA a animação de 120ms no
        // streaming SEM tremor. Ambas off (`ALUY_OVERWRITE_RENDER=0` E `ALUY_SYNC_OUTPUT=0`)
        // ⇒ animação no streaming fica OFF (preserva o #75, sem regredir o flicker).
        syncActive={sync !== undefined}
        version={CLI_VERSION}
        onCommand={onCommand}
        // BURACO-NO-MEIO-RESIZE — arma o hard-clear do `clearScreen()` da App p/ ser FUNDIDO
        // com o PRÓXIMO write de frame do Ink (ver `SyncStdout.primeClearOnNextFrame`), em vez
        // de um write cru separado seguido de um repaint assíncrono — a JANELA em branco entre
        // os dois é o "buraco no meio" ao AUMENTAR a janela reportado pelo dono. Ausente ⇒ a
        // App cai no write cru imediato de sempre (só quando `sync` é `undefined`: as duas
        // camadas de acabamento desligadas via env, `ALUY_SYNC_OUTPUT=0` e
        // `ALUY_OVERWRITE_RENDER=0` — sem envelope não há "próximo write" p/ fundir). Spread
        // condicional (≠ `armAtomicClear={sync ? fn : undefined}`) p/ NUNCA passar `undefined`
        // explícito a uma prop opcional (`exactOptionalPropertyTypes`) — e p/ a App de fato
        // cair no fallback cru quando `sync` está ausente, em vez de ganhar um no-op silencioso.
        {...(sync ? { armAtomicClear: () => sync.primeClearOnNextFrame() } : {})}
        registerClearScreen={(fn) => {
          // EST-0983 — a App entrega o seu `clearScreen` (clear de tela+scrollback + remonta
          // do <Static>); o wiring o dispara quando a sessão zera (`/clear`, `/clear full`
          // confirmado). Mantém o MESMO efeito visual do /clear de sempre (#77 intacto).
          clearScreenFn = fn;
        }}
        fileIndex={built.fileIndex}
        attachReader={built.attachReader}
        catalog={built.catalogClient}
        customModels={built.customModelClient}
        providersClient={built.providersClient}
        sessionStore={sessionStore}
        onResumeSession={onResumeSession}
        rewindSource={built.checkpoints}
        onRewind={onRewind}
        initialSplitView={initialSplitView}
        onSplitViewChange={(on) => {
          // EST-0990 — persiste a preferência do split p/ a próxima sessão (best-effort;
          // QoL não-crítica, não bloqueia). É só UI (booleano) — jamais segredo (CLI-SEC-7).
          configStore.saveSplitView(on);
        }}
        // EST-1000 · ADR-0076 §1/§2/§4 — MODO COCKPIT (tela cheia, alt-screen).
        initialFullscreen={initialFullscreen}
        // EST-1001 · ADR-0076 §2 — o BOOT já entrou no alt-screen (acima, ANTES do render)?
        // Quando sim, a App NÃO re-emite `?1049h` no seu effect de boot (evita duplo enter).
        // Quando o boot pediu cockpit mas a tela NÃO cabe, isto é `false` ⇒ a App degrada
        // pro inline com aviso (decisão (a) do ADR §6) no seu effect.
        cockpitEnteredAtBoot={bootCockpitFits}
        cockpitScreen={{
          // ENTRA no alt-screen: emite `?1049h`+esconde cursor no `baseStdout` CRU (não
          // pelo sync — bytes de controle de tela não devem ser re-transformados). E liga o
          // MODO COCKPIT do envelope (EST-0965 (cockpit) — §5): troca o transform p/ o do alt-screen
          // (`clearTerminal` `\x1b[2J\x1b[3J\x1b[H` → `\x1b[H`+overwrite) ⇒ frame sem flicker.
          enter: () => {
            enterAltScreen(baseStdout);
            sync?.setCockpit(true);
          },
          // SAI: a restauração ÚNICA idempotente (`?1049l`+cursor+raw-mode). MAS o `/fullscreen`
          // pode ser RELIGADO depois ⇒ precisamos re-armar: a `restoreScreen` é one-shot por
          // sessão de handlers; aqui usamos o write direto p/ o toggle de saída (o handler
          // GARANTIDO segue armado p/ sinais/crash/exit). Idempotente nos bytes. Volta o
          // transform do envelope p/ o do inline (#95/#118 valem de novo).
          leave: () => {
            sync?.setCockpit(false);
            // EST-1015 (dono: "texto embaralhado/sobreposto + cursor fora do lugar ao TOGGLE
            // dentro da sessão") — o `?1049l` restaura a tela PRIMÁRIA com o conteúdo VELHO
            // pré-cockpit E o cursor na posição salva. O `clearScreen()` que vem a seguir passa
            // pelo `overwriteInPlace` (inline) que TIRA o `\x1b[2J`/`\x1b[3J` (anti-flicker por
            // frame) ⇒ no toggle de saída o clear fica INCOMPLETO relativo ao cursor restaurado
            // ⇒ resíduo sobreposto + caret no lugar errado. Num TOGGLE (transição única) um clear
            // REAL é seguro (sem custo de flicker por-frame): escrevemos o hard-clear CRU no
            // baseStdout (NÃO pelo envelope, p/ não ser transformado) — cursor no HOME + tela e
            // scrollback limpos ANTES do repaint inline (Static bump). Reseta também o differ do
            // cockpit p/ uma RE-entrada futura já nascer com full-paint (defensivo).
            baseStdout.write('\x1b[?1049l\x1b[?25h\x1b[2J\x1b[3J\x1b[H');
            sync?.resetDiffer();
          },
          // EST-1000 · ADR-0076 §5 (P2-D) — resize-em-tamanho com o cockpit CONTINUANDO a
          // caber: reseta SÓ o differ (full-paint na dimensão nova) sem tocar o alt-screen.
          resetDiffer: () => {
            sync?.resetDiffer();
          },
          // EST-1015 (hardening — auto-correção) — repassa o `layout.rows` de CADA render da
          // App ao envelope, p/ o `CockpitDiffer` comparar o corpo real contra o valor que a
          // árvore de fato usou (ver `SyncStdout.setExpectedCockpitRows`).
          setExpectedRows: (rows) => {
            sync?.setExpectedCockpitRows(rows);
          },
        }}
        onFullscreenChange={(on) => {
          // EST-1000 · ADR-0076 §1 — persiste a pref do cockpit p/ a próxima sessão
          // (best-effort). Só UI (booleano) — jamais segredo (CLI-SEC-7).
          configStore.saveFullscreen(on);
        }}
        // F197 — SUGESTÃO DE PRÓXIMO PROMPT (ghost + Tab). Estado inicial + persistência.
        initialSuggestions={initialSuggestions}
        onSuggestionsChange={(on) => {
          // F197 — persiste a pref do `/suggest` p/ a próxima sessão (best-effort). Só UI
          // (booleano) — jamais segredo (CLI-SEC-7).
          configStore.saveSuggestions(on);
        }}
        onExportTranscript={exportTranscript}
        onSelectTier={(tier, model, opts) => {
          // EST-0962 — o seletor confirmou: troca o tier da sessão (caller → próxima
          // chamada) e registra uma nota NEUTRA (HG-2: só o tier/slug, nunca o provider).
          // Via Custom (ADR-0030 §3): `model` é o slug escolhido (browser/texto-livre,
          // warn-but-allow). Fora de Custom, `model` é undefined — o controller LIMPA o
          // slug. `opts.supportsTools` (do browser EST-0962) acrescenta um aviso de
          // não-suporte a tools quando `false` — informativo, NÃO bloqueia.
          built.controller.setTier(tier, model);
          // EST-0969/0962 — persiste o tier p/ a próxima sessão (best-effort; não bloqueia).
          // BUG Custom: quando Custom, persiste TAMBÉM o slug ⇒ a sessão NOVA reabre no
          // mesmo Custom sem re-input. Trocar p/ um canônico ⇒ saveTier LIMPA o slug salvo.
          configStore.saveTier(tier, model);
          if (tier === 'custom' && model) {
            built.controller.pushNote('model', [
              `modelo Custom: ${model}`,
              '◍ slug enviado ao broker, que revalida e resolve o provider/credencial (nunca exibido)',
              '⚠ warn-but-allow — fora do catálogo curado pode ter custo/qualidade variável',
              ...(opts?.supportsTools === false
                ? [
                    '⚠ este modelo não suporta ferramentas — o agente cai no parser de texto / pode não usar MCP/tools bem',
                  ]
                : []),
            ]);
          } else {
            built.controller.pushNote('model', [`tier trocado para: ${tier}`]);
          }
        }}
        {...bootEffortProp}
        onSelectConjugated={(model, effort) => {
          // EST-1117 — o `/model` CONJUGADO confirmou o trio: aplica MODELO + EFFORT de UMA
          // vez. Modelo: tier OU custom-slug (mesmo caminho do `onSelectTier` — setTier +
          // persiste). Effort: `keep` não muda; `set` aplica o `reasoning_effort` passthrough
          // (SEM tier-gate). UMA nota-resumo NEUTRA (HG-2: só tier/slug/effort — nunca
          // provider/credencial; o broker resolve a credencial server-side).
          const tier = model.kind === 'tier' ? model.key : 'custom';
          const slug = model.kind === 'custom' ? model.model : undefined;
          built.controller.setTier(tier, slug);
          configStore.saveTier(tier, slug);
          if (effort.kind === 'set') built.controller.setEffort(effort.value);
          const effortLine =
            effort.kind === 'set'
              ? `esforço: ${effort.value}`
              : `esforço: ${built.controller.effort ?? '(default do modelo)'} (mantido)`;
          const noTools =
            model.kind === 'custom' && model.supportsTools === false
              ? [
                  '⚠ este modelo não suporta ferramentas — o agente cai no parser de texto / pode não usar MCP/tools bem',
                ]
              : [];
          if (tier === 'custom' && slug) {
            built.controller.pushNote('model', [
              `modelo Custom: ${slug}`,
              effortLine,
              '◍ slug enviado ao broker, que revalida e resolve o provider/credencial (nunca exibido)',
              '⚠ warn-but-allow — fora do catálogo curado pode ter custo/qualidade variável',
              ...noTools,
            ]);
          } else {
            built.controller.pushNote('model', [`tier trocado para: ${tier}`, effortLine]);
          }
        }}
        {...bootProviderProp}
        onSelectProvider={(provider) => {
          // EST-0962 (/provider) — o seletor confirmou: SETA o provider do modo Custom
          // (caller → próxima chamada, em par com o slug) e registra uma nota NEUTRA. HG-2:
          // só o NOME vai ao broker, que resolve `(provider, model)` → credencial (nunca
          // exibida). Não persiste (escopo de sessão, como o tier/model). Fora de Custom o
          // caller o ignora (no-op) — a nota deixa explícito que pareia com `/model` → Custom.
          built.controller.setProvider(provider);
          const applied = built.controller.provider === provider;
          built.controller.pushNote(
            'provider',
            applied
              ? [
                  `provider do modo Custom: ${provider}`,
                  '◍ enviado ao broker em par com o modelo Custom — ele resolve a credencial (nunca exibida)',
                  'vale só nesta sessão (não persiste).',
                ]
              : [
                  `provider pretendido: ${provider}`,
                  '⚠ sem modelo Custom ativo — o provider pareia com um modelo Custom.',
                  'selecione um modelo via `/model` → Custom e refaça o `/provider`.',
                ],
          );
        }}
        permissionControl={{
          // EST-0968 — controle SEGURO do painel `/permissions`. O MODO passa pelo
          // CONTROLLER (espelha state.mode → o ModeIndicator re-renderiza); grants e
          // default de tools seguras vão direto pela API da engine (cli-core). Só o
          // que é SEGURO mudar (CLI-SEC-3): nenhum caminho aqui relaxa categoria
          // sempre-ask — o único bypass total continua sendo `--unsafe`.
          get mode() {
            return built.engine.mode;
          },
          setMode: (mode) => built.controller.setMode(mode),
          sessionGrants: built.engine.sessionGrants,
          effectiveSafeDefault: (tool) => built.engine.effectiveSafeDefault(tool),
          setSafeToolDefault: (tool, decision) => built.engine.setSafeToolDefault(tool, decision),
        }}
      />,
      // EST-1015 (fix do dono "1 ctrl+c já derruba a app") — `exitOnCtrlC: false`. O DEFAULT
      // do Ink é `true`: ele ENCERRA no Ctrl+C ANTES de chamar os handlers do `useInput`, o
      // que tornava o duplo-Ctrl+C do #367 INÚTIL no binário real (o app saía no 1º toque, no
      // composer vazio — exatamente a reclamação). Com `false`, o Ctrl+C-byte chega ao
      // `useInput` e a lógica clear/arm/exit do App passa a controlar a saída (o 2º Ctrl+C
      // chama `useApp().exit()`). O caminho de SINAL (SIGINT real) segue tratado pelos
      // handlers de restauração (alt-screen.ts) — independente deste flag.
      { stdout: renderStdout, exitOnCtrlC: false },
    );

    // EST-0972/0983 — semeia o contexto do PRÓXIMO submit. Combina, NA ORDEM:
    //   (1) o RECALL da memória (EST-0983): os fatos lembrados de sessões anteriores,
    //       como DADO ENVELOPADO (observation, CLI-SEC-4/GS-M3) — NUNCA `system`. A
    //       leitura é da mecânica interna (read-deny de `~/.aluy/memory/` mantido);
    //   (2) o histórico de uma sessão RETOMADA (EST-0972), se houver.
    // Ambos entram como `attachments` inertes (não tocam a catraca; nunca instrução).
    // Best-effort: uma falha de leitura da memória NUNCA derruba o boot.
    let memorySeed: HistoryItem[] = [];
    try {
      memorySeed = [...(await built.memory.recall())];
    } catch {
      memorySeed = []; // fail-safe: sem memória recuperada, a sessão segue normal.
    }
    const bootSeed = [...memorySeed, ...resumedHistory];
    if (bootSeed.length > 0) built.controller.seedHistory(bootSeed);
    const unsubSave = built.controller.subscribe(() => saveNow());

    // EST-1012 — ROBUSTEZ DE MEMÓRIA · liga o MONITOR DE PRESSÃO de heap agora que a TUI
    // está montada (temos o `unmount`). A porta de encerramento-limpo é o ÚLTIMO recurso
    // do backstop de OOM: SALVA a sessão (saveNow), marca o exit-code acionável e DESMONTA
    // a TUI limpo (o `finally` do waitUntilExit reseta o terminal) — em vez do "Killed"
    // cego do kernel. A nota acionável já foi empurrada pelo controller ANTES desta porta.
    built.controller.setMemoryShutdown(() => {
      saveNow(); // grava a transcrição corrente ANTES de sair (DoD: "salva a sessão").
      process.exitCode = 1; // sinal honesto p/ script: encerramos por pressão de memória.
      try {
        instance.unmount(); // desmonta a TUI limpo ⇒ o `finally` restaura o terminal.
      } catch {
        /* unmount best-effort: nunca derruba o encerramento já em curso. */
      }
    });
    built.controller.startMemoryMonitor();

    // ADR-0134/0135 — LIGA a bridge Telegram agora que o `SessionController` existe: preenche
    // a ref DEFERIDA do sink e dispara o PUMP do long-poll (em segundo plano). O pump roteia
    // CADA mensagem pela malha (C2) e injeta SÓ o que ela autoriza. NÃO bloqueia o boot/render
    // (`void`); um erro do pump é REDIGIDO (C1) e NÃO derruba a sessão. O `bridge.stop()` no
    // teardown cancela o long-poll. Só existe quando a bridge subiu (token presente — C6).
    if (telegramBridge) {
      telegramController = built.controller;
      void telegramBridge.pump();
    }

    // EST-0974 — HOOKS de `session-start`: disparados UMA vez no boot, ATRÁS da catraca.
    // Em Plan, são NEGADOS (run_command é efeito); fora de Plan, sempre-ask ⇒ ask. O
    // disparo é best-effort (não bloqueia o render). Sem hooks de session-start ⇒ no-op.
    const sessionStartHooks = selectHooks(hooksConfig, 'session-start');
    if (sessionStartHooks.length > 0) {
      void hookRunner.runAll(sessionStartHooks);
    }

    // EST-1018 (BUG-0021) — pre-tool / post-tool no HEADLESS já são fiados (ramo `if
    // (headless)`: `makeToolHooksObserver` + `controller.addToolObserver`). O MECANISMO
    // existe e é reusável aqui na TUI — basta registrar o mesmo observador no controller
    // (`built.controller.addToolObserver(makeToolHooksObserver({runner, config}))`). NÃO
    // fiado AQUI nesta estória por escopo (EST-1018 cobre só o resíduo do headless do #204;
    // a TUI já não os disparava antes — segue inalterada). Follow-up: fiar na TUI também.

    // Objetivo direto (`aluy "objetivo"`): submete após o 1º frame.
    if (opts.goal !== undefined && opts.goal.trim() !== '') {
      void built.controller.submit(opts.goal);
    }

    try {
      await instance.waitUntilExit();
    } finally {
      // EST-0965 — ESU FINAL ao desmontar (unmount limpo OU crash propagado pelo
      // waitUntilExit — daí o `finally`): garante que o terminal NÃO fica preso em modo
      // sync e o cursor reaparece. Idempotente c/ o handler de sinal. Solta também os
      // handlers de sinal p/ não vazar listener entre sessões.
      sync?.cleanup();
      // EST-1010 — RESETA o fundo do terminal ao default do usuário no unmount limpo OU
      // crash (daí o finally). Idempotente c/ o handler de sinal — não duplica a seq.
      bgController.reset();
      // EST-1000 · ADR-0076 §2 — RESTAURA o alt-screen no unmount LIMPO/crash (daí o
      // finally) e solta os handlers de sinal/crash (sem vazar listener). Idempotente: se um
      // sinal já restaurou, isto é no-op; se saímos limpo do cockpit, garante a tela primária.
      altScreen.dispose();
      // EST-1010 (BUG-0022) — solta os handlers no caminho FELIZ (unmount limpo/crash do
      // waitUntilExit). Idempotente com o `finally` externo (re-remoção é no-op).
      signalReset.dispose();
    }
    // ADR-0134/0135 — ENCERRA a bridge Telegram ao sair: aborta o long-poll (o connector
    // termina o `incoming()`). Idempotente; no-op quando a bridge não subiu. Solta a ref
    // deferida do sink (sem injetar em sessão já morta).
    telegramBridge?.stop();
    telegramController = undefined;
    // EST-0970/EST-BOOT-DECOUPLE — fecha os processos-server MCP ao sair (sem vazar
    // processo). Best-effort; espera o handshake em voo terminar se o boot desacoplado
    // ainda estava conectando quando o usuário saiu (nunca deixa órfão).
    await closeMcpSetup();
    // EST-0963 — solta o observador do sino ao sair (sem timer/subscrição órfã).
    detachNotify();
    // EST-0974 — solta o observador de hooks ao sair (sem subscrição órfã).
    detachHooks();
    // EST-0972 — solta o auto-save e grava a transcrição final ao sair.
    unsubSave();
    saveNow();
    // Ao SAIR, mostra o id da sessão + como retomá-la na linha de comando (como o Claude
    // Code). Só na saída INTERATIVA (TTY) e quando há conversa de fato — uma sessão vazia
    // (abriu e fechou) não imprime nada. O id é DADO (nome de arquivo em ~/.aluy/sessions/),
    // nunca credencial.
    if (
      process.stdout.isTTY &&
      hasResumableContent(built.controller.current.blocks, built.controller.label)
    ) {
      // F188 — quando a conversa tem NOME (rótulo), oferece também a retomada por nome
      // (`aluy --resume <nome>` — F169), além do id. Nome com espaço é citado. O id fica
      // como forma canônica (único); o nome é o atalho amigável.
      const label = built.controller.label;
      const byName =
        label !== undefined && label.trim() !== ''
          ? `  ou pelo nome:                 aluy --resume ${/\s/.test(label) ? `"${label}"` : label}\n`
          : '';
      process.stdout.write(
        `\n  Sessão salva — id: ${activeSession.id}\n` +
          `  Para retomar esta conversa:  aluy --resume ${activeSession.id}\n` +
          byName +
          '  (ou `aluy --continue` para a sessão mais recente deste diretório)\n\n',
      );
    }
  } finally {
    // REDE DE SEGURANÇA para stdin: garante que o stdin NUNCA fica em raw-mode após
    // sair — mesmo que o Ink tenha crashado antes do seu próprio cleanup. No Windows/
    // Cmder, stdin em raw-mode bloqueia TODOS os terminais que partilham o conhost.
    try {
      process.stdin.setRawMode?.(false);
      process.stdin.pause?.();
    } catch {
      /* best-effort */
    }
    // task #18 — DESFAZ o wrap do `read()` (guard de CSI-u) ao sair, em QUALQUER caminho de
    // término (unmount limpo / crash do `render` / sinal). Idempotente; restaura SÓ se ainda
    // for o nosso wrap — não vaza o interpositor entre sessões nem pisa num wrap de terceiros.
    restoreCsiUGuard();
    // EST-0965 — ESU FINAL ao desmontar (unmount limpo OU crash propagado pelo
    // waitUntilExit — daí o `finally`): garante que o terminal NÃO fica preso em modo
    // sync e o cursor reaparece. Idempotente c/ o handler de sinal. Solta também os
    // handlers de sinal p/ não vazar listener entre sessões.
    sync?.cleanup();
    // EST-1010 — RESETA o fundo do terminal ao default do usuário no unmount limpo OU
    // crash (daí o finally). Idempotente c/ o handler de sinal — não duplica a seq.
    bgController.reset();
    // EST-1000 · ADR-0076 §2 — RESTAURA o alt-screen no unmount LIMPO/crash (daí o
    // finally) e solta os handlers de sinal/crash (sem vazar listener). Idempotente: se um
    // sinal já restaurou, isto é no-op; se saímos limpo do cockpit, garante a tela primária.
    altScreen.dispose();
    // EST-0948 — desliga o bracketed paste (`?2004l`) no unmount LIMPO/crash. Idempotente
    // com o handler de sinal e o `process.once('exit')`. Solta o handler de exit registrado.
    disableBracketedPaste();
    process.removeListener('exit', disableBracketedPaste);
    // EST-1010 (BUG-0022) — REDE DE SEGURANÇA: solta os handlers de SIGINT/SIGTERM em
    // QUALQUER saída do ramo TTY via `signalReset.dispose()`, inclusive se o `render`/boot
    // LANÇOU antes do `waitUntilExit` (a remoção do `finally` interno nunca rodaria). Sem
    // isto, listeners de SIGINT/SIGTERM vazam entre sessões. Idempotente (chamá-lo no
    // `finally` interno E externo é seguro — re-remoção é no-op).
    signalReset.dispose();
  }
}

// EST-0948 / EST-0989 — `emitBootClear` vive em `run-clear.ts` (importável pelo
// splash-controller SEM ciclo). Re-exportado aqui (já importado no topo) p/ o
// binário/teste seguirem importando `from './run.js'` (contrato preservado).
export { emitBootClear };

/**
 * EST-0942 — CHECK DE CREDENCIAL no boot (só PRESENÇA, sem rede). Devolve `true`
 * quando NÃO há credencial alguma p/ a sessão: nem no keychain (`whoami()` ⇒ null)
 * nem como `ALUY_TOKEN` no ambiente. Nesse caso o boot orienta `aluy login` em vez
 * de deixar a 1ª chamada falhar com o "broker indisponível" genérico.
 *
 * NÃO valida o token na rede (caro/lento) — só checa que ALGO foi fornecido. Se a
 * credencial existir mas for inválida/expirada, isso vira um erro ESPECÍFICO (401 ⇒
 * "credencial inválida/expirada") na 1ª chamada, via `classifyBrokerError`.
 *
 * `whoami()` já devolve a credencial REDIGIDA (sem segredo) — aqui só olhamos a
 * presença (não-null), nunca o conteúdo. `ALUY_TOKEN` é checado por PRESENÇA: nunca
 * lemos/logamos o valor (CLI-SEC-6). Falha de leitura do keychain ⇒ fail-safe: se
 * há `ALUY_TOKEN`, consideramos logado; senão, avisamos (pior caso: 1 aviso extra,
 * nunca um falso "logado" que esconda o problema).
 */
export async function isLoggedOut(deps: {
  login: Pick<LoginService, 'whoami'>;
  env: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const hasEnvToken = (deps.env.ALUY_TOKEN ?? '').trim() !== '';
  if (hasEnvToken) return false;
  try {
    const cred = await deps.login.whoami();
    return cred === null;
  } catch {
    // keychain ilegível e sem ALUY_TOKEN ⇒ trata como deslogado (avisa — fail-safe).
    return true;
  }
}

/**
 * EST-0972 (BUG 2) — prompt SIM/NÃO do boot p/ a auto-oferta de retomada, ANTES de
 * montar o Ink (uma leitura de UMA linha do stdin cru). Default `S` (Enter = sim): a
 * UX menos surpreendente é continuar de onde parou. `s`/`sim`/`y`/`yes`/vazio ⇒ sim;
 * qualquer outra coisa ⇒ não (sessão nova). Fail-safe: stdin sem TTY / fim de fluxo /
 * erro ⇒ NÃO retoma (não pendura o boot esperando uma resposta impossível). NÃO loga.
 */
/**
 * Prompt sim/não do boot (EST-0972). `stdin` é injetável p/ teste de unidade
 * (default `process.stdin`); só precisa de `isTTY`, `setRawMode`, `resume`,
 * `pause`, `on`/`removeListener('data')` — i.e. um `NodeJS.ReadStream`.
 */
export function defaultBootPrompt(
  stdout?: NodeJS.WriteStream,
  stdinOverride?: NodeJS.ReadStream,
): (prompt: string) => Promise<boolean> {
  return (prompt: string) =>
    new Promise<boolean>((resolve) => {
      const out = stdout ?? process.stdout;
      const stdin = stdinOverride ?? process.stdin;
      if (stdin.isTTY !== true) {
        resolve(false); // sem TTY de entrada ⇒ não há como perguntar; fail-safe: nova.
        return;
      }
      out.write(prompt);
      let buf = '';
      const cleanup = (): void => {
        stdin.removeListener('data', onData);
        try {
          stdin.setRawMode?.(false);
          stdin.pause();
        } catch {
          /* best-effort */
        }
      };
      const decide = (line: string): void => {
        cleanup();
        out.write('\n');
        const a = line.trim().toLowerCase();
        // Enter (vazio) e sim explícito ⇒ retoma; o resto ⇒ sessão nova.
        resolve(a === '' || a === 's' || a === 'sim' || a === 'y' || a === 'yes');
      };
      const onData = (chunk: Buffer): void => {
        const s = chunk.toString('utf8');
        for (const ch of s) {
          if (ch === '\r' || ch === '\n') {
            decide(buf);
            return;
          }
          if (ch === '\x03' || ch === '\x04') {
            // Ctrl-C/Ctrl-D no prompt ⇒ "não" (não retoma; segue p/ sessão nova).
            decide('n');
            return;
          }
          // EST-0972: single-key — consistente com o resto da TUI ([s/n], [c]/[n]),
          // o 1º char já decide, SEM exigir Enter. 's'/'y' ⇒ retoma; 'n' ⇒ nova.
          // (cobre o lote `s\r`: o 's' já resolve antes do '\r'.)
          if (buf === '') {
            const low = ch.toLowerCase();
            if (low === 's' || low === 'y') {
              decide('s');
              return;
            }
            if (low === 'n') {
              decide('n');
              return;
            }
          }
          buf += ch;
        }
      };
      try {
        stdin.setRawMode?.(true);
        stdin.resume();
        stdin.on('data', onData);
      } catch {
        cleanup();
        resolve(false); // não conseguiu ler ⇒ fail-safe: sessão nova.
      }
    });
}

/**
 * EST-0966/EST-0969 — escolhe o tema INICIAL (só TTY). Ordem de precedência:
 *   1. Override EXPLÍCITO do env (COLORFGBG/--theme via resolveTheme) — preferência
 *      do usuário vence tudo; se o env já indica light/dark deliberado, usa.
 *   2. CONFIG SALVA (`~/.aluy/config.json`, EST-0969) — a última escolha de `/theme`
 *      do usuário, persistida. Vence a auto-detecção (é uma preferência explícita
 *      anterior, mais forte que adivinhar pelo fundo do terminal).
 *   3. AUTO-DETECÇÃO via OSC 11 (best-effort): pergunta a cor de fundo ao terminal.
 *   4. Default dark (terminal sem suporte / sem resposta / NO_COLOR).
 *
 * Nota: `resolveTheme({env})` sem override devolve `dark` por default, então não dá
 * p/ distinguir "usuário pediu dark" de "default". Por isso só tratamos COLORFGBG
 * como override explícito de brilho — é o sinal deliberado do terminal. Sem ele,
 * a config salva decide; sem ela, a auto-detecção OSC 11; falhando, o default dark.
 */
async function detectInitialTheme(
  env: NodeJS.ProcessEnv,
  stdout: NodeJS.WriteStream | undefined,
  config: UserConfig = {},
): Promise<ThemeName> {
  // (1) override explícito do env: COLORFGBG declara o brilho deliberadamente.
  if (env.COLORFGBG !== undefined && env.COLORFGBG.trim() !== '') {
    return themeNameForBrightness(resolveTheme({ env }).brightness);
  }
  // (2) config salva: a última escolha persistida de `/theme` (já validada no load).
  if (config.theme !== undefined) {
    return config.theme;
  }
  // (3) auto-detecção OSC 11 (best-effort; NO_COLOR/não-TTY ⇒ null lá dentro).
  const detected = await queryTerminalBrightness({
    stdout: stdout ?? process.stdout,
    stdin: process.stdin,
    env,
  });
  if (detected) return themeNameForBrightness(detected);
  // (4) default dark.
  return DEFAULT_THEME;
}

/**
 * EST-0964/0979 — lê as instruções de projeto do workspace no startup (config do dono,
 * confiável): AGENT.md (nativo) + AGENTS.md (Codex) + CLAUDE.md (Claude Code), na ordem
 * de precedência, compostas num texto p/ o `system`. Constrói um workspace/fs confinado
 * SÓ p/ esta leitura (o mesmo confinamento que o `buildSession` usa). Fail-safe:
 * qualquer erro ⇒ sem instruções (prompt baseline). NÃO é o `@arquivo` (esse é dado
 * ingerido por turno) — é config do dono. Devolve também QUAIS fontes carregaram.
 */
async function readProjectInstructions(opts: RunSessionOptions): Promise<ProjectInstructionsLoad> {
  try {
    const workspace = new NodeWorkspace(
      opts.workspaceRoot !== undefined ? { root: opts.workspaceRoot } : {},
    );
    const fs = new NodeFileSystemPort({ workspace });
    return await loadProjectInstructions({ workspace, fs });
  } catch {
    return { sources: [] };
  }
}

/**
 * EST-0979 — formata o INDICADOR DISCRETO de quais FONTES de config carregaram
 * (instruções nativo/compat, comandos global/projeto, MCP global/projeto). PURO: só
 * monta as linhas da nota; sem cor crua (o render é do DS). Devolve `[]` quando NADA
 * carregou (sem fontes ⇒ a nota nem aparece). Exportado p/ teste.
 */
export function describeConfigSources(input: {
  readonly instructionSources: readonly string[];
  readonly globalCommands: number;
  readonly projectCommands: number;
  readonly mcpServers: number;
  readonly projectMcp: boolean;
  /** EST-0979 (FU-S3-CODEX-TOML) — o `~/.codex/config.toml` contribuiu server(s). */
  readonly codexMcp?: boolean;
}): readonly string[] {
  const lines: string[] = [];
  if (input.instructionSources.length > 0) {
    lines.push(`instruções: ${input.instructionSources.join(' + ')}`);
  }
  const cmdParts: string[] = [];
  if (input.globalCommands > 0) cmdParts.push(`~/.aluy/commands (${input.globalCommands})`);
  if (input.projectCommands > 0) cmdParts.push(`.claude/commands (${input.projectCommands})`);
  if (cmdParts.length > 0) lines.push(`comandos: ${cmdParts.join(' + ')}`);
  if (input.mcpServers > 0) {
    // Lista as FONTES MCP que de fato contribuíram, na ordem de precedência
    // (`.aluy` global > .mcp.json projeto > Codex global). Só o global é sempre listado.
    const parts = ['~/.aluy/mcp.json'];
    if (input.projectMcp) parts.push('.mcp.json');
    if (input.codexMcp) parts.push('~/.codex/config.toml');
    lines.push(`MCP: ${input.mcpServers} server(s) (${parts.join(' + ')})`);
  }
  return lines;
}

/**
 * EST-0969 — extrai o `<nome>` de `/theme <nome>` (não-TTY) p/ decidir se persistir.
 * `/theme` sem arg (lista) ⇒ undefined; `/theme light` ⇒ `light`. Não é um `/theme`
 * ⇒ undefined (o caller já garantiu que foi tratado, mas é defensivo).
 */
function themeArgOf(goal: string | undefined): string | undefined {
  const line = (goal ?? '').trim();
  if (!line.startsWith('/theme ')) return undefined;
  const arg = line.slice('/theme '.length).trim();
  return arg === '' ? undefined : arg;
}

/**
 * EST-0989 (i18n) — extrai o `<code>` de `/lang <code>` (não-TTY) p/ decidir se
 * persistir. `/lang` sem arg (lista) ⇒ undefined; `/lang en` ⇒ `en`. Espelha o
 * `themeArgOf`.
 */
function langArgOf(goal: string | undefined): string | undefined {
  const line = (goal ?? '').trim();
  if (!line.startsWith('/lang ')) return undefined;
  const arg = line.slice('/lang '.length).trim();
  return arg === '' ? undefined : arg;
}

// Re-export p/ o binário/teste. `runLinear`/`linearize` (modo não-TTY, a11y do
// DoD) vivem em `linear.ts` — lógica testável fora deste módulo de render Ink.
export { NATIVE_COMMANDS };

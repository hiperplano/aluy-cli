// EST-0948 — <App>: a casca Ink que renderiza o `SessionState` e captura teclado.
//
// Casca FINA: a orquestração mora no SessionController (controller.ts, sem React).
// A App só (1) subscreve o estado, (2) renderiza os blocos via componentes, (3)
// captura teclas (composer / ask / budget / slash-menu). A captura de ask aplica
// os fail-safes via o AskResolver (deny em Ctrl-C/esc).
//
// Eixo 2 "vivo" (redesign): a App monta o ÚNICO tick central (`useTick`) e passa o
// `frame` aos componentes animados (`<Working>`, cursor/◇ pulse). Tudo desligável
// por `theme.animate` (reduced-motion / não-TTY). Cronologia esmaecida: só o
// ÚLTIMO turno é `isCurrent`.

import React, { useEffect, useState, useReducer, useCallback, useMemo, useRef } from 'react';
import { Box, Static, Text, useApp, useInput, useStdin, useStdout } from 'ink';
import {
  Header,
  StatusBar,
  Composer,
  QueuedInputs,
  PendingInjects,
  PendingAsks,
  queuedInputsLines,
  YouBlock,
  AluyBlock,
  ToolLine,
  TestRunBlock,
  AskDialog,
  QuestionDialog,
  OTHER_INDEX,
  BrokerError,
  BudgetGate,
  StuckGate,
  CycleCeilingGate,
  SlashMenu,
  CommandPalette,
  FilePicker,
  ModelPicker,
  ThemePicker,
  LangPicker,
  ProviderPicker,
  HistoryPicker,
  RewindPicker,
  AttachChips,
  Onboarding,
  Boot,
  Working,
  ProgressBar,
  ModeIndicator,
  FooterHints,
  NoteBlock,
  BangBlock,
  SubAgents,
  Doctor,
  PermissionsPanel,
  FlowTreeView,
  ActivityLog,
  TurnFooter,
  QuotaFooter,
  Divider,
  type HintState,
} from '../ui/components/index.js';
import { Role, useTheme } from '../ui/theme/index.js';
import { useTick } from '../ui/hooks/useTick.js';
import { useFilePicker } from '../ui/hooks/useFilePicker.js';
import { useModelPicker } from '../ui/hooks/useModelPicker.js';
import {
  usePermissionsPanel,
  type PermissionEngineControl,
} from '../ui/hooks/usePermissionsPanel.js';
import { useThemePicker } from '../ui/hooks/useThemePicker.js';
import { useLangPicker } from '../ui/hooks/useLangPicker.js';
import { useProviderPicker } from '../ui/hooks/useProviderPicker.js';
import { useHistoryPicker } from '../ui/hooks/useHistoryPicker.js';
import { useRewindPicker, type RewindChoice } from '../ui/hooks/useRewindPicker.js';
import { useCommandPalette } from '../ui/hooks/useCommandPalette.js';
import { themeNameForBrightness, resolveThemeName, type ThemeName } from '../ui/theme/themes.js';
import { useI18n, resolveLang, type Lang } from '../i18n/index.js';
import { resolveProviderName } from '../model/providers.js';
import type {
  CustomModelClient,
  TierCatalogClient,
  ProvidersClient,
  Checkpoint,
} from '@hiperplano/aluy-cli-core';
import { formatQuota } from '@hiperplano/aluy-cli-core';
import { DEFAULT_TIER } from './wiring.js';
import { tierDisplayName } from '../model/catalog.js';
import type { SessionController } from './controller.js';
import type { SessionState, SessionBlock } from './model.js';
import { formatElapsed, queueAtRest } from './model.js';
import { decideEscAction } from './esc-redirect.js';
import { animTickEnabled, elapsedTickEnabled } from './tick-policy.js';
import { splitBlocks } from './render-split.js';
import {
  speechMaxLines,
  slashMenuMaxRows,
  LIVE_SHELL_OUTPUT_MAX_LINES,
  RESPIRO_MIN_ROWS,
} from './live-budget.js';
import { visualLines } from './visual-lines.js';
import { debugRenderLog } from './debug-render.js';
import { answerInParallelWhileSubagents } from './mid-turn-routing.js';
import {
  resolveSplitLayout,
  splitLiveBudget,
  LOG_VISIBLE_ROWS,
  type SplitLayout,
} from './split-budget.js';
import { buildActivityLog, countActivityLines } from './activity-log.js';
import { Cockpit, type CockpitFocus } from './Cockpit.js';
import { resolveCockpitLayout } from './cockpit-layout.js';
import { scrollOffset, type ScrollKey } from './viewport.js';
import {
  insertAt,
  deleteBackward,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  clampCursor,
  applyTypedChunk,
  cursorSeqKind,
  deleteToStart,
  deleteToEnd,
  deleteWordBack,
  decideCtrlC,
  type EditState,
} from './composer-edit.js';
import {
  createBracketedPasteMachine,
  gateInputPaste,
  type PasteEvent,
  type InputPasteGate,
} from './bracketed-paste.js';
import { isUnrecognizedEscapeTail } from './escape-leak.js';
import {
  createPasteRegistry,
  shouldCollapse,
  makePasteChip,
  deleteChipAt,
  expandPastes,
  type PasteRegistry,
} from './paste-collapse.js';
import {
  filterCommands,
  localizeCommands,
  NATIVE_COMMANDS,
  routeInput,
  isSlashMenuQuery,
  slashMenuVisibleLines,
  entryCompletion,
  isTerminalSubcommand,
  terminalSubmitLine,
  isParallelWhileBusy,
  type SlashCommand,
  type PaletteHit,
} from '../slash/commands.js';
import { trailingMention, stripTrailingMention, parseAtMentions } from '../attach/index.js';
import { resolveLinearMentions } from './linear.js';
import type { FileIndexPort, SessionStore } from '../io/index.js';
import type { AttachReader } from '../attach/index.js';
import type { EgressAllowlist } from '../io/egress.js';
import { networkTargetOf } from '../io/egress.js';

// EST-0989 — SENTINELA do header no `<Static>`: o header é o 1º item do mesmo Static
// que carrega o histórico, pra ficar PINADO no TOPO (acima dos turnos). Um Symbol
// único distingue o item-header dos blocos da sessão sem colidir com nenhum `kind`.
const HEADER_ITEM = Symbol('header');
type StaticItem = typeof HEADER_ITEM | SessionBlock;

export interface AppProps {
  readonly controller: SessionController;
  /** Comandos do usuário (DADO de ~/.aluy/commands/). */
  readonly userCommands?: readonly SlashCommand[];
  /** Allowlist de egress p/ enriquecer o AskDialog de rede (CLI-SEC-5). */
  readonly egress?: EgressAllowlist;
  /** Nome do usuário (onboarding). */
  readonly userName?: string;
  /** Animação ligada (cursor pisca). */
  readonly animate?: boolean;
  /**
   * EST-0965 — synchronized-output (#76, Mode 2026) ATIVO nesta sessão. Quando ligado
   * (padrão), cada frame do Ink sai ATÔMICO (BSU…ESU), então a animação de 120ms VOLTA
   * a rodar no `streaming`/`retrying` SEM tremor (religa a "parte animada" que o #75
   * desligou). Quando o sync está OFF (`ALUY_SYNC_OUTPUT=0` ou terminal sem suporte que
   * o caller detecte), fica `false` ⇒ a animação no streaming segue DESLIGADA (preserva
   * o anti-flicker #75 no caminho sem-sync). `thinking`/`boot` animam de qualquer jeito.
   * Default `true` (wiring sem o flag ⇒ sync ligado, comportamento padrão).
   */
  readonly syncActive?: boolean;
  /** Versão do binário p/ o splash (CLI_VERSION). Sem hardcode na tela. */
  readonly version?: string;
  /**
   * Tempo (ms) que o splash de boot fica antes de auto-dispensar. Default 900ms
   * (spec: splash <1s). 0 desliga o auto-dismiss (some só na 1ª tecla/objetivo).
   */
  readonly bootMs?: number;
  /** Handler de comando nativo (ex.: /quit, /help) — wiring injeta. */
  readonly onCommand?: (command: SlashCommand, args: string) => void;
  /**
   * EST-0983 — registra a LIMPEZA VISUAL do terminal (`clearScreen` — clear de tela+
   * scrollback + remonta do `<Static>`) p/ o WIRING poder dispará-la quando a sessão de
   * fato zera (`/clear`, e `/clear full` SÓ na confirmação). Só a App tem o stdout + a
   * key do Static; o wiring tem a memória + o estado da confirmação. Chamado 1× no mount.
   */
  readonly registerClearScreen?: (clearScreen: () => void) => void;
  /** EST-0957 — índice de arquivos do workspace p/ o picker `@`. */
  readonly fileIndex?: FileIndexPort;
  /** EST-0957 — leitor confinado/path-deny dos anexos `@arquivo`. */
  readonly attachReader?: AttachReader;
  /**
   * EST-0962 — cliente do catálogo de tiers p/ o seletor `/model`. Quando ausente,
   * o `/model` cai p/ a NOTA de texto (comportamento antigo, via `onCommand`).
   */
  readonly catalog?: Pick<TierCatalogClient, 'list'>;
  /**
   * EST-0962 — cliente da lista de modelos CUSTOM (`GET /v1/models/custom`, a fonte
   * DEDICADA do autocomplete do modo Custom — os 342). SEPARADA do `catalog` (tiers).
   * Ausente ⇒ o Custom degrada p/ texto-livre puro (sem sugestão/aviso).
   */
  readonly customModels?: Pick<CustomModelClient, 'list'>;
  /**
   * EST-0962 — troca o tier da sessão (o controller aplica no caller). Chamado pelo
   * seletor `/model` ao confirmar. Sem ele, o picker não troca (degradação segura).
   * O 2º arg é o slug Custom (ADR-0030 §3): preenchido SÓ quando `tier === 'custom'`
   * (browser/texto-livre warn-but-allow); `undefined` nos tiers canônicos. O 3º arg
   * (EST-0962) carrega `supportsTools` quando o slug veio de uma linha CONHECIDA do
   * browser, p/ o caller ECOAR o aviso warn-but-allow de não-suporte a tools (não
   * bloqueia). HG-2: o slug é NOME de modelo, nunca credencial — o broker revalida.
   */
  readonly onSelectTier?: (
    tier: string,
    model?: string,
    opts?: { readonly supportsTools: boolean },
  ) => void;
  /**
   * EST-0968 — controle SEGURO da catraca p/ o painel interativo `/permissions`:
   * modo (plan/normal/unsafe), grants de sessão (revogar) e default de tools
   * seguras. So expoe o que e SEGURO mudar (CLI-SEC-3) — nao ha caminho p/ relaxar
   * categoria sempre-ask. `setMode` deve passar pelo controller (espelha state.mode
   * p/ o ModeIndicator). Ausente ⇒ `/permissions` cai p/ a NOTA antiga (via onCommand).
   */
  readonly permissionControl?: PermissionEngineControl;
  /**
   * EST-0966 — tema NOMEADO ativo (marca o item ● no `/theme` e pré-seleciona). Sem
   * ele, deriva do `brightness` do tema corrente (compat com testes/wiring antigos).
   */
  readonly currentTheme?: ThemeName;
  /**
   * EST-0966 — troca o tema da sessão (o `ThemeRoot` re-resolve o `Theme` e
   * re-renderiza a árvore com a nova paleta). Chamado pelo `/theme` ao confirmar.
   * Sem ele, o picker não troca (degradação segura).
   */
  readonly onSelectTheme?: (theme: ThemeName) => void;
  /**
   * EST-0989 (i18n) — idioma ATIVO (marca o item ● no `/lang` e pré-seleciona). Sem ele,
   * vem do contexto i18n (useI18n().lang). Espelha `currentTheme`.
   */
  readonly currentLang?: Lang;
  /**
   * EST-0989 (i18n) — troca o idioma da sessão (o `ThemeRoot` re-injeta o `I18n` no
   * contexto e re-renderiza a árvore no novo idioma + persiste via UserConfigStore).
   * Chamado pelo `/lang` ao confirmar. Sem ele, o picker não troca (degradação segura).
   */
  readonly onSelectLang?: (lang: Lang) => void;
  /**
   * EST-0962 (/provider) — provider Custom ATIVO (marca o item ● no `/provider` e
   * pré-seleciona). `undefined` = nenhum setado (o broker escolhe o default). Espelha
   * `currentTheme`/`currentLang`. É o NOME (DADO de catálogo, HG-2), nunca credencial.
   * `string` (não a union do seed) porque a lista VIVA do broker pode trazer providers
   * além de openrouter/deepseek (ADR-0076).
   */
  readonly currentProvider?: string;
  /**
   * EST-1117 — o `reasoning_effort` ATIVO no boot (`--effort`), p/ o passo de effort do
   * `/model` conjugado marcar o ● "atual". O valor LIVE pós-`/effort` mora no caller; este
   * é cosmético (a opção "manter" preserva o atual de qualquer jeito). DADO público.
   */
  readonly currentEffort?: string;
  /**
   * EST-1117 — aplica o TRIO conjugado (provider+model+effort) escolhido no `/model`:
   * a parte de MODELO (tier/slug, mesmo contrato do `onSelectTier`) e a de EFFORT
   * (`keep` = não muda; `set` = o valor passthrough). O wiring (run.tsx) aplica
   * `setTier`[/`setProvider`]+`setEffort` numa só vez. Sem ele, o App cai no
   * `onSelectTier`+`/effort` separados (degradação). HG-2: só DADO público no trio.
   */
  readonly onSelectConjugated?: (
    model:
      | { kind: 'tier'; key: string }
      | { kind: 'custom'; model: string; supportsTools?: boolean },
    effort: { kind: 'keep' } | { kind: 'set'; value: string },
  ) => void;
  /**
   * EST-0962 (/provider) — seta o provider do modo Custom da sessão (o controller o
   * aplica no caller; a próxima chamada o envia em par com o slug). Chamado pelo
   * `/provider` ao confirmar. Sem ele, o picker não troca (degradação segura). HG-2: só
   * o NOME — o broker resolve `(provider, model)` server-side.
   */
  readonly onSelectProvider?: (provider: string) => void;
  /**
   * EST-0962 / ADR-0076 — cliente da lista de providers cadastrados (`GET /v1/providers`,
   * MESMA credencial do chat). A FONTE VIVA do `/provider`: o picker lista os NOMES
   * realmente cadastrados em vez de chumbar openrouter/deepseek. Ausente / broker fora ⇒
   * o picker cai no FALLBACK estático conhecido + nota honesta (degradação segura).
   */
  readonly providersClient?: Pick<ProvidersClient, 'list'>;
  /**
   * EST-0972 — store das sessões persistidas, lido pelo seletor `/history` (lista as
   * sessões anteriores). Quando ausente, o `/history` cai p/ a NOTA informativa (via
   * `onCommand`) — degradação segura (testes antigos / wiring sem store).
   */
  readonly sessionStore?: Pick<SessionStore, 'list' | 'load'>;
  /**
   * EST-0972 — RETOMA a sessão escolhida no `/history` pelo id (carrega o record e
   * aplica `applyResumeRecord`: restoreBlocks + seedHistory + troca o alvo do
   * auto-save). O wiring (run.tsx) injeta. Sem ele, o picker não retoma (degradação
   * segura). Só o id sai daqui — a App não toca o store nem o auto-save.
   */
  readonly onResumeSession?: (id: string) => void;
  /**
   * EST-XXXX (CHECKPOINTS / REWIND) — fonte dos checkpoints da sessão (1 por prompt)
   * p/ o `/rewind`/Esc-Esc. Só LEITURA: `list()` (os pontos) + `barriersAfter(id)`
   * (avisos de `run_command` depois do ponto, p/ a etapa de ação). É o
   * `CheckpointRegistry` (core), injetado pelo wiring. Ausente ⇒ `/rewind` indisponível
   * (a App degrada com nota; Esc-Esc não abre nada).
   */
  readonly rewindSource?: {
    list(): readonly Checkpoint[];
    barriersAfter(id: string): readonly string[];
  };
  /**
   * EST-XXXX — APLICA a escolha do `/rewind` (ponto + ação). O wiring (run.tsx) restaura
   * o código (via o registry) e/ou rebobina a conversa (controller.rewindConversation).
   * A App só repassa a escolha — não toca journal/controller. Ausente ⇒ no-op.
   */
  readonly onRewind?: (choice: RewindChoice) => void;
  /**
   * EST-0973 — relógio p/ o ELAPSED do <ProgressBar> indeterminado (fase `compacting`):
   * `elapsed = now() - progress.startedAt`. Default `Date.now`. Injetável p/ teste
   * DETERMINÍSTICO do indicador (sem timer real). Só LEITURA — não dispara efeito.
   */
  readonly now?: () => number;
  /**
   * EST-0990 — estado INICIAL do MODO VIEW AVANÇADO (split CHAT | LOG). Resolvido pelo
   * wiring (precedência `--split` > `ui.splitView` > default OFF, via
   * `resolveInitialSplitView`). Default `false` (TUI de hoje, intacta).
   */
  readonly initialSplitView?: boolean;
  /**
   * EST-0990 — persiste a preferência do split ao alternar (Ctrl+L / /split). O wiring
   * injeta `store.saveSplitView`. Ausente ⇒ o toggle vale só na sessão (degradação
   * segura; testes antigos). É preferência de UI (booleano) — nunca segredo (CLI-SEC-7).
   */
  readonly onSplitViewChange?: (on: boolean) => void;
  /**
   * EST-1000 · ADR-0076 §1 — estado INICIAL do MODO COCKPIT (tela cheia, alt-screen).
   * Resolvido pelo wiring (`--fullscreen` > `ui.fullscreen` > default INLINE, via
   * `resolveInitialFullscreen`). Default `false` (INLINE — o DEFAULT do ADR). Só vale em
   * TTY interativo: o wiring NÃO liga isto em não-TTY/CI.
   */
  readonly initialFullscreen?: boolean;
  /**
   * EST-1001 · ADR-0076 §2 — o WIRING já entrou no alt-screen no boot (ANTES do 1º frame
   * do Ink), porque `--fullscreen`/`ui.fullscreen` foi pedido E a tela CABE. Quando `true`,
   * a App NÃO re-emite `?1049h` no seu effect de boot (o `?1049h` já saiu lá — emitir de
   * novo num `useEffect` pintaria o 1º frame na tela PRIMÁRIA e deixaria o alt-screen preto:
   * exatamente o bug #144). Quando o boot pediu cockpit mas a tela NÃO cabe (ou não pediu),
   * isto é `false`/ausente ⇒ a App segue a lógica de boot (degradar pro inline com aviso).
   */
  readonly cockpitEnteredAtBoot?: boolean;
  /**
   * EST-1000 · ADR-0076 §2 — ENTRA/SAI do alt-screen (`?1049h`/`?1049l` + restauração à
   * prova de tudo). O wiring injeta o controlador real (alt-screen.ts) registrado em todo
   * caminho de término. A App só CHAMA `enter()`/`leave()` no toggle/boot — a restauração
   * GARANTIDA (sinais/crash/exit) é do wiring, não da App. Ausente ⇒ o cockpit é inerte
   * (degradação segura; testes que não montam o alt-screen real).
   */
  readonly cockpitScreen?: {
    /** Emite `?1049h` + esconde cursor (entrar no cockpit). Reseta o differ. */
    readonly enter: () => void;
    /** Restaura `?1049l` + cursor (sair do cockpit p/ inline). Idempotente. */
    readonly leave: () => void;
    /**
     * EST-1000 · ADR-0076 §5 (P2-D) — RESETA o renderer diferencial do cockpit SEM
     * tocar o alt-screen (`?1049h`/`?1049l`). Usado quando o cockpit CONTINUA cabendo
     * mas as dimensões (`rows`/`columns`) mudaram: o `prevLines` do differ é de OUTRA
     * largura ⇒ o diff por-linha compararia frames incompatíveis (lixo). Resetar força
     * o full-paint do próximo frame na dimensão nova. Ausente ⇒ no-op (degradação
     * segura; testes/legado). O `enter()` já reseta — este é só p/ o resize-em-tamanho.
     */
    readonly resetDiffer?: () => void;
  };
  /**
   * EST-1000 · ADR-0076 §1 — persiste a preferência do cockpit ao alternar (`/fullscreen`/
   * `--fullscreen`). O wiring injeta `store.saveFullscreen`. Ausente ⇒ o toggle vale só na
   * sessão. Preferência de UI (booleano) — nunca segredo (CLI-SEC-7).
   */
  readonly onFullscreenChange?: (on: boolean) => void;
  /**
   * EST-1000 · ADR-0076 §4 / CLI-SEC-6 / RES-C-1 — exporta o transcript REDIGIDO p/
   * arquivo (`/export` / ctrl+s). O wiring injeta o gravador (passa pela catraca +
   * redação). Devolve o caminho gravado (p/ a nota de confirmação) ou um erro. Ausente ⇒
   * `/export`/ctrl+s caem numa nota honesta de indisponível.
   */
  readonly onExportTranscript?: (
    path?: string,
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
}

/** Stub no-op do picker quando o índice/leitor não foi injetado (teste antigo). */
const NOOP_INDEX: FileIndexPort = { list: async () => [] };
// FU (não nesta entrega): extrair uma interface mínima `AttachReader` (só `attach`)
// p/ o stub satisfazer o tipo sem o cast `as unknown as AttachReader`.
const NOOP_READER = {
  attach: async () => ({ kind: 'rejected' as const, path: '', reason: 'sem leitor' }),
} as unknown as AttachReader;
// EST-0962 — stub do catálogo quando não injetado (testes antigos / `/model` sem
// seletor): lista vazia ⇒ o hook cai no fallback de tiers conhecidos.
const NOOP_CATALOG: Pick<TierCatalogClient, 'list'> = { list: async () => [] };
// EST-0972 — stub do store de sessões quando não injetado (testes antigos / `/history`
// sem store): lista vazia ⇒ o picker abre em "nenhuma sessão anterior" (esc fecha).
const NOOP_SESSION_STORE: Pick<SessionStore, 'list' | 'load'> = {
  list: () => [],
  load: () => null,
};
// EST-XXXX — fonte de checkpoints vazia quando o `/rewind` não está fiado (testes
// antigos / wiring sem registry). O picker abre mostrando "nenhum ponto" e fecha.
const NOOP_REWIND_SOURCE = {
  list: (): readonly Checkpoint[] => [],
  barriersAfter: (): readonly string[] => [],
};
// EST-0968 — stub do controle de permissão quando não injetado: o hook existe mas
// `/permissions` cai p/ a NOTA antiga (via onCommand). O stub nunca muda nada.
const NOOP_PERMISSION: PermissionEngineControl = {
  mode: 'normal',
  setMode: () => {},
  sessionGrants: { list: () => [], revoke: () => false },
  effectiveSafeDefault: () => 'allow',
  setSafeToolDefault: () => false,
};

export function App(props: AppProps): React.ReactElement {
  const { controller } = props;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useTheme();
  // EST-0989 (i18n) — idioma ATIVO + tradutor do contexto (injetado pelo ThemeRoot).
  const { lang: activeLang, t } = useI18n();
  // EST-1000 · ADR-0076 §6 — DIMENSÕES REATIVAS. Esta versão do Ink NÃO re-renderiza a
  // árvore no `resize` do stdout (o `useStdout` devolve uma referência estável e o Ink só
  // re-pinta o frame, não re-executa o componente). Sem isto, `rows`/`columns` ficariam
  // CONGELADOS na dimensão do mount ⇒ o cockpit nunca reagiria ao redimensionamento em
  // runtime (entrar/sair do alt-screen conforme cabe/não-cabe). Assinamos o `resize` e
  // guardamos a dimensão em estado ⇒ a App re-renderiza com `rows`/`columns` frescos e o
  // effect de resize abaixo (P1-A/P1-B/P2-D) dispara. Best-effort; degrada p/ o default.
  // EST-1000 (fix regressão #272) — o Ink só RE-PINTA o frame no resize, não re-executa o
  // componente. Pra o cockpit/split reagirem ao resize EM RUNTIME, forçamos um re-render
  // num evento `resize` via um tick. NÃO chamamos `setState` no corpo do effect (o `onResize`
  // imediato + `setDims(stdout)` da 1ª versão fazia THRASH de re-render — o mock de stdout
  // muda de referência a cada render ⇒ effect re-roda ⇒ setState ⇒ re-render ⇒ loop, e a
  // árvore nunca assentava). Aqui o tick só sobe no evento real de resize.
  const [, bumpResize] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    // GUARD (fix regressão #272): stdout pode não ter `.on`/`.off` (mocks de teste,
    // ambientes sem stream de TTY real) — sem o guard, `stdout.on` LANÇA e quebra o render.
    if (!stdout || typeof stdout.on !== 'function') return;
    const onResize = (): void => bumpResize();
    stdout.on('resize', onResize);
    return () => {
      if (typeof stdout.off === 'function') stdout.off('resize', onResize);
    };
  }, [stdout]);
  // Lê a dimensão ATUAL do stdout a cada render (sempre reflete a largura real, sem congelar
  // no mount); o tick acima dispara o re-render quando ela muda, e o effect de resize do
  // cockpit (P1-A/B/P2-D, keyed em `[columns, rows, fullscreen]`) então enxerga o novo valor.
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;
  const showHints = theme.density !== 'compact';
  // EST-0985 — divisórias de HIERARQUIA (chrome estático, fora da região viva).
  // Em `compact` omitimos as do HEADER (mais sutil — espelha o `showHints` que já
  // some), mas SEMPRE mantemos as 2 que emolduram o input (acima/abaixo), pois é
  // a separação que dá o ganho de leitura. Largura total via `columns`.
  // EST-0987 — o MESMO flag emoldura o header: rege a régua ACIMA e a ABAIXO dele.
  const showHeaderDivider = theme.density !== 'compact';
  // Anti-flicker (EST-0965) — o teto da prévia viva é DINÂMICO: ver `live-budget.ts`
  // e o cálculo de `liveMaxLines` abaixo (após o `splitBlocks`, que dá os blocos
  // vivos do frame). `LIVE_CHROME_ROWS` (chrome fixo do rodapé) vive lá, re-derivado
  // pós-EST-0989 (header e suas divisórias saíram p/ o `<Static>` no topo).

  const [state, setState] = useState<SessionState>(controller.current);
  // EST-0948 (composer/sessão) — o composer deixou de ser append-only. O TEXTO e a
  // POSIÇÃO DO CURSOR moram num ÚNICO estado (`{text, cursor}`) p/ as mutações serem
  // ATÔMICAS via updater funcional: em xrdp/SSH/paste o Ink entrega vários eventos de
  // tecla SÍNCRONOS antes de um commit do React — ler `input`/`cursor` do closure
  // perderia keystrokes (last-write-wins). Com um só objeto e `setComposer(c => …)`,
  // cada tecla compõe sobre o estado ANTERIOR (igual ao antigo `setInput(v => v+ch)`).
  // O cursor é de VERDADE: ←/→ movem (clamp), Ctrl+A/Ctrl+E vão p/ início/fim (Home/End
  // estilo readline — o terminal envia Home/End como sequência que o Ink DESCARTA, daí
  // o atalho readline ser o canal confiável), Alt+←/→ (e Alt+b/Alt+f) movem por PALAVRA.
  // O char é INSERIDO em `cursor` (não append); backspace apaga em `cursor-1`.
  // INVARIANTE: `0 <= cursor <= text.length` SEMPRE (clampCursor).
  const [composer, setComposer] = useState<{ text: string; cursor: number }>({
    text: '',
    cursor: 0,
  });
  const input = composer.text;
  const cursorPos = composer.cursor;
  // EST-0969 (watchdog) — `true` quando o usuário escolheu `[r]` na pausa-pede-direção
  // e está digitando a NOVA INSTRUÇÃO no composer; Enter a envia (`redirectAfterStuck`),
  // esc cancela e volta ao menu `[r]/[c]/[n]`. Fora da fase `stuck`, sempre `false`.
  const [stuckRedirecting, setStuckRedirecting] = useState(false);
  // EST-1110 · ADR-0114 — estado de interação da PERGUNTA (`perguntar`). O <QuestionDialog>
  // é apresentação PURA; a navegação/seleção/digitação moram aqui (mesmo padrão do
  // composer/ask). `qCursor` = linha sob o cursor (OTHER_INDEX = entrada "Outro");
  // `qSelected` = marcados (multi); `qEditing` = digitando a resposta livre; `qDraft` = texto.
  const [qCursor, setQCursor] = useState(0);
  const [qSelected, setQSelected] = useState<ReadonlySet<number>>(() => new Set());
  const [qEditing, setQEditing] = useState(false);
  const [qDraft, setQDraft] = useState('');
  // Reset do estado de interação a cada NOVA pergunta (spec muda) — sem arrastar a
  // seleção/rascunho de uma pergunta anterior. `text` já abre direto em digitação.
  const qSpec = state.phase === 'questioning' ? state.pendingQuestion?.spec : undefined;
  const qSpecRef = useRef<typeof qSpec>(undefined);
  useEffect(() => {
    if (qSpec !== qSpecRef.current) {
      qSpecRef.current = qSpec;
      setQCursor(0);
      setQSelected(new Set());
      setQDraft('');
      setQEditing(qSpec?.kind === 'text');
    }
  }, [qSpec]);
  // EST-0948 (composer/sessão) — KEY do `<Static>` p/ o `/clear` REALMENTE limpar a
  // tela: o Ink escreve cada item do Static UMA vez no scrollback e nunca mais o
  // re-renderiza; esvaziar o ESTADO não tira o que já foi commitado. Bumpar esta key
  // REMONTA o `<Static>` (React o trata como árvore nova) ⇒ o Ink esquece os itens
  // commitados e redesenha do zero. Combinado com o clear de tela+scrollback do
  // terminal (ver clearScreen), a tela fica REALMENTE limpa.
  const [staticKey, setStaticKey] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashSel, setSlashSel] = useState(0);
  // histórico de inputs (↑↓ no composer vazio, §4.4); -1 = "fora do histórico".
  const [history, setHistory] = useState<readonly string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  // EST-0982 (type-ahead) — FILA de mensagens digitadas ENQUANTO o agente trabalha
  // (`thinking`/`streaming`/`retrying`): Enter no composer durante o trabalho NÃO
  // interrompe — empurra a linha p/ esta fila FIFO, mostrada acima do composer. Ao
  // terminar o turno (fase vira `idle`/`done`), a 1ª da fila é AUTO-SUBMETIDA como o
  // próximo objetivo (ver o efeito abaixo). É estado de UI puro; o auto-submit reusa
  // o MESMO `controller.submit` (mesma catraca, sem ampliar escopo). Ctrl+Enter NÃO
  // enfileira — INJETA no agente vivo (`injectInput`, EST-0982 controle).
  const [queue, setQueue] = useState<readonly string[]>([]);
  // EST-0982 (P0-1) — ESPELHO síncrono da fila. O `enqueueOrInject` precisa decidir "a fila
  // está vazia AGORA?" no MESMO tick em que vários Enters podem chegar (lote/burst), antes de
  // o React re-renderizar com o `queue` novo. O ref é a verdade-do-instante; o `setQueue`
  // (updater funcional) segue sendo a fonte do estado renderizado. Mantidos em sincronia.
  const queueRef = useRef<readonly string[]>([]);
  // F57 — rastreia timestamp do último ESC p/ detecção de duplo-ESC (500ms).
  // Duplo-ESC sempre aborta, mesmo com fila não-vazia; ESC simples com fila enfileira.
  const lastEscRef = useRef(0);
  // Reconcilia o ref com o estado renderizado (cobre limpezas externas: auto-submit drena,
  // /clear/esc zeram). Os ADDS atualizam o ref na hora (via `enqueue`), então o burst síncrono
  // já enxerga a fila crescer ANTES do próximo render.
  // F56 — sincronização DURANTE o render (não em useEffect): garante que após auto-submit
  // o ref não retenha ghost do item drenado. F57 — reseta lastEscRef quando fila esvazia.
  queueRef.current = queue;
  if (queue.length === 0) lastEscRef.current = 0;
  // EST-0982 — ADD na fila por DENTRO de um único ponto: escreve o ref AGORA (síncrono) e
  // agenda o `setQueue` (render). Assim, dois Enters no mesmo tick veem a fila não-vazia já no
  // 2º — base do P0-1 (texto novo NÃO fura item velho enfileirado).
  const enqueue = useCallback((line: string) => {
    queueRef.current = [...queueRef.current, line];
    setQueue((q) => [...q, line]);
  }, []);
  // EST-0982 (P1-2) — DESCARTA a fila inteira (ref + estado em sincronia). Usado quando o
  // usuário ABORTA o turno (esc/Ctrl-C/F8) ou ao drenar um `/clear`: "parar" = soltar também
  // o que ia auto-submeter. Idempotente; barato. Reseta também o lastEscRef (F57) p/ o
  // duplo-ESC não vazar entre turnos distintos.
  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueue([]);
    lastEscRef.current = 0;
  }, []);

  // EST-0982 · ADR-0063 — CONTROLE/OBSERVABILIDADE da árvore de fluxos (VER/PARAR/
  // INTERAGIR). `flowOpen` abre o painel (Ctrl+T); `flowSel` é a linha selecionada no
  // overview; `flowDrill` é o id do nó em DRILL-IN (null = overview). É estado de UI —
  // a mecânica (árvore/abort/auditoria/redação) é toda do controller/core.
  const [flowOpen, setFlowOpen] = useState(false);
  const [flowSel, setFlowSel] = useState(0);
  const [flowDrill, setFlowDrill] = useState<string | null>(null);

  // EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG, V2 agrupado por agente). Estado
  // de UI puro (nada de FlowTree direto aqui — o log lê a PROJEÇÃO redigida).
  //   • `splitView`   — toggle Ctrl+L / /split / --split (persiste em ui.splitView).
  //   • `logFocus`    — `true` quando o LOG tem o foco (Tab alterna); digitar com o log
  //                     focado NÃO edita o composer (rola/filtra). Default chat (false).
  //   • `tabsActive`  — em larguras 60–99 (TABS) qual aba está visível (chat/log).
  //   • `logCollapsed`— ids das seções (agentes) colapsadas (foco no log + Enter).
  //   • `logScroll`   — offset de rolagem da janela do log (foco no log + ↑↓; 0 = cauda).
  //   • `logErrorsOnly`— filtro `e` (só erros/deny). `logTimestamps`/`s`/`a` = incremento.
  const [splitView, setSplitView] = useState(props.initialSplitView === true);
  const [logFocus, setLogFocus] = useState(false);
  const [tabsActive, setTabsActive] = useState<'chat' | 'log'>('chat');
  const [logCollapsed, setLogCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const [logScroll, setLogScroll] = useState(0);
  const [logErrorsOnly, setLogErrorsOnly] = useState(false);

  // EST-1000 · ADR-0076 — MODO COCKPIT (tela cheia, alt-screen). Estado de UI puro.
  //   • `fullscreen`     — ligado? (toggle `/fullscreen`/`--fullscreen`/`ui.fullscreen`).
  //   • `cockpitFocus`   — qual região gerida tem o foco de scroll (Tab alterna).
  //   • `conversaScroll` — offset de scroll da conversa (0 = cauda, "ao vivo").
  //   • (o log reusa `logScroll` — mesma natureza).
  // O alt-screen REAL (`?1049h`/restauração) é gerido pelo wiring (props.cockpitScreen);
  // aqui só o estado de UI e a CHAMADA de enter/leave no toggle.
  const [fullscreen, setFullscreen] = useState(props.initialFullscreen === true);
  const [cockpitFocus, setCockpitFocus] = useState<CockpitFocus>('conversa');
  const [conversaScroll, setConversaScroll] = useState(0);

  // EST-1015 (dono, dogfooding) — DUPLO Ctrl+C p/ sair: um único Ctrl+C no composer ocioso
  // derrubava a app na hora ("uma vez já mata"). Agora o 1º Ctrl+C com o composer VAZIO só
  // ARMA a saída (o footer mostra "ctrl-c de novo para sair"); o 2º dentro de uma janela
  // curta encerra; senão DESARMA sozinho. (Com texto no composer, o 1º Ctrl+C LIMPA o texto.)
  // Durante o TRABALHO o Ctrl+C segue como interrupt (cancela o turno) — outro caminho.
  const [ctrlCArmed, setCtrlCArmed] = useState(false);
  const ctrlCTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // EST-XXXX — Esc-Esc (composer vazio) abre o `/rewind`. Marca quando o 1º Esc foi
  // visto + um timer p/ a JANELA do chord (~600ms). Ref (não estado): o handler de
  // input é síncrono e não deve re-renderizar a cada Esc solto.
  const escPendingRef = useRef<boolean>(false);
  const escTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const disarmCtrlC = useCallback((): void => {
    if (ctrlCTimerRef.current !== undefined) {
      clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = undefined;
    }
    setCtrlCArmed(false);
  }, []);
  // Solta o timer de saída-armada no unmount (não vaza handle nem seta estado fora da tela).
  useEffect(
    () => () => {
      if (ctrlCTimerRef.current !== undefined) clearTimeout(ctrlCTimerRef.current);
      // EST-XXXX — solta também o timer do chord Esc-Esc.
      if (escTimerRef.current !== undefined) clearTimeout(escTimerRef.current);
    },
    [],
  );

  // EST-1000 · ADR-0076 §2/§6 — o cockpit só "vale" em TTY largura ≥ piso e altura ≥ piso.
  // `resolveCockpitLayout` recusa (narrow/short) abaixo do piso ⇒ cai pro inline com aviso.
  // BUG P2-C — o composer cresce p/ input multi-linha (paridade com o inline): contamos as
  // linhas do `input` (1 + nº de `\n`) e o layout reserva até `COMPOSER_MAX_ROWS`,
  // descontando da CONVERSA p/ a soma seguir == rows (§5). Vazio/1 linha ⇒ inalterado. O
  // piso narrow/short é decidido com composer=1 (chamadas de resize abaixo), então o limiar
  // de recusa NÃO muda — só a partição quando já cabe.
  // RESIZE-FIX (bug do gap inline) — o `<Composer>` inline renderiza o input CRU e o terminal
  // o QUEBRA (wrap) em N linhas VISUAIS na largura `columns` (o prompt come ~2 cols de indent).
  // `composerLines` (linhas-FONTE) não vê o wrap. Medimos o VISUAL p/ descontar o EXCEDENTE
  // (além da 1 linha já contada no chrome) do orçamento da fala — senão o frame cruza `rows`,
  // o Ink cai no `clearTerminal` (que não reseta `previousLineCount`) e ACUMULA gap a cada tecla.
  const composerVisualLines =
    input.length === 0 ? 1 : visualLines(input, columns > 2 ? columns - 2 : columns);
  // MULTI-LINHA FIX (achado do dono) — TETO de altura do composer no INLINE. Sem ele o composer
  // crescia SEM LIMITE ao digitar várias linhas, o frame estourava `rows` e o Ink caía no
  // `clearTerminal` (que não reseta `previousLineCount`) ⇒ ESPAÇO EM BRANCO acumulado entre o
  // output e o composer. Com o teto o composer JANELA (mostra a vizinhança do cursor + marcador
  // `↑N`/`↓M`) em vez de empurrar o frame. ~1/3 da tela, piso de 3 linhas. (O cockpit já tinha
  // o seu próprio `maxRows`; só o inline ficou sem.)
  const inlineComposerMaxRows = Math.max(3, Math.floor(rows / 3));
  // O composer agora nunca renderiza mais que `maxRows` linhas (janela) ⇒ o EXCEDENTE que
  // desconta do orçamento da fala é capado nessa altura (não no total do input cru).
  const composerOverflow = Math.max(0, Math.min(composerVisualLines, inlineComposerMaxRows) - 1);
  // EST-1000 · ADR-0076 §3/§7 — as seções do LOG do cockpit: a MESMA projeção REDIGIDA
  // (`buildActivityLog`) que o split #135 usa. PROJETADA ANTES do layout (depende só de
  // `flowOverview` + flags de UI, NÃO das alturas), p/ o layout adaptativo dimensionar o
  // log pela atividade REAL. Só projeta quando o usuário pediu fullscreen (custo zero no inline).
  const cockpitFlowSummaries = fullscreen ? controller.flowOverview() : [];
  const cockpitLogSections = fullscreen
    ? buildActivityLog(cockpitFlowSummaries, (id) => controller.drillInFlow(id), {
        collapsed: logCollapsed,
        errorsOnly: logErrorsOnly,
      }).sections
    : [];
  // EST-1015 (UX redesign) — SINAL p/ o LOG ADAPTATIVO (mata o espaço morto): linhas reais,
  // se há atividade, sub-agentes VIVOS (fase ≠ terminal) e se o foco está no log. Derivado
  // do estado ESTÁVEL (não de tokens chegando) ⇒ a altura não "respira" a cada frame.
  const cockpitActiveAgents = cockpitFlowSummaries.filter(
    (s) =>
      s.kind === 'subagent' &&
      (s.phase === 'thinking' || s.phase === 'tool' || s.phase === 'asking'),
  ).length;
  const cockpitLogHint = fullscreen
    ? {
        lines: countActivityLines(cockpitLogSections),
        hasActivity: cockpitLogSections.length > 0,
        activeAgents: cockpitActiveAgents,
        focused: cockpitFocus === 'log',
      }
    : undefined;
  // BUG P2-C (task #14) — o cockpit dimensiona a Box do composer pelas linhas VISUAIS (com
  // soft-wrap), não LÓGICAS: uma ÚNICA linha lógica longa (1300 chars sem `\n`) é 1 linha
  // lógica mas ocupa N linhas visuais. Usar `composerLines` (lógicas) cravava a Box em 1
  // linha e CLIPAVA a janela+marcador do <Composer>; `composerVisualLines` cresce a Box até
  // COMPOSER_MAX_ROWS, casando com a janela visual que o <Composer> renderiza.
  const cockpitLayout = resolveCockpitLayout(rows, columns, composerVisualLines, cockpitLogHint);
  // ATIVO = o usuário pediu fullscreen E o layout cabe (não recusou). Se recusou, a App
  // renderiza o INLINE (degrada) e mostra o aviso. O alt-screen real (entrar/sair) é
  // disparado no TOGGLE (handler abaixo), espelhando este "ativo".
  const cockpitActive = fullscreen && cockpitLayout.kind === 'cockpit';

  // EST-0990 — RESOLUÇÃO do layout do split pela LARGURA corrente (puro). `single` (OFF
  // ou desabilitado por largura), `side` (≥100, lado-a-lado) ou `tabs` (60–99, alterna).
  // `disabledByWidth` = pediu split mas é estreito demais (<60) ⇒ 1 coluna COM aviso.
  // O log só está VISÍVEL/focável em `side` (sempre) ou `tabs` (aba do log ativa).
  const splitRes = resolveSplitLayout(columns, splitView);
  const splitLayout: SplitLayout = splitRes.layout;
  // O log COEXISTE com o chat (lado-a-lado) em `side`; em `tabs` só quando a aba ativa é
  // o log; em `single` nunca. Decide o foco efetivo e o orçamento de altura da coluna.
  const logVisible = splitLayout === 'side' || (splitLayout === 'tabs' && tabsActive === 'log');
  // Foco efetivo no log: só quando o log está visível E o usuário moveu o foco p/ ele.
  const logFocused = logVisible && logFocus;

  // EST-0957 — canal `@arquivo`: estado do picker + chips anexados ao turno.
  const picker = useFilePicker({
    fileIndex: props.fileIndex ?? NOOP_INDEX,
    attachReader: props.attachReader ?? NOOP_READER,
  });

  // EST-0962 — seletor `/model`: estado do picker de tiers (catálogo do broker +
  // fallback). Carrega na 1ª abertura; confirmar troca o tier da sessão.
  const modelPicker = useModelPicker({
    catalog: props.catalog ?? NOOP_CATALOG,
    // EST-0962 — fonte DEDICADA do Custom (`/v1/models/custom`). Ausente ⇒ o hook
    // degrada p/ texto-livre puro (sem sugestão/aviso) — compat com testes antigos.
    ...(props.customModels ? { customModels: props.customModels } : {}),
    currentTier: state.meta.tier,
    // EST-1117 — o effort ATIVO da sessão (p/ o passo de effort marcar o ● "atual"). Vem
    // do boot (`--effort`); o valor LIVE pós-`/effort` mora no caller (não em `state.meta`).
    // Best-effort cosmético — a opção "manter" preserva o atual independentemente do ●.
    ...(props.currentEffort !== undefined ? { currentEffort: props.currentEffort } : {}),
  });

  // EST-0968 — painel interativo `/permissions`: estado das linhas (modo/grants/
  // tools seguras/categorias travadas) + ações pela API SEGURA da engine. Quando o
  // controle não foi injetado, usa o stub no-op e o `/permissions` cai p/ a nota.
  const permPanel = usePermissionsPanel(props.permissionControl ?? NOOP_PERMISSION);

  // EST-0966 — seletor `/theme`: lista os temas (dark/light), marca o ativo. O tema
  // ativo vem da prop (wiring) ou, na sua ausência, deriva do brilho corrente.
  const currentTheme: ThemeName = props.currentTheme ?? themeNameForBrightness(theme.brightness);
  const themePicker = useThemePicker({ currentTheme });

  // EST-0989 (i18n) — seletor `/lang`: lista os idiomas (pt-BR/en), marca o ativo. O
  // idioma ativo vem do contexto i18n (injetado pelo ThemeRoot). Espelha o /theme.
  const currentLang: Lang = props.currentLang ?? activeLang;
  const langPicker = useLangPicker({ currentLang });

  // EST-0962 (/provider) — seletor `/provider`: lista os providers CADASTRADOS no broker
  // (`GET /v1/providers`, ADR-0076), marca o ativo. O provider ATIVO é REATIVO: deriva de
  // `state.meta.provider` (que o controller.setProvider espelha — re-render na hora), com
  // fallback p/ a prop do boot (`--provider`). `undefined`/`''` = nenhum setado (o broker
  // escolhe o default). É só o NOME (string, DADO de catálogo) — o picker o casa contra a
  // lista VIVA que carregar (que pode ter providers além do seed). Espelha o `/model`.
  const currentProvider: string | undefined =
    (state.meta.provider ?? '') !== '' ? state.meta.provider : props.currentProvider;
  const providerPicker = useProviderPicker({
    ...(currentProvider !== undefined ? { currentProvider } : {}),
    ...(props.providersClient ? { providersClient: props.providersClient } : {}),
  });

  // EST-0989 (i18n) — os NATIVOS LOCALIZADOS no idioma ativo (summaries traduzidos). Memo
  // pelo `t`: só re-mapeia ao trocar de idioma (em pt-BR devolve a MESMA ref ⇒ sem churn).
  const localizedNatives = useMemo(() => localizeCommands(NATIVE_COMMANDS, t), [t]);

  // EST-0972 — seletor `/history`: lista as sessões anteriores (do SessionStore local,
  // re-lidas a cada abertura) e RETOMA a escolhida AO VIVO. Confirmar devolve o id; o
  // wiring (run.tsx) carrega o record e aplica restoreBlocks + seedHistory (mesmo
  // caminho do --resume). Sem store injetado, o stub lista vazio (degradação segura).
  const historyPicker = useHistoryPicker({ store: props.sessionStore ?? NOOP_SESSION_STORE });

  // EST-XXXX — seletor `/rewind` (· Esc Esc): lista os CHECKPOINTS (1 por prompt) do
  // registry da sessão, depois a AÇÃO (código+conversa | só conversa | só código).
  // Confirmar devolve `{ checkpointId, action }`; o wiring (run.tsx, via `onRewind`)
  // aplica. Sem fonte injetada, o stub lista vazio (degradação segura).
  const rewindSource = props.rewindSource ?? NOOP_REWIND_SOURCE;
  const rewindPicker = useRewindPicker({ source: rewindSource });
  // Avisos de barreira (run_command) depois do ponto-alvo (etapa de ação) — REDIGIDOS
  // pelo registry (CLI-SEC-6). Recalculados quando o alvo muda.
  const rewindBarriers = useMemo(
    () => (rewindPicker.target ? rewindSource.barriersAfter(rewindPicker.target.id) : []),
    [rewindPicker.target, rewindSource],
  );

  // EST-0961 — command palette (Ctrl+P): índice fuzzy de TODOS os comandos/ações.
  // Lê a FONTE ÚNICA (mesmos comandos do slash-menu, via filterPalette) + as ações
  // puras. Modal: captura o foco quando aberta (gated contra os outros overlays).
  const palette = useCommandPalette({
    ...(props.userCommands !== undefined ? { userCommands: props.userCommands } : {}),
    // EST-0989 (i18n) — a palette mostra os summaries dos nativos no idioma ativo.
    natives: localizedNatives,
  });

  // ── EST-0965 (FLICKER, causa-raiz medida no PTY) — DOIS ticks, não um ───────────
  // Medido: COM animação no streaming SEM sync = ~210KB redraw; SEM animação = ~76KB
  // (2.75× menos) — era o flicker (o terminal pintava o erase+redraw intermediário do
  // log-update do Ink). O #75 desligou a animação no streaming p/ matar esse tremor.
  //
  // O #76 (synchronized-output, Mode 2026) resolveu pela RAIZ: cada frame do Ink sai
  // envelopado em BSU…ESU ⇒ o terminal pinta o frame ATÔMICO ⇒ redesenhar 8×/seg deixou
  // de tremer. Então RELIGAMOS a animação no `streaming`/`retrying` QUANDO o sync está
  // ATIVO (padrão `syncActive=true`): as bolinhas/spinner e o pulse do cursor/◇ voltam a
  // pulsar no streaming, SEM flicker (frame atômico). Com o sync OFF (`ALUY_SYNC_OUTPUT=0`
  // ou um terminal sem suporte que o caller detecte ⇒ `syncActive=false`), a animação no
  // streaming segue DESLIGADA — preserva o anti-flicker #75 no caminho sem-sync. O
  // `thinking`/`boot` animam dos dois jeitos (vácuo pré-progresso). A decisão é PURA
  // (tick-policy.ts), testável sem o loop de efeitos do Ink.
  const syncActive = props.syncActive ?? true;
  // EST-0970 — o `/doctor` roda em fase `idle` (a checklist viva é um bloco, não uma
  // fase), mas o spinner dos itens `pending` precisa GIRAR. Anima também enquanto houver
  // um bloco `doctor` com check pendente (some sozinho quando todos resolvem).
  const phaseAnimates = animTickEnabled(state.phase, syncActive) || doctorRunning(state.blocks);
  const frame = useTick({ enabled: theme.animate && phaseAnimates });

  // Tick LENTO de 1s (separado da animação) p/ o INDICADOR DE ATIVIDADE (elapsed):
  // durante o trabalho (`thinking`/`streaming`/`retrying`) o relógio precisa avançar
  // 1×/seg mesmo SEM token novo (ex.: o modelo gerando args de um `edit_file` grande
  // por segundos) — senão a tela parece CONGELADA. É INFORMATIVO (não decorativo): roda
  // mesmo com `ALUY_NO_ANIM` (independe de `theme.animate`). 1fps ⇒ NÃO reintroduz o
  // flicker (no máximo 1 redraw/seg + o flush do texto). `thinking`/`streaming`/
  // `retrying` são as fases ocupadas; idle/ask/budget/done/error não armam timer.
  const busy = elapsedTickEnabled(state.phase);
  useTick({ enabled: busy, intervalMs: 1000 });

  useEffect(() => {
    const unsubscribe = controller.subscribe(setState);
    return () => {
      unsubscribe();
      // Anti-flicker: libera o timer do throttle de flush ao desmontar a TUI.
      // EST-0982 (semântica do esc) — o dispose também PARA TUDO (turno + sub-agentes
      // + desacoplados): encerrar a sessão nunca deixa filho órfão no processo.
      controller.dispose();
    };
  }, [controller]);

  // ── EST-1000 · ADR-0076 §1/§2/§6 — ENTRADA do cockpit no BOOT (`--fullscreen`/pref) ──
  // Quando o wiring resolveu entrar no cockpit já no boot (`initialFullscreen`), entramos
  // no alt-screen UMA vez no mount — SE a tela cabe (§6). Se NÃO cabe (narrow/short), o
  // `fullscreen` é DESLIGADO (cai pro inline) e empurramos o aviso (decisão (a) do ADR).
  // Roda 1× (deps vazias): o resize ao vivo é tratado pelo `cockpitActive` no render +
  // pelo handler de toggle, não aqui. Best-effort.
  useEffect(() => {
    if (props.initialFullscreen !== true) return;
    // EST-1001 · ADR-0076 §2 (FIX #144) — o WIRING já entrou no alt-screen ANTES do 1º
    // frame do Ink (`cockpitEnteredAtBoot`). NÃO re-emitimos `?1049h` aqui: fazê-lo num
    // `useEffect` (que roda DEPOIS do 1º commit) pintava o frame na tela PRIMÁRIA e deixava
    // o alt-screen preto — o bug. O `?1049h` correto já saiu no wiring; o render abaixo só
    // monta o <Cockpit> (cockpitActive=true). Nada a fazer no effect quando já entrou.
    if (props.cockpitEnteredAtBoot === true) return;
    const fits = resolveCockpitLayout(rows, columns).kind === 'cockpit';
    if (fits) {
      // Caminho legado/teste: o boot pediu cockpit, cabe, mas o wiring NÃO entrou (ex.: sem
      // `cockpitScreen` injetado, ou teste). Entra agora (degradação segura) — não é o
      // caminho de produção do `--fullscreen`, que entra no wiring.
      props.cockpitScreen?.enter();
    } else {
      // não cabe no boot ⇒ desliga o cockpit e avisa (degrada pro inline limpo).
      setFullscreen(false);
      const reason = resolveCockpitLayout(rows, columns);
      const msg =
        reason.kind === 'refuse' && reason.reason === 'narrow'
          ? t('cockpit.refuseNarrow')
          : t('cockpit.refuseShort');
      controller.replaceNote('cockpit', [msg]);
    }
    // monta 1× (deps vazias de propósito — entrada de boot do cockpit; o resize ao vivo
    // é tratado no effect keyed em [rows, columns] abaixo, não aqui). props/rows/columns
    // são a fotografia do mount.
  }, []);

  // ── EST-1000 · ADR-0076 §2/§5/§6 (P1-A/P1-B/P2-D) — RESIZE AO VIVO do cockpit ──────
  // O boot/toggle só (re)armam o alt-screen 1×. Faltava tratar o RESIZE em runtime:
  // encolher abaixo do piso (`<80col`=narrow OU `rows<COCKPIT_MIN_ROWS`=short) fazia
  // `cockpitActive` virar false e a App cair pro inline — MAS `leave()` (`?1049l`) nunca
  // era chamado ⇒ o terminal ficava PRESO na tela alternativa (vazamento P1-A). E voltar
  // a caber re-montava o <Cockpit> sem re-armar o alt-screen/differ (buffer stale, P1-B).
  // Este effect, keyed nas DIMENSÕES, espelha a TRANSIÇÃO cockpit↔refuse com fullscreen ON:
  //   · cockpit→refuse (encolheu): leave() (write direto de `?1049l`, COMO o toggle — NÃO
  //     a restauração one-shot dos handlers, p/ preservar os handlers de sinal/crash/exit)
  //     + empurra a nota de recusa. NÃO mexe em `fullscreen` (p/ re-entrar ao voltar a caber).
  //   · refuse→cockpit (voltou a caber): enter() (que já reseta o differ + re-arma `?1049h`).
  //   · cockpit→cockpit em OUTRA dimensão (P2-D defensivo): reseta SÓ o differ (resetDiffer)
  //     p/ não comparar frames de larguras diferentes (lixo) — sem tocar o alt-screen.
  // Ref semeada com o estado do mount (o boot já tratou a entrada inicial) ⇒ não duplica.
  const prevFitsRef = useRef<boolean>(
    props.initialFullscreen === true && cockpitLayout.kind === 'cockpit',
  );
  const prevFullscreenRef = useRef<boolean>(props.initialFullscreen === true);
  useEffect(() => {
    // O TOGGLE (`/fullscreen`) já chama enter()/leave() ao virar o `fullscreen` — aqui só
    // SINCRONIZAMOS a ref (sem re-armar, p/ não duplicar o enter/leave). A lógica de resize
    // abaixo só vale quando o trigger foi uma mudança de DIMENSÃO, não do toggle.
    const fullscreenChanged = prevFullscreenRef.current !== fullscreen;
    prevFullscreenRef.current = fullscreen;
    // Só age quando o usuário PEDIU fullscreen (senão é inline puro — nada a re-armar).
    if (!fullscreen) {
      prevFitsRef.current = false;
      return;
    }
    const fitsNow = cockpitLayout.kind === 'cockpit';
    if (fullscreenChanged) {
      // Toggle ligou o fullscreen NESTE render: o handler já tratou o alt-screen. Só semeia.
      prevFitsRef.current = fitsNow;
      return;
    }
    const fitsBefore = prevFitsRef.current;
    if (fitsBefore && !fitsNow) {
      // ENCOLHEU abaixo do piso ⇒ SAI do alt-screen (sem mexer no `fullscreen`) + avisa.
      props.cockpitScreen?.leave();
      const msg =
        cockpitLayout.kind === 'refuse' && cockpitLayout.reason === 'narrow'
          ? t('cockpit.refuseNarrow')
          : t('cockpit.refuseShort');
      controller.replaceNote('cockpit', [msg]);
    } else if (!fitsBefore && fitsNow) {
      // VOLTOU A CABER ⇒ RE-ENTRA no alt-screen (enter() já reseta o differ + `?1049h`).
      props.cockpitScreen?.enter();
      // EST-1015 (fix TELA EM BRANCO na re-entrada) — o `enter()` troca p/ o alt-screen (VAZIO)
      // e reseta o differ, MAS o frame deste render já foi pintado na tela PRIMÁRIA (inline)
      // ANTES deste effect rodar. Como em repouso NENHUM render novo dispara, o alt-screen fica
      // EM BRANCO até a próxima tecla/resize (repro: fullscreen → encolhe < 80col (cai p/ inline)
      // → cresce de volta → tela preta). Forçamos um re-render AGORA: o differ (recém-resetado)
      // FAZ O FULL-PAINT do cockpit no frame seguinte. `bumpResize` não altera as deps deste
      // effect (`[rows,columns,fullscreen]`), então NÃO re-dispara o effect — só repinta.
      bumpResize();
    } else if (fitsBefore && fitsNow) {
      // Continua cabendo, mas as DIMENSÕES mudaram (este effect só roda em [rows, columns])
      // ⇒ reseta o differ p/ o full-paint na dimensão nova (P2-D). Sem tocar o alt-screen.
      props.cockpitScreen?.resetDiffer?.();
    }
    prevFitsRef.current = fitsNow;
    // Deps de propósito: reage SÓ à mudança de DIMENSÃO (rows/columns) e do toggle
    // (fullscreen). props/controller/t são estáveis na sessão; incluí-los re-dispararia o
    // effect sem mudança de dimensão (e o ramo fullscreenChanged acima já cobre o toggle).
  }, [rows, columns, fullscreen]);

  // ── EST-0982 (semântica do esc) — F8 = PARAR TUDO (pai + todos os filhos) ───────
  // O esc agora para SÓ o turno do pai (os sub-agentes seguem); a tecla FORTE que
  // derruba tudo é o F8 — o caminho do painel (Ctrl+T→P) sem abrir o painel.
  // DETECÇÃO NO CANAL RAW: o Ink parseia `\x1b[19~` como name='f8' mas o `useInput`
  // entrega `input=''` (indistinguível de outras teclas de função) — então, como no
  // fix do batch-Enter (EST-0948), lemos o canal CRU do stdin. O Ink consome o stream
  // via 'readable'+read(); um listener de 'data' coexiste (o Node re-emite o chunk
  // lido) sem roubar o fluxo. Cobre as DUAS sequências reais: CSI `\x1b[19~` (xterm/
  // rxvt/maioria) e SS3 `\x1bOW` (variantes VT/PF). Cessar≠agir (GS-C1): só aborta.
  const { stdin } = useStdin();
  useEffect(() => {
    if (!stdin) return;
    const onData = (data: Buffer | string): void => {
      const s = typeof data === 'string' ? data : data.toString('utf8');
      if (s.includes('\x1b[19~') || s.includes('\x1bOW')) {
        controller.cancelAllFlows();
        // EST-0982 (P1-2) — F8 = PARAR TUDO: descarta também a fila do type-ahead (os itens
        // que iam auto-submeter ao repousar). Parar o turno + limpar o que ia entrar.
        clearQueue();
        return;
      }
      // EST-1015 — HOME/END no composer pelo CANAL CRU (o Ink entrega `char=''` sem flag p/
      // essas teclas — `cursorSeqKind` lê a sequência). Move o cursor (Ctrl+A/E já faziam pelo
      // useInput; agora as teclas FÍSICAS também). setComposer funcional ⇒ usa o texto atual.
      const seq = cursorSeqKind(s);
      if (seq === 'home') setComposer((c) => ({ ...c, cursor: 0 }));
      else if (seq === 'end') setComposer((c) => ({ ...c, cursor: c.text.length }));
    };
    stdin.on('data', onData);
    return () => {
      stdin.removeListener('data', onData);
    };
  }, [stdin, controller, clearQueue, setComposer]);

  // Auto-dismiss do splash (spec §2.1: <1s). Some sozinho após `bootMs` mesmo
  // sem tecla — mas a 1ª tecla/objetivo já o dispensa antes (ver useInput/submit).
  useEffect(() => {
    if (state.phase !== 'boot') return;
    const ms = props.bootMs ?? 900;
    if (ms <= 0) return;
    const t = setTimeout(() => controller.dismissBoot(), ms);
    return () => clearTimeout(t);
  }, [state.phase, controller, props.bootMs]);

  // EST-0969 (watchdog) — ao SAIR da pausa-pede-direção (turno retomou/encerrou),
  // limpa o modo de redirecionamento: ele só vale DENTRO da fase `stuck`. Evita um
  // estado preso se a pausa foi resolvida por outro caminho (esc/abort).
  useEffect(() => {
    if (state.phase !== 'stuck' && stuckRedirecting) setStuckRedirecting(false);
  }, [state.phase, stuckRedirecting]);

  const userCommands = props.userCommands ?? [];
  const slashQuery = input.startsWith('/') ? input.slice(1) : '';
  // EST-0989 (i18n) — o slash-menu lista os nativos LOCALIZADOS (summaries no idioma ativo).
  const slashCommands = filterCommands(slashQuery, userCommands, localizedNatives);

  /**
   * EST-0948 (composer/sessão) — escreve o composer e o cursor de forma COERENTE: ao
   * trocar o texto (digitar, apagar, navegar histórico, anexar/remover chip) o cursor
   * vai p/ uma posição VÁLIDA. Default: FIM do novo texto (caso típico: histórico
   * carregado, chip removido). Quando a edição é POSICIONAL (insert/backspace/delete),
   * o chamador passa a posição exata. Sempre clampa (invariante 0..len).
   */
  const setText = useCallback((text: string, cursor?: number): void => {
    setComposer({ text, cursor: clampCursor(text, cursor ?? text.length) });
  }, []);

  /**
   * EST-0982 (slash-menu durante o trabalho) — FONTE ÚNICA de sincronia do slash-menu
   * com o texto do composer. Ao mudar o composer (digitar/apagar) chamamos isto p/
   * abrir/fechar o `<SlashMenu>` (`isSlashMenuQuery`: input começa com `/` e é só uma
   * "palavra" de comando) e RESETAR a seleção pro topo. Reusada pelos DOIS ramos —
   * idle E type-ahead (`thinking`/`streaming`/`retrying`) — pra não duplicar a regra:
   * em qualquer fase, digitar `/` ABRE o menu; um espaço (ou texto que não casa) FECHA.
   * O `<SlashMenu>` é `{slashOpen && …}` SEM gate de fase, então basta setar `slashOpen`.
   */
  const syncSlashMenu = useCallback(
    (text: string): void => {
      // EST-0974 — `isSlashMenuQuery` precisa dos comandos (do usuário inclusive) p/
      // saber quais têm subcomandos (e tolerar 1 espaço: `/mcp ` segue com o menu aberto).
      setSlashOpen(isSlashMenuQuery(text, props.userCommands ?? []));
      setSlashSel(0);
    },
    [props.userCommands],
  );

  /**
   * EST-0948 (composer/sessão) — `/clear` REALMENTE limpa a tela. O `<Static>` do Ink
   * já commitou os turnos no scrollback (escritos UMA vez, nunca re-renderizados):
   * esvaziar o estado dos blocos NÃO os tira da tela. Então (a) emitimos o clear de
   * TELA + SCROLLBACK do terminal (`\x1b[2J` apaga a tela, `\x1b[3J` o scrollback,
   * `\x1b[H` reposiciona o cursor no topo) e (b) BUMPAMOS a key do `<Static>` p/
   * REMONTÁ-LO (o Ink esquece os itens já commitados e redesenha do zero). Sem (a) o
   * scrollback antigo continua rolável; sem (b) o Ink não re-escreve o header/conteúdo
   * que restou após o clear de tela. Os dois juntos ⇒ tela REALMENTE limpa.
   */
  // F58 — a ordem `H;2J;3J` (cursor home ANTES do clear) tem o mesmo efeito visual
  // que `2J;3J;H` mas NÃO casa com o prefixo `CLEAR_TERMINAL` do overwriteInPlace
  // (synchronized-output.ts). Assim o clearScreen não é interceptado pelo transform
  // anti-flicker e o scrollback é REALMENTE limpo — sem acumular conteúdo fantasma a
  // cada restart de sessão.
  const clearScreen = useCallback((): void => {
    // F-FLICKER (debug) — este é o "carrega TUDO de novo": limpa a tela + remonta o
    // <Static> (re-emite o histórico inteiro). Se isto dispara ao abrir `/`, achamos o bug.
    debugRenderLog('clearScreen() → \\x1b[2J\\x1b[3J + staticKey++ (REEMITE histórico)');
    stdout?.write('\x1b[H\x1b[2J\x1b[3J');
    setStaticKey((k) => k + 1);
  }, [stdout]);

  // EST-0983 — entrega o `clearScreen` ao WIRING (que decide QUANDO a sessão zera —
  // `/clear` sempre; `/clear full` só na confirmação; `/clear memory` nunca). Registro
  // 1× (a identidade do callback é estável: só depende do `stdout`, fixo na sessão).
  const registerClearScreen = props.registerClearScreen;
  useEffect(() => {
    registerClearScreen?.(clearScreen);
  }, [registerClearScreen, clearScreen]);

  // F-FLICKER (debug) — correlaciona o toggle do slash-menu com os repaints acima.
  // Se o log mostra `slashOpen=true` seguido de `resize`/`clearScreen`, então abrir `/`
  // dispara o "carrega tudo" (provável reflow do conhost). Se NÃO há resize/clearScreen
  // junto, o flicker é do overflow da viva (orçamento) — outro caminho.
  useEffect(() => {
    debugRenderLog(`slashOpen=${slashOpen} (rows=${rows} cols=${columns})`);
  }, [slashOpen, rows, columns]);

  // EST-1015 — RESIZE no modo INLINE: REPAINT LIMPO ao redimensionar ───────────────
  // O `log-update` do Ink só apaga `previousLineCount` linhas antes de re-pintar; ao
  // redimensionar, o REFLOW do terminal re-quebra as linhas já pintadas numa largura
  // diferente e a conta de apagar fica errada ⇒ divisores/linhas de larguras ANTIGAS
  // ficam ÓRFÃOS na tela ("tela quebra ao redimensionar"): um divisor de 60 col sobra
  // acima do frame de 120, fragmentos colam no composer, etc. O COCKPIT já trata isso
  // pelo differ (P1/P2-D acima, full-paint na dimensão nova); o INLINE não tinha nada.
  // Aqui forçamos um repaint limpo (`clearScreen` = `\x1b[2J\x1b[3J\x1b[H` + remontar o
  // <Static>) DEPOIS que o resize ASSENTA — debounce ~90ms p/ NÃO re-emitir o histórico
  // a cada tick enquanto o usuário ARRASTA a janela (1 clear no fim, não N). Só vale no
  // inline: em fullscreen o effect de cockpit cuida (e clearScreen brigaria com o
  // alt-screen). Ref semeada com a dimensão do mount ⇒ não dispara um clear no 1º render.
  const inlineResizeDimRef = useRef<{ rows: number; columns: number }>({ rows, columns });
  useEffect(() => {
    if (fullscreen) {
      // Em cockpit o differ trata o resize; só sincroniza a ref p/ a 1ª volta ao inline
      // não disparar um clear espúrio por "mudança" que aconteceu enquanto estava cheio.
      inlineResizeDimRef.current = { rows, columns };
      return;
    }
    const prev = inlineResizeDimRef.current;
    if (prev.rows === rows && prev.columns === columns) return; // sem mudança real
    // F-FLICKER (debug) — mudança de DIMENSÃO detectada. No Windows o conhost pode
    // reportar dims diferentes ao escrever output pesado (reflow) ⇒ dispara clearScreen
    // ESPÚRIO. Se isto loga sem o usuário redimensionar, é a causa do flicker "milenar".
    debugRenderLog(
      `resize ${prev.rows}x${prev.columns} → ${rows}x${columns} (clearScreen em 90ms)`,
    );
    inlineResizeDimRef.current = { rows, columns };
    // RESIZE-FIX — clear no trailing-edge (1 clear quando o DRAG assenta, não N durante o arraste:
    // o clear imediato-por-tick reintroduzia flicker de arraste). O conserto do "gap que CRESCE ao
    // digitar" é o `composerOverflow` no orçamento (acima): sem estourar `rows`, o Ink não cai no
    // `clearTerminal` que dessincroniza o `previousLineCount` — então este clear pós-assento basta.
    const id = setTimeout(() => clearScreen(), 90);
    return () => clearTimeout(id); // novo resize antes de 90ms ⇒ recancela (trailing-edge)
  }, [rows, columns, fullscreen, clearScreen]);

  /**
   * EST-0962 — executa um slash-command. `/model` SEM argumento abre o SELETOR de
   * tiers (picker) quando há catálogo+handler injetados; `/model <tier>` LITERAL e
   * todos os demais comandos seguem p/ o `onCommand` (nota/efeito do wiring). Assim
   * o seletor reusa a mecânica do menu sem duplicar o roteamento.
   */
  // EST-0990 — TOGGLE do MODO VIEW AVANÇADO (Ctrl+L / /split). Liga/desliga o split,
  // PERSISTE a preferência (best-effort — `onSplitViewChange`), e ao DESLIGAR devolve o
  // foco ao chat (sem deixar o foco órfão no log que sumiu). Memoizado p/ reuso pelo
  // atalho (Ctrl+L), pelo comando nativo `/split` e pela command palette.
  const toggleSplit = useCallback(() => {
    setSplitView((on) => {
      const next = !on;
      props.onSplitViewChange?.(next);
      if (!next) {
        setLogFocus(false);
        setTabsActive('chat');
      }
      return next;
    });
  }, [props]);

  // EST-1000 · ADR-0076 §1/§2 — TOGGLE do MODO COCKPIT (`/fullscreen`/`/cockpit`). Liga/
  // desliga o cockpit, dispara o alt-screen REAL (enter/leave do wiring), PERSISTE a
  // preferência (best-effort) e empurra uma nota honesta. Se a tela é estreita/baixa
  // demais (ADR §6), `resolveCockpitLayout` recusa: ligar o `fullscreen` ainda grava o
  // estado, mas o render CAI no inline com o aviso (cockpitActive=false) — não prende o
  // alt-screen (só chamamos enter() quando o layout CABE).
  const toggleFullscreen = useCallback(() => {
    // Tela cheia (cockpit, `/fullscreen`/`/cockpit`) DESATIVADA p/ o usuário nesta versão —
    // a experiência ainda não está boa o bastante (decisão do dono). O comando só AVISA e
    // seguimos no inline. O CÓDIGO do cockpit segue intacto e testável via o escape hatch
    // `ALUY_FULLSCREEN=1` (QA/testes e p/ religar a feature quando voltar). O boot também
    // ignora `--fullscreen`/`ui.fullscreen` sem o env (ver run.tsx).
    if (process.env.ALUY_FULLSCREEN !== '1') {
      controller.replaceNote('fullscreen', [
        'O modo tela cheia (/fullscreen) está desativado nesta versão — ainda em ajustes.',
        'A sessão continua no modo inline (o padrão), que é o recomendado.',
      ]);
      return;
    }
    setFullscreen((on) => {
      const next = !on;
      const fits = resolveCockpitLayout(rows, columns).kind === 'cockpit';
      if (next && fits) {
        // ENTRA no alt-screen só quando cabe — senão degrada pro inline com aviso.
        props.cockpitScreen?.enter();
        controller.replaceNote('cockpit', [t('cockpit.entered')]);
      } else if (next && !fits) {
        const reason = resolveCockpitLayout(rows, columns);
        const msg =
          reason.kind === 'refuse' && reason.reason === 'narrow'
            ? t('cockpit.refuseNarrow')
            : t('cockpit.refuseShort');
        controller.replaceNote('cockpit', [msg]);
      } else {
        // SAI do cockpit: restaura a tela primária (?1049l) e volta ao inline.
        props.cockpitScreen?.leave();
        clearScreen();
        controller.replaceNote('cockpit', [t('cockpit.left')]);
      }
      props.onFullscreenChange?.(next);
      return next;
    });
    setCockpitFocus('conversa');
    setConversaScroll(0);
    setLogScroll(0);
  }, [props, controller, t, rows, columns, clearScreen]);

  const runCommand = useCallback(
    (command: SlashCommand, args: string) => {
      // EST-0990 — `/split` (alias `/view`): alterna o MODO VIEW AVANÇADO na hora
      // (mesmo efeito do Ctrl+L). É UI pura — não toca o turno/contexto; não vai ao
      // onCommand (sem nota redundante do wiring).
      if (command.id === 'split') {
        toggleSplit();
        return;
      }
      // EST-1000 · ADR-0076 — `/fullscreen` (alias `/cockpit`): alterna o MODO COCKPIT
      // na hora (alt-screen + 6 regiões). UI pura — não toca turno/contexto; não vai ao
      // onCommand. Só em TTY que cabe (ADR §6: senão a nota de recusa, fica no inline).
      if (command.id === 'fullscreen') {
        toggleFullscreen();
        return;
      }
      if (
        command.id === 'model' &&
        args.trim() === '' &&
        props.catalog !== undefined &&
        props.onSelectTier !== undefined
      ) {
        modelPicker.openPicker();
        return;
      }
      // EST-0968 — `/permissions` abre o PAINEL interativo quando há controle da
      // catraca injetado; sem ele, cai p/ a nota informativa (onCommand). O painel
      // só muda o que é SEGURO (CLI-SEC-3); nunca relaxa categoria sempre-ask.
      if (command.id === 'permissions' && props.permissionControl !== undefined) {
        permPanel.openPanel();
        return;
      }
      // EST-0972 — `/history` SEM arg abre o PICKER de sessões anteriores (quando há
      // store + handler de retomada injetados). Com arg (`/history <id>`): retoma
      // DIRETO aquele id (atalho — mesmo caminho do enter no picker). Sem store/handler,
      // cai p/ a nota informativa (onCommand). Reusa o resume, não duplica.
      if (
        command.id === 'history' &&
        props.sessionStore !== undefined &&
        props.onResumeSession !== undefined
      ) {
        const arg = args.trim();
        if (arg === '') {
          historyPicker.openPicker();
          return;
        }
        // LIMPEZA VISUAL antes de retomar: a transcrição antiga substitui a corrente
        // (some o lixo já commitado no `<Static>`) — só a App tem stdout + key do
        // Static. Depois o wiring restaura os blocos + semeia o contexto.
        clearScreen();
        props.onResumeSession(arg);
        return;
      }
      // EST-XXXX — `/rewind` abre o seletor de CHECKPOINTS (igual ao atalho Esc-Esc),
      // quando há fonte de checkpoints + handler de aplicação injetados. Sem eles, cai
      // p/ a nota informativa (onCommand). UI pura — não toca turno/contexto aqui.
      if (
        command.id === 'rewind' &&
        props.rewindSource !== undefined &&
        props.onRewind !== undefined
      ) {
        rewindPicker.openPicker();
        return;
      }
      // EST-0966 — `/theme`: SEM arg abre o PICKER (quando há handler de troca). Com
      // arg (`/theme light`): se casa um tema, troca DIRETO via onSelectTheme (mesmo
      // caminho do picker — re-render com a paleta nova); se não casa, cai p/ o
      // onCommand (nota honesta de "tema desconhecido"). Reusa o picker, não duplica.
      if (command.id === 'theme' && props.onSelectTheme !== undefined) {
        const arg = args.trim();
        if (arg === '') {
          themePicker.openPicker();
          return;
        }
        const entry = resolveThemeName(arg);
        if (entry) {
          props.onSelectTheme(entry.name);
          return;
        }
        // nome inválido ⇒ deixa o wiring empurrar a nota honesta.
      }
      // EST-0989 (i18n) — `/lang`: SEM arg abre o PICKER (quando há handler de troca).
      // Com arg (`/lang en`): se casa um idioma, troca DIRETO via onSelectLang (mesmo
      // caminho do picker — re-render no novo idioma + persiste); se não casa, cai p/ o
      // onCommand (nota honesta de "idioma desconhecido"). Espelha o /theme.
      if (command.id === 'lang' && props.onSelectLang !== undefined) {
        const arg = args.trim();
        if (arg === '') {
          langPicker.openPicker();
          return;
        }
        const entry = resolveLang(arg);
        if (entry) {
          props.onSelectLang(entry.code);
          return;
        }
        // código inválido ⇒ deixa o wiring empurrar a nota honesta.
      }
      // EST-0962 (/provider) — `/provider`: SEM arg abre o PICKER (quando há handler de
      // troca). Com arg (`/provider deepseek`): se casa um provider, seta DIRETO via
      // onSelectProvider (mesmo caminho do picker); se não casa, cai p/ o onCommand (nota
      // honesta de "provider desconhecido"). Espelha o /theme//lang. Reusa o picker.
      if (command.id === 'provider' && props.onSelectProvider !== undefined) {
        const arg = args.trim();
        if (arg === '') {
          providerPicker.openPicker();
          return;
        }
        // Casa contra a lista CARREGADA do picker (viva do broker quando já abriu uma vez,
        // senão o fallback estático) — assim `/provider tokenrouter` resolve mesmo fora do
        // seed. Nome inválido ⇒ cai p/ o onCommand (nota honesta de "desconhecido").
        const entry = resolveProviderName(arg, providerPicker.providers);
        if (entry) {
          props.onSelectProvider(entry.name);
          return;
        }
        // nome inválido ⇒ deixa o wiring empurrar a nota honesta.
      }
      // EST-0948/EST-0983 (composer/sessão) — `/clear`: a LIMPEZA VISUAL do terminal
      // (clear de tela+scrollback + remonta o `<Static>`) é da App (só ela tem o stdout
      // + a key do Static). Mas ela só ocorre quando a SESSÃO de fato zera — e isso passou
      // a depender do SUBcomando (`/clear` = sempre; `/clear full` = só na confirmação;
      // `/clear memory` = NUNCA, só apaga a memória). Quem sabe disso é o wiring (tem a
      // memória + o estado da confirmação): ele chama `clearScreen` via `registerClearScreen`
      // QUANDO a sessão realmente limpa. Aqui só roteamos ao onCommand — sem wipe prematuro
      // (a confirmação do `/clear full` precisa ficar VISÍVEL na tela).
      props.onCommand?.(command, args);
    },
    [
      props,
      modelPicker,
      permPanel,
      themePicker,
      langPicker,
      providerPicker,
      historyPicker,
      rewindPicker,
      clearScreen,
      toggleSplit,
    ],
  );

  /**
   * EST-0961 — executa o item confirmado na palette. Slash-command ⇒ MESMO
   * caminho do menu (`runCommand`, sem args — abre o picker do /model//theme se
   * couber). Ação pura ⇒ dispara o efeito correspondente (hoje só `cycle-mode`,
   * o que o Tab faz). Reusa o roteamento; não duplica a execução.
   */
  const executePaletteHit = useCallback(
    (hit: PaletteHit) => {
      if (hit.action.kind === 'command') {
        runCommand(hit.action.command, '');
        return;
      }
      if (hit.action.actionId === 'cycle-mode') {
        controller.cycleMode();
      }
    },
    [runCommand, controller],
  );

  const submit = useCallback(
    (line: string) => {
      const route = routeInput(line, userCommands);
      if (route.kind === 'goal') {
        // EST-0957 — leva os arquivos anexados (chips) como DADO rotulado/confinado
        // (CLI-SEC-4): observations semeadas ANTES do objetivo. Exige um objetivo
        // de texto (o anexo sozinho não é um pedido); limpa os chips após enviar.
        if (route.text !== '') {
          // ── EST-0982 (P1-3) — `@anexo` DIGITADO MID-TURN não vira TEXTO MORTO ──────
          // Bug do dono: no ramo de TRABALHO (thinking/streaming/retrying) a edição NÃO
          // chama `syncPicker` (só o idle) ⇒ digitar `@auth/session` durante o turno NÃO
          // abre o FilePicker nem vira chip; a linha ENFILEIRA com o `@` LITERAL e, ao
          // drenar, caía aqui como `goal` cru com o `@` inútil (o usuário PENSA que
          // anexou; anexou texto morto). FIX de menor blast-radius: aqui, no SUBMIT (a
          // via comum do idle E do dreno da fila), se o texto AINDA carrega `@mention`s
          // plausíveis (o idle já as teria resolvido via picker ⇒ não sobram), nós as
          // RESOLVEMOS pelo MESMO `AttachReader` confinado/path-deny do fallback NÃO-TTY
          // (`resolveLinearMentions` — parse + confina + STRIP do texto). O `@` passa a
          // ANEXAR DE VERDADE quando a fila drena (DADO rotulado, não texto cru), sem
          // abrir o picker mid-turn. Sem menções, é o caminho de antes (zero custo).
          if (parseAtMentions(route.text).length > 0 && props.attachReader) {
            const beforeChips = picker.attachments.map((a) => a.item);
            void resolveLinearMentions(route.text, props.attachReader).then(
              ({ goal, items: resolved }) => {
                // STRIP pode esvaziar o texto (a linha era só `@arquivo`): preservamos a
                // regra "anexo sozinho NÃO é pedido" — sem goal E sem nada resolvido, não
                // submete. Com anexo resolvido mas goal vazio, mandamos o texto original
                // (ainda carrega a intenção `@…`) como objetivo, com o DADO rotulado.
                if (goal === '' && resolved.length === 0) {
                  picker.clear();
                  return;
                }
                const items = [...beforeChips, ...resolved];
                const outGoal = goal !== '' ? goal : route.text;
                setHistory((h) => [...h, outGoal]);
                void controller.submit(outGoal, items);
                picker.clear();
              },
            );
            return;
          }
          const items = picker.attachments.map((a) => a.item);
          setHistory((h) => [...h, route.text]);
          void controller.submit(route.text, items);
          picker.clear();
        }
        return;
      }
      if (route.kind === 'command') {
        runCommand(route.command, route.args);
        return;
      }
      // EST-0958 — `!comando`: roda o atalho de shell ATRÁS DA CATRACA (mesma do
      // run_command). Vai p/ o histórico de inputs (↑↓) como qualquer entrada do
      // composer. O controller avalia/executa; a saída vira um bloco de saída.
      if (route.kind === 'bang') {
        setHistory((h) => [...h, `!${route.command}`]);
        void controller.runBang(route.command);
        return;
      }
      // unknown-command: ignora silenciosamente (o menu já guia o usuário).
    },
    [controller, userCommands, picker, runCommand, props.attachReader],
  );

  // ── EST-0982 (type-ahead mid-turn) — ENFILEIRAR vs ENCAIXAR uma linha do composer ──
  // O bug (reportado pelo dono): com um turno/ciclo VIVO, uma linha de TEXTO PURO digitada
  // e dada com Enter ia p/ a fila e só era consumida no REPOUSO real — em `/cycle` isso é
  // "só no fim de TODOS os ciclos" (`queueAtRest` segura por `cycleActive`). Mas texto puro
  // é CONTEXTO, não AÇÃO: pertence ao MESMO turno vivo. Aqui decidimos por linha:
  //   • TEXTO PURO (rota `goal`) E SEM anexos `@` pendentes ⇒ ENCAIXA AGORA no agente vivo
  //     (`injectInput('root', …)`): o controller já roteia p/ a fila VIVA (`liveInjected`)
  //     quando o turno está vivo, drenada pelo loop ENTRE iterações (`pollInjected`) ANTES
  //     da próxima chamada do modelo — incorporado MID-TURN como `user_inject` (canal `user`
  //     confiável, CLI-SEC-4; um efeito derivado RE-PASSA `decide()` — catraca intocada).
  //     Reusa auditoria (CLI-SEC-10), eco REDIGIDO (CLI-SEC-6) e a nota "↳ encaixado". NÃO é
  //     submit ⇒ NÃO cria turno concorrente nem gasto dobrado (a guarda anti-colisão EST-0981
  //     vale só p/ SUBMIT). Se o turno estiver PARADO (idle/done), o `injectInput` cai no
  //     `pendingInjected` (re-semeado no próximo submit) — comportamento atual preservado.
  //   • `/slash` (command/unknown) · `!bang` · TEXTO PURO COM anexos `@` pendentes ⇒ é AÇÃO/
  //     comando (precisa de `submit`/`routeInput` p/ rotear slash/bang/anexar) ⇒ ENFILEIRA
  //     como "próximo objetivo" (segurado até o repouso real). NÃO injeta comando como contexto.
  // Devolve `true` se ENCAIXOU mid-turn (a linha já foi consumida); `false` se ENFILEIROU
  // (o caller faz o `setQueue`). A UI de staging (`<QueuedInputs>`) só guarda os enfileirados.
  const injectIfPlainText = useCallback(
    (line: string): boolean => {
      const route = routeInput(line, userCommands);
      // Só TEXTO PURO (objetivo) e SEM anexos `@` pendentes vira contexto mid-turn. Anexos
      // pendentes precisam viajar como DADO rotulado pelo `submit` (CLI-SEC-4) ⇒ enfileira.
      // EST-0982 (P1-3) — o anexo `@` pode estar PENDENTE de DUAS formas: (1) como CHIP já
      // confirmado (`picker.attachments`), ou (2) como `@mention` LITERAL no texto, digitada
      // no ramo de TRABALHO (que NÃO tem `syncPicker`, então o `@` nunca virou chip). Em
      // AMBAS, encaixar como texto puro (`injectInput`) injetaria o `@` CRU = TEXTO MORTO (o
      // injectInput não resolve `@`). Forçamos o ENFILEIRAMENTO: ao drenar, o `submit`
      // resolve a menção pelo `AttachReader` confinado (DADO rotulado), igual ao fallback
      // não-TTY. Sem menção e sem chip, segue o encaixe mid-turn normal (texto é contexto).
      if (
        route.kind !== 'goal' ||
        route.text === '' ||
        picker.attachments.length > 0 ||
        parseAtMentions(route.text).length > 0
      ) {
        return false;
      }
      // `injectInput('root', …)`: VIVO ⇒ fila viva (mid-turn); PARADO ⇒ `pendingInjected`.
      return controller.injectInput('root', route.text);
    },
    [controller, userCommands, picker],
  );

  // ── EST-0982 · ADR-0080 — COMANDO PARALELO-SEGURO mid-turn: roda JÁ, não enfileira ──
  // Bug do dono (dogfood): o `/ask` (pergunta PARALELA read-only — ADR-0080) caía no
  // `setQueue` como qualquer `/slash` durante o trabalho e só era respondido AO FIM do
  // turno — matando o propósito dele (responder AGORA, em paralelo). Aqui, ANTES de
  // enfileirar, detectamos comandos marcados `parallelWhileBusy` (hoje só o `/ask`) e os
  // EXECUTAMOS pelo MESMO caminho do idle (`runCommand` ⇒ `controller.askParallel` no
  // wiring): caller PRÓPRIO read-only, fire-and-forget, sem tocar o loop/histórico/catraca
  // do turno vivo. Comandos que MUTAM (compact/model/clear/…) NÃO são marcados ⇒ seguem
  // enfileirando (rodar mid-turn quebraria o turno). Espelha `injectIfPlainText`: devolve
  // `true` se EXECUTOU (a linha já foi consumida); `false` se não é paralelo-seguro (o
  // caller faz o `setQueue` de sempre).
  const runIfParallelCommand = useCallback(
    (line: string): boolean => {
      const route = routeInput(line, userCommands);
      if (route.kind !== 'command' || !isParallelWhileBusy(route.command, route.args)) return false;
      runCommand(route.command, route.args);
      return true;
    },
    [userCommands, runCommand],
  );

  // ── EST-0982 (P0-1) — PRESERVA A ORDEM DIGITADA: encaixe mid-turn SÓ com a fila vazia ──
  // Bug do dono: `/compact` (Enter) e DEPOIS `texto tardio` (Enter). O `/compact` enfileira
  // (mutador, drena no repouso); o texto puro, pela via do ENCAIXE (injectInput) ou do
  // PARALELO, era incorporado AGORA — FURANDO o `/compact` que veio ANTES. `pendingInjects`/
  // fila-viva e a `queue` são filas paralelas que drenam em tempos diferentes ⇒ inversão.
  // REGRA: se a `queue` JÁ tem itens, QUALQUER linha nova ENFILEIRA (ordem global FIFO
  // respeitada). SÓ com a fila VAZIA o texto puro encaixa mid-turn (#253/#265) e o comando
  // paralelo-seguro (#271) roda já. `@`-anexos/`/slash` mutador/`!bang` sempre enfileiram
  // (via `injectIfPlainText`/`runIfParallelCommand` devolverem `false`).
  const enqueueOrInject = useCallback(
    (line: string): void => {
      // Fila NÃO-vazia ⇒ preserva a ordem: enfileira sem tentar encaixar/paralelizar.
      if (queueRef.current.length > 0) {
        enqueue(line);
        return;
      }
      // DECISÃO DO DONO — texto puro do composer é PEDIDO AO AGENTE PRINCIPAL, sempre. Com
      // SUB-AGENTES RODANDO o pai está BLOQUEADO os aguardando, então o pedido vai pra FILA (e
      // processa quando o pai voltar) — NÃO vira `/ask` automático. O canal lateral (`/ask`,
      // resposta paralela read-only) é OPT-IN explícito: só quando você digita `/ask`. Assim a
      // fila só tem o que você manda como pedido real; o `/ask` é uma pergunta lateral separada.
      // (Antes, EST-1015 transformava texto puro em askParallel — confundia "meu pedido sumiu".)
      const route = routeInput(line, userCommands);
      const goalText = route.kind === 'goal' ? route.text : '';
      if (
        answerInParallelWhileSubagents({
          subagentsRunning: subAgentsRunning(controller.current.blocks),
          isPlainGoal: route.kind === 'goal',
          nonEmpty: goalText !== '',
          hasPendingAttachment:
            picker.attachments.length > 0 ||
            (goalText !== '' && parseAtMentions(goalText).length > 0),
        })
      ) {
        // INJETA no turno do agente principal (drena na PRÓXIMA iteração, indicador "encaixando…")
        // — NÃO enfileira. A fila (`queueAtRest`) só drena em REPOUSO = fim de TODO o ciclo, o que
        // demora demais (achado do dono: "a fila só libera quando termina tudo"). Inject vai pro
        // agente principal e é incorporado bem antes — quando o pai retoma após os sub-agentes.
        injectIfPlainText(line);
        return;
      }
      // Fila vazia ⇒ encaixe mid-turn (texto puro) / paralelo-seguro / senão enfileira.
      if (!injectIfPlainText(line) && !runIfParallelCommand(line)) enqueue(line);
    },
    [enqueue, injectIfPlainText, runIfParallelCommand, controller, userCommands, picker],
  );

  // ── EST-0948 — BRACKETED PASTE: cola MULTI-LINHA vira newline LITERAL (não submit) ──
  // O bug do dogfood: colar um bloco multi-linha submetia na 1ª `\n` e descartava o
  // resto. Com o `?2004` ligado (run.tsx), o terminal envelopa o colado em
  // `\x1b[200~`…`\x1b[201~`. Aqui detectamos os marcadores NO CANAL CRU (`'data'`, o
  // mesmo do F8) com uma MÁQUINA que bufferiza paste cruzando chunks, e INSERIMOS o
  // conteúdo LITERAL na posição do cursor — `\n`/`\r` viram newline (multi-linha), NUNCA
  // Enter/submit. O conteúdo já vem normalizado (`\r\n`→`\n`, control chars perigosos
  // removidos) da máquina. Inserimos pela MESMA `insertAt` das funções puras do composer.
  const pasteMachineRef = useRef<ReturnType<typeof createBracketedPasteMachine>>();
  if (!pasteMachineRef.current) pasteMachineRef.current = createBracketedPasteMachine();
  // EST-PASTE-COLLAPSE — REGISTRO de pastes COLAPSADOS desta sessão de composição: id →
  // conteúdo COMPLETO. Um paste GRANDE (≥6 linhas ou >800 chars) vira um CHIP textual
  // `[texto colado #N, +L linhas]` no buffer e o conteúdo cheio fica AQUI, expandido de
  // volta no submit. O ref persiste entre renders; `reset()` ao limpar/submeter o composer.
  const pasteRegistryRef = useRef<PasteRegistry>();
  if (!pasteRegistryRef.current) pasteRegistryRef.current = createPasteRegistry();
  // EST-PASTE-COLLAPSE — EXPANDE os chips do `line` no conteúdo COMPLETO e ESVAZIA o registro
  // (uma sessão de composição termina ao submeter/enfileirar/encaixar a linha). FONTE ÚNICA
  // p/ todos os caminhos de saída do composer (Enter limpo, Enter em lote, type-ahead).
  const expandAndReset = useCallback((line: string): string => {
    const out = expandPastes(line, pasteRegistryRef.current!);
    pasteRegistryRef.current!.reset();
    return out;
  }, []);
  // EST-PASTE-COLLAPSE — apaga ATÔMICO um chip na borda do cursor; senão `deleteBackward`
  // normal. FONTE ÚNICA do backspace/delete do composer (idle E type-ahead). Devolve o novo
  // estado já com o ref do chip esquecido.
  const composerDeleteBackward = useCallback((c: EditState): EditState => {
    const chip = deleteChipAt(c, pasteRegistryRef.current!, 'backward');
    if (chip.handled) {
      if (chip.removedId !== undefined) pasteRegistryRef.current!.remove(chip.removedId);
      return chip.state;
    }
    return deleteBackward(c);
  }, []);
  // O `useInput` consulta o gate abaixo p/ NÃO reprocessar os bytes do paste (o `char`
  // mangled que o Ink lhe entrega): enquanto um paste está ABERTO, o composer é alimentado
  // SÓ pelo canal cru. O gate rastreia o paste pelos VESTÍGIOS dos marcadores no próprio
  // `char` do `useInput` ⇒ funciona em qualquer ordem de evento ('data' vs 'readable').
  const inputPasteGateRef = useRef<InputPasteGate>({ open: false });
  const insertPaste = useCallback(
    (text: string): void => {
      if (text === '') return;
      // Cola durante o splash: dispensa o boot (o usuário já está compondo) e segue.
      if (controller.current.phase === 'boot') controller.dismissBoot();
      picker.dismissNotice();
      // EST-PASTE-COLLAPSE — paste GRANDE (≥6 linhas OU >800 chars) COLAPSA num CHIP textual
      // no cursor; o conteúdo cheio vai pro registro e é expandido no submit. Paste pequeno
      // segue INLINE (literal), exatamente como antes — nada muda no caso comum. SÓ o
      // marcador de bracketed paste chega aqui (a máquina), então não há heurística de "muitas
      // linhas digitadas" — degradação sem bracketed paste preserva o comportamento atual.
      const collapse = shouldCollapse(text);
      setComposer((c) => {
        const next = collapse
          ? makePasteChip(c, text, pasteRegistryRef.current!)
          : insertAt(c, text);
        syncSlashMenu(next.text);
        syncPicker(next.text);
        return next;
      });
      setHistIdx(-1);
    },
    [controller, picker, syncSlashMenu],
  );
  useEffect(() => {
    if (!stdin) return;
    const machine = pasteMachineRef.current!;
    const onPasteData = (data: Buffer | string): void => {
      const s = typeof data === 'string' ? data : data.toString('utf8');
      // Atalho: fora de paste E sem nenhum vestígio de marcador ⇒ nada a fazer (o
      // `useInput` trata a digitação normal). `\x1b[20` cobre tanto `\x1b[200~` (início)
      // quanto `\x1b[201~` (fim), inclusive CORTADOS no fim do chunk — é o prefixo comum
      // dos dois marcadores. Evita varrer todo chunk de tecla na máquina.
      if (!machine.isInPaste() && !s.includes('\x1b[20')) return;
      const events: PasteEvent[] = machine.feed(s);
      for (const ev of events) {
        if (ev.kind === 'paste') insertPaste(ev.text);
        // `passthrough` é tratado pelo `useInput` (canal normal) — aqui não fazemos nada.
      }
    };
    stdin.on('data', onPasteData);
    return () => {
      stdin.removeListener('data', onPasteData);
    };
  }, [stdin, insertPaste]);

  // EST-0982 (type-ahead) — AUTO-SUBMIT da fila. Quando o turno TERMINA (fase vira
  // `idle`/`done`) e há mensagem(ns) enfileirada(s), consome a 1ª como PRÓXIMO
  // objetivo: a remove da fila E a submete pela MESMA `submit` (rota igual ao Enter
  // limpo — objetivo/`/slash`/`!bang`). Submete UMA por vez: o `submit` leva a fase
  // de volta a `thinking`, então o efeito só re-dispara quando ESSE objetivo terminar
  // (a próxima da fila vira o seguinte) — ordem FIFO preservada, sem despejar tudo de
  // uma vez. `asking`/`budget` NÃO disparam (ainda é "trabalho"/decisão pendente);
  // `error` também não (o usuário decide retry/cancel). Só os estados de REPOUSO
  // (idle/done) liberam a próxima.
  //
  // EST-0981 · CLI-SEC-14 (guarda anti-colisão) — com um `/cycle` ATIVO a fila fica
  // SEGURADA mesmo se a fase repousar por um instante NO VÃO entre ciclos: disparar
  // ali criaria um turno CONCORRENTE ao ciclo (gasto dobrado, blocos intercalados).
  // `queueAtRest` (pura, em model.ts) exige idle/done E `cycleActive !== true`; quando
  // o ciclo TERMINA de verdade (fim/abort/erro), o controller limpa `cycleActive`, o
  // estado re-publica e este efeito re-roda — a fila re-tenta sozinha.
  // EST-0982 (P1-2) — o drain da fila é CEGO a overlays: abrir um picker NÃO muda a fase
  // (segue idle/done), então `queueAtRest` (só phase+cycleActive) seguia `true` sob um
  // overlay. Sem este gate, drenar um `/model`/`/theme`/`/history`/… ABRE o picker e, no
  // MESMO repouso, o PRÓXIMO item da fila JÁ submete → turno começa SOB o overlay; e drenar
  // um 2º `/model`/`/theme` com um picker já aberto EMPILHA pickers. Passamos `anyPickerOpen`
  // (todos os modais: file/model/perm/theme/lang/provider/history/palette) a `queueAtRest`:
  // a fila PAUSA enquanto há overlay e RE-TENTA quando ele fecha (fechar re-publica o estado
  // ⇒ este efeito re-roda). `slashOpen` NÃO entra (o menu de slash não é modal e já some no
  // submit). Mantém o FIFO e os freios EST-0981/CLI-SEC-14.
  const anyPickerOpen =
    picker.open ||
    modelPicker.open ||
    permPanel.open ||
    themePicker.open ||
    langPicker.open ||
    providerPicker.open ||
    historyPicker.open ||
    rewindPicker.open ||
    palette.open;
  const atRest = queueAtRest({ ...state, anyPickerOpen });
  useEffect(() => {
    if (!atRest || queue.length === 0) return;
    const next = queue[0] ?? '';
    // EST-0982 (P1-1) — `/clear` (qualquer variante: `/clear`, `/clear full`) DESCARTA o
    // RESTO da fila: o clear zera o contexto do controller, então itens enfileirados DEPOIS
    // dele re-semeariam o contexto recém-limpo (vazamento). A `queue` é estado LOCAL da App —
    // o `controller.clear()` não a toca; aqui, ao DRENAR o clear, esvaziamos a fila inteira
    // (o item drenado já saiu). Detecção pelo `id` roteado (cobre `/clear` e subs terminais).
    const route = routeInput(next, userCommands);
    if (route.kind === 'command' && route.command.id === 'clear') {
      clearQueue();
      submit(next);
      return;
    }
    setQueue((q) => q.slice(1));
    submit(next);
    // `submit` é estável o suficiente p/ o ciclo (memoizado); incluí-lo evita usar um
    // closure obsoleto. `atRest`/`queue` são as dependências reais do gatilho.
  }, [atRest, queue, submit, userCommands, clearQueue]);

  // DRENO MID-TURN (achado GRAVE do dono — "as mensagens na fila ficam infinitamente esperando o
  // turno acabar"). O efeito acima só drena a fila no REPOUSO TOTAL (e por `submit` = novo turno).
  // Aqui, enquanto há turno VIVO (thinking/streaming), drenamos os itens de TEXTO PURO da FRENTE
  // da fila INJETANDO-os no agente vivo (`injectInput` ⇒ processam na PRÓXIMA iteração do loop, não
  // no fim de TUDO). PARA no 1º item não-injetável (bang/slash/anexo) p/ PRESERVAR A ORDEM — esses
  // seguem esperando o repouso/submit. Assim "como está?" digitado durante o trabalho entra logo,
  // sem esperar o turno inteiro. (Limite honesto: se o pai está bloqueado num sub-agente/tool longo,
  // a próxima iteração — e o drain — só vem quando aquele efeito termina; é o mais cedo possível.)
  useEffect(() => {
    if (atRest || queue.length === 0) return;
    if (state.phase !== 'thinking' && state.phase !== 'streaming') return;
    let drained = 0;
    for (const item of queue) {
      if (!injectIfPlainText(item)) break; // bang/slash/anexo ⇒ para (ordem preservada)
      drained += 1;
    }
    if (drained > 0) setQueue((q) => q.slice(drained));
    // `injectIfPlainText` é memoizado; `atRest`/`queue`/`phase` são os gatilhos reais.
  }, [atRest, queue, state.phase, injectIfPlainText]);

  useInput((char, key) => {
    // ── EST-0948 — BRACKETED PASTE: SUPRIME os bytes do paste no `useInput` ──────────
    // Com o `?2004` ligado, o Ink entrega ao `useInput` o chunk do paste MANGLED (`[200~
    // …conteúdo…\x1b[201~`). O composer é alimentado pelo CANAL CRU (`onPasteData`, que
    // insere o conteúdo LITERAL multi-linha); o `useInput` NÃO pode reprocessar esses
    // bytes — senão o detector de lote (EST-0948) submeteria a 1ª linha do paste. O gate
    // rastreia o paste pelos marcadores no próprio `char` e suprime enquanto ABERTO.
    if (gateInputPaste(inputPasteGateRef.current, char)) return;

    // ── BUG-A (task #16) — VAZAMENTO de sequência de escape como TEXTO no composer ──
    // Um terminal que emita shift+enter via CSI-u (`\x1b[13;2u`, kitty) ou modifyOtherKeys
    // (`\x1b[27;2;13~`) SEM o aluy ter negociado o protocolo: o Ink engole o `\x1b` mas
    // entrega a CAUDA (`[13;2u` / `[27;2;13~`) como `char` ⇒ vazava como texto literal
    // (`› AAA[13;2uBBB●`). `isUnrecognizedEscapeTail` reconhece o corpo COMPLETO de uma
    // sequência CSI/SS3 (introdutor `[`/`O` + params + byte final) e a SUPRIME. Um `[`/`O`
    // DIGITADO sozinho (len 1, sem byte final) NÃO casa ⇒ a digitação normal segue intacta.
    // Roda DEPOIS do gate de paste (que já trata os marcadores `[200~`/`[201~`).
    if (isUnrecognizedEscapeTail(char)) return;

    // ── splash de boot: QUALQUER tecla dispensa (a sessão começou) ───────────
    if (state.phase === 'boot') {
      if (key.ctrl && char === 'c') {
        exit();
        return;
      }
      // EST-0948 — dispensar o boot NÃO pode ENGOLIR o input em lote. Em xrdp/SSH a
      // 1ª "tecla" pode ser o chunk inteiro (texto+Enter); o `dismissBoot()` + return
      // cego perdia tudo. Se o char traz CONTEÚDO real, dispensa o boot E re-processa:
      // - char com `\r`/`\n` embutido (lote) ⇒ submete a linha até a quebra agora
      //   (`submit` também dispensa o boot — ver controller.submit);
      // - char de texto puro (sem quebra) ⇒ semeia no composer (vira a 1ª digitação)
      //   para a próxima tecla/Enter continuar daí, sem perder o caractere.
      // Teclas "vazias" de controle (Enter limpo, setas, etc.) seguem só dispensando.
      if (char && !key.ctrl && !key.meta) {
        controller.dismissBoot();
        const nlIdx = char.search(/[\r\n]/);
        if (nlIdx !== -1) {
          submit(input + char.slice(0, nlIdx));
        } else {
          // Semeia o composer com o char digitado (boot → composer); o cursor vai p/
          // o FIM p/ a próxima tecla continuar daí (EST-0948 cursor). Updater funcional
          // (compõe sobre o estado anterior — robusto a teclas em lote no boot).
          setComposer((c) => {
            const text = c.text + char;
            setSlashOpen(isSlashMenuQuery(text, props.userCommands ?? []));
            return { text, cursor: text.length };
          });
        }
        return;
      }
      controller.dismissBoot();
      return;
    }

    // ── EST-1000 · ADR-0076 §4 — MODO COCKPIT: foco (Tab) + scroll próprio + export ──
    // Quando o cockpit está ATIVO, a captura de Tab/scroll/ctrl+s tem prioridade (sem
    // overlay aberto). Tab alterna conversa↔log; pgup/pgdn/↑↓ rolam a região FOCADA (sem
    // tocar o scrollback do terminal — que não existe em alt-screen). ctrl+s exporta.
    // `/fullscreen` (toggle de saída) é roteado pelo runCommand como qualquer slash.
    // OBS: só age se nenhum overlay modal está aberto (slash/picker/ask capturam antes,
    // abaixo) — mas no cockpit o composer/slash seguem funcionando: só interceptamos as
    // teclas de NAVEGAÇÃO DE REGIÃO, deixando a digitação cair no composer normalmente.
    if (cockpitActive && !slashOpen && !picker.open && !palette.open && state.phase !== 'asking') {
      // Tab — alterna o foco da região de scroll (conversa↔log).
      if (key.tab && !key.shift) {
        setCockpitFocus((f) => (f === 'conversa' ? 'log' : 'conversa'));
        return;
      }
      // ctrl+s — EXPORTA o transcript redigido (ADR §4 / RES-C-1). Async; nota ao concluir.
      if (key.ctrl && (char === 's' || char === '\x13')) {
        if (props.onExportTranscript) {
          void props.onExportTranscript().then((r) => {
            if (r.ok && r.path)
              controller.pushNote('export', [`${t('cockpit.exported')} ${r.path}`]);
            else controller.pushNote('export', [r.error ?? 'export indisponível']);
          });
        } else {
          controller.pushNote('export', ['export indisponível nesta sessão']);
        }
        return;
      }
      // SCROLL próprio da região FOCADA (pgup/pgdn/↑↓/home/end). Só intercepta as teclas
      // de scroll (NÃO chars) p/ a digitação seguir caindo no composer. O passo de página
      // usa a altura da própria região (viewport.scrollOffset).
      const layout = cockpitLayout.kind === 'cockpit' ? cockpitLayout : undefined;
      if (layout) {
        const scrollKey: ScrollKey | undefined = key.pageUp
          ? 'pageUp'
          : key.pageDown
            ? 'pageDown'
            : key.upArrow
              ? 'up'
              : key.downArrow
                ? 'down'
                : undefined;
        if (scrollKey !== undefined) {
          if (cockpitFocus === 'conversa') {
            const visible = Math.max(1, layout.regions.conversaRows - 1);
            setConversaScroll((s) => scrollOffset(scrollKey, s, state.blocks.length, visible));
          } else {
            const visible = Math.max(1, layout.regions.logRows - 1);
            setLogScroll((s) => scrollOffset(scrollKey, s, cockpitLogSections.length + 1, visible));
          }
          return;
        }
      }
      // ctrl+c — sair (igual ao inline): cai no handler global de ctrl+c abaixo (não
      // interceptamos aqui p/ não duplicar a semântica de duplo ctrl-c).
    }

    // ── EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG): toggle + foco + navegação ──
    // O Ctrl+T (painel de fluxos) tem prioridade quando ABERTO (modal por cima do
    // split): este bloco é inerte enquanto `flowOpen` (o modal captura tudo abaixo).
    // O Ctrl+L é GLOBAL (alterna o split em qualquer fase, sem interferir no turno).
    // Quando o log está FOCADO, captura as teclas de navegação/filtro ANTES do composer
    // (digitar com o log focado NÃO edita o composer); o `esc` devolve o foco ao chat
    // (1º esc), e só o 2º esc (já no chat) interrompe — sem matar o turno por engano.
    if (!flowOpen) {
      // Ctrl+L — TOGGLE do split (liga/desliga). Em TABS alterna a aba quando JÁ ligado
      // (mesma tecla do Tab, conforme a spec V2: `Tab`/`Ctrl+L` alterna no modo tabs).
      if (key.ctrl && char === 'l') {
        if (splitView && splitLayout === 'tabs') {
          setTabsActive((t) => (t === 'chat' ? 'log' : 'chat'));
          setLogFocus((f) => !f);
        } else {
          toggleSplit();
        }
        return;
      }

      // Tab — alterna o FOCO chat↔log (só quando o log está visível/coexistindo). Em
      // `tabs` o Tab TAMBÉM troca a aba ativa (não há lado-a-lado p/ focar). O rótulo do
      // painel focado fica em `accent` (passivo em `fgDim`) — SEM borda viva (anti-flicker).
      if (key.tab && !key.shift && logVisible) {
        if (splitLayout === 'tabs') {
          setTabsActive((t) => (t === 'chat' ? 'log' : 'chat'));
          setLogFocus((f) => !f);
        } else {
          setLogFocus((f) => !f);
        }
        return;
      }

      // FOCO NO LOG — captura navegação/filtros (NÃO edita o composer). `esc` 1º devolve
      // o foco ao chat (e o 2º esc, já no chat, segue p/ o interrupt de hoje).
      if (logFocused) {
        if (key.escape) {
          setLogFocus(false);
          return; // 1º esc: só devolve o foco (não interrompe o turno).
        }
        if (key.upArrow) {
          setLogScroll((s) => s + 1); // rola p/ CIMA na cauda (mostra mais antigo).
          return;
        }
        if (key.downArrow) {
          setLogScroll((s) => Math.max(0, s - 1)); // volta p/ a cauda (`▼ ao vivo`).
          return;
        }
        if (key.pageUp) {
          setLogScroll((s) => s + LOG_VISIBLE_ROWS);
          return;
        }
        if (key.pageDown) {
          setLogScroll((s) => Math.max(0, s - LOG_VISIBLE_ROWS));
          return;
        }
        // Enter — colapsa/expande a 1ª seção (V2: foco no log + Enter alterna). MVP:
        // alterna o COLAPSO da seção do `root` (a navegação por seção é incremento `s`).
        if (key.return) {
          setLogCollapsed((set) => {
            const next = new Set(set);
            if (next.has('root')) next.delete('root');
            else next.add('root');
            return next;
          });
          return;
        }
        // `e` — filtro só-erros (toggle). `t`/`s`/`a` = incremento (não capturam aqui).
        if (char === 'e' && !key.ctrl && !key.meta) {
          setLogErrorsOnly((v) => !v);
          return;
        }
        // Qualquer OUTRA tecla com o log focado é ENGOLIDA (não vaza p/ o composer) —
        // exceto Ctrl-C (sai) e Ctrl+T (painel), tratados nos ramos próprios abaixo.
        if (!(key.ctrl && char === 'c') && !(key.ctrl && char === 't')) {
          return;
        }
      }
    }

    // ── EST-0982 · ADR-0063 — PAINEL DE FLUXOS captura o foco (VER/PARAR/INTERAGIR) ──
    // Modal: enquanto aberto, ↑↓ navega · enter: drill-in · p: parar este · P: parar
    // todos · i: interagir · esc: fecha (ou volta do drill-in à árvore). A árvore vem
    // do controller (FlowTree); aqui só captura tecla → chama o verbo do controller.
    if (flowOpen) {
      // DRILL-IN aberto: esc/enter volta à árvore; p para este; i interage.
      if (flowDrill) {
        if (key.escape || key.return) {
          setFlowDrill(null);
          return;
        }
        if (char === 'p') {
          controller.cancelFlow(flowDrill);
          return;
        }
        if (char === 'i') {
          // INTERAGIR: o input do composer (se houver) é injetado como DADO pela MESMA
          // catraca (RES-C-2). Vazio ⇒ no-op (a UI plena de digitar-no-painel é evolução).
          if (input.trim() !== '') {
            controller.injectInput(flowDrill, input);
            setText('');
          }
          return;
        }
        return;
      }
      // OVERVIEW: navega/age sobre a árvore.
      const overview = controller.flowOverview();
      if (key.escape || (key.ctrl && char === 't')) {
        setFlowOpen(false);
        return;
      }
      if (key.upArrow) {
        setFlowSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setFlowSel((s) => Math.min(Math.max(0, overview.length - 1), s + 1));
        return;
      }
      if (key.return) {
        const node = overview[Math.min(flowSel, overview.length - 1)];
        if (node) setFlowDrill(node.id);
        return;
      }
      if (char === 'p') {
        const node = overview[Math.min(flowSel, overview.length - 1)];
        if (node) controller.cancelFlow(node.id);
        return;
      }
      if (char === 'P') {
        controller.cancelAllFlows();
        return;
      }
      if (char === 'i') {
        const node = overview[Math.min(flowSel, overview.length - 1)];
        if (node && input.trim() !== '') {
          controller.injectInput(node.id, input);
          setText('');
        }
        return;
      }
      return;
    }

    // ── ask pendente CAPTURA o foco (handoff §10 regra 3) ───────────────────
    if (state.phase === 'asking' && state.pendingAsk) {
      const alwaysAsk = state.pendingAsk.request.alwaysAsk;
      if (char === 'a') return controller.resolveAsk({ kind: 'approve-once' });
      if (char === 's' && alwaysAsk === false)
        return controller.resolveAsk({ kind: 'approve-session' });
      if (char === 'n')
        return controller.resolveAsk({ kind: 'deny', reason: 'negado pelo usuário' });
      if (key.escape) {
        // BUG #2/#13 (QA) — o modal "comia" o ESC (deny + return), então o handler principal
        // com double-ESC+interrupt NUNCA era alcançado: um `!cmd` de fundo (ex.: `!sleep 30`
        // já aprovado e rodando atrás deste modal) seguia VIVO; ele terminava DEPOIS do bloco
        // virar Static e a linha "rodando" ficava FANTASMA até um resize re-emitir (#13).
        //
        // BUG B (achado do dono) — REGRA EXPLÍCITA: "o ESC só pode parar se eu der ESC DEPOIS
        // de ter encaixado todas as msgs". Com uma msg JÁ na FILA, o double-ESC sob o ask
        // chamava interrupt()+clearQueue() ⇒ ABORTAVA O TRABALHO E LIMPAVA A FILA ("aborta
        // tudo"). Isso é PROIBIDO: o ESC sob ask com fila pendente cancela SÓ o ask — NUNCA
        // descarta a fila nem interrompe o turno. O hard-stop (double-ESC ⇒ interrupt+clear)
        // só vale quando a FILA JÁ ESTÁ VAZIA (nada a preservar): aí o double-ESC é o gesto
        // explícito de parar tudo (alinhado ao handler principal). Com fila não-vazia, o
        // single-ESC nega o ask e a fila SOBREVIVE (drena no repouso, como sempre).
        const now = Date.now();
        const hasQueue = queueRef.current.length > 0;
        const isDoubleEsc = now - lastEscRef.current < 500;
        controller.resolveAsk({ kind: 'deny', reason: 'cancelado (esc)' });
        // Só faz o hard-stop (interrupt + clear) quando NÃO há fila pendente. Com fila,
        // o double-ESC NÃO aborta nem limpa: a fila é a intenção do dono, preservada.
        if (isDoubleEsc && !hasQueue) {
          controller.interrupt();
          clearQueue();
        }
        // BUG B (vazamento entre handlers) — `lastEscRef` é COMPARTILHADO com o handler
        // principal. Se o deste ESC armasse o "double-ESC" (lastEscRef = now), o PRÓXIMO
        // ESC — que, após o deny, a fase já saiu de `asking` e cai no HANDLER PRINCIPAL —
        // seria lido como double-ESC e ABORTARIA + LIMPARIA a fila (o bug que o tmux
        // pegou). Com FILA pendente, NEGAR o ask é gesto ISOLADO: reseta o relógio (=0)
        // p/ o ESC seguinte ser um SINGLE-ESC fresco (caminho que PRESERVA a fila). Sem
        // fila, mantém o relógio armado p/ o double-ESC (hard-stop) seguir funcionando.
        lastEscRef.current = hasQueue ? 0 : now;
        return;
      }
      // `e` (editar) cai p/ deny em v1 (abrir $EDITOR é evolução; nunca executa por inação).
      if (char === 'e')
        return controller.resolveAsk({ kind: 'deny', reason: 'editar (não aplicado)' });
      return;
    }

    // ── EST-1110 · ADR-0114 — PERGUNTA pendente CAPTURA o foco ──────────────
    if (state.phase === 'questioning' && state.pendingQuestion) {
      const spec = state.pendingQuestion.spec;
      const options = spec.options ?? [];
      const allowOther = spec.kind !== 'text' && spec.allowOther !== false;

      // Cancelar (esc): sai da digitação livre PRIMEIRO; senão cancela a pergunta inteira.
      if (key.escape) {
        if (qEditing && spec.kind !== 'text') {
          setQEditing(false);
          setQDraft('');
          return;
        }
        return controller.resolveQuestion({ kind: 'unavailable', reason: 'cancelado (esc)' });
      }

      // Digitação da resposta LIVRE (campo `text` OU "Outro" de single/multi).
      if (qEditing) {
        if (key.return) {
          const text = qDraft.trim();
          if (text === '') return; // não confirma vazio
          return controller.resolveQuestion({ kind: 'text', text });
        }
        if (key.backspace || key.delete) {
          setQDraft((d) => d.slice(0, -1));
          return;
        }
        if (char && !key.ctrl && !key.meta) {
          setQDraft((d) => d + char);
          return;
        }
        return;
      }

      // single/multi: navegação da lista (a entrada "Outro" é a última, sob OTHER_INDEX).
      const lastReal = options.length - 1;
      if (key.upArrow) {
        setQCursor((c) => {
          if (c === OTHER_INDEX) return lastReal; // de "Outro" sobe p/ a última opção
          if (c <= 0) return allowOther ? OTHER_INDEX : lastReal; // wrap
          return c - 1;
        });
        return;
      }
      if (key.downArrow) {
        setQCursor((c) => {
          if (c === OTHER_INDEX) return 0; // wrap de "Outro" p/ a 1ª
          if (c >= lastReal) return allowOther ? OTHER_INDEX : 0;
          return c + 1;
        });
        return;
      }
      // multi: espaço alterna a opção sob o cursor (não vale p/ "Outro").
      if (spec.kind === 'multi' && char === ' ' && qCursor !== OTHER_INDEX && qCursor >= 0) {
        setQSelected((prev) => {
          const next = new Set(prev);
          if (next.has(qCursor)) next.delete(qCursor);
          else next.add(qCursor);
          return next;
        });
        return;
      }
      if (key.return) {
        // "Outro" sob o cursor ⇒ abre a digitação livre.
        if (qCursor === OTHER_INDEX) {
          setQEditing(true);
          return;
        }
        if (spec.kind === 'multi') {
          const indices = [...qSelected].sort((a, b) => a - b);
          const labels = indices.map((i) => options[i]?.label ?? '').filter((l) => l !== '');
          return controller.resolveQuestion({ kind: 'choices', indices, labels });
        }
        // single: confirma a opção sob o cursor.
        const opt = options[qCursor];
        if (opt)
          return controller.resolveQuestion({ kind: 'choice', index: qCursor, label: opt.label });
        return;
      }
      return;
    }

    // ── budget gate ──────────────────────────────────────────────────────────
    if (state.phase === 'budget') {
      if (char === 'n') return exit();
      // EST-0948 — `[c] continuar`: ESTENDE o teto (tokens+iterações) e RETOMA o MESMO
      // turno de onde pausou (async, como `[k] compactar`). Re-estourar ⇒ pausa de novo.
      if (char === 'c') {
        void controller.continueAfterBudget();
        return;
      }
      // EST-0973 — `[k] compactar`: resume o contexto e RETOMA o loop na hora, em vez
      // de só continuar/encerrar. Só oferecido quando há o que compactar (canCompact).
      if (char === 'k' && controller.canCompact) {
        void controller.compactAfterBudget();
        return;
      }
      return;
    }

    // ── ADR-0137 (Fatia 3) — gate do TETO do /cycle (juiz pediu continuar) ──────────
    // O teto duro bateu, mas o juiz sugeriu seguir. `[c]` estende um teto-worth e re-roda;
    // `[n]`/esc ENCERRA (C3 — default seguro). É decisão HUMANA consciente (o motivo do
    // juiz é DADO rotulado, não instrução).
    if (state.phase === 'cycle-ceiling') {
      // `n` OU Esc ENCERRA (C3 — default seguro; a tela promete ambos). Espelha os irmãos
      // `pendingUnsafeConfirm`/`stuck`. Sem a Esc aqui, ela ficava morta nesta fase (o
      // `return` abaixo engolia tudo) — contradizendo o contrato escrito no gate/controller.
      if (char === 'n' || key.escape) {
        controller.stopCycleCeiling();
        return;
      }
      if (char === 'c') {
        controller.continueCycleCeiling();
        return;
      }
      return;
    }

    // ── EST-1015 · ADR-0072 §3b (opção (c) do dono) — CONFIRMAÇÃO de Tab→YOLO ──────────
    // Tab→unsafe (catraca off) não troca mais direto: arma esta confirmação modal single-key.
    // `[s]`/`[y]` ATIVA o YOLO; `[n]`/Esc CANCELA (fica no modo seguro). Bloqueia o resto
    // enquanto pendente (espelha o `[s/N]` que o `--yolo` já exige no boot).
    if (state.pendingUnsafeConfirm === true) {
      if (char === 's' || char === 'y') {
        controller.confirmUnsafe();
        return;
      }
      if (char === 'n' || key.escape) {
        controller.cancelUnsafe();
        return;
      }
      return; // ignora qualquer outra tecla enquanto a pergunta está aberta
    }

    // ── EST-0969 (watchdog) — PAUSA-PEDE-DIREÇÃO ("parece travado") ──────────────
    // O agente girou sem avançar; a sessão pausou e PEDE DIREÇÃO. Duas sub-fases:
    //  (a) MENU: `[r]` redirecionar (abre o composer p/ a nova instrução), `[c]`
    //      continuar mesmo assim (reseta o detector), `[n]`/esc encerrar.
    //  (b) REDIRECIONANDO (`stuckRedirecting`): o composer captura a nova instrução;
    //      Enter a envia (entra como input do dono — MESMA via do "btw"), esc volta
    //      ao menu. Aqui as teclas vão p/ o composer (fluxo normal abaixo).
    if (state.phase === 'stuck') {
      if (stuckRedirecting) {
        if (key.escape) {
          setStuckRedirecting(false);
          return;
        }
        if (key.return && !key.shift) {
          const text = composer.text;
          setComposer({ text: '', cursor: 0 });
          setStuckRedirecting(false);
          controller.redirectAfterStuck(text);
          return;
        }
        // demais teclas (digitar/editar) caem no fluxo do composer mais abaixo.
      } else {
        if (char === 'r') {
          setStuckRedirecting(true);
          return;
        }
        if (char === 'c') {
          controller.continueAfterStuck();
          return;
        }
        if (char === 'n' || key.escape) {
          controller.endAfterStuck();
          return;
        }
        return;
      }
    }

    // ── EST-0982 — `!comando` EM CURSO: esc/Ctrl-C MATA o comando ───────────────
    // Um `!comando` (atalho de shell do usuário) roda sem entrar em `thinking`/
    // `streaming` (não há turno de modelo) — a fase fica idle/done com o BLOCO `bang`
    // em `running`. Sem este ramo, o esc cairia no composer e o `!sleep 20` esperaria
    // os 20s. Aqui o esc/Ctrl-C dispara o MESMO `interrupt()` (abort do turno), que a
    // `runBang` propaga ao shell ⇒ o processo (grupo) é MORTO em < grace. Captura ANTES
    // do composer/overlays (o comando vivo tem prioridade do freio).
    if (lastBangRunning(state.blocks)) {
      if (key.escape || (key.ctrl && char === 'c')) {
        controller.interrupt();
        // EST-0982 (P1-2) — esc = parar: solta também a fila do type-ahead.
        clearQueue();
        return;
      }
      // Outras teclas caem p/ o fluxo normal (o usuário pode digitar enquanto roda).
    }

    // ── thinking/streaming/retrying: TYPE-AHEAD (digitar enquanto trabalha) ─────
    // EST-0982 (type-ahead) — o composer fica ATIVO durante o trabalho: você digita à
    // vontade SEM ter que interromper. Os freios continuam:
    //   • esc / Ctrl-C → INTERROMPE o turno (cancela — `interrupt()`); auto-retry:
    //     `retrying` é o BACKOFF VISÍVEL e o mesmo freio corta o sleep do backoff.
    //   • Ctrl+T → abre o PAINEL DE FLUXOS (ver/parar/interagir) sobre o turno vivo.
    // Novos caminhos do type-ahead (só nestas fases de TRABALHO):
    //   • Enter → ENFILEIRA a linha (auto-submetida como próximo objetivo ao terminar);
    //   • Ctrl+Enter (ou LF/Ctrl+J) → ENCAIXAR: injeta AGORA no agente vivo
    //     (`injectInput('root', …)`, EST-0982 controle — MESMA catraca, não amplia escopo);
    //   • digitar / ←→ / Ctrl+A/E / backspace → edita o composer (sem slash/`@`: estes
    //     são resolvidos no auto-submit, via a MESMA `submit`/`routeInput`).
    // `ask`/`budget` NÃO chegam aqui (capturados ANTES — a decisão tem o foco).
    if (state.phase === 'thinking' || state.phase === 'streaming' || state.phase === 'retrying') {
      // FREIOS (prioridade do controle vivo, antes do type-ahead).
      if (key.ctrl && char === 't') {
        setFlowDrill(null);
        setFlowSel(0);
        setFlowOpen(true);
        return;
      }
      // ── EST-0982 — SLASH-MENU durante o trabalho (NAVEGAÇÃO) ───────────────────
      // Com o menu ABERTO (você digitou `/` enquanto o agente trabalha), o ramo de
      // trabalho ganha a MESMA navegação do idle: ↑↓ move a seleção (`slashSel`), Tab
      // COMPLETA o comando selecionado no composer e Enter ENFILEIRA o comando (segue o
      // type-ahead: NÃO interrompe — auto-submete ao terminar o turno) fechando o menu.
      // CAPTURADO ANTES dos freios de esc/Enter abaixo: assim ↑↓/Tab/Enter/esc agem
      // sobre o MENU, não sobre o turno. Quando o menu está FECHADO, este bloco é inerte
      // e os freios (esc=interromper) e o type-ahead (Enter=fila) seguem intactos.
      if (slashOpen) {
        if (key.upArrow) {
          setSlashSel((s) => Math.max(0, s - 1));
          return;
        }
        if (key.downArrow) {
          setSlashSel((s) => Math.min(slashCommands.length - 1, s + 1));
          return;
        }
        // esc FECHA o menu SEM cancelar o turno (o esc de interromper só vale com o
        // menu fechado — ver o freio abaixo). Some o overlay, o trabalho segue.
        if (key.escape) {
          setSlashOpen(false);
          setSlashSel(0);
          return;
        }
        // Tab COMPLETA a entrada selecionada NO COMPOSER (sem submeter nem executar
        // — diferente do idle, onde durante o trabalho não rodamos o comando na hora).
        // EST-0974 — `entryCompletion`: comando-folha ⇒ `/<name>` (menu segue aberto no
        // match, pronto p/ Enter/espaço); comando-PAI ⇒ `/<name> ` (revela os subs no
        // menu); SUBcomando ⇒ `/<pai> <sub> ` (com o espaço pra digitar o argumento). Re-
        // sincroniza o menu pela MESMA regra (`syncSlashMenu`) e zera a seleção.
        if (key.tab) {
          const entry = slashCommands[slashSel];
          if (entry) {
            const completion = entryCompletion(entry);
            setText(completion);
            syncSlashMenu(completion);
          }
          return;
        }
        // Enter: SUBcomando ⇒ COMPLETA `/<pai> <sub> ` no composer (precisa de argumento;
        // não enfileira nem executa). Comando ⇒ ENFILEIRA `/<name>` (type-ahead: auto-
        // submete ao fim do turno, NÃO interrompe), fecha o menu e limpa o composer.
        // Sem seleção (lista vazia) ⇒ no-op + fecha.
        if (key.return && !key.shift) {
          const entry = slashCommands[slashSel];
          // EST-0983 (#157 fix) — SUBcomando TERMINAL (`/clear full`/`/clear memory`):
          // verbo SEM argumento ⇒ ENFILEIRA `/<pai> <sub>` (auto-submetido ao fim do
          // turno, igual ao type-ahead), em vez de re-completar e ficar preso. Subs que
          // pedem argumento seguem completando `/<pai> <sub> ` (aguardam o termo).
          if (entry && entry.kind === 'subcommand' && isTerminalSubcommand(entry)) {
            setSlashOpen(false);
            setSlashSel(0);
            const line = terminalSubmitLine(entry);
            enqueue(line);
            setHistory((h) => [...h, line]);
            setText('');
            setHistIdx(-1);
            return;
          }
          if (entry && entry.kind === 'subcommand') {
            const completion = entryCompletion(entry);
            setText(completion);
            syncSlashMenu(completion);
            return;
          }
          setSlashOpen(false);
          setSlashSel(0);
          if (entry) {
            // EST-0982 · ADR-0080 — COMANDO PARALELO-SEGURO (`/ask`) escolhido no menu DURANTE
            // o trabalho: EXECUTA JÁ (mesmo caminho do idle ⇒ `askParallel`), não enfileira —
            // senão a pergunta paralela esperaria o fim do turno (o bug do dono). `/ask` sem
            // arg cai na nota de uso do `askParallel` (comportamento atual preservado).
            if (isParallelWhileBusy(entry.command, '')) {
              runCommand(entry.command, '');
              setText('');
              setHistIdx(-1);
              return;
            }
            // ENFILEIRA `/<name>` (a forma canônica do comando). Auto-submetido ao fim do
            // turno pela MESMA `submit`/`routeInput` (que roteia `/slash`), igual ao
            // resto do type-ahead. `name` (não `id`) p/ cobrir comandos do usuário.
            const line = `/${entry.command.name}`;
            enqueue(line);
            setHistory((h) => [...h, line]);
            setText('');
            setHistIdx(-1);
          }
          return;
        }
        // Demais teclas (char/backspace/cursor) caem p/ a edição abaixo, que
        // RE-SINCRONIZA o menu via `syncSlashMenu` (espaço/qualquer não-casamento fecha).
      }
      // Ctrl+C (turno vivo) = HARD-STOP INALTERADO — para tudo na hora, independente de
      // pendência (mesma garantia do F8). NÃO entra na lógica "acelera" do ESC abaixo.
      if (key.ctrl && char === 'c') {
        controller.interrupt();
        clearQueue();
        return;
      }
      if (key.escape) {
        // ESPEC FINAL DO DONO (corrigida ao vivo) — o ESC durante o turno vivo SÓ PARA quando
        // está TUDO VAZIO: fila (queueRef) vazia E sem injects pendentes (controller.current.
        // pendingInjects — estado AUTORITATIVO, patch SÍNCRONO via injectInput) E composer vazio.
        // Havendo QUALQUER pendência, o ESC NUNCA para — ele só ACELERA o encaixe AGORA:
        //   • composer não-vazio ⇒ REDIRECIONA a minha msg p/ o agente vivo (injectInput; o
        //     agente a vê na próxima iteração). `/ask <q>` vira a pergunta `<q>` injetada;
        //     `/ask` sozinho (nada a injetar) só limpa o composer (não para).
        //   • fila com TEXTO PURO ⇒ FORÇA o encaixe de cada item (injectInput('root', …),
        //     drena na próxima iteração do loop); bang/slash/anexo FICAM na fila (rodam no
        //     repouso). Em /cycle mantém o NO-OP clássico (não encaixa a fila).
        // O fluxo natural já dá o "freio em 2 ESC": o 1º acelera/esvazia, o 2º (agora com tudo
        // vazio) para. SEM contador de double-ESC nem janela de 500ms — a decisão de PARAR é
        // PURAMENTE "está tudo vazio?". F8 e Ctrl+C seguem hard-stop a qualquer momento.
        //
        // FONTE FRESCA OBRIGATÓRIA: `controller.current.pendingInjects` (não o espelho React
        // `state.pendingInjects`, STALE no closure do useInput — mesmo motivo do queueRef).
        const hasQueue = queueRef.current.length > 0;
        const hasInjects = controller.current.pendingInjects.length > 0;
        const composer = expandAndReset(input).trim();
        const hasComposer = composer !== '';

        if (hasQueue || hasInjects || hasComposer) {
          // (1) ACELERA a msg do composer: REDIRECIONA p/ o agente vivo (não enfileira p/ o fim).
          if (hasComposer) {
            const action = decideEscAction(composer);
            if (action.kind === 'redirect') {
              controller.injectInput('root', action.inject);
              setHistory((h) => [...h, action.inject]);
            }
            // `/ask` sozinho ⇒ nada a injetar; só limpamos o composer (segue sem parar).
            setText('');
            setHistIdx(-1);
          }
          // (2) ACELERA a fila: encaixa cada item de TEXTO PURO agora (drena na próxima
          //     iteração). bang/slash/anexo ⇒ FICAM na fila (rodam no repouso). /cycle ⇒ NO-OP.
          if (!state.cycleActive && queueRef.current.length > 0) {
            const kept: string[] = [];
            for (const q of queueRef.current) {
              if (!injectIfPlainText(q)) kept.push(q);
            }
            setQueue(kept);
          }
          return; // NÃO interrompe — havendo pendência, o ESC só acelera o encaixe.
        }

        // TUDO VAZIO (sem fila, sem injects pendentes, composer vazio) ⇒ PARAR o turno
        // (freio — a ÚNICA condição em que o ESC para). Memória de músculo do ESC.
        controller.interrupt();
        clearQueue();
        return;
      }
      // ENCAIXAR (Ctrl+Enter): injeta o composer AGORA no agente vivo (raiz). Detecção
      // robusta entre terminais: `key.return && key.ctrl` (CSI-u/kitty) OU um LF cru
      // (`\n`, Ctrl+J — muitos terminais mapeiam Ctrl+Enter p/ LF) chegando como char.
      // Vazio ⇒ no-op (nada a injetar). Reusa o `pendingInjected` (não duplica catraca).
      const isCtrlEnter =
        (key.return && key.ctrl) || (!key.return && char === '\n' && !key.ctrl && !key.meta);
      if (isCtrlEnter) {
        // EST-PASTE-COLLAPSE — expande chips antes de injetar no agente vivo (conteúdo cheio).
        const line = expandAndReset(input).trim();
        if (line !== '') {
          controller.injectInput('root', line);
          setText('');
          setHistory((h) => [...h, line]);
          setHistIdx(-1);
        }
        return;
      }
      // ENFILEIRAR (Enter limpo): o composer NÃO submete na hora — empurra p/ a fila.
      // (shift+enter quebra linha como sempre; o LF cru já foi tratado como encaixar.)
      if (key.return && key.shift) {
        setComposer((c) => insertAt(c, '\n'));
        return;
      }
      if (key.return) {
        // EST-PASTE-COLLAPSE — expande chips antes de enfileirar (a fila guarda o texto cheio).
        const line = expandAndReset(input).trim();
        if (line !== '') {
          // EST-0982 (mid-turn) — TEXTO PURO ⇒ ENCAIXA agora no turno vivo (drenado pelo loop
          // na PRÓXIMA iteração, não no fim de tudo). COMANDO PARALELO-SEGURO (`/ask`) ⇒ roda
          // JÁ (read-only, em paralelo). `/slash` mutador/`!bang`/anexos ⇒ ENFILEIRA.
          enqueueOrInject(line);
          setHistory((h) => [...h, line]);
          setText('');
          setHistIdx(-1);
        }
        return;
      }
      // ── EDIÇÃO do composer durante o trabalho (sem slash/`@`) ──────────────────
      // Backspace na FILA vazia de texto remove a ÚLTIMA da fila (editar a fila — DoD).
      if (key.backspace || key.delete) {
        if (input === '' && queue.length > 0) {
          setQueue((q) => q.slice(0, -1));
          return;
        }
        setComposer((c) => {
          // EST-PASTE-COLLAPSE — apaga ATÔMICO o chip na borda; senão char normal.
          const next = composerDeleteBackward(c);
          // EST-0982 — re-sincroniza o slash-menu ao apagar (igual ao idle): apagar o
          // `/` (ou o que casava) FECHA o menu; ainda casando, segue aberto/filtrado.
          syncSlashMenu(next.text);
          return next;
        });
        return;
      }
      // Movimento do cursor (mesma mecânica readline do composer idle).
      if (key.leftArrow) {
        setComposer((c) => ({ ...c, cursor: key.meta ? moveWordLeft(c) : moveLeft(c) }));
        return;
      }
      if (key.rightArrow) {
        setComposer((c) => ({ ...c, cursor: key.meta ? moveWordRight(c) : moveRight(c) }));
        return;
      }
      if (key.ctrl && char === 'a') {
        setComposer((c) => ({ ...c, cursor: 0 }));
        return;
      }
      if (key.ctrl && char === 'e') {
        setComposer((c) => ({ ...c, cursor: c.text.length }));
        return;
      }
      // Digitação: aplica o chunk pela FONTE ÚNICA `applyTypedChunk` (EST-0965) — insere
      // na posição do cursor E honra backspace EMBUTIDO (`\x7f`/`\x08`) num chunk MISTO
      // (xrdp/SSH/paste entregam texto+edição grudados; o `key.backspace` só vem quando
      // o chunk é SÓ o byte). Em LOTE com quebra (`\r`/`\n`) o type-ahead ENFILEIRA/
      // ENCAIXA a linha até a 1ª quebra: o `\r` é fila; o `\n` (LF) é ENCAIXAR (injeta
      // agora). A LINHA já vem com os backspaces aplicados (não o texto cru).
      if (char && !key.ctrl && !key.meta) {
        if (char.search(/[\r\n]/) !== -1) {
          // updater funcional: a linha sai do estado ATUAL (+ o chunk até a quebra),
          // robusto a teclas síncronas. Os efeitos (fila/inject/histórico) leem o
          // resultado puro de `applyTypedChunk` sobre o composer corrente.
          setComposer((c) => {
            const r = applyTypedChunk(c, char);
            // EST-PASTE-COLLAPSE — expande chips antes de injetar/enfileirar (texto cheio).
            const line = expandAndReset(r.state.text).trim();
            if (line !== '') {
              // `\n` (LF/Ctrl+Enter) é o ENCAIXAR explícito ⇒ injeta a linha como está. `\r`
              // (Enter) segue o type-ahead: TEXTO PURO ENCAIXA mid-turn (EST-0982), COMANDO
              // PARALELO-SEGURO (`/ask`) RODA JÁ, `/slash` mutador/`!bang`/anexos ENFILEIRA.
              if (r.newline === '\n') controller.injectInput('root', line);
              else enqueueOrInject(line);
              setHistory((h) => [...h, line]);
            }
            setHistIdx(-1);
            return { text: '', cursor: 0 };
          });
          // O composer esvaziou (enfileirou/encaixou a linha) ⇒ fecha o menu.
          setSlashOpen(false);
          setSlashSel(0);
          return;
        }
        setComposer((c) => {
          const next = applyTypedChunk(c, char).state;
          // EST-0982 — digitar `/` ABRE o menu; espaço/qualquer texto que não casa
          // `isSlashMenuQuery` o FECHA (MESMA regra do idle, via `syncSlashMenu`).
          syncSlashMenu(next.text);
          return next;
        });
        return;
      }
      return;
    }

    // ── ERRO DE BROKER captura o foco (EST-0989) ───────────────────────────────
    // O <BrokerError> anuncia "r tentar agora · esc cancelar" — a afordância tem que
    // FUNCIONAR (não pode mentir). Em `phase === 'error'` (broker indisponível), `r`/
    // `R` RETENTA o último objetivo (mesmo turno, mesma catraca) e `esc` CANCELA
    // (descarta o erro, volta ao composer). Capturado ANTES do composer p/ as teclas
    // não vazarem como digitação. (`Ctrl-C` segue saindo via o atalho global abaixo.)
    if (state.phase === 'error') {
      if (key.escape) {
        // CANCELA: limpa o erro no controller (blocos+fase) e REPINTA o scrollback —
        // o bloco `broker-error` já foi commitado no `<Static>` (chrome imutável),
        // então só some da tela com o bump da staticKey + clear (igual ao /clear).
        controller.dismissError();
        clearScreen();
        return;
      }
      if ((char === 'r' || char === 'R') && !key.ctrl && !key.meta) {
        // RETENTA: re-dispara o último objetivo. Limpa o erro do scrollback (Static)
        // antes — a nova tentativa começa numa tela limpa; se falhar de novo, um erro
        // FRESCO é commitado.
        controller.retryLastGoal();
        clearScreen();
        return;
      }
      // Demais teclas: ignoradas (o erro segue na tela até `r`/`esc`); Ctrl-C sai.
      if (!(key.ctrl && char === 'c')) return;
    }

    // ── COMMAND PALETTE CAPTURA o foco (EST-0961) ──────────────────────────────
    // Modal: enquanto aberta, ↑↓ navega, enter executa, esc fecha, e a digitação
    // alimenta a BUSCA própria da palette (não o composer). Capturada ANTES dos
    // demais overlays — só uma pode estar aberta por vez (gating na abertura).
    if (palette.open) {
      if (key.escape) {
        palette.closePalette();
        return;
      }
      if (key.upArrow) {
        palette.move(-1);
        return;
      }
      if (key.downArrow) {
        palette.move(1);
        return;
      }
      if (key.return) {
        const hit = palette.confirm();
        if (hit) executePaletteHit(hit);
        return;
      }
      if (key.backspace || key.delete) {
        palette.setQuery(palette.query.slice(0, -1));
        return;
      }
      // Ctrl+P / Ctrl+X de novo (ou Ctrl-C) FECHA — toggle/escape consistente.
      if (key.ctrl && (char === 'p' || char === 'x' || char === 'c')) {
        palette.closePalette();
        return;
      }
      // Digitação comum vira busca; ignora outras combinações com ctrl/meta.
      if (char && !key.ctrl && !key.meta) {
        palette.setQuery(palette.query + char);
      }
      return;
    }

    // ── seletor `/model` CAPTURA o foco (EST-0962) ─────────────────────────────
    // Mesma mecânica/teclas do slash-menu/file-picker: ↑↓ navega, enter troca o
    // tier da sessão, esc fecha. Captura ANTES do composer (modal).
    if (modelPicker.open) {
      // ── PASSO de EFFORT (EST-1117, conjugado): 2ª etapa, depois do modelo ───────
      // ↑↓ navegam as opções (manter/low/medium/high/custom); enter aplica o TRIO
      // (model+effort) de uma vez; esc VOLTA pro passo de modelo (não fecha tudo). No
      // effort-custom (texto-livre), digitar filtra o valor e enter confirma se válido.
      if (modelPicker.effortStepOpen) {
        if (modelPicker.effortCustomOpen) {
          if (key.escape) {
            modelPicker.backFromEffort();
            return;
          }
          if (key.return) {
            const choice = modelPicker.confirm();
            if (choice) props.onSelectConjugated?.(choice.model, choice.effort);
            return;
          }
          if (key.backspace || key.delete) {
            modelPicker.backspaceEffortCustom();
            return;
          }
          if (char && !key.ctrl && !key.meta) {
            modelPicker.appendEffortCustom(char);
          }
          return;
        }
        if (key.upArrow) {
          modelPicker.effortMove(-1);
          return;
        }
        if (key.downArrow) {
          modelPicker.effortMove(1);
          return;
        }
        if (key.return || key.tab) {
          // "custom" ⇒ confirm() abre o texto-livre (null); nível/manter ⇒ aplica o trio.
          const choice = modelPicker.confirm();
          if (choice) props.onSelectConjugated?.(choice.model, choice.effort);
          return;
        }
        if (key.escape) {
          // esc VOLTA pro passo de modelo (não fecha o picker inteiro).
          modelPicker.backFromEffort();
          return;
        }
        return;
      }
      // ── modo CUSTOM (ADR-0030 §3): BROWSER navegável + filtro por digitação ─────
      // EST-0962 — ↑↓ navegam a lista filtrada (scroll), Ctrl+T alterna "só com tools",
      // enter na linha realçada SELECIONA o modelo e AVANÇA pro passo de effort, esc volta.
      if (modelPicker.customInputOpen) {
        if (key.escape) {
          // esc no modo Custom cancela a sessão de Custom INTEIRA (fecha o picker).
          modelPicker.closePicker();
          return;
        }
        if (key.upArrow) {
          modelPicker.browseMove(-1);
          return;
        }
        if (key.downArrow) {
          modelPicker.browseMove(1);
          return;
        }
        if (key.return) {
          // EST-1117 — enter seleciona a linha realçada (ou o texto-livre) e AVANÇA pro
          // passo de effort (confirm() devolve null aqui — o trio só aplica no effort).
          modelPicker.confirm();
          return;
        }
        if (key.backspace || key.delete) {
          modelPicker.backspaceCustom();
          return;
        }
        // Ctrl+T ALTERNA o filtro "só com tools". Usa CTRL (não `t` solto) de
        // propósito: `t` é caractere de slug comum (mis`t`ral, gp`t`, …) — um `t`
        // literal precisa FILTRAR, não togglar, senão não dá p/ buscar esses nomes.
        if (key.ctrl && char === 't') {
          modelPicker.toggleToolsOnly();
          return;
        }
        // Digitação comum (incl. colar um slug multi-char) FILTRA o browser; ignora
        // combinações com ctrl/meta (não fazem parte do filtro/slug).
        if (char && !key.ctrl && !key.meta) {
          modelPicker.appendCustom(char);
        }
        return;
      }
      // ── modo LISTA (tiers + linha Custom) ──────────────────────────────────────
      if (key.upArrow) {
        modelPicker.move(-1);
        return;
      }
      if (key.downArrow) {
        modelPicker.move(1);
        return;
      }
      if (key.return || key.tab) {
        // EST-1117 — tier ⇒ AVANÇA pro passo de effort; linha Custom ⇒ confirm() ABRE o
        // browser (não fecha). Em ambos confirm() devolve null aqui (o trio aplica no effort).
        modelPicker.confirm();
        return;
      }
      if (key.escape) {
        modelPicker.closePicker();
        return;
      }
      // qualquer outra tecla é ignorada enquanto o seletor está aberto (modal).
      return;
    }

    // ── painel `/permissions` CAPTURA o foco (EST-0968) ────────────────────────
    // Mesma mecânica/teclas dos pickers: ↑↓ navega, enter AGE na linha (cicla modo /
    // alterna default de tool segura / revoga grant), esc fecha. Linhas TRAVADAS são
    // no-op no enter (CLI-SEC-3 — o painel não relaxa categoria sempre-ask). Captura
    // ANTES do composer (modal).
    if (permPanel.open) {
      if (key.upArrow) {
        permPanel.move(-1);
        return;
      }
      if (key.downArrow) {
        permPanel.move(1);
        return;
      }
      if (key.return) {
        permPanel.act();
        return;
      }
      if (key.escape) {
        permPanel.closePanel();
        return;
      }
      // qualquer outra tecla é ignorada enquanto o painel está aberto (modal).
      return;
    }

    // ── seletor `/theme` CAPTURA o foco (EST-0966) ─────────────────────────────
    // Mesma mecânica/teclas do slash-menu/file-picker/model-picker: ↑↓ navega,
    // enter troca o tema da sessão (re-render com a nova paleta), esc fecha. Modal.
    if (themePicker.open) {
      if (key.upArrow) {
        themePicker.move(-1);
        return;
      }
      if (key.downArrow) {
        themePicker.move(1);
        return;
      }
      if (key.return || key.tab) {
        const name = themePicker.confirm();
        if (name) props.onSelectTheme?.(name);
        return;
      }
      if (key.escape) {
        themePicker.closePicker();
        return;
      }
      return;
    }

    // ── seletor `/lang` CAPTURA o foco (EST-0989) ──────────────────────────────
    // Espelha o /theme: ↑↓ navega, enter troca o idioma da sessão (re-render no novo
    // idioma + persiste), esc fecha. Modal.
    if (langPicker.open) {
      if (key.upArrow) {
        langPicker.move(-1);
        return;
      }
      if (key.downArrow) {
        langPicker.move(1);
        return;
      }
      if (key.return || key.tab) {
        const code = langPicker.confirm();
        if (code) props.onSelectLang?.(code);
        return;
      }
      if (key.escape) {
        langPicker.closePicker();
        return;
      }
      return;
    }

    // ── seletor `/provider` CAPTURA o foco (EST-0962) ──────────────────────────
    // Espelha o /theme//lang: ↑↓ navega, enter seta o provider do modo Custom da sessão
    // (a próxima chamada o envia em par com o slug), esc fecha. Modal.
    if (providerPicker.open) {
      if (key.upArrow) {
        providerPicker.move(-1);
        return;
      }
      if (key.downArrow) {
        providerPicker.move(1);
        return;
      }
      if (key.return || key.tab) {
        const name = providerPicker.confirm();
        if (name) props.onSelectProvider?.(name);
        return;
      }
      if (key.escape) {
        providerPicker.closePicker();
        return;
      }
      return;
    }

    // ── seletor `/history` CAPTURA o foco (EST-0972) ───────────────────────────
    // Mesma mecânica/teclas dos pickers: ↑↓ navega, enter RETOMA a sessão escolhida
    // (carrega a transcrição + semeia o contexto, via onResumeSession), esc CANCELA
    // (fica na sessão atual, sem mudar nada). Lista vazia ⇒ enter é no-op (esc sai).
    // Captura ANTES do composer (modal).
    if (historyPicker.open) {
      if (key.upArrow) {
        historyPicker.move(-1);
        return;
      }
      if (key.downArrow) {
        historyPicker.move(1);
        return;
      }
      if (key.return || key.tab) {
        const id = historyPicker.confirm();
        if (id) {
          // limpa a tela ANTES de retomar (a transcrição antiga substitui a corrente);
          // o wiring então restaura os blocos + semeia o contexto da sessão escolhida.
          clearScreen();
          props.onResumeSession?.(id);
        }
        return;
      }
      if (key.escape) {
        historyPicker.closePicker();
        return;
      }
      // qualquer outra tecla é ignorada enquanto o seletor está aberto (modal).
      return;
    }

    // ── seletor `/rewind` (· Esc Esc) CAPTURA o foco (EST-XXXX) ─────────────────
    // DUAS etapas: ↑↓ navega; enter confirma (etapa `list` AVANÇA p/ a ação; etapa
    // `action` aplica via onRewind); esc VOLTA (na ação → lista; na lista → fecha).
    // Captura ANTES do composer (modal).
    if (rewindPicker.open) {
      if (key.upArrow) {
        rewindPicker.move(-1);
        return;
      }
      if (key.downArrow) {
        rewindPicker.move(1);
        return;
      }
      if (key.return) {
        const choice = rewindPicker.confirm();
        if (choice) {
          // a etapa de ação confirmou: o wiring restaura código e/ou rebobina a
          // conversa. A limpeza visual fica a cargo do wiring (a transcrição muda).
          props.onRewind?.(choice);
        }
        return;
      }
      if (key.escape) {
        rewindPicker.back();
        return;
      }
      // qualquer outra tecla é ignorada enquanto o seletor está aberto (modal).
      return;
    }

    // ── slash-menu navegação ───────────────────────────────────────────────────
    if (slashOpen) {
      if (key.upArrow) {
        setSlashSel((s) => Math.max(0, s - 1));
        return;
      }
      if (key.downArrow) {
        setSlashSel((s) => Math.min(slashCommands.length - 1, s + 1));
        return;
      }
      if (key.return || key.tab) {
        const entry = slashCommands[slashSel];
        if (entry) {
          // EST-0974 — SUBcomando: SEMPRE completa `/<pai> <sub> ` no composer (precisa de
          // argumento; nunca executa direto). Comando-PAI (com subs) no TAB: drilla os subs
          // (`/<name> `). Caso contrário (comando-folha, ou Enter no pai): EXECUTA — mesmo
          // caminho de sempre (`runCommand`, abre o picker do /model//theme se couber).
          const isParent =
            entry.kind === 'command' &&
            entry.command.subcommands !== undefined &&
            entry.command.subcommands.length > 0;
          // EST-0983 (#157 fix) — SUBcomando TERMINAL (`/clear full`, `/clear memory`):
          // verbo SEM argumento ⇒ o Enter SUBMETE direto (`runCommand` do pai com o verbo
          // como arg), em vez de re-completar e ficar preso. O Tab segue só completando
          // (descoberta). Subs que pedem argumento (`/mcp search <termo>`) NÃO são
          // terminais ⇒ caem no ramo de baixo (completam e aguardam o termo, intacto).
          if (entry.kind === 'subcommand' && isTerminalSubcommand(entry) && key.return) {
            setText('');
            setSlashOpen(false);
            setSlashSel(0);
            runCommand(entry.parent, entry.sub.name);
            return;
          }
          if (entry.kind === 'subcommand' || (isParent && key.tab)) {
            const completion = entryCompletion(entry);
            setText(completion);
            syncSlashMenu(completion);
            return;
          }
          setText('');
          setSlashOpen(false);
          setSlashSel(0);
          runCommand(entry.command, '');
        }
        return;
      }
      if (key.escape) {
        setSlashOpen(false);
        setSlashSel(0);
        return;
      }
    }

    // ── file-picker `@` navegação (EST-0957) ───────────────────────────────────
    // Mesma mecânica/teclas do slash-menu: ↑↓ navega, enter/tab anexa, esc fecha.
    // A digitação (char/backspace) cai p/ o composer abaixo e RE-SINCRONIZA a query
    // via o trailing mention (ver os handlers de char/backspace).
    if (picker.open) {
      if (key.upArrow) {
        picker.move(-1);
        return;
      }
      if (key.downArrow) {
        picker.move(1);
        return;
      }
      if (key.return || key.tab) {
        // Anexa o selecionado e remove o `@query` em digitação do input. O cursor vai
        // p/ o FIM do que sobrou (EST-0948 cursor).
        void picker.confirm();
        setText(stripTrailingMention(input));
        return;
      }
      if (key.escape) {
        picker.closePicker();
        return;
      }
    }

    // ── composer ──────────────────────────────────────────────────────────────
    // EST-1015 (dono) — Ctrl+C no composer ocioso: NÃO mata mais na 1ª. Com texto, o 1º
    // LIMPA o composer; vazio, o 1º ARMA a saída (footer avisa) e só o 2º (dentro da janela)
    // encerra. Qualquer OUTRA tecla desarma (abaixo). Mata "uma vez já derruba a app".
    if (key.ctrl && char === 'c') {
      const action = decideCtrlC(input, ctrlCArmed); // PURO (composer-edit) — testado à parte.
      if (action === 'clear') {
        // há texto digitado ⇒ limpa (e desarma, se estava armado de antes).
        setText('');
        disarmCtrlC();
        return;
      }
      if (action === 'exit') {
        // 2º Ctrl+C dentro da janela ⇒ SAI de fato.
        disarmCtrlC();
        exit();
        return;
      }
      // 'arm' — 1º Ctrl+C com composer vazio ⇒ ARMA + auto-desarma após a janela (~2.5s).
      setCtrlCArmed(true);
      if (ctrlCTimerRef.current !== undefined) clearTimeout(ctrlCTimerRef.current);
      ctrlCTimerRef.current = setTimeout(() => setCtrlCArmed(false), 2500);
      return;
    }
    // Qualquer tecla que NÃO seja Ctrl+C desarma a saída pendente (atividade = cancela o
    // "quer mesmo sair?"). Barato e idempotente (no-op quando já desarmado).
    if (ctrlCArmed) disarmCtrlC();

    // ── EST-XXXX — Esc-Esc abre o `/rewind` (composer VAZIO, em REPOUSO) ────────
    // Chega aqui só fora de qualquer modal e fora das fases de trabalho/erro (esc nelas
    // foi capturado ACIMA p/ interromper/cancelar). Com o composer VAZIO, dois Esc dentro
    // da janela (~600ms) abrem o seletor de checkpoints — paridade com o `/rewind` do
    // Claude Code. Só quando a fonte de checkpoints está fiada (senão Esc-Esc é inerte).
    // Um Esc com texto no composer NÃO arma (esc ali é p/ outras affordances/no-op).
    if (key.escape) {
      if (props.rewindSource !== undefined && props.onRewind !== undefined && input === '') {
        if (escPendingRef.current) {
          // 2º Esc dentro da janela ⇒ abre o picker.
          escPendingRef.current = false;
          if (escTimerRef.current !== undefined) clearTimeout(escTimerRef.current);
          rewindPicker.openPicker();
          return;
        }
        // 1º Esc ⇒ ARMA + auto-desarma após a janela do chord.
        escPendingRef.current = true;
        if (escTimerRef.current !== undefined) clearTimeout(escTimerRef.current);
        escTimerRef.current = setTimeout(() => {
          escPendingRef.current = false;
        }, 600);
        return;
      }
      // sem rewind fiado / composer com texto ⇒ não arma (esc segue inerte aqui).
      escPendingRef.current = false;
    } else if (escPendingRef.current) {
      // qualquer OUTRA tecla quebra o chord (Esc-Esc tem que ser consecutivo).
      escPendingRef.current = false;
      if (escTimerRef.current !== undefined) clearTimeout(escTimerRef.current);
    }
    // EST-0961 — Ctrl+P (ou o leader Ctrl+X, alias trivial) ABRE a command palette.
    // GATED: só quando NENHUM outro overlay está aberto. O model/theme-picker já
    // deram `return` acima (modais totais); o slash-menu e o file-picker `@` NÃO
    // retornam em teclas livres (a digitação cai p/ o composer), então os
    // excluímos aqui explicitamente — sem conflito com o `/`, o `@` ou o Tab de
    // completar. A própria palette (acima) trata o toggle/fechar quando já aberta.
    if (key.ctrl && (char === 'p' || char === 'x') && !slashOpen && !picker.open) {
      palette.openPalette();
      return;
    }
    // EST-1015 (opção (c)) — Tab cicla o MODO (`normal → plan → unsafe → normal`, INVERTIDO)
    // quando o slash-menu NÃO está aberto (lá o Tab completa o comando). A aresta `→unsafe`
    // não troca direto: recusa como root OU arma a confirmação (gate acima). O indicador
    // re-renderiza; a catraca passa a decidir pelo novo modo na hora.
    if (key.tab && !slashOpen) {
      controller.cycleMode();
      return;
    }
    // histórico ↑↓ (só com composer vazio ou já navegando — §4.4). Vertical: NÃO
    // colide com o cursor (←/→, horizontal). Ao carregar uma entrada, o cursor vai p/
    // o FIM dela (EST-0948 cursor).
    if (!slashOpen && key.upArrow && history.length > 0) {
      const next = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setText(history[next] ?? '');
      return;
    }
    if (!slashOpen && key.downArrow && histIdx >= 0) {
      const next = histIdx + 1;
      if (next >= history.length) {
        setHistIdx(-1);
        setText('');
      } else {
        setHistIdx(next);
        setText(history[next] ?? '');
      }
      return;
    }

    // ── EST-0948 (composer/sessão) — MOVIMENTO DO CURSOR (não muta o texto) ────────
    // O composer deixou de ser append-only: o cursor é um índice 0..input.length que
    // ←/→ movem (clamp), Alt+←/→ (e Alt+b/Alt+f) movem por PALAVRA, Ctrl+A/Ctrl+E vão
    // p/ início/fim (Home/End readline — o terminal manda Home/End como sequência que o
    // Ink DESCARTA por completo, sem flag nem char, então Ctrl+A/E é o canal CONFIÁVEL).
    // Estas teclas dão `return` ANTES da edição (não inserem char, não apagam). TODAS
    // usam updater funcional (compõem sobre o estado ANTERIOR — robusto a teclas em lote).
    // Alt+← / Alt+b → palavra à esquerda; ← → 1 char à esquerda.
    if (key.leftArrow) {
      setComposer((c) => ({ ...c, cursor: key.meta ? moveWordLeft(c) : moveLeft(c) }));
      return;
    }
    if (key.rightArrow) {
      setComposer((c) => ({ ...c, cursor: key.meta ? moveWordRight(c) : moveRight(c) }));
      return;
    }
    // Alt+b / Alt+f (readline word-move por letra, p/ terminais sem Alt+seta).
    if (key.meta && (char === 'b' || char === 'f')) {
      setComposer((c) => ({ ...c, cursor: char === 'b' ? moveWordLeft(c) : moveWordRight(c) }));
      return;
    }
    // Ctrl+A → início (Home); Ctrl+E → fim (End) — estilo readline.
    if (key.ctrl && char === 'a') {
      setComposer((c) => ({ ...c, cursor: 0 }));
      return;
    }
    if (key.ctrl && char === 'e') {
      setComposer((c) => ({ ...c, cursor: c.text.length }));
      return;
    }
    // EST-1015 — Ctrl+U (apaga até o início) · Ctrl+K (apaga até o fim) · Ctrl+W (apaga a
    // palavra à esquerda) — readline padrão. Sincroniza o slash-menu (o texto mudou).
    if (key.ctrl && (char === 'u' || char === 'k' || char === 'w')) {
      setComposer((c) => {
        const next =
          char === 'u' ? deleteToStart(c) : char === 'k' ? deleteToEnd(c) : deleteWordBack(c);
        syncSlashMenu(next.text);
        return next;
      });
      setHistIdx(-1);
      return;
    }

    // multilinha: shift+enter insere `\n` NA POSIÇÃO do cursor (§4.2); enter puro envia.
    if (key.return && key.shift) {
      setComposer((c) => insertAt(c, '\n'));
      return;
    }
    if (key.return) {
      // EST-PASTE-COLLAPSE — EXPANDE os chips de paste no submit: o modelo recebe o conteúdo
      // COMPLETO original (fiel byte-a-byte) no lugar de cada `[texto colado #N, …]`. Sem
      // chips, é o `input` inalterado. Esvazia o registro depois (sessão de composição nova).
      const line = expandAndReset(input);
      setText('');
      setSlashOpen(false);
      setSlashSel(0);
      setHistIdx(-1);
      picker.closePicker();
      submit(line);
      return;
    }
    // BACKSPACE apaga em `pos-1`; DELETE (forward) apaga em `pos`. Ambas as físicas
    // (0x7f e [3~) chegam ao Ink como `key.delete` — indistinguíveis aqui —, então
    // tratamos `backspace || delete` como BACKSPACE (apagar à esquerda), o gesto
    // dominante e o comportamento histórico do composer (não-regressão). Forward-delete
    // de verdade fica disponível pela API pura (deleteForward) p/ quando o canal de
    // tecla as distinguir; o caso comum (backspace) é o coberto e testado.
    if (key.backspace || key.delete) {
      // Backspace no input VAZIO remove o último chip anexado (CA-5/§4.2).
      if (input === '' && picker.attachments.length > 0) {
        picker.removeLast();
        return;
      }
      // EST-PASTE-COLLAPSE — backspace/delete na BORDA de um chip de paste o remove INTEIRO
      // (unidade atômica) e descarta o ref, não 1 char (via `composerDeleteBackward`). Fora
      // de borda ⇒ edição normal de char. `key.delete`/`key.backspace` ambos chegam como
      // apagar-à-esquerda aqui (o Ink não os distingue), então a borda testada é 'backward'.
      setComposer((c) => {
        const next = composerDeleteBackward(c);
        syncSlashMenu(next.text);
        syncPicker(next.text);
        return next;
      });
      return;
    }
    if (char && !key.ctrl && !key.meta) {
      // ── INPUT EM LOTE (xrdp/SSH/paste): Enter GRUDADO no texto (EST-0948) ──────
      // Em sessões remotas a latência faz texto+Enter chegarem num ÚNICO chunk: o
      // Ink entrega ao `useInput` um `char` MULTI-caractere terminando em `\r`/`\n`
      // com `key.return === false`. Sem isto o `\r` viraria texto e o objetivo NUNCA
      // submeteria (o Enter limpo nunca dispara). Detectamos a 1ª quebra, submetemos a
      // linha até ela e PARAMOS — o resto do paste (linhas seguintes) não é nosso caso
      // (composer é de 1 objetivo; multilinha é shift+enter). O paste em lote é
      // tratado como APPEND no fim (o cursor de meio é p/ digitação char-a-char; um
      // chunk com Enter é "submeter", não "editar no meio").
      // EST-0965 — a LINHA sai da FONTE ÚNICA `applyTypedChunk` (honra backspace
      // EMBUTIDO no chunk, igual ao type-ahead): `abc\x7f\r` submete `ab`, não `abc`.
      if (char.search(/[\r\n]/) !== -1) {
        picker.dismissNotice();
        const typed = applyTypedChunk({ text: input, cursor: input.length }, char).state.text;
        // EST-PASTE-COLLAPSE — expande chips de paste antes de submeter (igual ao Enter limpo).
        const line = expandAndReset(typed);
        // Limpa o composer e fecha overlays de digitação ANTES de rotear (mesma
        // sequência do Enter limpo). `submit` → `routeInput` trata objetivo, `/slash`
        // (com/sem args) e `!bang` de forma uniforme — o paste literal é o que o
        // usuário digitou, então roteamos o texto, não a seleção do menu.
        setText('');
        setSlashOpen(false);
        setSlashSel(0);
        setHistIdx(-1);
        picker.closePicker();
        submit(line);
        return;
      }
      // O aviso de recusa de anexo (revisor #3) some na próxima digitação (ação nova).
      picker.dismissNotice();
      // APLICA o chunk NA posição do cursor pela FONTE ÚNICA `applyTypedChunk` (EST-0965):
      // insere texto E aplica backspace EMBUTIDO (chunk misto `abc\x7f` ⇒ `ab`) — o MESMO
      // caminho do type-ahead, fonte ÚNICA de edição. Updater funcional: várias teclas
      // SÍNCRONAS (xrdp/SSH) compõem sem se perder (cada uma sobre o estado da anterior).
      setComposer((c) => {
        const next = applyTypedChunk(c, char).state;
        syncSlashMenu(next.text);
        syncPicker(next.text);
        return next;
      });
      setHistIdx(-1);
    }
  });

  /**
   * EST-0957 — re-sincroniza o picker `@` com o input corrente: abre/fecha e
   * atualiza a query pelo "trailing mention" (`@auth/sess` no fim do input). Mantém
   * a única fonte de verdade do `@` no texto do composer (consistente com o slash).
   */
  function syncPicker(next: string): void {
    const mention = trailingMention(next);
    if (mention) {
      // EST-0982 (P1-1) — só ABRIR o FilePicker em REPOUSO (idle/done) e com o composer
      // como foco. O paste (`insertPaste`→`syncPicker`) é o único caminho que chega aqui
      // FORA do idle: durante o trabalho (thinking/streaming/retrying) o ramo de type-ahead
      // dá `return` ANTES do handler do picker ⇒ o overlay do `@` abriria por cima do turno
      // vivo SEM receber ↑↓/enter/esc (preso, in-navegável; esc interrompe o turno). Em
      // `asking`/`budget`/`stuck`/`error` abriria órfão. Nessas fases o texto colado entra
      // LITERAL (sem `@` ativo) — a resolução do `@` mid-turn é do dreno da fila (#278), não
      // do picker. Em idle/done segue abrindo/atualizando como sempre.
      const canOpenPicker = state.phase === 'idle' || state.phase === 'done';
      if (!picker.open) {
        if (canOpenPicker) {
          picker.openPicker();
          picker.setQuery(mention.query);
        }
        return;
      }
      // Já aberto (foi aberto em repouso): segue atualizando a query normalmente.
      picker.setQuery(mention.query);
    } else if (picker.open) {
      picker.closePicker();
    }
  }

  // EST-0987 (2/3) — RETIRADO (EST-0985 polish): o colapso da régua "acima do
  // input" quando a conversa estava vazia nasceu no layout ANTIGO, em que a régua
  // "sob o header" e a "acima do input" ficavam COLADAS (régua dupla) sem turnos.
  // No layout atual o header vive no <Static> no TOPO e o composer no rodapé da
  // região viva, SEMPRE separados pelo corpo (Onboarding/histórico) — então as duas
  // nunca encostam. O gate só DESMOLDURAVA o composer em sessão fresca / pós-`/clear`
  // (sumia a de cima, ficava a de baixo). A divisória acima do composer agora é
  // INCONDICIONAL (ver "EST-0985 (2/3)" abaixo); o respiro SUTIL por-turno (3/3)
  // segue derivado por bloco no <Static>, sem depender de `hasTurns`.

  // EST-0982 (type-ahead) — o composer fica ATIVO também enquanto o agente TRABALHA
  // (`thinking`/`streaming`/`retrying`): você digita à vontade sem interromper (Enter
  // enfileira, Ctrl+Enter encaixa). NÃO em `ask`/`budget` — lá a DECISÃO tem o foco
  // (o composer fica dim, esperando a escolha acima). Idle/done seguem ativos (1º turno
  // ou entre turnos).
  const isWorkPhase =
    state.phase === 'thinking' || state.phase === 'streaming' || state.phase === 'retrying';
  // EST-0969 (watchdog) — na pausa-pede-direção, o composer só fica ATIVO quando o
  // usuário escolheu `[r]` (está digitando a nova instrução). No MENU (`[r]/[c]/[n]`)
  // ele fica dim, como no `budget`/`ask` (a DECISÃO tem o foco).
  const stuckTyping = state.phase === 'stuck' && stuckRedirecting;
  const composerActive =
    state.phase === 'idle' || state.phase === 'done' || isWorkPhase || stuckTyping;
  // A dica do composer: em trabalho o composer está ATIVO ⇒ sem `hint` (a dica só
  // aparece quando inativo). Em `ask`/`budget` (composer dim) explica que a decisão
  // acima tem o foco. (O `<Composer>` só mostra `hint` quando `active === false`.)
  const composerHint = state.phase === 'asking' ? 'aguardando sua decisão acima' : undefined;

  // EST-0965 — UM CURSOR SÓ NA TELA. Enquanto o agente TRABALHA (isWorkPhase), o
  // <AluyBlock> pinta o cursor AMARELO de trabalho (●) na ponta do stream — ELE é o
  // indicador dominante. Nesse intervalo o `▏` branco do composer fica OFF, p/ nunca
  // haver DOIS cursores ao mesmo tempo (o "3 cursores" do #118 não pode voltar por
  // este caminho). TYPE-AHEAD: assim que o usuário começa a digitar (`input !== ''`),
  // o cursor do composer VOLTA — você precisa ver onde está editando a fila; o de
  // trabalho segue na região viva, mas agora o foco textual é o composer. Fora do
  // trabalho (idle/done) o composer manda no cursor normalmente.
  const composerShowCursor = props.animate !== false && (input !== '' || !isWorkPhase);

  // egress enrichment p/ o AskDialog (CLI-SEC-5)
  const askEgress = computeEgress(state, props.egress);
  // EST-0982 (semântica do esc) — com SUB-AGENTES VIVOS o footer ensina a nova
  // semântica de parada: esc para SÓ o pai; F8 para tudo.
  const hintState = hintStateOf(state, slashOpen, palette.open, subAgentsRunning(state.blocks));

  // EST-0965 — INDICADOR DE ATIVIDADE (elapsed). Enquanto OCUPADO, o relógio do turno
  // vem da contabilidade VIVA do controller (`durationMs` = clock − início do turno,
  // medido na raiz). Lido a cada render — o tick LENTO de 1s (acima) força um render
  // por segundo mesmo SEM token, então o número AVANÇA (não parece congelado). Fora do
  // trabalho ⇒ `undefined` (o footer de idle/ask/etc. não ganha relógio). Independe de
  // `theme.animate`: com `ALUY_NO_ANIM` o número segue subindo (é informativo, não
  // decorativo). Formato `M:SS` (`0:12`) via `formatElapsed`.
  const acc = busy ? controller.turnAccounting() : undefined;
  const elapsed = acc && acc.live ? formatElapsed(acc.durationMs) : undefined;

  // EST-0973 — ELAPSED do <ProgressBar> indeterminado (fase `compacting`): `now() −
  // startedAt`. Como `compacting` arma o tick de 1s (elapsedTickEnabled), este valor é
  // relido a cada segundo e o `0:0N` AVANÇA — a barra de progresso "respira". `now`
  // injetável (default Date.now) p/ teste determinístico. Indefinido fora de `compacting`.
  const nowFn = props.now ?? Date.now;
  const compactElapsedMs = state.progress ? Math.max(0, nowFn() - state.progress.startedAt) : 0;

  // ── ANTI-FLICKER (Static + isolamento da animação) ──────────────────────────
  // Os blocos CONCLUÍDOS (histórico imutável) vão p/ o `<Static>` do Ink: escritos
  // UMA vez no scrollback e NUNCA mais re-renderizados — nem pelo token do stream,
  // nem pelo `frame` do tick. Só a região VIVA (turno em streaming + tool running)
  // participa do render dinâmico. Isso mata o tremor: sem isto, o Ink redesenhava a
  // árvore inteira (incl. todo o histórico) a cada token E a cada frame.
  const { done, live, liveStart } = splitBlocks(state.blocks);

  // EST-0965 (anti-flicker) — TETO DINÂMICO da prévia de FALA. A região viva precisa
  // caber INTEIRA em `rows-1`, senão o Ink redesenha tudo (header+histórico+viva) a
  // cada frame (`ink.js`: `outputHeight >= rows`) — o "refresh toda hora". O furo
  // antigo (`rows - 13` direto no teto da fala) ignorava os OUTROS blocos vivos do
  // frame: o(s) tool `running`, o <Working>, o sub-agents, o marcador `…N acima`, o
  // cursor — então `chrome + fala(no teto) + tool + working + …N = rows + N` ⇒ estouro.
  // `speechMaxLines` subtrai o chrome fixo (`LIVE_CHROME_ROWS`), a folga e a altura
  // dos OUTROS vivos do frame, com piso seguro. (Conta linha-a-linha em live-budget.ts.)
  // EST-0982 (type-ahead) — altura BOUNDED da FILA (`<QueuedInputs>`), p/ o orçamento.
  // A fila mora ABAIXO da região viva (acima do composer): consome altura do frame, então
  // ENTRA no desconto do teto da fala (senão a soma estoura `rows-1` ⇒ flicker). O `+1`
  // é o `paddingBottom={1}` do contêiner da fila no render (só quando há fila).
  const queueLines = queue.length > 0 ? queuedInputsLines(queue.length) + 1 : 0;
  // EST-0982 (mid-turn UX) — altura BOUNDED do indicador "encaixando…" (`<PendingInjects>`,
  // os injects de texto puro AINDA não drenados pelo loop). Mora no MESMO lugar da fila
  // (abaixo da região viva, acima do composer) ⇒ ENTRA no MESMO desconto do orçamento da
  // fala (anti-flicker), reusando `queuedInputsLines` (mesma forma de altura) + o `+1` do
  // `paddingBottom`. Somado ao `queueLines` (ambos coexistem: fila de submit × encaixando).
  const pendingInjectLines =
    state.pendingInjects.length > 0 ? queuedInputsLines(state.pendingInjects.length) + 1 : 0;
  // `/ask` pendente ocupa a MESMA região (abaixo da fala, acima do composer) ⇒ mesmo desconto.
  const pendingAskLines =
    state.pendingAsks.length > 0 ? queuedInputsLines(state.pendingAsks.length) + 1 : 0;
  const stagedLines = queueLines + pendingInjectLines + pendingAskLines;
  // EST-1015 (anti-flicker) — o <SlashMenu> mora ABAIXO do composer e PODE coexistir com o stream
  // (EST-0982). Sua altura (lista filtrada + cabeçalhos + ajuda + o `paddingTop={1}` do contêiner)
  // CONSOME altura do frame: desconta do teto da fala p/ `chrome + fala + menu` caber em `rows`
  // (senão o Ink repinta a tela toda via clearTerminal ⇒ cintilação). Só o slash-menu entra aqui:
  // os pickers (model/theme/…) capturam o foco e NÃO coexistem com stream (abrem no idle).
  // EST-1015 (🔴 fix menu-FANTASMA) — TETO de altura do <SlashMenu> INLINE. Sem teto a lista
  // INTEIRA podia estourar `rows` ⇒ Ink entra no caminho full-screen (clearTerminal) e, ao FECHAR
  // o menu, o scrollback empurrado pra fora não volta ⇒ linhas do menu de fantasma "em cima". Com
  // o teto o menu JANELA (↑N/↓N) e a região viva nunca estoura. Reserva ~10 linhas p/ o chrome
  // (conversa-mín + composer + status + modo + hints + réguas); piso 4 em telas minúsculas.
  // F88 — o teto do menu reserva a região viva REAL (não `rows - 10` fixo): durante o
  // stream a viva já passa de 10 ⇒ menu+viva estourava `rows` ⇒ flicker + fantasma ao
  // fechar. Agora desconta chrome+blocos+fala-mín+staged (ver `slashMenuMaxRows`).
  const slashMenuRowCap = slashMenuMaxRows({
    rows,
    live,
    phase: state.phase,
    hasBlocks: state.blocks.length > 0,
    mode: state.mode,
    columns,
    stagedLines,
  });
  const cappedSlashLines = slashOpen
    ? Math.min(slashMenuVisibleLines(slashCommands), slashMenuRowCap)
    : 0;
  const overlayLines = slashOpen ? cappedSlashLines + 1 : 0;
  const liveMaxLines = speechMaxLines({
    rows,
    live,
    phase: state.phase,
    hasBlocks: state.blocks.length > 0,
    // EST-0965 (wrap): a largura entra no orçamento. Linhas largas (JSON/paths/logs)
    // quebram em VÁRIAS visuais; sem `columns` o teto contava linhas-fonte e a região
    // viva estourava `rows` em output real ⇒ flicker. Agora o teto e a janela de
    // cauda medem a altura VISUAL real (wrap em columns-2/columns-4).
    columns,
    // EST-0965 (fix --unsafe): o modo entra no orçamento. Em `unsafe` o
    // <ModeIndicator> vira o banner (quebra p/ 2 linhas em larguras médias) e
    // come 1 linha ALÉM da base contada no chrome — sem descontar, a região viva
    // estoura `rows` e o Ink redesenha tudo a cada frame (o "piscar" do --unsafe).
    mode: state.mode,
    // EST-0982 — fila de submit + indicador "encaixando…" descontam do teto da fala
    // (anti-flicker, ver acima): ambos moram abaixo da região viva e somam altura.
    queuedLines: stagedLines,
    // EST-1015 — o slash-menu aberto (coexiste com o stream) também desconta (ver acima).
    overlayLines,
    // RESIZE-FIX — excedente VISUAL do composer (wrap) desconta do teto (anti-gap inline).
    composerOverflow,
  });

  // ── EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG): projeção do log + orçamento ──
  // O LOG lê a PROJEÇÃO da FlowTree (`flowOverview` + `drillInFlow`, JÁ REDIGIDA —
  // RES-C-1). NUNCA o stream cru. Só projetamos quando o log de fato COEXISTE (side) ou
  // está VISÍVEL na aba (tabs+log) — em `single`/OFF o custo é zero (TUI de hoje intacta).
  const logSections = logVisible
    ? buildActivityLog(controller.flowOverview(), (id) => controller.drillInFlow(id), {
        collapsed: logCollapsed,
        errorsOnly: logErrorsOnly,
      }).sections
    : [];
  // A coluna do LOG (lado-a-lado) tem teto PRÓPRIO em linhas VISUAIS (`LOG_VISIBLE_ROWS`).
  // As 2 colunas vivas dividem a altura do frame: o orçamento da fala (`splitLiveBudget`)
  // desconta o EXCEDENTE do log sobre o chat p/ `max(chat, log) + chrome ≤ rows-1`. Em
  // `tabs` só UMA coluna está visível ⇒ a do log NÃO coexiste com a do chat (logo 0).
  const logColumnLines =
    splitLayout === 'side' ? Math.min(LOG_VISIBLE_ROWS, logSections.length + 1) : 0;
  const splitMaxLines =
    splitLayout === 'single'
      ? liveMaxLines
      : splitLiveBudget({
          rows,
          layout: splitLayout,
          live,
          phase: state.phase,
          hasBlocks: state.blocks.length > 0,
          mode: state.mode,
          columns,
          queuedLines: stagedLines,
          composerOverflow,
          logColumnLines,
        });

  // EST-0989 (Variação B) — o TIER é o 1º campo do <StatusBar> e ACENDE (accent)
  // quando ≠ default. A via Custom é sempre ≠ default (acende). Re-renderiza a cada
  // frame ⇒ trocar `/model` reflete AQUI (o <Header> estático no Static não muda).
  const isDefaultTier =
    state.meta.backend !== 'local' &&
    state.meta.tier === DEFAULT_TIER &&
    state.meta.model === undefined;

  // EST-1015 (#24, pedido do dono — re-habilita o display do modelo resolvido) — OPT-IN
  // p/ mostrar `<tier> · <modelo>` mesmo FORA da via Custom, lendo o `meta.activeModel`
  // (o modelo que o broker RESOLVEU do tier, via `usage.model`). OFF por DEFAULT: o binário
  // público NÃO revela o mapa tier→provider (HG-2/CLI-SEC-7, gate AG-0008). O DONO liga via
  // `ALUY_SHOW_MODEL=1` no ambiente (consentimento informado do operador, como `--yolo`).
  // `displayModel`: o slug Custom (escolha do usuário, SEMPRE exibível) tem prioridade;
  // senão, o resolvido SÓ com o opt-in. NUNCA toca o roteamento (é só display).
  const showRoutedModel =
    process.env.ALUY_SHOW_MODEL === '1' || process.env.ALUY_SHOW_MODEL === 'true';
  // FATIA 1 (CICLOS/SUBCICLOS) — knob `ALUY_CYCLE_UI_OFF` suprime o indicador `↻ ciclo N/M`
  // (escape hatch p/ quem não quer o display do ciclo de vida do loop). OFF por default
  // ⇒ o indicador aparece quando há ciclo/plano. Ligado (`1`/`true`) ⇒ a prop não passa.
  const cycleUiOff =
    process.env.ALUY_CYCLE_UI_OFF === '1' || process.env.ALUY_CYCLE_UI_OFF === 'true';
  // ADR-0120 — INDICAÇÃO DO MODO no 1º campo da StatusBar (lê o backend EFETIVO do `meta`,
  // não env: respeita flag>env>config). `broker` mostra o TIER (`◷ broker · Flui`); `local`
  // (BYO) mostra `◷ local · <provider> · <modelo>` — o usuário escolheu provider+modelo,
  // então NÃO há mapa tier→provider a esconder (CLI-SEC-7/HG-2 só protege o broker) e
  // dispensa o opt-in `ALUY_SHOW_MODEL`/a largura mínima. Nomes do `meta` (pós-resposta) e,
  // no boot, das envs do backend local (`ALUY_LOCAL_PROVIDER`/`ALUY_LOCAL_MODEL`).
  const localByModel = state.meta.backend === 'local';
  const localProviderName =
    state.meta.provider ?? (process.env.ALUY_LOCAL_PROVIDER?.trim() || undefined);
  const localModelName =
    state.meta.model ??
    state.meta.activeModel ??
    (process.env.ALUY_LOCAL_MODEL?.trim() || undefined);
  const displayModel = localByModel
    ? undefined
    : (state.meta.model ?? (showRoutedModel ? state.meta.activeModel : undefined));

  // EST-0962 — NOME DE EXIBIÇÃO do tier (`Granito`), nunca a KEY crua (`aluy-granito`).
  // O catálogo do broker (`modelPicker.tiers`, carregado na 1ª abertura do `/model`)
  // VENCE; antes disso (ou 401/ausente) cai no mapa local FALLBACK_TIERS; tier sem
  // mapa nem catálogo ⇒ a própria key (último recurso). A via Custom mantém a key
  // `custom` (sem mapa) ⇒ exibe `custom`, com o slug indo separado em `state.meta.model`.
  const tierDisplay = localByModel
    ? ['local', localProviderName, localModelName]
        .filter((v) => v !== undefined && v !== '')
        .join(' · ') || 'local'
    : `broker · ${tierDisplayName(state.meta.tier, modelPicker.tiers)}`;

  // ── EST-1000 · ADR-0076 — OVERLAYS de `/` (SlashMenu + pickers + paleta) ─────────
  // EST-1000 (#157 fix) — o <SlashMenu>, os pickers abertos POR `/` (model/theme/lang/
  // history) e a <CommandPalette> (Ctrl+P) são overlays MODAIS: abrem SOBRE a superfície
  // ativa (inline OU cockpit). O ESTADO (`slashOpen`/`*Picker.open`/`palette.open`) é o
  // MESMO nas duas superfícies (o `useInput` já trata as teclas); só o JSX precisava
  // existir nos DOIS caminhos. Extraímos os MESMOS componentes do inline p/ um nó ÚNICO
  // (`slashOverlays`), reusado AQUI (passado ao <Cockpit> como popover sobre a conversa)
  // e ABAIXO (inline, ancorado sob o composer — #129, layout intacto). Sem duplicar
  // componente: uma fonte de render, duas posições. `overlayOpen` resume "há overlay
  // aberto?" p/ o cockpit decidir trocar a região da conversa pelo popover.
  const overlayOpen =
    slashOpen ||
    modelPicker.open ||
    themePicker.open ||
    langPicker.open ||
    providerPicker.open ||
    historyPicker.open ||
    rewindPicker.open ||
    palette.open;
  const slashOverlays = (
    <>
      {palette.open && (
        <Box flexDirection="column" paddingBottom={1}>
          <CommandPalette
            hits={palette.hits}
            selected={palette.selected}
            query={palette.query}
            maxRows={Math.min(8, slashMenuRowCap)}
          />
        </Box>
      )}
      {slashOpen && (
        <Box flexDirection="column">
          {/* TETO de altura: SEM `maxRows` o menu despejava a lista INTEIRA (40+ comandos) e
              "ocupava a tela toda", empurrando o histórico pro scrollback — e ao fechar (`/`
              apagado) a tela não voltava. Janela de 8 (como a <CommandPalette> irmã): o menu
              fica compacto, o histórico não é empurrado pra fora e fechar não desloca a vista. */}
          <SlashMenu
            commands={slashCommands}
            selected={slashSel}
            query={slashQuery}
            maxRows={Math.min(8, slashMenuRowCap)}
            columns={columns}
          />
        </Box>
      )}
      {modelPicker.open && (
        <Box flexDirection="column">
          <ModelPicker
            tiers={modelPicker.tiers}
            selected={modelPicker.selected}
            currentTier={state.meta.tier}
            loading={modelPicker.loading}
            usingFallback={modelPicker.usingFallback}
            customSelected={modelPicker.customSelected}
            customInputOpen={modelPicker.customInputOpen}
            customInput={modelPicker.customInput}
            customSuggestions={modelPicker.customSuggestions}
            customWarnOutOfCatalog={modelPicker.customWarnOutOfCatalog}
            customBrowserAvailable={modelPicker.customBrowserAvailable}
            customRows={modelPicker.customRows}
            customFilteredCount={modelPicker.customFilteredCount}
            customTotalCount={modelPicker.customTotalCount}
            customHasMoreAbove={modelPicker.customHasMoreAbove}
            customHasMoreBelow={modelPicker.customHasMoreBelow}
            customToolsOnly={modelPicker.customToolsOnly}
            customNoToolsWarning={modelPicker.customNoToolsWarning}
            effortStepOpen={modelPicker.effortStepOpen}
            effortOptions={modelPicker.effortOptions}
            effortSelected={modelPicker.effortSelected}
            {...(modelPicker.currentEffort !== undefined
              ? { currentEffort: modelPicker.currentEffort }
              : {})}
            effortCustomOpen={modelPicker.effortCustomOpen}
            effortCustomInput={modelPicker.effortCustomInput}
            effortCustomWarn={modelPicker.effortCustomWarn}
          />
        </Box>
      )}
      {themePicker.open && (
        <Box flexDirection="column">
          <ThemePicker
            themes={themePicker.themes}
            selected={themePicker.selected}
            currentTheme={currentTheme}
          />
        </Box>
      )}
      {langPicker.open && (
        <Box flexDirection="column">
          <LangPicker
            langs={langPicker.langs}
            selected={langPicker.selected}
            currentLang={currentLang}
          />
        </Box>
      )}
      {providerPicker.open && (
        <Box flexDirection="column">
          <ProviderPicker
            providers={providerPicker.providers}
            selected={providerPicker.selected}
            usingFallback={providerPicker.usingFallback}
            maxRows={slashMenuRowCap - 2}
            columns={columns}
            {...(currentProvider !== undefined ? { currentProvider } : {})}
          />
        </Box>
      )}
      {historyPicker.open && (
        <Box flexDirection="column">
          <HistoryPicker sessions={historyPicker.sessions} selected={historyPicker.selected} />
        </Box>
      )}
      {rewindPicker.open && rewindPicker.phase !== 'closed' && (
        <Box flexDirection="column">
          <RewindPicker
            phase={rewindPicker.phase}
            checkpoints={rewindPicker.checkpoints}
            actions={rewindPicker.actions}
            target={rewindPicker.target}
            selected={rewindPicker.selected}
            barrierWarnings={rewindBarriers}
          />
        </Box>
      )}
    </>
  );

  // ── EST-1000 · ADR-0076 — MODO COCKPIT (tela cheia, 6 regiões) ──────────────────
  // Quando o cockpit está ATIVO (fullscreen pedido E o layout cabe — ADR §6), a App
  // renderiza a 2ª superfície: <Cockpit> com as 6 regiões de altura FIXA (soma == rows,
  // anti-flicker §5). Reusa Header/StatusBar/Composer/FooterHints/ActivityLog + o
  // <BlockView> da conversa (uma fonte só). O boot ainda mostra o splash; fora do boot,
  // o cockpit assume. A digitação no composer e os slash-commands SEGUEM funcionando (o
  // useInput trata o composer normalmente; só as teclas de navegação de região são do
  // cockpit). A recusa narrow/short NÃO chega aqui (cai no inline, abaixo, com aviso).
  // Os overlays de `/` (SlashMenu/pickers/paleta) entram como POPOVER (`slashOverlays`)
  // SOBRE a região da conversa — sem inflar o grid (a região é Box de altura fixa, §5).
  if (cockpitActive && state.phase !== 'boot' && cockpitLayout.kind === 'cockpit') {
    return (
      <Cockpit
        state={state}
        layout={cockpitLayout}
        logSections={cockpitLogSections}
        focus={cockpitFocus}
        conversaScroll={conversaScroll}
        logScroll={logScroll}
        input={input}
        cursorPos={cursorPos}
        composerActive={composerActive}
        showCursor={composerShowCursor}
        hintState={hintState}
        tierDisplay={tierDisplay}
        isDefaultTier={isDefaultTier}
        columns={columns}
        frame={frame}
        cwd={state.meta.cwd}
        overlay={overlayOpen ? slashOverlays : null}
        {...(props.version !== undefined ? { version: props.version } : {})}
      />
    );
  }

  // EST-0989 (#125) — o `◔ quota` no FIM da linha primária do <StatusBar>: o % de
  // consumo de BILLING (janela 5h/semana do broker). Derivado da MESMA fonte do
  // <QuotaFooter> (`formatQuota`): a janela que mais "aperta" (maior %) + seu nível de
  // cor. SEM janela (dev/PAT, `windows:[]`) ⇒ `undefined` ⇒ o campo NÃO aparece
  // (degrada/oculto — o crédito/reset ricos seguem no <QuotaFooter> em repouso).
  const quotaView = formatQuota(state.meta.quota);
  const dominantQuota =
    quotaView !== undefined && quotaView.segments.length > 0
      ? quotaView.segments.reduce((a, b) => (b.pct > a.pct ? b : a))
      : undefined;

  // EST-0989 — HEADER PINADO NO TOPO: o header é o PRIMEIRO item do MESMO `<Static>`
  // que carrega o histórico, então ele fica ACIMA dos turnos no scrollback (e não
  // mais ESPREMIDO entre histórico e input). O sentinela `HEADER_ITEM` é o item 0; os
  // blocos concluídos vêm depois. (Só conteúdo do Static fica fixo acima do frame
  // vivo do Ink — daí ser preciso o header morar DENTRO do Static, não antes dele.)
  const staticItems: StaticItem[] = [HEADER_ITEM, ...done];

  // EST-0990 — contagem de eventos do log (p/ o badge `●N` de novidade no modo TABS).
  const logSectionEventCount = logSections.reduce((n, s) => n + s.events.length, 0);

  // EST-0990 — a COLUNA DO CHAT VIVO (o sufixo vivo de hoje): blocos vivos + thinking +
  // progresso + ask/budget/stuck gates. Extraída p/ uma const REUSADA pelos 3 modos
  // (single/side/tabs) — o conteúdo é IDÊNTICO; só o CONTÊINER muda (1 col vs row vs
  // aba). O `maxLines` é o `splitMaxLines` (= `liveMaxLines` em single; orçado p/ as 2
  // colunas em side/tabs), mantendo a região viva em `rows-1` (anti-flicker).
  const liveChatColumn = (
    <>
      {state.blocks.length === 0 && state.phase === 'idle' ? (
        <Onboarding {...(props.userName !== undefined ? { name: props.userName } : {})} />
      ) : (
        // Só os blocos VIVOS (sufixo). `isCurrent` só p/ o ÚLTIMO bloco da sessão.
        live.map((b, i) => (
          <BlockView
            key={liveStart + i}
            block={b}
            isCurrent={liveStart + i === state.blocks.length - 1}
            frame={frame}
            maxLines={splitMaxLines}
            columns={splitLayout === 'side' ? splitRes.chatCols : columns}
          />
        ))
      )}

      {/* pensando pré-stream (§2.4): a "vau" âmbar enche o vácuo até o 1º token */}
      {/* F55 — Λ aluy visível quando NADA mais se move: `thinking` (vácuo pré-1º-token)
           e `retrying` (backoff). NO `streaming` o próprio texto da resposta é o
           indicador vivo — mostrar o Λ junto duplica ("bolinha + processando ao mesmo
           tempo"). No `tool` o <ToolLine> ○ cobre. Por isso só thinking+retrying. */}
      {(state.phase === 'thinking' || state.phase === 'retrying') && (
        <Box paddingTop={state.blocks.length > 0 ? 1 : 0}>
          <Working
            glyph="aluy"
            glyphRole="accent"
            label={state.workingLabel ?? 'pensando'}
            frame={frame}
          />
        </Box>
      )}

      {/* EST-0973 — PROGRESSO de op longa (1ª: `/compact`). Indeterminado por padrão
          (spinner + elapsed `compactando a conversa… 0:03`); se a op reportar etapas
          (`value`+`max`), vira a barra ▰▰▱ + N%. O elapsed avança pelo tick de 1s. */}
      {state.phase === 'compacting' && state.progress && (
        <Box paddingTop={state.blocks.length > 0 ? 1 : 0}>
          <ProgressBar
            label={state.progress.label}
            frame={frame}
            elapsedMs={compactElapsedMs}
            {...(state.progress.value !== undefined ? { value: state.progress.value } : {})}
            {...(state.progress.max !== undefined ? { max: state.progress.max } : {})}
          />
        </Box>
      )}

      {state.phase === 'asking' && state.pendingAsk && (
        <Box paddingTop={1}>
          <AskDialog request={state.pendingAsk.request} {...askEgress} />
        </Box>
      )}

      {/* EST-1110 · ADR-0114 — <QuestionDialog>: a PERGUNTA pendente (`perguntar`). */}
      {state.phase === 'questioning' && state.pendingQuestion && (
        <Box paddingTop={1}>
          <QuestionDialog
            spec={state.pendingQuestion.spec}
            cursor={qCursor}
            selected={qSelected}
            editing={qEditing}
            draft={qDraft}
          />
        </Box>
      )}

      {state.phase === 'budget' && state.pendingBudget && (
        <Box paddingTop={1}>
          <BudgetGate {...state.pendingBudget} canCompact={controller.canCompact} />
        </Box>
      )}

      {/* ADR-0137 (Fatia 3) — gate do TETO do /cycle: o teto duro bateu mas o juiz pediu
          continuar; pergunta ao humano [c] continua / [n] encerra com o motivo do juiz
          (DADO rotulado, 1 linha). Default seguro = encerrar (n/timeout/esc). */}
      {state.phase === 'cycle-ceiling' && state.pendingCycleCeiling && (
        <Box paddingTop={1}>
          <CycleCeilingGate {...state.pendingCycleCeiling} />
        </Box>
      )}

      {/* EST-1015 · ADR-0072 §3b (opção (c) do dono) — CONFIRMAÇÃO de Tab→YOLO. Modal
          single-key: ativar o YOLO (catraca off) exige um [s] explícito, como o `--yolo`
          no boot. `warn` (accent forte) p/ o usuário PERCEBER que vai desligar a aprovação. */}
      {state.pendingUnsafeConfirm === true && (
        <Box paddingTop={1} flexDirection="column">
          <Role name="accent">⚠ ativar MODO YOLO? A catraca de aprovação será DESLIGADA.</Role>
          <Role name="fgDim">
            (a cerca de FS e a rede interna seguem confinadas — só a aprovação cai)
          </Role>
          <Role name="fgDim">[s] sim, ativar · [n] não (Esc cancela)</Role>
        </Box>
      )}

      {/* EST-0969 (watchdog) — pausa-pede-direção: o agente travou; o gate resume o
          que travou e oferece [r] redirecionar / [c] continuar / [n] encerrar. */}
      {state.phase === 'stuck' && state.pendingStuck && (
        <Box paddingTop={1}>
          <StuckGate {...state.pendingStuck} redirecting={stuckRedirecting} />
        </Box>
      )}
    </>
  );

  // ── SPLASH de boot (spec §2.1) — o indicador de modo acompanha desde o boot ──
  // EST-0959 · ADR-0055: o indicador é SEMPRE visível (inclusive no boot) e
  // reativo ao `state.mode` (Tab cicla). Em `unsafe` vira o banner gritante.
  if (state.phase === 'boot') {
    return (
      <Box flexDirection="column">
        <Box paddingBottom={1}>
          <ModeIndicator mode={state.mode} columns={columns} />
        </Box>
        <Boot
          tier={tierDisplay}
          columns={columns}
          frame={frame}
          status={state.workingLabel ?? 'conectando'}
          {...(props.version !== undefined ? { version: props.version } : {})}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* ── HEADER PINADO NO TOPO + HISTÓRICO IMUTÁVEL, ambos no `<Static>` ───────
          EST-0989 — o Ink só mantém o conteúdo do `<Static>` ACIMA do frame vivo
          (escrito uma vez no scrollback, no topo). Pra fixar o HEADER no TOPO —
          ACIMA do histórico — ele precisa ser o PRIMEIRO item do MESMO Static (não
          basta vir antes no JSX: tudo fora do Static renderiza no frame vivo, lá
          embaixo). Então prefixamos um item-sentinela `__header` aos blocos
          concluídos: item 0 é o header (banner+info, emoldurado pelas divisórias),
          os demais são os turnos do histórico crescendo ABAIXO dele.

          O Ink escreve cada item UMA vez e NUNCA mais o re-renderiza ⇒ o header
          (chrome ESTÁTICO) e o histórico não tremem com o token do stream nem com o
          `frame` do tick (anti-flicker EST-0965 intacto). A INFO VIVA de saúde do
          broker (`⚠ erro`) NÃO mora aqui — ela tem casa VIVA no <StatusBar> do
          rodapé (que já reflete `phase === 'error'` a cada frame). `key` estável:
          'header' p/ o sentinela, índice absoluto (deslocado de 1) p/ os blocos. */}
      {/* EST-0948 (composer/sessão) — `key={staticKey}`: o `/clear` BUMPA a key p/
          REMONTAR o `<Static>`. O Ink mantém um contador interno dos itens já
          commitados no scrollback e só escreve os NOVOS; remontar (key nova ⇒ árvore
          nova p/ o React) zera esse contador, então o Ink re-escreve do começo numa
          tela já limpa (ver clearScreen). Em uso normal a key não muda ⇒ anti-flicker
          intacto (o Static segue escrevendo cada turno UMA vez). */}
      <Static key={staticKey} items={staticItems}>
        {(item, i) => {
          if (item === HEADER_ITEM) {
            // Item 0 — HEADER no TOPO, emoldurado pelas divisórias (EST-0987/0985).
            return (
              <Box key="header" flexDirection="column">
                {/* EST-0987 (1/3) — divisória ACIMA do header. */}
                {showHeaderDivider && <Divider columns={columns} />}
                <Header
                  tier={tierDisplay}
                  columns={columns}
                  rows={rows}
                  {...(props.version !== undefined ? { version: props.version } : {})}
                  {...(state.meta.backend !== undefined ? { backend: state.meta.backend } : {})}
                />
                {/* EST-0985 (1/3) — divisória SOB o header: separa o chrome
                    (marca/tier) do corpo da conversa. */}
                {showHeaderDivider && <Divider columns={columns} />}
              </Box>
            );
          }
          const block = item;
          // `i` inclui o sentinela (índice 0); o índice absoluto do bloco é i-1.
          const blockIndex = i - 1;
          return (
            <Box key={blockIndex} flexDirection="column">
              {/* EST-0987 (3/3) — divisória SUTIL de RESPIRO entre turnos do
                  histórico. Antes de cada `you` que NÃO é o 1º turno, um traço
                  CURTO no papel apagado (subtle) separa o turno anterior do novo. */}
              {block.kind === 'you' && blockIndex > 0 && (
                <Box paddingBottom={1}>
                  <Divider columns={columns} subtle />
                </Box>
              )}
              <BlockView block={block} isCurrent={false} frame={0} columns={columns} />
            </Box>
          );
        }}
      </Static>

      {/* ── REGIÃO VIVA (dinâmica) — só o que ainda muda ─────────────────────────
          Indicador de modo + turno em streaming/tool running + thinking + ask/budget
          + composer/status. É o ÚNICO trecho re-renderizado por token/frame; o
          header saiu daqui (foi pro topo do Static), mantendo o redesenho enxuto.

          EST-0990 — MODO VIEW AVANÇADO: a COLUNA ESQUERDA (chat vivo) é a MESMA de
          hoje — só o SUFIXO vivo, NUNCA o histórico (que segue no <Static> full-width,
          intacto — a trava anti-flicker #95/#118: não reintroduzir o redesenho do
          histórico). Quando o split está LIGADO e a largura permite, a coluna do LOG
          (<ActivityLog>, lê a projeção REDIGIDA da FlowTree) entra ao lado via
          `flexDirection="row"`; as duas colunas dividem a altura do frame (orçada por
          `splitLiveBudget`). Em `single` (OFF/estreito) é 1 coluna, idêntica a hoje. */}

      {/* EST-0990 — AVISO de split DESABILITADO por largura (<60 col): pediu o split
          (toggle/flag/config ON) mas a tela é estreita demais ⇒ 1 coluna + esta nota
          honesta (a11y: a palavra carrega o sentido). Some ao alargar / desligar. */}
      {splitRes.disabledByWidth && (
        <Box paddingTop={1}>
          <Role name="fgDim">
            {'split desabilitado: tela estreita (<60 col) — alargue o terminal ou /split'}
          </Role>
        </Box>
      )}

      {splitLayout === 'single' ? (
        <Box flexDirection="column" paddingY={1}>
          {liveChatColumn}
        </Box>
      ) : splitLayout === 'side' ? (
        <Box flexDirection="column" paddingY={1}>
          {/* Linha de RÓTULOS (chrome +1 em split — orçado). SÓ o painel de LOG se
              rotula: a conversa é OBVIAMENTE o chat — um letreiro "CHAT" à esquerda só
              polui (EST-0990, polish). O `LOG` fica alinhado SOBRE a coluna do log (a
              caixa-fantasma à esquerda ocupa a largura do chat); o divisor vertical já
              separa os painéis. FOCADO em accent, passivo em fgDim. SEM borda pintada por
              painel (borda viva = re-render — anti-flicker). */}
          <Box>
            <Box width={splitRes.chatCols} />
            <Role name="fgDim">│ </Role>
            <Role name={logFocused ? 'accent' : 'fgDim'}>LOG</Role>
          </Box>
          {/* As DUAS colunas vivas LADO-A-LADO (mesma altura de frame). */}
          <Box flexDirection="row">
            <Box flexDirection="column" width={splitRes.chatCols}>
              {liveChatColumn}
            </Box>
            <Box width={1} flexShrink={0}>
              <Role name="fgDim">│</Role>
            </Box>
            <Box flexDirection="column" width={splitRes.logCols} flexShrink={0}>
              <ActivityLog
                sections={logSections}
                visibleRows={LOG_VISIBLE_ROWS}
                scrollOffset={logScroll}
                focused={logFocused}
                columns={splitRes.logCols}
              />
            </Box>
          </Box>
        </Box>
      ) : (
        // TABS (60–99 col): a barra de abas (chrome +1) + a coluna ATIVA. Tab/Ctrl+L
        // alterna; o badge `●N` na aba do log sinaliza novidade quando o chat está ativo.
        <Box flexDirection="column" paddingY={1}>
          <Box>
            <Role name={tabsActive === 'chat' ? 'accent' : 'fgDim'}>▎CHAT</Role>
            <Text> </Text>
            <Role name={tabsActive === 'log' ? 'accent' : 'fgDim'}>LOG</Role>
            {tabsActive !== 'log' && logSections.length > 0 && (
              <Role name="accent"> ●{Math.min(99, logSectionEventCount)}</Role>
            )}
          </Box>
          {tabsActive === 'log' ? (
            <ActivityLog
              sections={logSections}
              visibleRows={LOG_VISIBLE_ROWS}
              scrollOffset={logScroll}
              focused={logFocused}
              columns={columns}
            />
          ) : (
            liveChatColumn
          )}
        </Box>
      )}

      {/* EST-0974 — o <SlashMenu> e os pickers ABERTOS POR `/` (model/theme/history)
          NÃO renderizam mais AQUI (acima do composer). Eles migraram p/ ABAIXO do
          composer (logo após o <Composer>), pra o composer ficar ANCORADO: abrir/
          filtrar o menu não muda mais a linha do input (o "subir e descer" que
          incomodava). O menu cresce/encolhe PRA BAIXO. Ver o bloco "MENU/PICKERS
          DE `/` ABAIXO DO COMPOSER" depois do <Composer>. */}

      {/* EST-0961 — command palette (Ctrl+P): índice fuzzy de comandos/ações. */}
      {palette.open && (
        <Box flexDirection="column" paddingBottom={1}>
          <CommandPalette
            hits={palette.hits}
            selected={palette.selected}
            query={palette.query}
            maxRows={Math.min(8, slashMenuRowCap)}
          />
        </Box>
      )}

      {/* EST-0974 — `/model` (ModelPicker) migrou p/ ABAIXO do composer (junto do
          <SlashMenu>). Ver o bloco depois do <Composer>. */}

      {/* EST-0968 — painel interativo `/permissions` (mesma mecânica dos pickers). */}
      {permPanel.open && (
        <Box flexDirection="column" paddingBottom={1}>
          {/* F88 (anti-flicker) — `maxRows` JANELA o painel (grants acumulam numa sessão
              longa) p/ não estourar `rows` no inline ⇒ evita o full-screen do Ink
              (clearTerminal/frame) que pisca no Windows. `-6` reserva help + modo-atual +
              cabeçalhos de seção + rodapé do painel (chrome além do menu). */}
          <PermissionsPanel
            rows={permPanel.rows}
            selected={permPanel.selected}
            mode={permPanel.mode}
            columns={columns}
            maxRows={Math.max(4, slashMenuRowCap - 6)}
          />
        </Box>
      )}

      {/* EST-0982 · ADR-0063 — painel de CONTROLE/OBSERVABILIDADE da árvore de fluxos
          (VER drill-in · PARAR um/todos · INTERAGIR). Modal: captura o foco quando
          aberto (Ctrl+T). A árvore/contabilidade vêm do controller (FlowTree). */}
      {flowOpen && (
        <Box flexDirection="column" paddingBottom={1}>
          {/* F88 (anti-flicker) — `maxRows` JANELA o overview da árvore (até
              MAX_TERMINAL_NODES=32 nós numa sessão pesada) p/ não estourar `rows` no
              inline ⇒ evita o full-screen do Ink (clearTerminal/frame) que pisca no
              Windows. `-2` reserva o cabeçalho + legenda do painel (chrome além do menu).
              O drill-in já é limitado no core (MAX_RECENT=12). */}
          <FlowTreeView
            overview={controller.flowOverview()}
            selected={flowSel}
            maxRows={Math.max(4, slashMenuRowCap - 2)}
            columns={columns}
            {...(!cycleUiOff && state.cycleProgress !== undefined
              ? { cycleProgress: state.cycleProgress }
              : {})}
            {...(flowDrill ? { drillIn: controller.drillInFlow(flowDrill) } : {})}
          />
        </Box>
      )}

      {/* EST-0974 — `/theme` (ThemePicker) e `/history` (HistoryPicker) migraram p/
          ABAIXO do composer (junto do <SlashMenu>). Ver o bloco depois do <Composer>. */}

      {/* EST-0957 — picker `@arquivo` (mesma mecânica do slash-menu). */}
      {picker.open && (
        <Box flexDirection="column" paddingBottom={1}>
          <FilePicker
            hits={picker.hits}
            selected={picker.selected}
            query={picker.query}
            columns={columns}
          />
        </Box>
      )}

      {/* EST-0957 (revisor #3) — recusa de anexo na TUI: o motivo NÃO falha mudo.
          Aviso `◷` (papel do DS, NoteBlock) acima do composer; some na próxima ação. */}
      {picker.notice !== null && (
        <Box paddingBottom={1}>
          <NoteBlock title="anexo recusado" lines={[picker.notice]} />
        </Box>
      )}

      {/* EST-0957 — chips dos arquivos anexados ao turno (removíveis, §4.2). */}
      {picker.attachments.length > 0 && (
        <Box paddingBottom={1}>
          <AttachChips
            chips={picker.attachments.map((a) => ({ path: a.path, truncated: a.truncated }))}
            active={picker.attachments.length - 1}
          />
        </Box>
      )}

      {/* EST-0982 (type-ahead) — a FILA de mensagens digitadas DURANTE o trabalho
          (Enter enfileira). Mostra as pendentes ACIMA do composer; some quando vazia.
          BOUNDED (`queuedInputsLines`) e descontada do orçamento da fala (anti-flicker).
          Fora da região viva animada — não treme com o token/frame. */}
      {queue.length > 0 && (
        <Box paddingBottom={1}>
          <QueuedInputs items={queue} />
        </Box>
      )}

      {/* EST-0982 (mid-turn UX) — INDICADOR "encaixando…": o texto puro injetado num
          turno VIVO (`injectInput('root', …)`) fica VISÍVEL aqui ENQUANTO espera o loop
          drenar (entre o Enter e a próxima iteração). Some quando o loop incorpora (vira
          o `InjectBlock` "↳ encaixado" no histórico) ou no fim/abort do turno (sem ghost).
          Itens = ecos JÁ REDIGIDOS (CLI-SEC-6 — nunca texto cru). Altura BOUNDED descontada
          do orçamento (`pendingInjectLines`), fora da região viva (não treme). */}
      {state.pendingInjects.length > 0 && (
        <Box paddingBottom={1}>
          <PendingInjects items={state.pendingInjects} />
        </Box>
      )}
      {/* `/ask` EM VOO — área SEPARADA da fila (canal lateral ↗), até a resposta chegar. */}
      {state.pendingAsks.length > 0 && (
        <Box paddingBottom={1}>
          <PendingAsks items={state.pendingAsks} />
        </Box>
      )}

      {/* EST-0985 (2/3) — divisória ACIMA DO INPUT: separa a conversa do composer e,
          com a (3/3) abaixo, EMOLDURA o composer de forma SIMÉTRICA. Fica fora da
          região viva animada (sem jitter); largura total estável.
          EST-0985 (polish, #985→#…) — INCONDICIONAL: antes era gated por `hasTurns`
          (herdado do colapso EST-0987, quando header e composer ficavam COLADOS no
          layout antigo). Hoje o header vive no <Static> no TOPO e o composer no
          rodapé da região viva, SEPARADOS pelo corpo (Onboarding/histórico) — então
          a régua acima do composer NUNCA encosta na "sob o header". Gatear por turnos
          só DESMOLDURAVA o composer em sessão fresca / pós-`/clear` (sumia a de cima,
          ficava a de baixo). A do HEADER segue gated por densidade (`showHeaderDivider`);
          esta — que emoldura o composer — é sempre visível. */}
      <Divider columns={columns} />

      <Composer
        value={input}
        cursorPos={cursorPos}
        active={composerActive}
        showCursor={composerShowCursor}
        maxRows={inlineComposerMaxRows}
        columns={columns}
        shellMode={input.startsWith('!')}
        {...(composerHint !== undefined ? { hint: composerHint } : {})}
        {...(state.meta.label !== undefined ? { sessionLabel: state.meta.label } : {})}
        {...(state.meta.labelColor !== undefined ? { sessionColor: state.meta.labelColor } : {})}
      />

      {/* ── MENU/PICKERS DE `/` ABAIXO DO COMPOSER (EST-0974) ────────────────────
          O <SlashMenu> e os pickers abertos POR `/` (model/theme/history) renderizam
          AQUI — logo abaixo do <Composer> (ancorado), entre ele e o rodapé. Antes
          moravam ACIMA do composer: abrir/filtrar/crescer/encolher o menu MUDAVA a
          linha do input ("subir e descer", reclamação do Tiago). Agora o composer é o
          PONTO FIXO e o menu cresce/encolhe PRA BAIXO, empurrando só o rodapé.

          Navegação intacta: ↑↓ navega, Tab completa, Enter executa/enfileira, esc
          fecha (a captura de teclas é a MESMA — só a posição de render mudou). A
          ordem visual dos itens é a mesma de antes, então ↑/↓ seguem intuitivos (o
          item de cima é o "anterior", o de baixo é o "próximo"); nada a inverter.

          Anti-flicker (#95/#118): estes overlays são abertos por `/` e capturam o
          foco; o <SlashMenu> pode coexistir com o stream (EST-0982). A altura que
          ocupam é a MESMA de antes (só mudou a ordem vertical, não a contagem de
          linhas vivas) ⇒ o orçamento (`LIVE_CHROME_ROWS`/`speechMaxLines`) não muda. */}
      {slashOpen && (
        <Box flexDirection="column" paddingTop={1}>
          {/* EST-1015 — `maxRows` CAPA a altura (janela ↑N/↓N) p/ o menu não estourar `rows` e
              deixar fantasma ao fechar (só o INLINE; o do cockpit é clipado por conversaRows). */}
          <SlashMenu
            commands={slashCommands}
            selected={slashSel}
            query={slashQuery}
            maxRows={slashMenuRowCap}
            columns={columns}
          />
        </Box>
      )}

      {/* EST-0962 — seletor `/model` (mesma mecânica do slash-menu/file-picker). */}
      {modelPicker.open && (
        <Box flexDirection="column" paddingTop={1}>
          <ModelPicker
            tiers={modelPicker.tiers}
            selected={modelPicker.selected}
            currentTier={state.meta.tier}
            loading={modelPicker.loading}
            usingFallback={modelPicker.usingFallback}
            customSelected={modelPicker.customSelected}
            customInputOpen={modelPicker.customInputOpen}
            customInput={modelPicker.customInput}
            customSuggestions={modelPicker.customSuggestions}
            customWarnOutOfCatalog={modelPicker.customWarnOutOfCatalog}
            customBrowserAvailable={modelPicker.customBrowserAvailable}
            customRows={modelPicker.customRows}
            customFilteredCount={modelPicker.customFilteredCount}
            customTotalCount={modelPicker.customTotalCount}
            customHasMoreAbove={modelPicker.customHasMoreAbove}
            customHasMoreBelow={modelPicker.customHasMoreBelow}
            customToolsOnly={modelPicker.customToolsOnly}
            customNoToolsWarning={modelPicker.customNoToolsWarning}
            effortStepOpen={modelPicker.effortStepOpen}
            effortOptions={modelPicker.effortOptions}
            effortSelected={modelPicker.effortSelected}
            {...(modelPicker.currentEffort !== undefined
              ? { currentEffort: modelPicker.currentEffort }
              : {})}
            effortCustomOpen={modelPicker.effortCustomOpen}
            effortCustomInput={modelPicker.effortCustomInput}
            effortCustomWarn={modelPicker.effortCustomWarn}
          />
        </Box>
      )}

      {/* EST-0966 — seletor `/theme` (mesma mecânica do slash-menu/model-picker). */}
      {themePicker.open && (
        <Box flexDirection="column" paddingTop={1}>
          <ThemePicker
            themes={themePicker.themes}
            selected={themePicker.selected}
            currentTheme={currentTheme}
          />
        </Box>
      )}

      {/* EST-0989 (i18n) — seletor `/lang` (mesma mecânica dos pickers): lista os
          idiomas (pt-BR/en) e troca o ativo. Espelha o <ThemePicker>. */}
      {langPicker.open && (
        <Box flexDirection="column" paddingTop={1}>
          <LangPicker
            langs={langPicker.langs}
            selected={langPicker.selected}
            currentLang={currentLang}
          />
        </Box>
      )}

      {/* EST-0972 — seletor `/history` (mesma mecânica dos pickers): lista as sessões
          anteriores e retoma a escolhida AO VIVO. */}
      {historyPicker.open && (
        <Box flexDirection="column" paddingTop={1}>
          {/* F88 (anti-flicker) — `maxRows` JANELA a lista (↑↓ rola) p/ dezenas de sessões
              salvas não estourarem `rows` no inline ⇒ o Ink cairia no full-screen
              (clearTerminal/frame) e piscaria no Windows. Reusa o cap do overlay
              (`slashMenuRowCap`); o componente ainda tem default próprio (10). */}
          <HistoryPicker
            sessions={historyPicker.sessions}
            selected={historyPicker.selected}
            maxRows={slashMenuRowCap - 2}
            columns={columns}
          />
        </Box>
      )}

      {/* EST-XXXX — seletor `/rewind` (· Esc Esc): pontos da sessão + ação. */}
      {rewindPicker.open && rewindPicker.phase !== 'closed' && (
        <Box flexDirection="column" paddingTop={1}>
          {/* F88 (anti-flicker) — `maxRows` JANELA os checkpoints (1 por prompt → dezenas
              numa sessão longa) p/ não estourar `rows` no inline ⇒ evita o full-screen do
              Ink (clearTerminal/frame) que pisca no Windows. Reusa o cap do overlay. */}
          <RewindPicker
            phase={rewindPicker.phase}
            checkpoints={rewindPicker.checkpoints}
            actions={rewindPicker.actions}
            target={rewindPicker.target}
            selected={rewindPicker.selected}
            barrierWarnings={rewindBarriers}
            maxRows={slashMenuRowCap - 2}
            columns={columns}
          />
        </Box>
      )}

      {/* EST-0985 (3/3) — divisória ABAIXO DO INPUT: separa o composer da área de
          baixo (status / hints / sub-agentes). Com a (2/3), EMOLDURA o input.
          EST-0974 — quando o menu/picker de `/` está aberto, a divisória vem DEPOIS
          dele (separa o menu do rodapé), preservando a moldura do input. */}
      <Divider columns={columns} />

      {/* EST-0982 · ADR-0063 (CONTABILIDADE) — rodapé do TURNO do agente PRINCIPAL
          (tokens + tempo), estilo Claude Code. Aparece quando o turno terminou
          (done/budget) — leitura/display puro (não dispara efeito, não vaza segredo). */}
      {state.turnAccounting && (state.phase === 'done' || state.phase === 'budget') && (
        <TurnFooter accounting={state.turnAccounting} />
      )}

      {/* EST-0948 · ADR-0069/APR-0074 — footer de QUOTA da PRÓPRIA conta do ator CLI/PAT.
          FONTE REAL (broker#59): `meta.quota` = saldo de CRÉDITO (dimensão PRIMÁRIA do CLI
          — ledger ADR-0038, hard-cap 402) + janelas (5h/semana), do `GET /v1/quota` (boot/
          refresh) + dos campos achatados do `usage` (loop quente). `serverLimits` continua
          passando o `balance_after` do `usage` (surfaça o crédito mesmo antes do 1º
          `/v1/quota` chegar; o aviso de saldo baixo já se ancora nele). ADR-0069 CRAVA o
          CRÉDITO como primário (a janela do app estoura em minutos sob um loop agêntico —
          ADR-0053 §4) — mostramos a janela só QUANDO o broker a reportar (em dev/PAT sem
          janela, `windows:[]` ⇒ ela some). DEGRADA oculto: sem crédito NEM janela, o
          <QuotaFooter> devolve `null` (omite o widget — não inventa número). É BILLING
          (distinta do budget LOCAL anti-runaway do <StatusBar>). Mostrado FORA do stream
          (em repouso) p/ NÃO inflar o chrome vivo (anti-flicker: `LIVE_CHROME_ROWS` conta o
          stream; este só aparece em done/budget/idle/error). */}
      {(state.phase === 'done' ||
        state.phase === 'budget' ||
        state.phase === 'idle' ||
        state.phase === 'error') && (
        <QuotaFooter quota={state.meta.quota} serverLimits={state.meta.serverLimits} />
      )}

      {/* EST-0989 (Variação B) — RESPIRO: 1 LINHA EM BRANCO entre o TurnFooter
          (`◷ tokens · tools · Xs`) / o footer de quota e o <StatusBar> (antes colavam).
          NÃO é divisória — só espaço (`<Box height={1}>` reserva 1 linha vazia). Conta
          no orçamento anti-flicker: `LIVE_CHROME_ROWS` foi RECONTADO 8→9 incluindo este
          espaçador (live-budget.ts). SUPRIMIDO em narrow (<60 col) — espaço é caro lá; o
          chrome segue contando 9 (over-reserva — sempre seguro, nunca estoura `rows-1`).
          O <ModeIndicator>+<FooterHints> SEGUEM coesos logo abaixo (sem respiro entre eles).
          CONDICIONAL: só em telas LARGAS (≥60 col) e ALTAS (≥RESPIRO_MIN_ROWS linhas) — em
          terminais apertados a linha em branco some (anti-flicker antes de estética; o
          orçamento `respiroOverhead` espelha exatamente este gate). */}
      {columns >= 60 && rows >= RESPIRO_MIN_ROWS && <Box height={1} />}

      <StatusBar
        {...(state.meta.branch !== undefined ? { branch: state.meta.branch } : {})}
        cwd={state.meta.cwd}
        tier={tierDisplay}
        isDefaultTier={isDefaultTier}
        {...(displayModel !== undefined
          ? // HG-2/CLI-SEC-7: o `model` da via Custom (slug que o USUÁRIO escolheu) SEMPRE
            // exibe. O `activeModel` (=usage.model resolvido do tier) só entra com o OPT-IN
            // `ALUY_SHOW_MODEL` (default OFF — o binário público NÃO revela o mapa tier→
            // provider; gate AG-0008). `displayModel` já aplicou essa regra acima. A redação
            // server-side do trailer (broker) segue como o caminho p/ expor por default.
            { model: displayModel }
          : {})}
        tokens={state.meta.tokens}
        {...(state.meta.budgetPct !== undefined ? { budgetPct: state.meta.budgetPct } : {})}
        windowPct={state.meta.windowPct}
        {...(dominantQuota !== undefined
          ? { quotaPct: dominantQuota.pct, quotaLevel: dominantQuota.level }
          : {})}
        columns={columns}
        error={state.phase === 'error'}
        {...(state.governance !== undefined ? { governance: state.governance } : {})}
        {...(!cycleUiOff && state.cycleProgress !== undefined
          ? { cycleProgress: state.cycleProgress }
          : {})}
      />
      {/* EST-0959 · ADR-0055 / EST-0989 — INDICADOR DE MODO no RODAPÉ (onde o olho
          descansa). Sempre visível (glifo+palavra, a11y): plan=read-only (petrol),
          normal=catraca (neutro), unsafe=BANNER gritante e persistente (CLI-SEC-3 —
          o aviso loud NÃO regride; o usuário PRECISA ver que a catraca está
          desligada). Reativo: o Tab cicla `normal→plan→unsafe` (invertido) — fica VIVO (fora do
          Static, na região viva do rodapé, já dentro do LIVE_CHROME_ROWS), só mudou
          de lugar (topo→rodapé), sem flicker. */}
      {/* DETACH-FIX (item 4) — AVISO PERSISTENTE de sub-agentes desacoplados vivos (esc). Com o
          teto de relógio em "nunca" (decisão do dono), F8 é o único stop ⇒ o dono PRECISA ver
          que há trabalho órfão rodando. Só quando há ⇒ não infla o frame no caso comum. */}
      {state.detachedSubagents !== undefined && state.detachedSubagents > 0 && (
        <Box>
          <Text color="yellow">
            ⚠ {state.detachedSubagents} sub-agente(s) em segundo plano (esc) — F8 para parar.
          </Text>
        </Box>
      )}
      <ModeIndicator mode={state.mode} columns={columns} />
      {/* fix(footer-bleed) — durante uma APROVAÇÃO ATIVA (`asking`) o <AskDialog> JÁ
          renderiza seu PRÓPRIO footer de atalhos (`a aprova · s sempre · …`), em
          contexto, colado ao diálogo (AskDialog.footerOf, mesmas strings de
          `hints.ask`/`hints.askDestructive`). Repetir o footer AQUI no rodapé —
          separado do diálogo pelo composer + régua + status + modo — fazia a linha de
          aprovação "vazar" PRA BAIXO do composer: um 2º footer idêntico, solto sob o
          input, lido como resíduo entre o diálogo e o composer. A decisão está capturada
          pelo diálogo (o composer já fica dim com "aguardando sua decisão acima"), então
          o rodapé NÃO deve duplicar a dica de ask. Suprimimos os estados de ask aqui; o
          AskDialog é a única fonte da dica durante a catraca. Ao resolver, `hintState`
          volta a `idle`/etc. e o rodapé reaparece — transição limpa ask→composer. */}
      {showHints && hintState && hintState !== 'ask' && hintState !== 'ask-destructive' && (
        <FooterHints
          state={hintState}
          {...(elapsed !== undefined ? { elapsed } : {})}
          {...(ctrlCArmed ? { armedExit: true } : {})}
        />
      )}
    </Box>
  );
}

/** Renderiza um bloco da sessão pelo seu tipo. */
// EST-1000 · ADR-0076 §3 — exportado p/ o <Cockpit> REUSAR o mesmo render de bloco da
// conversa (uma fonte só; o cockpit não duplica a renderização dos turnos).
export function BlockView(props: {
  readonly block: SessionState['blocks'][number];
  readonly isCurrent: boolean;
  readonly frame: number;
  /** Anti-flicker — teto de altura da prévia viva (só p/ o aluy streaming). */
  readonly maxLines?: number;
  /** Largura do terminal (colunas) — p/ medir a altura VISUAL (wrap) da prévia. */
  readonly columns?: number;
}): React.ReactElement {
  const b = props.block;
  switch (b.kind) {
    case 'you':
      return (
        <Box paddingBottom={1}>
          <YouBlock text={b.text} isCurrent={props.isCurrent} />
        </Box>
      );
    case 'aluy':
      return (
        <Box paddingBottom={1}>
          <AluyBlock
            text={b.text}
            streaming={b.streaming}
            isCurrent={props.isCurrent}
            frame={props.frame}
            {...(props.maxLines !== undefined ? { maxLines: props.maxLines } : {})}
            {...(props.columns !== undefined ? { columns: props.columns } : {})}
          />
        </Box>
      );
    case 'tool':
      return (
        <ToolLine
          verb={b.verb}
          target={b.target}
          result={b.result}
          status={b.status}
          frame={props.frame}
          {...(b.verbGerund !== undefined ? { verbGerund: b.verbGerund } : {})}
          {...(b.output !== undefined ? { output: b.output } : {})}
          {...(b.liveOutput !== undefined ? { liveOutput: b.liveOutput } : {})}
          maxLines={LIVE_SHELL_OUTPUT_MAX_LINES}
          {...(props.columns !== undefined ? { columns: props.columns } : {})}
        />
      );
    case 'note':
      return (
        <Box paddingBottom={1}>
          <NoteBlock title={b.title} lines={b.lines} />
        </Box>
      );
    case 'bang':
      // EST-0958 — bloco de saída do `!comando` (atalho de shell do composer).
      return (
        <Box paddingBottom={1}>
          <BangBlock
            command={b.command}
            status={b.status}
            frame={props.frame}
            {...(b.output !== undefined ? { output: b.output } : {})}
            {...(b.liveOutput !== undefined ? { liveOutput: b.liveOutput } : {})}
            maxLines={LIVE_SHELL_OUTPUT_MAX_LINES}
            {...(props.columns !== undefined ? { columns: props.columns } : {})}
          />
        </Box>
      );
    case 'subagents':
      // EST-0969 (display) — indicador compacto dos sub-agentes paralelos: status
      // por filho, NUNCA os tokens crus de cada um (que interleavariam). Bloco
      // estável (sem jitter): só muda na transição de um filho (início/fim).
      return <SubAgents childrenStatus={b.children} />;
    case 'doctor':
      // EST-0970 (ticks AO VIVO) — checklist progressiva do `/doctor`: cada item
      // `pending` (spinner ⠋) "acende" p/ ✓/⚠/✗ quando o probe resolve aquele check.
      // Bloco VIVO enquanto houver pending (o frame anima o spinner); estável depois.
      return (
        <Doctor
          checks={b.checks}
          frame={props.frame}
          {...(b.summary !== undefined ? { summary: b.summary } : {})}
        />
      );
    case 'deny':
      return (
        <Box paddingLeft={2}>
          <Role name="danger">
            [x] negado · {b.verb} {b.exact}
          </Role>
        </Box>
      );
    case 'broker-error':
      return (
        <BrokerError
          message={b.message}
          {...(b.headline !== undefined ? { headline: b.headline } : {})}
          {...(b.status !== undefined ? { status: b.status } : {})}
          {...(b.attempt !== undefined ? { attempt: b.attempt } : {})}
          {...(b.maxAttempts !== undefined ? { maxAttempts: b.maxAttempts } : {})}
          {...(b.retryInSeconds !== undefined ? { retryInSeconds: b.retryInSeconds } : {})}
          {...(b.retrying !== undefined ? { retrying: b.retrying } : {})}
          {...(b.backend !== undefined ? { backend: b.backend } : {})}
        />
      );
    case 'testrun':
      // ADR-0112 · EST-RT-3 — bloco VIVO de progresso de testes: barra + placar +
      // falhas, atualizado IN-PLACE a cada evento do `run_tests`. Frame-driven.
      return (
        <TestRunBlock
          score={b.score}
          running={b.running}
          startedAt={b.startedAt}
          frame={props.frame}
        />
      );
    case 'inject':
      // EST-0982 (mid-turn) — confirmação "↳ encaixado": o "btw" do usuário ENTROU no
      // turno vivo (incorporado entre iterações). Nota leve/dim — feedback, não fala do
      // agente. O eco já vem REDIGIDO (CLI-SEC-6); vazio ⇒ só o rótulo.
      return <InjectAck text={b.text} />;
  }
}

/**
 * EST-0982 (mid-turn) — a nota "↳ encaixado" da injeção mid-turn. Dim, recuada, com o
 * eco REDIGIDO do que entrou (truncado p/ não inundar a região viva). Avisa o usuário
 * que o input foi incorporado no turno em curso (e não engolido / adiado).
 */
function InjectAck(props: { readonly text: string }): React.ReactElement {
  const echo = props.text.trim();
  const shown = echo.length > 80 ? `${echo.slice(0, 80)}…` : echo;
  return (
    <Box paddingLeft={2} paddingBottom={1}>
      <Role name="fgDim">↳ encaixado{shown ? `: ${shown}` : ''}</Role>
    </Box>
  );
}

/**
 * EST-0982 — `true` se o ÚLTIMO bloco relevante é um `!comando` em `running` (o
 * comando do atalho de shell está executando). Usado p/ o esc/Ctrl-C MATAR o
 * comando vivo (interrupt → kill do processo) antes de cair no composer.
 */
function lastBangRunning(blocks: SessionState['blocks']): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b) continue;
    if (b.kind === 'bang') return b.status === 'running';
    // Um bloco mais novo de outra natureza (you/note/…) significa que o último bang
    // já não é o foco — não há comando vivo a matar por este caminho.
    if (b.kind === 'you' || b.kind === 'tool' || b.kind === 'aluy') return false;
  }
  return false;
}

/**
 * EST-0982 (semântica do esc) — `true` se o ÚLTIMO bloco `subagents` tem algum filho
 * `running`: há SUB-AGENTES VIVOS (durante o turno OU desacoplados pós-esc). Puro.
 */
function subAgentsRunning(blocks: SessionState['blocks']): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind === 'subagents') return b.children.some((c) => c.status === 'running');
  }
  return false;
}

/**
 * EST-0970 (ticks AO VIVO) — `true` se o ÚLTIMO bloco `doctor` ainda tem algum check
 * `pending`: a checklist do `/doctor` está RODANDO (o spinner dos itens precisa girar).
 * Some sozinho quando todos resolvem (o bloco fica estável). Puro.
 */
function doctorRunning(blocks: SessionState['blocks']): boolean {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b?.kind === 'doctor') return b.checks.some((c) => c.status === 'pending');
  }
  return false;
}

/** Deriva o estado do footer de atalhos (§4.3) a partir da fase corrente. */
function hintStateOf(
  state: SessionState,
  slashOpen: boolean,
  paletteOpen: boolean,
  subAgentsLive = false,
): HintState | null {
  // EST-0961 — a palette é modal: seu hint tem prioridade quando aberta.
  if (paletteOpen) return 'palette';
  if (slashOpen) return 'slash';
  switch (state.phase) {
    // EST-0948 (auto-retry) — durante o backoff (`retrying`) o footer mostra o mesmo
    // hint do `thinking` ("esc para interromper"): esc cancela a re-tentativa.
    // EST-0982 (semântica do esc) — com SUB-AGENTES VIVOS, o hint de trabalho ensina
    // a parada em dois níveis: "esc para o pai · F8 para tudo".
    case 'thinking':
    case 'retrying':
      return subAgentsLive ? 'work-subagents' : 'thinking';
    case 'streaming':
      return subAgentsLive ? 'work-subagents' : 'streaming';
    case 'asking':
      return state.pendingAsk?.request.category === 'always-ask:destructive'
        ? 'ask-destructive'
        : 'ask';
    case 'budget':
      return 'budget';
    // ADR-0137 (Fatia 3) — o gate do teto do /cycle reusa o hint de budget (`[c]/[n]`).
    case 'cycle-ceiling':
      return 'budget';
    case 'error':
      return 'error';
    case 'idle':
    case 'done':
      // EST-0982 — pós-esc com filhos DESACOPLADOS rodando: o composer está livre,
      // mas o F8 segue sendo o freio dos sub-agentes em segundo plano.
      return subAgentsLive ? 'idle-subagents' : 'idle';
    default:
      return null;
  }
}

/** Deriva o enriquecimento de egress p/ o AskDialog corrente (CLI-SEC-5). */
function computeEgress(
  state: SessionState,
  egress?: EgressAllowlist,
): { egressOutsideAllowlist?: boolean; egressTarget?: string } {
  if (!egress || state.phase !== 'asking' || !state.pendingAsk) return {};
  const eff = state.pendingAsk.request.effect;
  if (eff.kind !== 'network' && eff.kind !== 'command') return {};
  const command = state.pendingAsk.request.call.input['command'];
  const cmd = typeof command === 'string' ? command : '';
  const target = eff.target ?? networkTargetOf(cmd);
  if (target === undefined) return {};
  const inspection = egress.inspect(cmd);
  return {
    egressOutsideAllowlist: inspection.outsideAllowlist,
    egressTarget: target,
  };
}

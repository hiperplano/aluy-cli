// EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG, Variação V2). ORÇAMENTO PURO da
// degradação de LARGURA e da ALTURA do frame no split — o espelho de `live-budget.ts`
// para o eixo HORIZONTAL (colunas) e para a coexistência das DUAS colunas vivas.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ TRAVA ANTI-FLICKER (#95/#118/#0989 — a parte que mais importa):             ║
// ║                                                                            ║
// ║ • O `<Static>` (header + histórico do chat) continua ÚNICO e full-width — a ║
// ║   coluna esquerda VIVA é só o SUFIXO vivo (fala em stream/tool), como hoje. ║
// ║   Este módulo NÃO move o histórico p/ dentro de uma Box viva (era o bug do  ║
// ║   `render-split.ts` original: redesenhar o histórico a cada token).         ║
// ║                                                                            ║
// ║ • As 2 colunas vivas (via `flexDirection="row"`) compartilham a MESMA       ║
// ║   altura de frame: o teto mira `max(coluna_chat, coluna_log) + chrome ≤     ║
// ║   rows-1`. `splitLiveBudget` devolve o teto da FALA (chat) JÁ ciente de que ║
// ║   a coluna do log tem teto PRÓPRIO (`LOG_VISIBLE_ROWS`, em linhas VISUAIS).  ║
// ║                                                                            ║
// ║ • O chrome ganha +1 em split (a linha de rótulos `CHAT │ LOG`) e +1 em tabs ║
// ║   (a linha de abas) — somado SOBRE `LIVE_CHROME_BASE_ROWS`+respiro, sem      ║
// ║   regredir o header/footer (#133, que já recontou a base p/ 8 + respiro).    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PURO (sem React/Ink): só aritmética de layout. Testável sem TUI — e o teste de
// altura de frame (`live-region-height`) confere a conta renderizando de verdade.

import type { SessionBlock, SessionState } from './model.js';
import {
  LIVE_CHROME_BASE_ROWS,
  SAFETY_MARGIN,
  MIN_SPEECH_LINES,
  respiroOverhead,
  liveOverheadLines,
  modeIndicatorOverhead,
} from './live-budget.js';

type SessionPhase = SessionState['phase'];
type SessionMode = SessionState['mode'];

// ── CONSTANTES DE LARGURA (espírito do live-budget) ─────────────────────────────

/** Mínimo de colunas p/ o split LADO-A-LADO (chat | log). Abaixo disto, vira TABS. */
export const SPLIT_MIN_COLS = 100;

/** Mínimo de colunas p/ o split em TABS (alterna chat/log). Abaixo disto, DESABILITA. */
export const TABS_MIN_COLS = 60;

/** Mínimo de colunas que a COLUNA do log precisa p/ ser legível no modo lado-a-lado. */
export const LOG_MIN_COLS = 34;

/** Proporção da largura para o CHAT no modo lado-a-lado (o resto, menos o gutter, é log). */
export const SPLIT_CHAT_RATIO = 0.62;

/** Largura (colunas) do gutter ENTRE as colunas (a régua `│` + respiro). */
export const SPLIT_GUTTER_COLS = 1;

// ── CONSTANTES DE ALTURA (chrome extra do split/tabs + teto do log) ─────────────

/**
 * Linha EXTRA de chrome no split LADO-A-LADO: o cabeçalho de RÓTULOS das colunas
 * (`CHAT │ LOG`, o focado em `accent`). Some no modo single (OFF) / tabs.
 */
export const SPLIT_LABEL_ROWS = 1;

/**
 * Linha EXTRA de chrome no modo TABS: a linha de ABAS (`▎CHAT  LOG ●3`). Some no
 * modo single (OFF) / lado-a-lado.
 */
export const TABS_BAR_ROWS = 1;

/**
 * Teto de altura (linhas VISUAIS) da COLUNA do LOG (`<ActivityLog>`) na região viva.
 * EM LINHAS VISUAIS (lição EST-0965 — wrap): a janela do log é a CAUDA `▼ ao vivo`
 * que cabe nestas linhas; o resto rola no anel em memória (não no scrollback do chat).
 * FIXO (não derivado do teto da fala) p/ QUEBRAR a circularidade — espelha o
 * `LIVE_SHELL_OUTPUT_MAX_LINES`. A coluna do chat e a do log compartilham a altura
 * do frame: o teto da fala mira caber em `rows-1` JUNTO com esta coluna do log.
 */
export const LOG_VISIBLE_ROWS = 12;

// ── RESOLUÇÃO DO LAYOUT (degradação por largura) ────────────────────────────────

/** O modo de layout efetivo do split, resolvido pela largura corrente. */
export type SplitLayout =
  | 'single' // OFF (default) ou desabilitado por largura: 1 coluna, TUI de hoje.
  | 'side' // ≥ SPLIT_MIN_COLS: chat | log LADO-A-LADO.
  | 'tabs'; // TABS_MIN_COLS..SPLIT_MIN_COLS-1: alterna chat/log (Tab/Ctrl+L).

/** Resultado da resolução: o modo + (no `side`) as larguras das colunas. */
export interface SplitResolution {
  readonly layout: SplitLayout;
  /** Largura (colunas) da coluna do CHAT — só relevante em `side`. */
  readonly chatCols: number;
  /** Largura (colunas) da coluna do LOG — só relevante em `side`. */
  readonly logCols: number;
  /**
   * `true` quando o usuário PEDIU split (toggle/flag/config ON) mas a largura é
   * estreita demais (`< TABS_MIN_COLS`) ⇒ caímos em `single` COM AVISO. Distingue
   * "OFF por escolha" (sem aviso) de "ON mas desabilitado pela largura" (com aviso).
   */
  readonly disabledByWidth: boolean;
}

/**
 * Resolve o layout do split pela LARGURA corrente, dado se o split está LIGADO
 * (toggle/flag/config). PURO. Ordem da degradação (a spec V2):
 *   • split OFF                         ⇒ `single` (TUI de hoje, sem aviso).
 *   • ON & columns ≥ SPLIT_MIN_COLS     ⇒ `side` (lado-a-lado) — desde que a coluna
 *     do log caiba em `LOG_MIN_COLS` (senão cai p/ `tabs`, defensivo).
 *   • ON & TABS_MIN_COLS ≤ cols < 100   ⇒ `tabs` (alterna).
 *   • ON & columns < TABS_MIN_COLS      ⇒ `single` + `disabledByWidth` (aviso).
 */
export function resolveSplitLayout(columns: number, enabled: boolean): SplitResolution {
  const cols = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 0;
  if (!enabled) {
    return { layout: 'single', chatCols: cols, logCols: 0, disabledByWidth: false };
  }
  if (cols < TABS_MIN_COLS) {
    // Pediu split mas é estreito demais: 1 coluna + aviso (a spec: "<60 desabilita").
    return { layout: 'single', chatCols: cols, logCols: 0, disabledByWidth: true };
  }
  if (cols >= SPLIT_MIN_COLS) {
    const chatCols = Math.max(1, Math.floor(cols * SPLIT_CHAT_RATIO));
    const logCols = cols - chatCols - SPLIT_GUTTER_COLS;
    // Defesa: se por algum motivo a coluna do log não couber em LOG_MIN_COLS, cai p/
    // tabs (em vez de espremer o log ilegível). Em cols≥100 com ratio 0.62 isto não
    // dispara (100*0.38≈38 > 34), mas o guard mantém o invariante p/ qualquer ratio.
    if (logCols >= LOG_MIN_COLS) {
      return { layout: 'side', chatCols, logCols, disabledByWidth: false };
    }
    return { layout: 'tabs', chatCols: cols, logCols: cols, disabledByWidth: false };
  }
  // 60..99 colunas: TABS.
  return { layout: 'tabs', chatCols: cols, logCols: cols, disabledByWidth: false };
}

/**
 * Linhas de chrome EXTRA que o split/tabs acrescenta ao chrome base (`LIVE_CHROME_
 * BASE_ROWS` + respiro).
 *   • `single` ⇒ 0 (não regride o header/footer #133).
 *   • `side`   ⇒ `SPLIT_LABEL_ROWS` (a linha de rótulos `CHAT │ LOG`).
 *   • `tabs`   ⇒ `TABS_BAR_ROWS` (a linha de abas).
 */
export function splitChromeOverhead(layout: SplitLayout): number {
  if (layout === 'side') return SPLIT_LABEL_ROWS;
  if (layout === 'tabs') return TABS_BAR_ROWS;
  return 0;
}

// ── ORÇAMENTO DE ALTURA DAS 2 COLUNAS VIVAS (anti-flicker) ──────────────────────

export interface SplitLiveBudgetInput {
  readonly rows: number;
  /** Layout efetivo (de `resolveSplitLayout`). */
  readonly layout: SplitLayout;
  /** Os blocos VIVOS do CHAT (sufixo vivo) — saída de `splitBlocks().live`. */
  readonly live: readonly SessionBlock[];
  readonly phase: SessionPhase;
  readonly hasBlocks: boolean;
  readonly mode: SessionMode;
  /** Largura do terminal (colunas) — mede a altura VISUAL dos vivos (wrap). */
  readonly columns?: number;
  /** Altura BOUNDED da fila de inputs (`<QueuedInputs>`), abaixo da viva (anti-flicker). */
  readonly queuedLines?: number;
  /**
   * Altura (linhas VISUAIS) que a COLUNA DO LOG ocupará neste frame, já capada em
   * `LOG_VISIBLE_ROWS`. As duas colunas vivas compartilham a altura do frame, então a
   * MAIOR delas é quem dita o teto. Em `tabs` só UMA aba está visível ⇒ a do log NÃO
   * coexiste com a do chat (passe 0 quando a aba ativa é o chat).
   */
  readonly logColumnLines?: number;
}

/**
 * EST-0990 — TETO da prévia de FALA (corpo do aluy streaming) NO SPLIT, p/ as DUAS
 * colunas vivas caberem JUNTAS em `rows-1`. Espelha `speechMaxLines` (mesmo chrome,
 * folga, overhead dos outros vivos do chat e excedente do banner unsafe), e SUBTRAI:
 *   − o chrome EXTRA do split/tabs (`splitChromeOverhead`);
 *   − a parte da coluna do LOG que EXCEDE a coluna do chat (anti-flicker do `row`):
 *     como as colunas dividem a altura do frame, se a coluna do log for MAIS ALTA que
 *     a do chat, o frame fica do tamanho do log — então descontamos esse excedente do
 *     teto da fala p/ `max(chat, log) + chrome ≤ rows-1` valer SEMPRE.
 *
 * Resultado: `frame_height = chrome_base + respiro + extra + max(chat_live, log) ≤
 * rows-1`.
 * com piso `MIN_SPEECH_LINES`. PURO.
 */
export function splitLiveBudget(input: SplitLiveBudgetInput): number {
  const overhead = liveOverheadLines({
    live: input.live,
    phase: input.phase,
    hasBlocks: input.hasBlocks,
    ...(input.columns !== undefined ? { columns: input.columns } : {}),
  });
  const extraChrome = splitChromeOverhead(input.layout);
  const logLines = Math.min(LOG_VISIBLE_ROWS, Math.max(0, input.logColumnLines ?? 0));

  // O teto que a COLUNA DO CHAT (fala + outros vivos) pode ter p/ o frame caber em
  // rows-1, JÁ pago o chrome (fixo + extra do split), a folga, o banner unsafe e a fila.
  const chatBudget =
    input.rows -
    LIVE_CHROME_BASE_ROWS -
    respiroOverhead(input.rows) -
    extraChrome -
    SAFETY_MARGIN -
    modeIndicatorOverhead(input.mode) -
    (input.queuedLines ?? 0) -
    1; // reserva do marcador `…N acima`

  // O ALTO das duas colunas é quem dita o frame. Se a coluna do log já é mais alta que
  // tudo que a do chat poderia ter, a fala precisa caber ABAIXO do log: o teto da fala
  // = chatBudget − (overhead dos outros vivos do chat) − excedente do log sobre o chat.
  // Modelamos de forma conservadora: o frame = chrome + max(chat_total, logLines), e
  // chat_total = overhead + fala. Logo fala ≤ chatBudget − overhead, E o `max` com o
  // log não pode estourar ⇒ se logLines > (overhead + fala_teto), o frame seria o log,
  // que já cabe (logLines ≤ chatBudget por construção do teto do log). Então só
  // precisamos garantir que a COLUNA DO CHAT também caiba: fala ≤ chatBudget − overhead.
  // E, p/ o caso do log ser a coluna alta, reservamos seu excedente sobre o overhead do
  // chat (senão a fala poderia crescer e empatar/estourar o frame ditado pelo log).
  const chatColumnCap = chatBudget - overhead;
  const speechVsLog = chatBudget - Math.max(overhead, logLines);
  const budget = Math.min(chatColumnCap, speechVsLog);

  return Math.max(MIN_SPEECH_LINES, budget);
}

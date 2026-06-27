// EST-0948 (composer/sessão) — EDIÇÃO COM CURSOR do composer: funções PURAS de
// manipulação de `(text, cursor)`. Vivem fora do React p/ serem testáveis sem TTY
// (a App só liga as teclas a estas funções). Toda função preserva a INVARIANTE
// `0 <= cursor <= text.length` (clamp) e nunca produz índice fora de faixa.
//
// Por que um módulo próprio: o composer deixou de ser append-only. A lógica de
// mover/inserir/apagar NA POSIÇÃO do cursor (incl. por palavra) é fácil de errar nas
// bordas (início/fim/vazio/multibyte) — isolá-la em funções puras dá cobertura
// determinística e mantém o `useInput` da App enxuto (só roteia tecla → função).

/** Estado mínimo de edição: o texto e a posição do cursor (caret) dentro dele. */
export interface EditState {
  readonly text: string;
  /** Índice do caret: 0 = antes do 1º char; text.length = depois do último. */
  readonly cursor: number;
}

/** Garante `0 <= cursor <= text.length` (clamp das duas pontas). */
export function clampCursor(text: string, cursor: number): number {
  if (cursor < 0) return 0;
  if (cursor > text.length) return text.length;
  return cursor;
}

// FIX (HUNT-RENDER) — UTF-16 surrogate awareness. Um code point ASTRAL (emoji `🎉`,
// `🧑‍🚀`, ideogramas do plano B+) ocupa DUAS unidades UTF-16 (par surrogate: alto
// 0xD800–0xDBFF + baixo 0xDC00–0xDFFF). Apagar/mover por 1 unidade caía NO MEIO do par,
// deixando um surrogate ÓRFÃO no texto — que o terminal pinta como `�` (replacement) e
// que vai assim no que é SUBMETIDO (corrupção visual E de dado). Estes helpers detectam
// o par e passam por cima das duas unidades de uma vez.

/** `pos` está logo à DIREITA da metade BAIXA de um par surrogate? (apagar/recuar 1 unidade
 * partiria o par). */
function isLowSurrogateBefore(text: string, pos: number): boolean {
  if (pos < 2) return false;
  const lo = text.charCodeAt(pos - 1);
  const hi = text.charCodeAt(pos - 2);
  return lo >= 0xdc00 && lo <= 0xdfff && hi >= 0xd800 && hi <= 0xdbff;
}

/** `pos` está logo à ESQUERDA da metade ALTA de um par surrogate? (apagar/avançar 1 unidade
 * partiria o par). */
function isHighSurrogateAt(text: string, pos: number): boolean {
  if (pos + 1 >= text.length) return false;
  const hi = text.charCodeAt(pos);
  const lo = text.charCodeAt(pos + 1);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/** Insere `chunk` NA posição do cursor e avança o cursor pelo tamanho inserido. */
export function insertAt(state: EditState, chunk: string): EditState {
  const pos = clampCursor(state.text, state.cursor);
  const text = state.text.slice(0, pos) + chunk + state.text.slice(pos);
  return { text, cursor: pos + chunk.length };
}

/**
 * BACKSPACE — apaga o char ANTES do cursor (`pos-1`) e recua o cursor. No-op com o
 * cursor no início (nada antes p/ apagar).
 */
export function deleteBackward(state: EditState): EditState {
  const pos = clampCursor(state.text, state.cursor);
  if (pos === 0) return { text: state.text, cursor: 0 };
  // FIX (HUNT-RENDER) — apaga o CODE POINT inteiro: se à esquerda há um par surrogate,
  // remove as DUAS unidades (senão sobra um surrogate órfão `�`).
  const step = isLowSurrogateBefore(state.text, pos) ? 2 : 1;
  const text = state.text.slice(0, pos - step) + state.text.slice(pos);
  return { text, cursor: pos - step };
}

/**
 * DELETE (forward) — apaga o char NA posição do cursor (`pos`), o cursor NÃO se move.
 * No-op com o cursor no fim (nada à frente p/ apagar).
 */
export function deleteForward(state: EditState): EditState {
  const pos = clampCursor(state.text, state.cursor);
  if (pos >= state.text.length) return { text: state.text, cursor: pos };
  // FIX (HUNT-RENDER) — apaga o CODE POINT inteiro à frente (par surrogate ⇒ 2 unidades).
  const step = isHighSurrogateAt(state.text, pos) ? 2 : 1;
  const text = state.text.slice(0, pos) + state.text.slice(pos + step);
  return { text, cursor: pos };
}

/** Move o cursor 1 char à esquerda (clamp no 0). FIX (HUNT-RENDER): pula o par surrogate
 * inteiro p/ o caret não pousar no MEIO de um emoji/astral. */
export function moveLeft(state: EditState): number {
  const pos = clampCursor(state.text, state.cursor);
  const step = isLowSurrogateBefore(state.text, pos) ? 2 : 1;
  return clampCursor(state.text, pos - step);
}

/** Move o cursor 1 char à direita (clamp no fim). FIX (HUNT-RENDER): pula o par surrogate
 * inteiro. */
export function moveRight(state: EditState): number {
  const pos = clampCursor(state.text, state.cursor);
  const step = isHighSurrogateAt(state.text, pos) ? 2 : 1;
  return clampCursor(state.text, pos + step);
}

/**
 * EST-1015 — Ctrl+U (readline): apaga do CURSOR até o INÍCIO da linha, preservando o que está
 * À DIREITA do cursor; o cursor vai p/ 0. Linha toda quando o cursor está no fim (caso comum).
 */
export function deleteToStart(state: EditState): EditState {
  const pos = clampCursor(state.text, state.cursor);
  return { text: state.text.slice(pos), cursor: 0 };
}

/**
 * EST-1015 — Ctrl+K (readline): apaga do CURSOR até o FIM da linha; o cursor NÃO se move.
 */
export function deleteToEnd(state: EditState): EditState {
  const pos = clampCursor(state.text, state.cursor);
  return { text: state.text.slice(0, pos), cursor: pos };
}

/**
 * EST-1015 — Ctrl+W (readline): apaga a PALAVRA antes do cursor (até a fronteira de palavra à
 * esquerda, mesma de `moveWordLeft`), preservando o resto. PT-BR-safe (reusa o WORD_CHAR).
 */
export function deleteWordBack(state: EditState): EditState {
  const pos = clampCursor(state.text, state.cursor);
  const start = moveWordLeft({ text: state.text, cursor: pos });
  return { text: state.text.slice(0, start) + state.text.slice(pos), cursor: start };
}

/**
 * EST-1015 — classifica uma SEQUÊNCIA CRUA de stdin como HOME ou END (ou nenhuma). O Ink
 * NÃO expõe `key.home`/`key.end` (entrega `char=''` sem flag, indistinguível), então lemos a
 * sequência crua (como o F8). Cobre as variantes comuns: CSI (`\x1b[H`/`\x1b[F`, `\x1b[1~`/
 * `\x1b[7~` Home, `\x1b[4~`/`\x1b[8~` End) e SS3 (`\x1bOH`/`\x1bOF`). PURO. `includes` (não
 * `===`) p/ tolerar bytes coalescidos no mesmo chunk; ordem: testa as 2 famílias.
 */
export function cursorSeqKind(s: string): 'home' | 'end' | undefined {
  if (
    s.includes('\x1b[H') ||
    s.includes('\x1bOH') ||
    s.includes('\x1b[1~') ||
    s.includes('\x1b[7~')
  )
    return 'home';
  if (
    s.includes('\x1b[F') ||
    s.includes('\x1bOF') ||
    s.includes('\x1b[4~') ||
    s.includes('\x1b[8~')
  )
    return 'end';
  return undefined;
}

/**
 * EST-1015 (dono, dogfooding) — DECISÃO PURA do Ctrl+C no composer ocioso. Um único
 * Ctrl+C derrubava a app ("uma vez já mata"); a regra correta (estilo Claude Code) é:
 *   • há TEXTO no composer ⇒ `'clear'` — o 1º Ctrl+C limpa o composer (não sai);
 *   • composer VAZIO e a saída JÁ ARMADA ⇒ `'exit'` — o 2º Ctrl+C encerra de fato;
 *   • composer VAZIO e NÃO armada ⇒ `'arm'` — o 1º Ctrl+C arma (footer pede confirmação).
 * Pura/determinística — o App mapeia a decisão p/ os efeitos (setText/exit/armar). Mantém
 * o branching testável sem Ink (o `exit()` real é difícil de exercitar no ink-testing). */
export type CtrlCAction = 'clear' | 'exit' | 'arm';
export function decideCtrlC(composerText: string, exitArmed: boolean): CtrlCAction {
  if (composerText.length > 0) return 'clear';
  return exitArmed ? 'exit' : 'arm';
}

// EST-0965 — bytes de CONTROLE de edição que podem vir EMBUTIDOS num chunk de input
// (xrdp/SSH/paste entregam texto+edição num único `read`): backspace físico (DEL,
// 0x7f) e ^H (0x08) apagam à esquerda; o Ink só seta `key.backspace`/`key.delete`
// quando o chunk é SÓ o byte — num chunk MISTO (`abc\x7f`) o byte vinha literal e o
// `insertAt` cego deixava o texto intacto (o bug medido no PTY: `XYZ`+backspace ⇒
// `XYZ`). `applyTypedChunk` é a FONTE ÚNICA que aplica o chunk char-a-char pelas MESMAS
// funções puras (insertAt/deleteBackward) — válida em idle E em trabalho (type-ahead).
const BACKSPACE_BYTE = '\x7f';
const CTRL_H = '\x08';

/** Resultado de aplicar um chunk de input cru ao estado de edição (EST-0965). */
export interface ApplyChunkResult {
  /** O novo estado de edição após consumir tudo ATÉ a 1ª quebra de linha (exclusive). */
  readonly state: EditState;
  /**
   * Posição (índice no chunk) da 1ª quebra de linha encontrada, ou `-1` se não houve.
   * O caractere de quebra é `chunk[newlineIndex]` (`\r` = Enter/submeter; `\n` = LF/
   * encaixar). O chamador decide o que fazer com a LINHA (`state.text`) e o resto.
   */
  readonly newlineIndex: number;
  /** O caractere de quebra encontrado (`\r`/`\n`), ou `''` se `newlineIndex === -1`. */
  readonly newline: string;
}

/**
 * EST-0965 — aplica um CHUNK de input cru ao `(text, cursor)`, char-a-char, honrando
 * os bytes de edição EMBUTIDOS (backspace `\x7f`/`\x08` apagam à esquerda) e PARANDO na
 * 1ª quebra de linha (`\r`/`\n`) sem consumi-la. FONTE ÚNICA de "aplicar o que chegou
 * do terminal": o ramo idle e o type-ahead roteiam por aqui, então o backspace funciona
 * IGUAL nos dois — inclusive quando texto+backspace chegam GRUDADOS num único chunk.
 *
 * Não trata setas/Ctrl-A/E (essas chegam como `key.*` flags, não como bytes no chunk);
 * só o que vem como texto/edição no `char`. Puro e determinístico.
 */
export function applyTypedChunk(state: EditState, chunk: string): ApplyChunkResult {
  let acc = state;
  for (let i = 0; i < chunk.length; i++) {
    const ch = chunk[i] as string;
    if (ch === '\r' || ch === '\n') {
      return { state: acc, newlineIndex: i, newline: ch };
    }
    if (ch === BACKSPACE_BYTE || ch === CTRL_H) {
      acc = deleteBackward(acc);
      continue;
    }
    acc = insertAt(acc, ch);
  }
  return { state: acc, newlineIndex: -1, newline: '' };
}

/**
 * BUG P2-C — JANELA de linhas do composer p/ o COCKPIT (altura cravada). Recebe o
 * `(text, cursor)` e um `maxRows`; devolve o subtexto das ATÉ `maxRows` linhas lógicas
 * (`\n`-delimitadas) que CONTÊM o cursor (tail-biased: a linha do cursor sempre visível),
 * com o cursor re-mapeado pro subtexto e a contagem de linhas escondidas ACIMA/ABAIXO.
 *
 * Por que isto existe: no inline o composer cresce sem teto (scrollback); no cockpit a
 * região do composer é um <Box> de altura cravada (soma == rows, §5). Sem janelar, as
 * linhas além da altura SUMIAM (clipadas pelo Box) — exatamente o bug. Aqui mostramos a
 * VIZINHANÇA do cursor (onde a digitação acontece) e sinalizamos `hiddenAbove`/`hiddenBelow`
 * p/ o usuário SABER que há mais. `maxRows <= 0` ou texto que já cabe ⇒ devolve tudo
 * (hidden=0): o caso 1-linha é INALTERADO. PURO.
 */
export interface ComposerWindow {
  readonly text: string;
  readonly cursor: number;
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
}

export function windowComposerLines(text: string, cursor: number, maxRows: number): ComposerWindow {
  const lines = text.split('\n');
  if (maxRows <= 0 || lines.length <= maxRows) {
    return { text, cursor: clampCursor(text, cursor), hiddenAbove: 0, hiddenBelow: 0 };
  }
  const pos = clampCursor(text, cursor);
  // Em que LINHA lógica cai o cursor? (nº de `\n` antes de `pos`).
  let cursorLine = 0;
  for (let i = 0; i < pos; i++) if (text[i] === '\n') cursorLine++;
  // Janela tail-biased: a última linha visível é a do cursor (ou o fim, se o cursor está
  // numa linha anterior à cauda — aí mostramos do cursor p/ baixo). Mantém ≥1 linha de
  // contexto acima quando dá, mas garante a linha do cursor SEMPRE dentro.
  let start = Math.max(0, cursorLine - (maxRows - 1));
  let end = start + maxRows; // exclusivo
  if (end > lines.length) {
    end = lines.length;
    start = Math.max(0, end - maxRows);
  }
  const winLines = lines.slice(start, end);
  const winText = winLines.join('\n');
  // re-mapeia o cursor: subtrai o comprimento (com `\n`) das linhas removidas acima.
  let removedLen = 0;
  for (let i = 0; i < start; i++) removedLen += (lines[i] as string).length + 1; // +1 = `\n`
  const winCursor = clampCursor(winText, pos - removedLen);
  return {
    text: winText,
    cursor: winCursor,
    hiddenAbove: start,
    hiddenBelow: lines.length - end,
  };
}

// EST-1015 (fix word-jump PT-BR) — `\w` é ASCII-ONLY ([A-Za-z0-9_]): NÃO casa letras
// acentuadas (á/ç/ã/é/ô…) nem não-latinas. No idioma do usuário (PT-BR) o Alt+←/→
// (word-jump) PARAVA no MEIO da palavra a cada acento (ex.: "ação rápida", Alt+← do fim
// caía em "rá|pida", não "|rápida"). `\p{L}` (qualquer LETRA Unicode) + `\p{N}` (número)
// + `_` trata a palavra ACENTUADA como uma unidade. Compatível c/ ASCII (segue casando
// a-z0-9_). Emoji/símbolos seguem sendo SEPARADOR (não são `\p{L}`), como antes.
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Move o cursor p/ o INÍCIO da palavra anterior (Alt+←/Alt+b, estilo readline): pula
 * os separadores à esquerda e então o corpo da palavra. Clamp no 0.
 */
export function moveWordLeft(state: EditState): number {
  let i = clampCursor(state.text, state.cursor);
  // pula separadores imediatamente à esquerda
  while (i > 0 && !WORD_CHAR.test(state.text[i - 1] as string)) i--;
  // pula o corpo da palavra
  while (i > 0 && WORD_CHAR.test(state.text[i - 1] as string)) i--;
  return i;
}

/**
 * Move o cursor p/ o FIM da próxima palavra (Alt+→/Alt+f, estilo readline): pula os
 * separadores à direita e então o corpo da palavra. Clamp no fim.
 */
export function moveWordRight(state: EditState): number {
  const n = state.text.length;
  let i = clampCursor(state.text, state.cursor);
  while (i < n && !WORD_CHAR.test(state.text[i] as string)) i++;
  while (i < n && WORD_CHAR.test(state.text[i] as string)) i++;
  return i;
}

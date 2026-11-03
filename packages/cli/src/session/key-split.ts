// F7 (UX de entrada) — VÁRIAS sequências de escape num ÚNICO chunk de stdin.
//
// O Ink lê o teclado via `stdin.read()` e entrega o chunk INTEIRO ao `parseKeypress` como UMA
// tecla. Quando o terminal (ou o `tmux send-keys Left Left Left`, ou um digitador rápido /
// auto-repeat sob carga) junta `\x1b[D\x1b[D\x1b[D` num chunk só, o `fnKeyRe` do Ink casa a
// PRIMEIRA sequência e descarta o resto: o cursor andava 1 casa em vez de 3.
//
// O FIX fica no canal cru (mesmo ponto do `csi-u-guard`): este tokenizador quebra o chunk em
// TECLAS — cada sequência de escape é um token, e cada corrida de texto puro (sem ESC) é um
// token só (o type-ahead em lote `abc\r` e o Enter grudado seguem como antes). O interpositor
// de `read()` devolve UM token por chamada; o laço do Ink (`while (read() !== null)`) consome
// todos, um evento `useInput` por tecla.
//
// PURO e determinístico — testável sem TTY. Não toca engine/catraca.

const ESC = '\x1b';

/** Fim de CSI: byte final 0x40–0x7E. */
function isFinalByte(c: string): boolean {
  return c >= '@' && c <= '~';
}

/**
 * Lê UMA sequência de escape começando em `s[i] === ESC` e devolve o índice APÓS ela.
 * Sequência incompleta (cortada no fim do chunk) consome o resto.
 */
function scanEscape(s: string, start: number): number {
  let i = start;
  // `\x1b\x1b…` (Alt+tecla com prefixo duplo, ex.: Alt+seta `\x1b\x1b[A`): ESCs consecutivos
  // fazem parte do MESMO token.
  while (s[i] === ESC) i += 1;
  if (i >= s.length) return s.length; // ESC(s) soltos no fim.
  const c = s[i]!;
  if (c === '[') {
    i += 1;
    // `\x1b[[A` (console linux): o 2º `[` é parte do introdutor.
    if (s[i] === '[') i += 1;
    // parâmetros (0x30–0x3F) e intermediários (0x20–0x2F)
    while (i < s.length && s[i]! >= ' ' && s[i]! <= '?') i += 1;
    if (i < s.length && isFinalByte(s[i]!)) i += 1;
    return i;
  }
  if (c === 'O') {
    i += 1;
    while (i < s.length && s[i]! >= '0' && s[i]! <= '?') i += 1;
    if (i < s.length) i += 1; // byte final do SS3
    return i;
  }
  // Alt+<tecla> (`\x1bb`, `\x1b\r` = Alt+Enter, `\x1b\x7f` = Alt+Backspace): 1 code point.
  const cp = s.codePointAt(i)!;
  return i + (cp > 0xffff ? 2 : 1);
}

/** Quebra `s` em teclas: corridas de texto sem ESC e sequências de escape completas. */
export function splitKeys(s: string): string[] {
  if (s.indexOf(ESC) === -1) return s === '' ? [] : [s];
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === ESC) {
      const end = scanEscape(s, i);
      out.push(s.slice(i, end));
      i = end;
    } else {
      const next = s.indexOf(ESC, i);
      const end = next === -1 ? s.length : next;
      out.push(s.slice(i, end));
      i = end;
    }
  }
  return out;
}

const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

export interface KeySplitter {
  /** Quebra o chunk em teclas (paste bracketed passa INTEIRO, sem quebrar). */
  split(chunk: string): string[];
}

/**
 * Splitter com ESTADO só p/ o bracketed paste: o conteúdo colado pode conter ESC (cores
 * ANSI copiadas de um terminal) e o `gateInputPaste` da App espera o chunk do paste inteiro
 * — então, de `\x1b[200~` até `\x1b[201~` o chunk NÃO é quebrado.
 */
export function createKeySplitter(): KeySplitter {
  let inPaste = false;
  return {
    split(chunk: string): string[] {
      if (chunk === '') return [];
      const hasStart = chunk.includes(PASTE_START);
      if (inPaste || hasStart) {
        const lastStart = chunk.lastIndexOf(PASTE_START);
        const lastEnd = chunk.lastIndexOf(PASTE_END);
        inPaste = lastStart > lastEnd || (lastStart === -1 && lastEnd === -1 && inPaste);
        return [chunk];
      }
      return splitKeys(chunk);
    },
  };
}

// EST-0948 (composer/sessão) — funções PURAS de edição com cursor do composer.
// Cobertura determinística (sem TTY) da mecânica que o `useInput` da App liga às
// teclas: inserir/apagar NA POSIÇÃO, mover por char e por palavra, sempre clampado.

import { describe, expect, it } from 'vitest';
import {
  cursorSeqKind,
  deleteToStart,
  deleteToEnd,
  deleteWordBack,
  clampCursor,
  insertAt,
  deleteBackward,
  deleteForward,
  moveLeft,
  moveRight,
  moveWordLeft,
  moveWordRight,
  applyTypedChunk,
  decideCtrlC,
  windowComposerLines,
  windowComposerVisual,
} from '../../src/session/composer-edit.js';
import { visualLines } from '../../src/session/visual-lines.js';

describe('composer-edit — clampCursor (invariante 0..len)', () => {
  it('clampa as duas pontas', () => {
    expect(clampCursor('abc', -5)).toBe(0);
    expect(clampCursor('abc', 0)).toBe(0);
    expect(clampCursor('abc', 2)).toBe(2);
    expect(clampCursor('abc', 3)).toBe(3);
    expect(clampCursor('abc', 99)).toBe(3);
    expect(clampCursor('', 0)).toBe(0);
    expect(clampCursor('', 7)).toBe(0);
  });
});

describe('composer-edit — insertAt (insere NA posição, não append)', () => {
  it('insere no MEIO e avança o cursor pelo tamanho inserido', () => {
    // "abcd", cursor entre b e c (pos 2): inserir "X" ⇒ "abXcd", cursor 3.
    expect(insertAt({ text: 'abcd', cursor: 2 }, 'X')).toEqual({ text: 'abXcd', cursor: 3 });
  });
  it('insere no INÍCIO (pos 0)', () => {
    expect(insertAt({ text: 'bc', cursor: 0 }, 'a')).toEqual({ text: 'abc', cursor: 1 });
  });
  it('insere no FIM (pos === len) — equivalente ao append antigo', () => {
    expect(insertAt({ text: 'ab', cursor: 2 }, 'c')).toEqual({ text: 'abc', cursor: 3 });
  });
  it('insere num texto VAZIO', () => {
    expect(insertAt({ text: '', cursor: 0 }, 'o')).toEqual({ text: 'o', cursor: 1 });
  });
  it('insere um CHUNK multi-char (paste sem quebra) inteiro, avançando pelo tamanho', () => {
    expect(insertAt({ text: 'ad', cursor: 1 }, 'bc')).toEqual({ text: 'abcd', cursor: 3 });
  });
  it('cursor fora de faixa é clampado antes de inserir', () => {
    expect(insertAt({ text: 'ab', cursor: 99 }, 'c')).toEqual({ text: 'abc', cursor: 3 });
  });
});

describe('composer-edit — deleteBackward (Backspace, apaga em pos-1)', () => {
  it('apaga o char ANTES do cursor e recua', () => {
    // "abcd", cursor 3 (entre c e d): backspace ⇒ "abd", cursor 2.
    expect(deleteBackward({ text: 'abcd', cursor: 3 })).toEqual({ text: 'abd', cursor: 2 });
  });
  it('no MEIO: "abc" cursor 2 ⇒ remove o "b"', () => {
    expect(deleteBackward({ text: 'abc', cursor: 2 })).toEqual({ text: 'ac', cursor: 1 });
  });
  it('cursor no INÍCIO é no-op (nada à esquerda)', () => {
    expect(deleteBackward({ text: 'abc', cursor: 0 })).toEqual({ text: 'abc', cursor: 0 });
  });
  it('cursor no FIM apaga o último (comportamento append-only de antes)', () => {
    expect(deleteBackward({ text: 'abc', cursor: 3 })).toEqual({ text: 'ab', cursor: 2 });
  });
});

describe('composer-edit — deleteForward (Delete, apaga em pos, cursor fixo)', () => {
  it('apaga o char NA posição e NÃO move o cursor', () => {
    // "abcd", cursor 1 (entre a e b): delete ⇒ "acd", cursor 1.
    expect(deleteForward({ text: 'abcd', cursor: 1 })).toEqual({ text: 'acd', cursor: 1 });
  });
  it('cursor no FIM é no-op (nada à frente)', () => {
    expect(deleteForward({ text: 'abc', cursor: 3 })).toEqual({ text: 'abc', cursor: 3 });
  });
  it('cursor no INÍCIO apaga o 1º char', () => {
    expect(deleteForward({ text: 'abc', cursor: 0 })).toEqual({ text: 'bc', cursor: 0 });
  });
});

describe('composer-edit — moveLeft/moveRight (1 char, clamp)', () => {
  it('move 1 à esquerda, clamp no 0', () => {
    expect(moveLeft({ text: 'abc', cursor: 2 })).toBe(1);
    expect(moveLeft({ text: 'abc', cursor: 0 })).toBe(0);
  });
  it('move 1 à direita, clamp no fim', () => {
    expect(moveRight({ text: 'abc', cursor: 1 })).toBe(2);
    expect(moveRight({ text: 'abc', cursor: 3 })).toBe(3);
  });
});

describe('composer-edit — moveWordLeft/moveWordRight (por palavra, readline)', () => {
  it('word-left pula separadores e o corpo da palavra', () => {
    // "liste os arquivos", cursor no fim (17) ⇒ início de "arquivos" (9).
    const s = { text: 'liste os arquivos', cursor: 17 };
    expect(moveWordLeft(s)).toBe(9);
    // de 9 ⇒ início de "os" (6).
    expect(moveWordLeft({ text: s.text, cursor: 9 })).toBe(6);
    // de 6 ⇒ início de "liste" (0).
    expect(moveWordLeft({ text: s.text, cursor: 6 })).toBe(0);
    // no 0 fica no 0.
    expect(moveWordLeft({ text: s.text, cursor: 0 })).toBe(0);
  });
  it('word-right pula separadores e o corpo da palavra', () => {
    const s = { text: 'liste os arquivos', cursor: 0 };
    expect(moveWordRight(s)).toBe(5); // fim de "liste"
    expect(moveWordRight({ text: s.text, cursor: 5 })).toBe(8); // fim de "os"
    expect(moveWordRight({ text: s.text, cursor: 8 })).toBe(17); // fim de "arquivos"
    expect(moveWordRight({ text: s.text, cursor: 17 })).toBe(17); // fim fica no fim
  });
  it('múltiplos espaços contam como um só separador', () => {
    const s = { text: 'a   b', cursor: 5 };
    expect(moveWordLeft(s)).toBe(4); // início de "b"
    expect(moveWordLeft({ text: s.text, cursor: 4 })).toBe(0); // início de "a"
  });

  // EST-1015 (fix) — palavras ACENTUADAS PT-BR são UMA unidade (antes `\w` ASCII-only
  // tratava cada acento como SEPARADOR ⇒ word-jump parava no MEIO da palavra).
  it('PT-BR: word-left/right tratam letras acentuadas como parte da palavra', () => {
    // "ação rápida": índices r=5,á=6,p=7,i=8,d=9,a=10 (len 11). Sem o fix, word-left do
    // fim parava em 7 (no acento 'á' de "rápida"); com o fix vai ao INÍCIO da palavra (5).
    const s = { text: 'ação rápida', cursor: 11 };
    expect(moveWordLeft(s)).toBe(5); // |rápida (não rá|pida)
    expect(moveWordLeft({ text: s.text, cursor: 5 })).toBe(0); // |ação (não aç|ão)
    // word-right do começo vai ao FIM de "ação" (4), não para no 'ç'/'ã'.
    expect(moveWordRight({ text: s.text, cursor: 0 })).toBe(4); // ação|
    expect(moveWordRight({ text: s.text, cursor: 4 })).toBe(11); // rápida| (fim)
  });

  it('PT-BR: word-jump atravessa palavra acentuada inteira (coração, José)', () => {
    const s = { text: 'José ama coração', cursor: 16 };
    expect(moveWordLeft(s)).toBe(9); // |coração (palavra acentuada inteira)
    const s2 = { text: 'José', cursor: 0 };
    expect(moveWordRight(s2)).toBe(4); // José| (não Jos|é)
  });
});

// EST-0965 — applyTypedChunk: FONTE ÚNICA de "aplicar o chunk cru do terminal".
// O bug medido no PTF: texto+backspace EMBUTIDOS num único chunk (xrdp/SSH/paste) —
// o Ink só seta `key.backspace` quando o chunk é SÓ o byte; num chunk MISTO o `\x7f`
// vinha literal e o `insertAt` cego deixava o texto intacto (`XYZ`+backspace ⇒ `XYZ`).
// applyTypedChunk aplica char-a-char pelas MESMAS funções puras, honrando backspace.
const BS = '\x7f'; // DEL (backspace físico da maioria dos terminais)
const CH = '\x08'; // ^H (alguns terminais)

describe('composer-edit — applyTypedChunk (EST-0965: backspace EMBUTIDO no chunk)', () => {
  it('chunk de texto puro insere tudo na posição do cursor', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, 'abc');
    expect(r.state).toEqual({ text: 'abc', cursor: 3 });
    expect(r.newlineIndex).toBe(-1);
    expect(r.newline).toBe('');
  });

  it('o bug do PTY: `XYZ` + 2 backspace GRUDADOS ⇒ `X` (não `XYZ`)', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, 'XYZ' + BS + BS);
    expect(r.state).toEqual({ text: 'X', cursor: 1 });
  });

  it('`abc` + backspace num único chunk ⇒ `ab`', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, 'abc' + BS);
    expect(r.state.text).toBe('ab');
  });

  it('honra ^H (0x08) igual ao DEL (0x7f)', () => {
    expect(applyTypedChunk({ text: '', cursor: 0 }, 'abc' + CH).state.text).toBe('ab');
  });

  it('backspace além do início é no-op (clamp no 0), não estoura', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, BS + BS + 'z');
    expect(r.state).toEqual({ text: 'z', cursor: 1 });
  });

  it('apaga A PARTIR do cursor do estado inicial (edição NO MEIO)', () => {
    // texto "abXc" com cursor após o X (pos 3): um backspace tira o X ⇒ "abc", cursor 2.
    const r = applyTypedChunk({ text: 'abXc', cursor: 3 }, BS);
    expect(r.state).toEqual({ text: 'abc', cursor: 2 });
  });

  it('PARA na 1ª quebra `\\r` (Enter) sem consumi-la; reporta o índice e o caractere', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, 'ab\rcd');
    expect(r.state.text).toBe('ab'); // só ATÉ a quebra
    expect(r.newlineIndex).toBe(2);
    expect(r.newline).toBe('\r');
  });

  it('PARA na 1ª quebra `\\n` (LF/encaixar) — distingue de `\\r`', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, 'oi\nresto');
    expect(r.state.text).toBe('oi');
    expect(r.newline).toBe('\n');
  });

  it('backspace ANTES da quebra entra na linha: `abc` + BS + `\\r` ⇒ linha `ab`', () => {
    const r = applyTypedChunk({ text: '', cursor: 0 }, 'abc' + BS + '\r');
    expect(r.state.text).toBe('ab');
    expect(r.newline).toBe('\r');
  });

  it('aplicado SOBRE um texto existente compõe (cada tecla sobre o estado anterior)', () => {
    let s = { text: 'X', cursor: 1 };
    s = applyTypedChunk(s, 'Y').state; // XY
    s = applyTypedChunk(s, 'Z').state; // XYZ
    s = applyTypedChunk(s, BS).state; // XY
    expect(s).toEqual({ text: 'XY', cursor: 2 });
  });
});

// FIX (HUNT-RENDER) — UTF-16 surrogate awareness. Um emoji/astral (`🎉`, `🧑`) ocupa
// DUAS unidades UTF-16 (par surrogate). Apagar/mover por 1 unidade caía NO MEIO do par e
// deixava um surrogate ÓRFÃO (`\uD83C`) no texto — pintado como `�` e SUBMETIDO assim
// (corrupção visual E de dado). Estes testes FALHAM sem o fix (sobrava 1 code unit órfão).
describe('composer-edit — pares surrogate (emoji/astral) nunca partem', () => {
  const EMOJI = '🎉'; // U+1F389 — 2 unidades UTF-16 (high+low surrogate)

  it('backspace apaga o EMOJI INTEIRO (não sobra surrogate órfão)', () => {
    const after = deleteBackward({ text: EMOJI, cursor: 2 });
    expect(after.text).toBe(''); // sem `\uD83C` órfão
    expect(after.cursor).toBe(0);
    // nenhum code unit isolado de surrogate
    for (const c of after.text) expect(c.codePointAt(0)! <= 0xffff || c.length === 2).toBe(true);
  });

  it('backspace entre dois emojis remove só o da esquerda, inteiro', () => {
    const after = deleteBackward({ text: EMOJI + EMOJI, cursor: 2 });
    expect(after.text).toBe(EMOJI);
    expect(after.cursor).toBe(0);
  });

  it('delete-forward apaga o EMOJI INTEIRO à frente', () => {
    const after = deleteForward({ text: EMOJI + 'x', cursor: 0 });
    expect(after.text).toBe('x');
    expect(after.cursor).toBe(0);
  });

  it('moveLeft/moveRight pulam o par inteiro (caret nunca no meio)', () => {
    expect(moveLeft({ text: 'a' + EMOJI, cursor: 3 })).toBe(1); // pula as 2 unidades do emoji
    expect(moveRight({ text: EMOJI + 'a', cursor: 0 })).toBe(2); // pula as 2 unidades
  });

  it('um char BMP (largura 1) ainda anda 1 a 1 (não regride)', () => {
    expect(moveLeft({ text: 'abc', cursor: 2 })).toBe(1);
    expect(moveRight({ text: 'abc', cursor: 1 })).toBe(2);
    expect(deleteBackward({ text: 'abc', cursor: 2 }).text).toBe('ac');
  });

  // EST-1015 — Ctrl+U/K/W (readline) apagam até início/fim/palavra.
  it('deleteToStart (Ctrl+U) apaga do cursor até o início, preserva o resto', () => {
    expect(deleteToStart({ text: 'alpha bravo', cursor: 11 })).toEqual({ text: '', cursor: 0 });
    // cursor no meio: só apaga à esquerda dele.
    expect(deleteToStart({ text: 'alpha bravo', cursor: 6 })).toEqual({
      text: 'bravo',
      cursor: 0,
    });
  });
  it('deleteToEnd (Ctrl+K) apaga do cursor até o fim, cursor fica', () => {
    expect(deleteToEnd({ text: 'alpha bravo', cursor: 6 })).toEqual({ text: 'alpha ', cursor: 6 });
    expect(deleteToEnd({ text: 'alpha', cursor: 5 })).toEqual({ text: 'alpha', cursor: 5 });
  });
  it('deleteWordBack (Ctrl+W) apaga a palavra à esquerda (PT-BR-safe)', () => {
    expect(deleteWordBack({ text: 'alpha bravo charlie', cursor: 19 })).toEqual({
      text: 'alpha bravo ',
      cursor: 12,
    });
    // acento não quebra a fronteira de palavra (reusa o WORD_CHAR do #315).
    const r = deleteWordBack({ text: 'ação café', cursor: 9 });
    expect(r.text).toBe('ação ');
    // no início ⇒ no-op.
    expect(deleteWordBack({ text: 'x', cursor: 0 })).toEqual({ text: 'x', cursor: 0 });
  });

  // EST-1015 — Home/End vêm CRUS (o Ink entrega char='' sem flag); classificamos a sequência.
  it('cursorSeqKind reconhece HOME e END em todas as variantes comuns (CSI + SS3)', () => {
    for (const h of ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']) {
      expect(cursorSeqKind(h), `home: ${JSON.stringify(h)}`).toBe('home');
    }
    for (const e of ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']) {
      expect(cursorSeqKind(e), `end: ${JSON.stringify(e)}`).toBe('end');
    }
    // tolera bytes coalescidos no mesmo chunk.
    expect(cursorSeqKind('\x1b[H')).toBe('home');
    // teclas que NÃO são home/end ⇒ undefined (não rouba arrow/F8/texto).
    expect(cursorSeqKind('\x1b[D')).toBeUndefined(); // seta esquerda
    expect(cursorSeqKind('\x1b[19~')).toBeUndefined(); // F8
    expect(cursorSeqKind('abc')).toBeUndefined();
    expect(cursorSeqKind('')).toBeUndefined();
  });
});

describe('composer-edit — decideCtrlC (duplo Ctrl+C p/ sair, EST-1015)', () => {
  it('TEXTO no composer ⇒ clear (1º Ctrl+C limpa, NÃO sai) — independe do armado', () => {
    expect(decideCtrlC('rascunho', false)).toBe('clear');
    expect(decideCtrlC('rascunho', true)).toBe('clear'); // texto vence o armado
    expect(decideCtrlC(' ', false)).toBe('clear'); // 1 espaço já é texto
  });

  it('composer VAZIO e NÃO armado ⇒ arm (1º Ctrl+C arma, não sai)', () => {
    expect(decideCtrlC('', false)).toBe('arm');
  });

  it('composer VAZIO e JÁ armado ⇒ exit (2º Ctrl+C sai de fato)', () => {
    expect(decideCtrlC('', true)).toBe('exit');
  });
});

// BUG P2-C (task #14) — JANELA por linhas VISUAIS (single long line / soft-wrap).
describe('composer-edit — windowComposerVisual (janela VISUAL, task #14)', () => {
  it('linha curta que cabe ⇒ INALTERADO (sem corte, sem hidden)', () => {
    const w = windowComposerVisual('uma linha curta', 5, 10, 80);
    expect(w.text).toBe('uma linha curta');
    expect(w.hiddenAbove).toBe(0);
    expect(w.hiddenBelow).toBe(0);
    expect(w.cursor).toBe(5);
  });

  it('columns ≤ 0 (largura desconhecida) ⇒ degrada p/ janela LÓGICA', () => {
    const text = Array.from({ length: 9 }, (_, i) => `L${i}`).join('\n');
    // teto 4 linhas, cols 0 ⇒ deve casar com windowComposerLines (lógica).
    const vis = windowComposerVisual(text, text.length, 4, 0);
    const log = windowComposerLines(text, text.length, 4);
    expect(vis.text).toBe(log.text);
    expect(vis.hiddenAbove).toBe(log.hiddenAbove);
    expect(vis.hiddenBelow).toBe(log.hiddenBelow);
  });

  it('LINHA ÚNICA longa (sem \\n) ⇒ corta p/ caber em maxRows×columns linhas VISUAIS', () => {
    const cols = 20;
    const maxRows = 3; // orçamento ~ 3×20 = 60 cols de cauda visível
    const long = 'Z'.repeat(1300); // 1 linha lógica, mas 65 linhas visuais a 20 cols
    const w = windowComposerVisual(long, long.length, maxRows, cols);
    // a altura VISUAL do resultado NÃO ultrapassa maxRows.
    expect(visualLines(w.text, cols)).toBeLessThanOrEqual(maxRows);
    // marcou chars escondidos acima (corte de cabeça com `…`).
    expect(w.hiddenAbove).toBeGreaterThan(0);
    expect(w.text.startsWith('…')).toBe(true);
    // o cursor (no FIM) continua DENTRO do texto janelado (visível).
    expect(w.cursor).toBeLessThanOrEqual(w.text.length);
    expect(w.cursor).toBeGreaterThan(0);
  });

  it('LINHA ÚNICA longa, cursor no MEIO ⇒ janela contém o cursor (vizinhança)', () => {
    const cols = 20;
    const maxRows = 3;
    const long = 'A'.repeat(600) + 'B'.repeat(600); // cursor logo após os As
    const cursor = 600;
    const w = windowComposerVisual(long, cursor, maxRows, cols);
    expect(visualLines(w.text, cols)).toBeLessThanOrEqual(maxRows);
    // a janela cobre a fronteira A/B (vizinhança do cursor): contém ambos.
    expect(w.text).toContain('A');
    expect(w.text).toContain('B');
    // cortou cabeça E cauda ⇒ hidden dos dois lados.
    expect(w.hiddenAbove).toBeGreaterThan(0);
    expect(w.hiddenBelow).toBeGreaterThan(0);
    // o cursor permanece em faixa válida.
    expect(w.cursor).toBeLessThanOrEqual(w.text.length);
  });

  it('hiddenAbove/Below em LINHAS VISUAIS, não chars (fix do marcador `↑1307 linhas`)', () => {
    const cols = 20;
    const maxRows = 3;
    const long = 'Z'.repeat(1300); // 65 linhas visuais a 20 cols; janela mostra ~3
    const w = windowComposerVisual(long, long.length, maxRows, cols);
    // ~62 linhas ficaram acima — o marcador diz "linhas", então a ORDEM tem que ser
    // essa (dezenas), nunca a contagem de CHARS (~1240) que aparecia antes.
    expect(w.hiddenAbove).toBeGreaterThan(50);
    expect(w.hiddenAbove).toBeLessThanOrEqual(65);
  });

  it('maxRows ≥ altura visual ⇒ devolve tudo (sem janelar)', () => {
    const text = 'Z'.repeat(30); // 30 chars
    const cols = 80; // cabe em 1 linha visual
    const w = windowComposerVisual(text, text.length, 5, cols);
    expect(w.text).toBe(text);
    expect(w.hiddenAbove).toBe(0);
    expect(w.hiddenBelow).toBe(0);
  });
});

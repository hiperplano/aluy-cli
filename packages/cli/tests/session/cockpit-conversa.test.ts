// EST-1015 (UX do cockpit) — a janela da CONVERSA por LINHAS VISUAIS (cockpit-conversa).
//
// O INVARIANTE anti-corrupção (raiz do "texto embaralhado/sobreposto"): a soma das
// alturas visuais dos blocos visíveis NUNCA passa de `room` — assim o conteúdo nunca
// estoura a Box fixa da região e o mis-clip do Ink (que MESCLA linhas) nem é exercitado.
// Prova PURA (sem Ink): medição espelho do <BlockView> + encaixe da cauda + clip na fonte.

import { describe, expect, it } from 'vitest';
import {
  wrappedLineCount,
  markdownLines,
  measureConversaBlock,
  clipConversaBlock,
  fitConversaWindow,
  streamPreviewMaxLines,
  type ConversaCtx,
} from '../../src/session/cockpit-conversa.js';
import type { SessionBlock } from '../../src/session/model.js';

const CTX: ConversaCtx = { columns: 100, rows: 33 };

const you = (text: string): SessionBlock => ({ kind: 'you', text });
const aluy = (text: string, streaming = false): SessionBlock => ({ kind: 'aluy', text, streaming });
const note = (lines: string[]): SessionBlock => ({ kind: 'note', title: 'ajuda', lines });

describe('wrappedLineCount — wrap por PALAVRA (o mesmo do Ink)', () => {
  it('linha curta = 1; vazia = 1', () => {
    expect(wrappedLineCount('oi', 80)).toBe(1);
    expect(wrappedLineCount('', 80)).toBe(1);
  });

  it('word-wrap conta MAIS linhas que o corte por largura (o furo do visualLines)', () => {
    // 12 palavras de 7 chars em 10 colunas: 1 palavra por linha (7+1+7 > 10) ⇒ 12
    // linhas. O corte por largura (ceil(95/10)) diria ~10 — subestimava ⇒ estouro.
    const text = Array.from({ length: 12 }, () => 'palavra').join(' ');
    expect(wrappedLineCount(text, 10)).toBe(12);
  });

  it('palavra mais LARGA que a coluna quebra DURO (hard: true)', () => {
    expect(wrappedLineCount('x'.repeat(25), 10)).toBe(3);
  });
});

describe('measureConversaBlock — espelho do <BlockView>', () => {
  it('you: rótulo + fala + respiro', () => {
    // 1 (▌ você) + 1 (fala curta) + 1 (paddingBottom) = 3.
    expect(measureConversaBlock(you('oi'), CTX)).toBe(3);
  });

  it('you multi-linha com wrap: cada linha-fonte conta suas linhas visuais', () => {
    const wide = 'x'.repeat(200); // 200 chars em 98 cols (100-2 indent) ⇒ 3 linhas.
    expect(measureConversaBlock(you(`a\n${wide}`), CTX)).toBe(1 + 1 + 3 + 1);
  });

  it('aluy concluído: rótulo + markdown + respiro (parágrafos separados por linha vazia)', () => {
    // 'Oi.\n\nTchau.' = 2 parágrafos = 2 linhas de markdown.
    expect(measureConversaBlock(aluy('Oi.\n\nTchau.'), CTX)).toBe(1 + 2 + 1);
  });

  it('aluy streaming ganha a linha do cursor ● e respeita o teto da prévia', () => {
    const short = aluy('Oi.', true);
    // 1 (rótulo) + 1 (parágrafo) + 1 (cursor) + 1 (pad) = 4.
    expect(measureConversaBlock(short, { ...CTX, streamMaxLines: 10 })).toBe(4);
    const long = aluy(Array.from({ length: 50 }, (_, i) => `linha ${i}`).join('\n'), true);
    const cap = 8;
    const h = measureConversaBlock(long, { ...CTX, streamMaxLines: cap });
    // rótulo + marcador `…N acima` + ≤cap linhas + cursor + pad.
    expect(h).toBeLessThanOrEqual(1 + 1 + cap + 1 + 1);
  });

  it('bang concluído: linha do ⏺ + box de saída + respiro', () => {
    const b: SessionBlock = { kind: 'bang', command: 'ls', status: 'ok', output: 'a\nb' };
    // 1 (⏺ shell) + [1 borda + 2 linhas + 1 borda] + 1 (pad) = 6.
    expect(measureConversaBlock(b, CTX)).toBe(6);
  });
});

describe('markdownLines — altura do markdown renderizado', () => {
  it('bloco de código conta a moldura (topo + linhas + base)', () => {
    expect(markdownLines('```js\na\nb\n```', 98, false)).toBe(2 + 2);
  });

  it('mono acrescenta as cercas visíveis (*negrito*) na largura medida', () => {
    const boldWord = `**${'x'.repeat(96)}**`; // 96 chars + 2 cercas = 98 > 97 ⇒ 2 linhas no mono.
    expect(markdownLines(boldWord, 97, true)).toBe(2);
    expect(markdownLines(boldWord, 97, false)).toBe(1);
  });
});

describe('fitConversaWindow — o INVARIANTE: soma das alturas ≤ room', () => {
  const blocks: SessionBlock[] = [];
  for (let i = 0; i < 20; i += 1) {
    blocks.push(you(`objetivo ${i}: ${'muito '.repeat(10)}longo`));
    blocks.push(aluy(`Resposta ${i}.\n${'⏺ write arquivo-'.padEnd(120, 'x')}\nFim.`));
  }

  it('nunca estoura o room (varre rooms e scrolls)', () => {
    for (const room of [1, 2, 3, 5, 8, 13, 21, 34]) {
      for (const scroll of [0, 1, 5, 17, 999]) {
        const w = fitConversaWindow(blocks, room, scroll, CTX);
        expect(w.usedLines).toBeLessThanOrEqual(room);
        let sum = 0;
        for (const b of w.blocks) sum += measureConversaBlock(b, CTX);
        expect(sum).toBeLessThanOrEqual(room);
        expect(w.hiddenAbove + (w.end - w.start) + w.hiddenBelow).toBe(blocks.length);
      }
    }
  });

  it('cauda ancorada: scroll 0 mostra o bloco MAIS NOVO', () => {
    const w = fitConversaWindow(blocks, 12, 0, CTX);
    expect(w.end).toBe(blocks.length);
    expect(w.hiddenBelow).toBe(0);
    expect(w.blocks.length).toBeGreaterThan(0);
  });

  it('scroll clampado deixa chegar ao TOPO (o bloco 0 visível)', () => {
    const w = fitConversaWindow(blocks, 12, 9999, CTX);
    expect(w.start).toBe(0);
    expect(w.hiddenAbove).toBe(0);
  });

  it('bloco sozinho maior que a região é CLIPADO NA FONTE (com marcador)', () => {
    const giant = note(Array.from({ length: 40 }, (_, i) => `linha ${i}`));
    const w = fitConversaWindow([giant], 8, 0, CTX);
    expect(w.blocks.length).toBe(1);
    expect(w.usedLines).toBeLessThanOrEqual(8);
    const clipped = w.blocks[0]!;
    expect(clipped.kind).toBe('note');
    expect((clipped as { lines: readonly string[] }).lines.join('\n')).toContain('…(+');
  });

  it('vazio/room 0 ⇒ janela vazia (sem lixo)', () => {
    expect(fitConversaWindow([], 10, 0, CTX).blocks).toEqual([]);
    expect(fitConversaWindow(blocks, 0, 0, CTX).blocks).toEqual([]);
  });
});

describe('clipConversaBlock — clip na fonte (generalização do clipNoteToFit)', () => {
  it('you longo: mantém a cabeça + marcador, e a medição cabe', () => {
    const long = you(Array.from({ length: 30 }, (_, i) => `pedido ${i}`).join('\n'));
    const c = clipConversaBlock(long, 10, CTX);
    expect(measureConversaBlock(c, CTX)).toBeLessThanOrEqual(10);
    expect((c as { text: string }).text).toContain('…(+');
  });

  it('aluy STREAMING maior que a região encolhe pela CAUDA (mantém o fim)', () => {
    const cap = streamPreviewMaxLines(6);
    const long = aluy(Array.from({ length: 60 }, (_, i) => `token ${i}`).join('\n'), true);
    const c = clipConversaBlock(long, 6, { ...CTX, streamMaxLines: cap });
    expect(measureConversaBlock(c, { ...CTX, streamMaxLines: cap })).toBeLessThanOrEqual(6);
    expect((c as { text: string }).text).toContain('token 59'); // a cauda (o mais novo) fica.
  });

  it('saída de bang concluído clipada com marcador', () => {
    const b: SessionBlock = {
      kind: 'bang',
      command: 'seq 1 100',
      status: 'ok',
      output: Array.from({ length: 100 }, (_, i) => `${i}`).join('\n'),
    };
    const c = clipConversaBlock(b, 12, CTX);
    expect(measureConversaBlock(c, CTX)).toBeLessThanOrEqual(12);
    expect((c as { output?: string }).output).toContain('…(+');
  });

  it('bloco que já cabe passa INTACTO (mesma referência)', () => {
    const b = you('curto');
    expect(clipConversaBlock(b, 10, CTX)).toBe(b);
  });
});

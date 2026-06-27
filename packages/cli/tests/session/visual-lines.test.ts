// EST-0965 (anti-flicker, WRAP) — PROVA PURA da contagem de linhas VISUAIS. O furo
// que sobrou do #59/#64: o orçamento da região viva contava linhas-FONTE (1 por
// `\n`). Uma linha mais larga que `columns` QUEBRA em VÁRIAS linhas VISUAIS — então a
// altura REAL estourava o orçado ⇒ o Ink redesenhava tudo ⇒ flicker. Aqui ancoramos
// `visualLines` (e a janela de cauda visual) no comportamento de wrap, sem TUI.

import { describe, expect, it } from 'vitest';
import { displayWidth, visualLines, windowTailVisual } from '../../src/session/visual-lines.js';

describe('visualLines — conta linhas VISUAIS (com WRAP), não linhas-fonte', () => {
  it('linha de 200 chars em columns=80 ⇒ 3 visuais (ceil(200/80))', () => {
    expect(visualLines('x'.repeat(200), 80)).toBe(3);
  });

  it('linha exatamente da largura ⇒ 1; +1 char ⇒ 2 (borda do ceil)', () => {
    expect(visualLines('x'.repeat(80), 80)).toBe(1);
    expect(visualLines('x'.repeat(81), 80)).toBe(2);
  });

  it('multi-linha soma o wrap de CADA linha-fonte', () => {
    // 250 chars em col=80 = 4 visuais (ceil(250/80)); 5 linhas dessas = 20.
    const wide = Array.from({ length: 5 }, () => 'a'.repeat(250)).join('\n');
    expect(visualLines(wide, 80)).toBe(20);
  });

  it('mistura: linha curta (1) + linha larga (3) + vazia (1) = 5', () => {
    const text = ['curta', 'y'.repeat(200), ''].join('\n');
    expect(visualLines(text, 80)).toBe(1 + 3 + 1);
  });

  it('string vazia ⇒ 1 linha visual (uma linha-fonte vazia ocupa 1)', () => {
    expect(visualLines('', 80)).toBe(1);
  });

  it('só `\\n` (2 linhas-fonte vazias) ⇒ 2', () => {
    expect(visualLines('\n', 80)).toBe(2);
  });

  it('columns<=0 (largura desconhecida) ⇒ cai p/ linhas-FONTE (degradação graciosa)', () => {
    const wide = Array.from({ length: 5 }, () => 'a'.repeat(250)).join('\n');
    expect(visualLines(wide, 0)).toBe(5);
    expect(visualLines(wide, -1)).toBe(5);
  });
});

describe('displayWidth — largura de exibição conservadora', () => {
  it('ASCII = 1 coluna por char', () => {
    expect(displayWidth('hello')).toBe(5);
  });

  it('CJK = 2 colunas por char (largura-dupla)', () => {
    expect(displayWidth('日本')).toBe(4);
  });

  it('emoji astral = 2 colunas e conta UMA vez (itera por code point)', () => {
    expect(displayWidth('🚀')).toBe(2);
  });

  it('combinante (zero-width) não soma largura', () => {
    // 'e' + combining acute accent (U+0301) ⇒ largura 1, não 2.
    expect(displayWidth('é')).toBe(1);
  });

  it('CJK larga estoura o wrap mais cedo: 40 ideogramas em col=80 ⇒ 1 visual; 41 ⇒ 2', () => {
    expect(visualLines('日'.repeat(40), 80)).toBe(1); // 40*2 = 80
    expect(visualLines('日'.repeat(41), 80)).toBe(2); // 82 > 80
  });
});

describe('windowTailVisual — janela de cauda por linhas VISUAIS (com WRAP)', () => {
  it('texto que cabe (visualmente) ⇒ inteiro, hidden 0', () => {
    const r = windowTailVisual('a\nb\nc', 6, 80);
    expect(r.text).toBe('a\nb\nc');
    expect(r.hidden).toBe(0);
  });

  it('linhas LARGAS: mostra MENOS linhas-fonte, mas cabe no teto VISUAL', () => {
    // 5 linhas-fonte de 250 chars (4 visuais cada). Teto 6 visuais ⇒ cabe só 1
    // linha-fonte (4 visuais; a 2ª levaria a 8 > 6). hidden = 4 linhas-fonte acima.
    const lines = Array.from({ length: 5 }, (_, i) => `L${i}` + 'z'.repeat(248));
    const text = lines.join('\n');
    const r = windowTailVisual(text, 6, 80);
    expect(r.hidden).toBe(4); // 4 linhas-fonte ocultas (o `…N acima` mostra 4)
    expect(r.text).toBe(lines[4]); // a CAUDA (última linha-fonte)
    // a altura VISUAL do que mostramos NÃO passa do teto.
    expect(visualLines(r.text, 80)).toBeLessThanOrEqual(6);
  });

  it('janela por linhas-fonte VS visual: a visual mostra menos quando há wrap', () => {
    // 10 linhas curtas + a janela visual deixa caber mais linhas-fonte que a larga.
    const curtas = Array.from({ length: 10 }, (_, i) => `linha ${i}`).join('\n');
    const r = windowTailVisual(curtas, 6, 80);
    // curtas: 6 visuais = 6 linhas-fonte (sem wrap) ⇒ hidden 4, cauda = últimas 6.
    expect(r.hidden).toBe(4);
    expect(r.text.split('\n')).toHaveLength(6);
    expect(r.text).toContain('linha 9');
    expect(r.text).not.toContain('linha 3');
  });

  it('uma ÚNICA linha gigante é CORTADA na cauda p/ caber no teto VISUAL (HUNT-RENDER)', () => {
    // FIX HUNT-RENDER: uma linha-fonte gigante SEM `\n` (minified JS/JSON/log de MB) NÃO
    // pode ser pintada inteira — o Ink a re-flui em centenas de linhas visuais e estoura
    // o orçamento (live-budget reservou só maxLines+1) ⇒ flicker/flood. Cortamos na CAUDA.
    const huge = 'g'.repeat(2000); // 25 visuais em col=80, teto 6 — ANTES vinha inteira
    const r = windowTailVisual(huge, 6, 80);
    expect(r.hidden).toBe(0); // não há linhas-FONTE acima (o corte é de LARGURA)
    // a altura VISUAL do que mostramos NÃO passa do teto (era 25 — o bug).
    expect(visualLines(r.text, 80)).toBeLessThanOrEqual(6);
    expect(r.text.startsWith('…')).toBe(true); // marcador de corte no início
    expect(r.text.endsWith('g')).toBe(true); // mantém a CAUDA (conteúdo mais novo)
  });

  it('linha gigante de MEGABYTES (1 linha-fonte) fica bounded (anti-flood/flicker)', () => {
    // O cenário crítico do hunt: `run_command` despeja minified JS de 1MB numa linha só.
    // O render TEM de ficar bounded a maxLines visuais, não despejar 1MB no Ink.
    const mb = 'x'.repeat(1_000_000);
    const r = windowTailVisual(mb, 6, 80);
    expect(visualLines(r.text, 80)).toBeLessThanOrEqual(6);
    // o texto pintado é minúsculo (~maxLines*columns), não o MB inteiro.
    expect(r.text.length).toBeLessThanOrEqual(6 * 80 + 1);
    expect(r.hidden).toBe(0);
  });

  it('última linha gigante após linhas-fonte ocultas: corta a cauda E reporta hidden', () => {
    // linhas curtas acima + última linha-fonte gigante: a janela mantém só a última,
    // que é cortada na cauda; hidden conta as linhas-FONTE acima.
    const text = ['a', 'b', 'c', 'z'.repeat(2000)].join('\n');
    const r = windowTailVisual(text, 6, 80);
    expect(r.hidden).toBe(3); // a, b, c ocultas
    expect(visualLines(r.text, 80)).toBeLessThanOrEqual(6);
    expect(r.text.startsWith('…')).toBe(true);
    expect(r.text.endsWith('z')).toBe(true);
  });

  it('CJK na linha gigante: corte por largura de exibição, não corta surrogate/code point', () => {
    const huge = '界'.repeat(2000); // 4000 cols, teto 6 em col=80
    const r = windowTailVisual(huge, 6, 80);
    expect(visualLines(r.text, 80)).toBeLessThanOrEqual(6);
    // toda a cauda mantida é ideograma íntegro (nunca meio code point).
    expect([...r.text.slice(1)].every((ch) => ch === '界')).toBe(true);
  });

  it('columns<=0 (largura desconhecida): NÃO corta a linha gigante (degradação graciosa)', () => {
    const huge = 'g'.repeat(2000);
    const r = windowTailVisual(huge, 6, 0);
    expect(r.text).toBe(huge); // sem largura conhecida, mantém o comportamento antigo
    expect(r.hidden).toBe(0);
  });

  it('maxLines ausente ⇒ texto inteiro; columns<=0 ⇒ janela por linhas-fonte', () => {
    const text = Array.from({ length: 5 }, () => 'a'.repeat(250)).join('\n');
    expect(windowTailVisual(text, undefined, 80).hidden).toBe(0);
    // col=0: cai p/ fonte ⇒ 5 linhas-fonte, teto 2 ⇒ mostra 2, hidden 3.
    const r = windowTailVisual(text, 2, 0);
    expect(r.hidden).toBe(3);
    expect(r.text.split('\n')).toHaveLength(2);
  });
});

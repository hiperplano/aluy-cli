// EST-0982 (type-ahead) — <QueuedInputs>: render BOUNDED da fila + a conta de altura
// (`queuedInputsLines`) que o orçamento anti-flicker (live-budget) usa p/ não estourar.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  QueuedInputs,
  PendingInjects,
  queuedInputsLines,
  VISIBLE_QUEUED,
} from '../../src/ui/components/QueuedInputs.js';
import { displayWidth } from '../../src/session/visual-lines.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return (s ?? '').replace(ANSI, '');
}

function renderQueue(items: readonly string[]): string {
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <QueuedInputs items={items} />
    </ThemeProvider>,
  );
  const out = plain(r.lastFrame());
  r.unmount();
  return out;
}

describe('QueuedInputs — fila do type-ahead (EST-0982)', () => {
  it('vazia ⇒ não renderiza nada (sem chrome quando não há fila)', () => {
    expect(renderQueue([])).toBe('');
  });

  it('mostra a contagem + as mensagens pendentes (palavra "fila" junto — a11y)', () => {
    const out = renderQueue(['primeira ideia', 'segunda ideia']);
    expect(out).toContain('2 na fila');
    expect(out).toContain('primeira ideia');
    expect(out).toContain('segunda ideia');
  });

  it('COLAPSA acima do teto: mostra VISIBLE_QUEUED + a contagem do excedente (…+N)', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const out = renderQueue(items);
    // os 3 primeiros aparecem; o resto colapsa em `…+2`.
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
    expect(out).toContain(`…+${items.length - VISIBLE_QUEUED}`);
    // os colapsados NÃO aparecem em texto (só na contagem).
    expect(out).not.toContain('  › d');
    expect(out).not.toContain('  › e');
    expect(out).toContain('5 na fila');
  });

  it('queuedInputsLines: a conta de altura BATE com a composição do render', () => {
    // 0 itens → 0 linhas (nada renderiza).
    expect(queuedInputsLines(0)).toBe(0);
    // 1..VISIBLE → cabeçalho (1) + N itens.
    expect(queuedInputsLines(1)).toBe(2);
    expect(queuedInputsLines(VISIBLE_QUEUED)).toBe(1 + VISIBLE_QUEUED);
    // > VISIBLE → cabeçalho (1) + VISIBLE itens + 1 (a linha `…+N`).
    expect(queuedInputsLines(VISIBLE_QUEUED + 3)).toBe(1 + VISIBLE_QUEUED + 1);
  });

  // FIX (HUNT-RENDER) — `elide` media por `.length` (unidades UTF-16) e cortava por `slice`.
  // Um item de 48 CJK (length 48, mas 96 COLUNAS) passava o teto e renderizava com 96 cols ⇒
  // estourava ITEM_MAX_COLS, re-fluía e FURAVA o orçamento anti-flicker (a altura reservada
  // por `queuedInputsLines` assume ≤1 linha por item). Agora elide por DISPLAY WIDTH.
  it('elide CJK: item de muitos ideogramas cabe em ITEM_MAX_COLS COLUNAS (não em .length)', () => {
    // 60 CJK = 120 colunas; o item DEVE ser elidido p/ ≤ 48 colunas (o teto interno).
    const item = '中'.repeat(60);
    const out = renderQueue([item]);
    // pega a linha do item (a que começa com `  › `).
    const itemLine = out.split('\n').find((l) => l.includes('›'))!;
    // remove o prefixo `  › ` (4 col) e mede o resto por DISPLAY WIDTH.
    const content = itemLine.replace(/^\s*›\s/, '');
    expect(displayWidth(content)).toBeLessThanOrEqual(48);
    expect(itemLine).toContain('…'); // foi elidido.
  });

  it('elide emoji: corte não parte um par surrogate (sem `\\uFFFD` órfão)', () => {
    const item = '🎉'.repeat(40); // 40 emojis = 80 colunas ⇒ elide.
    const out = renderQueue([item]);
    expect(out).not.toContain('�'); // nenhum replacement char (surrogate partido).
    expect(out).toContain('…');
  });
});

function renderPending(items: readonly string[]): string {
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <PendingInjects items={items} />
    </ThemeProvider>,
  );
  const out = plain(r.lastFrame());
  r.unmount();
  return out;
}

describe('PendingInjects — indicador "encaixando…" do mid-turn (EST-0982)', () => {
  it('vazio ⇒ não renderiza nada (sem chrome quando não há pendente)', () => {
    expect(renderPending([])).toBe('');
  });

  it('mostra a contagem + os ecos pendentes (palavra "encaixando" junto — a11y)', () => {
    const out = renderPending(['foque em auth', 'rode os testes']);
    expect(out).toContain('2 encaixando');
    expect(out).toContain('foque em auth');
    expect(out).toContain('rode os testes');
  });

  it('rótulo é DISTINTO da fila de submit ("encaixando", não "na fila")', () => {
    const out = renderPending(['btw']);
    expect(out).toContain('encaixando');
    expect(out).not.toContain('na fila');
  });

  it('COLAPSA acima do teto (mesma altura BOUNDED de queuedInputsLines)', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    const out = renderPending(items);
    expect(out).toContain('a');
    expect(out).toContain('c');
    expect(out).toContain(`…+${items.length - VISIBLE_QUEUED}`);
    expect(out).not.toContain('  › d');
  });
});

// EST-0972 — render do <HistoryPicker> (ink-testing-library). Cobre: lista de sessões
// (data · cwd abreviado · 1ª mensagem), marcador do selecionado (›), dica de teclas,
// estado vazio ("nenhuma sessão anterior"), e o INVARIANTE CLI-SEC-6 (só metadados —
// nunca o corpo da transcrição).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { HistoryPicker } from '../../src/ui/components/HistoryPicker.js';
import type { SessionSummary } from '../../src/io/index.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const SESSIONS: readonly SessionSummary[] = [
  {
    id: 'sess-b',
    createdAt: 1,
    updatedAt: 2,
    cwd: '/home/dev/proj/x',
    tier: 't',
    blockCount: 4,
    title: 'adicione o slash /history',
  },
  {
    id: 'sess-a',
    createdAt: 1,
    updatedAt: 1,
    cwd: '/home/dev/outro',
    tier: 't',
    blockCount: 2,
    title: 'corrija o bug do composer',
  },
];

describe('HistoryPicker — seletor de sessões', () => {
  it('lista cada sessão com cwd ABREVIADO + 1ª mensagem', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={SESSIONS} selected={0} home="/home/dev" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('~/proj/x');
    expect(out).toContain('adicione o slash /history');
    expect(out).toContain('corrija o bug do composer');
  });

  it('marca o item SELECIONADO com › (a11y: não só cor)', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={SESSIONS} selected={1} home="/home/dev" />);
    const out = plain(lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.includes('proj') || l.includes('outro'));
    // a linha do item 1 (outro) leva o ›; a do item 0 (proj) não.
    const selLine = lines.find((l) => l.includes('outro'));
    expect(selLine).toMatch(/›/);
  });

  it('mostra a dica de teclas (↑↓ navega · enter retoma · esc cancela)', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={SESSIONS} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('enter retoma');
    expect(out).toContain('esc cancela');
  });

  it('lista VAZIA ⇒ "nenhuma sessão anterior"', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={[]} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('nenhuma sessão anterior');
  });

  it('CLI-SEC-6 — só metadados: não há marcador de corpo de transcrição', () => {
    // O picker recebe SessionSummary (sem blocks): não há como vazar o corpo. Sanidade:
    // o título exibido é a 1ª fala (rótulo), e nada além de data/cwd/título aparece.
    const { lastFrame } = wrap(<HistoryPicker sessions={SESSIONS} selected={0} home="/home/dev" />);
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('blockCount');
    expect(out).not.toContain('tier');
  });

  // F88 (anti-flicker, Windows) — JANELAMENTO. Sem teto de altura, dezenas de sessões
  // salvas faziam o `/history` despejar a lista inteira no inline ⇒ a região dinâmica
  // estourava `rows` ⇒ o Ink caía no caminho full-screen (`outputHeight>=rows`,
  // clearTerminal por frame) ⇒ flicker no console do Windows. O `maxRows` janela a lista.
  const MANY: readonly SessionSummary[] = Array.from({ length: 50 }, (_, i) => ({
    id: `sess-${i}`,
    createdAt: 1,
    updatedAt: 1,
    cwd: '/home/dev/proj',
    tier: 't',
    blockCount: 2,
    title: `sessao-num-${i}`,
  }));
  const titleLines = (out: string): number =>
    out.split('\n').filter((l) => /sessao-num-\d+/.test(l)).length;

  it('JANELA a lista a `maxRows` itens (não despeja 50 sessões) + indicador de resto', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={MANY} selected={0} maxRows={8} />);
    const out = plain(lastFrame() ?? '');
    expect(titleLines(out)).toBe(8); // exatamente o teto, não as 50.
    expect(out).toContain('42'); // 50 − 8 = 42 sessões a mais.
    expect(out).toContain('a mais');
  });

  it('a janela CENTRA no selecionado (item escolhido sempre visível, mesmo no fim)', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={MANY} selected={49} maxRows={8} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('sessao-num-49'); // o último, selecionado, está na janela.
    expect(out).toMatch(/›/); // e leva o marcador de seleção.
    expect(titleLines(out)).toBe(8);
  });

  it('lista MENOR que `maxRows` ⇒ mostra tudo, sem indicador de resto', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={SESSIONS} selected={0} maxRows={10} />);
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('a mais');
  });

  it('default seguro: SEM `maxRows`, ainda janela (teto interno) — nunca despeja 50', () => {
    const { lastFrame } = wrap(<HistoryPicker sessions={MANY} selected={0} />);
    const out = plain(lastFrame() ?? '');
    expect(titleLines(out)).toBeLessThanOrEqual(10); // default interno = 10.
    expect(out).toContain('a mais');
  });
});

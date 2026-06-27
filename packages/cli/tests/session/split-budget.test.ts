// EST-0990 — PROVA PURA do orçamento do MODO VIEW AVANÇADO (split CHAT | LOG). Dois
// eixos: (1) a DEGRADAÇÃO por LARGURA (`resolveSplitLayout`: single/side/tabs/<60) e
// (2) a ALTURA do frame com as DUAS colunas vivas (`splitLiveBudget`): `max(chat, log)
// + chrome ≤ rows-1` — a trava anti-flicker (#95/#118/#133). Sem TUI, sem modelo.

import { describe, expect, it } from 'vitest';
import {
  resolveSplitLayout,
  splitLiveBudget,
  splitChromeOverhead,
  SPLIT_MIN_COLS,
  TABS_MIN_COLS,
  LOG_MIN_COLS,
  SPLIT_CHAT_RATIO,
  LOG_VISIBLE_ROWS,
} from '../../src/session/split-budget.js';
import {
  LIVE_CHROME_BASE_ROWS,
  respiroOverhead,
  liveOverheadLines,
  modeIndicatorOverhead,
  MIN_SPEECH_LINES,
} from '../../src/session/live-budget.js';
import type { SessionBlock } from '../../src/session/model.js';

const longSpeech = (lines: number): SessionBlock => ({
  kind: 'aluy',
  text: Array.from({ length: lines }, (_, i) => `linha ${i + 1}`).join('\n'),
  streaming: true,
});
const runningTool = (): SessionBlock => ({
  kind: 'tool',
  verb: 'rodar',
  target: 'npm test',
  result: '',
  status: 'running',
  verbGerund: 'rodando',
});

describe('resolveSplitLayout — degradação por largura (V2)', () => {
  it('split OFF ⇒ single em qualquer largura, sem aviso', () => {
    for (const cols of [40, 80, 120, 200]) {
      const r = resolveSplitLayout(cols, false);
      expect(r.layout).toBe('single');
      expect(r.disabledByWidth).toBe(false);
    }
  });

  it('ON & ≥100 col ⇒ side (lado-a-lado), com chat≈62% e log≥34', () => {
    const r = resolveSplitLayout(120, true);
    expect(r.layout).toBe('side');
    expect(r.chatCols).toBe(Math.floor(120 * SPLIT_CHAT_RATIO));
    expect(r.logCols).toBeGreaterThanOrEqual(LOG_MIN_COLS);
    // chat + gutter + log = colunas totais (sem sobra/estouro).
    expect(r.chatCols + 1 + r.logCols).toBe(120);
  });

  it('exatamente 100 col ⇒ side; 99 col ⇒ tabs (a fronteira SPLIT_MIN_COLS)', () => {
    expect(resolveSplitLayout(SPLIT_MIN_COLS, true).layout).toBe('side');
    expect(resolveSplitLayout(SPLIT_MIN_COLS - 1, true).layout).toBe('tabs');
  });

  it('60–99 col ⇒ tabs', () => {
    for (const cols of [60, 75, 99]) {
      expect(resolveSplitLayout(cols, true).layout).toBe('tabs');
    }
  });

  it('exatamente 60 col ⇒ tabs; 59 col ⇒ single DESABILITADO (aviso)', () => {
    expect(resolveSplitLayout(TABS_MIN_COLS, true).layout).toBe('tabs');
    const r = resolveSplitLayout(TABS_MIN_COLS - 1, true);
    expect(r.layout).toBe('single');
    expect(r.disabledByWidth).toBe(true);
  });

  it('<60 col com split ON ⇒ single + disabledByWidth (1 coluna com aviso)', () => {
    for (const cols of [20, 40, 59]) {
      const r = resolveSplitLayout(cols, true);
      expect(r.layout).toBe('single');
      expect(r.disabledByWidth).toBe(true);
    }
  });
});

describe('splitChromeOverhead — chrome EXTRA do split/tabs (+1 em cada, 0 em single)', () => {
  it('single=0, side=+1 (rótulos), tabs=+1 (abas)', () => {
    expect(splitChromeOverhead('single')).toBe(0);
    expect(splitChromeOverhead('side')).toBe(1);
    expect(splitChromeOverhead('tabs')).toBe(1);
  });
});

// ALTURA TOTAL do frame no split, do jeito que o Ink desenharia: as DUAS colunas
// vivas (chat = overhead + fala-no-teto; log = sua janela) compartilham a altura; o
// frame é o chrome + max(chat, log). Tem de ficar ≤ rows-1 (anti-flicker).
function splitFrameHeight(args: {
  rows: number;
  live: readonly SessionBlock[];
  mode: 'normal' | 'unsafe';
  logColumnLines: number;
  columns: number;
}): number {
  const { rows, live, mode, logColumnLines, columns } = args;
  const layout = 'side' as const;
  const speechMax = splitLiveBudget({
    rows,
    layout,
    live,
    phase: 'streaming',
    hasBlocks: true,
    mode,
    columns,
    logColumnLines,
  });
  const overhead = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns });
  const speech = live.find((b) => b.kind === 'aluy' && b.streaming);
  const speechLines = speech && speech.kind === 'aluy' ? speech.text.split('\n').length : 0;
  const bodyShown = Math.min(speechLines, speechMax);
  const willTruncate = speechLines > speechMax;
  const chatColumn = overhead + bodyShown + (willTruncate ? 1 : 0);
  const logColumn = Math.min(LOG_VISIBLE_ROWS, logColumnLines);
  const chromeBase = LIVE_CHROME_BASE_ROWS + respiroOverhead(rows) + splitChromeOverhead(layout);
  // O banner unsafe (excedente) e a folga já estão no orçamento; aqui modelamos a
  // altura real = chrome + max(coluna_chat, coluna_log) + excedente do banner.
  return chromeBase + modeIndicatorOverhead(mode) + Math.max(chatColumn, logColumn);
}

describe('splitLiveBudget — as 2 colunas vivas cabem em rows-1 (anti-flicker)', () => {
  it('side: fala LONGA + tool + log cheio ⇒ frame ≤ rows-1, normal E unsafe', () => {
    for (const mode of ['normal', 'unsafe'] as const) {
      for (const rows of [24, 40, 50]) {
        const total = splitFrameHeight({
          rows,
          live: [longSpeech(80), runningTool()],
          mode,
          logColumnLines: LOG_VISIBLE_ROWS, // log na altura máxima
          columns: 124,
        });
        expect(total, `mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('o teto da fala ENCOLHE quando a coluna do log fica mais alta', () => {
    const base = {
      rows: 40,
      layout: 'side' as const,
      live: [longSpeech(80)],
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
      columns: 124,
    };
    const semLog = splitLiveBudget({ ...base, logColumnLines: 0 });
    const comLog = splitLiveBudget({ ...base, logColumnLines: LOG_VISIBLE_ROWS });
    expect(comLog).toBeLessThanOrEqual(semLog);
  });

  it('o split desconta +1 de chrome vs o single (a linha de rótulos)', () => {
    const base = {
      rows: 40,
      live: [longSpeech(80)],
      phase: 'streaming' as const,
      hasBlocks: true,
      mode: 'normal' as const,
      columns: 124,
      logColumnLines: 0,
    };
    const side = splitLiveBudget({ ...base, layout: 'side' });
    const single = splitLiveBudget({ ...base, layout: 'single' });
    // side custa +1 de chrome (rótulos) ⇒ 1 linha a menos de teto que single (mesmo log).
    expect(single - side).toBe(1);
  });

  it('piso de segurança: terminal minúsculo nunca dá teto < MIN_SPEECH_LINES', () => {
    const max = splitLiveBudget({
      rows: 10,
      layout: 'side',
      live: [longSpeech(80), runningTool()],
      phase: 'streaming',
      hasBlocks: true,
      mode: 'normal',
      columns: 124,
      logColumnLines: LOG_VISIBLE_ROWS,
    });
    expect(max).toBe(MIN_SPEECH_LINES);
  });
});

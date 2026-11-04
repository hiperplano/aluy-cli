// Cockpit — a duplicação de linhas em /fullscreen (composer 2×, `┃ ola` 2×, header sumido).
//
// Duas causas-raiz, provadas em tmux (100x30 → 80x24):
//  (a) RESIZE: o reset do differ rodava num useEffect (passivo), DEPOIS de o Ink já ter
//      escrito o frame da dimensão nova ⇒ o 1º frame pós-resize era DIFFADO contra a
//      geometria antiga e deixava o reflow do terminal na tela. O differ agora detecta a
//      mudança de geometria sozinho (síncrono) e faz full-paint.
//  (b) ALTURA/LARGURA: a nota de entrada (111 colunas, título `cockpit` + texto que dizia
//      "modo cockpit" de novo) quebrava em 2 linhas. Agora é 1 linha, truncada com `…`.
// Estes testes FALHAM se qualquer um dos dois voltar.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Cockpit, fitCockpitNoteToWidth } from '../../src/session/Cockpit.js';
import { I18nProvider, i18n as makeI18n } from '../../src/i18n/index.js';
import { resolveCockpitLayout } from '../../src/session/cockpit-layout.js';
import { createCockpitDiffer } from '../../src/session/synchronized-output.js';
import stringWidth from 'string-width';
import { displayWidth } from '../../src/session/visual-lines.js';
import type { SessionState } from '../../src/session/model.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const CSI = String.fromCharCode(27) + '[';
const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

const entered = makeI18n('pt-BR').t('cockpit.entered');

function stateOf(withTurn: boolean): SessionState {
  const blocks: SessionState['blocks'][number][] = [
    { kind: 'note', title: 'cockpit', lines: [entered] },
  ];
  if (withTurn) {
    blocks.push({ kind: 'you', text: 'ola' });
    blocks.push({
      kind: 'aluy',
      text: 'Olá! 👋 Sou o Aluy, agente de terminal 🚀, pronto para trabalhar no diretório do projeto aluy-cli. O que você gostaria de fazer? Posso explorar o código, editar arquivos, rodar comandos e testes 👍🏽.',
      streaming: false,
    });
  }
  return {
    phase: 'idle',
    blocks,
    mode: 'normal',
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 10, windowPct: 1 },
  } as unknown as SessionState;
}

async function frameAt(rows: number, cols: number, withTurn: boolean): Promise<string[]> {
  const layout = resolveCockpitLayout(rows, cols);
  if (layout.kind !== 'cockpit') throw new Error(`layout deveria caber em ${cols}x${rows}`);
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: ENV })}>
      <I18nProvider value={makeI18n('pt-BR')}>
        <Cockpit
          state={stateOf(withTurn)}
          layout={layout}
          logSections={[]}
          focus="conversa"
          conversaScroll={0}
          logScroll={0}
          input=""
          cursorPos={0}
          composerActive
          showCursor={false}
          hintState="idle"
          tierDisplay="Flux"
          isDefaultTier
          columns={cols}
          frame={0}
          cwd="/proj"
        />
      </I18nProvider>
    </ThemeProvider>,
  );
  await flush();
  const lines = plain(r.lastFrame() ?? '').split('\n');
  r.unmount();
  return lines;
}

describe('cockpit — o frame nunca excede o terminal (altura e largura)', () => {
  it('60 colunas: o cockpit RECUSA (não desenha um frame que não cabe)', () => {
    expect(resolveCockpitLayout(24, 60).kind).toBe('refuse');
  });

  for (const [rows, cols] of [
    [24, 80],
    [30, 100],
    [40, 120],
  ] as const) {
    for (const withTurn of [false, true]) {
      it(`${cols}x${rows} ${withTurn ? 'com resposta c/ emoji' : 'só a nota'}: linhas ≤ rows, nenhuma linha > cols, nota em 1 linha`, async () => {
        const lines = await frameAt(rows, cols, withTurn);
        expect(lines.length).toBeLessThanOrEqual(rows);
        // largura medida como o Ink mede (string-width): é a régua do wrap dele.
        for (const l of lines) expect(stringWidth(l), JSON.stringify(l)).toBeLessThanOrEqual(cols);
        const noteLines = lines.filter(
          (l) => l.includes('tab alterna') || l.includes('tab altern'),
        );
        // (com uma resposta longa a nota pode ter rolado p/ fora da janela: aí são 0.)
        expect(
          noteLines.length,
          'a nota de entrada deve ocupar no máximo 1 linha',
        ).toBeLessThanOrEqual(1);
        if (!withTurn) expect(noteLines).toHaveLength(1);
        // a linha da nota termina inteira (`/fullscreen sai`) ou truncada (`…`) — nunca quebrada
        // no meio (a cauda cairia numa 2ª linha).
        for (const l of noteLines) expect(/(\/fullscreen sai|…)\s*$/.test(l), l).toBe(true);
        // sem o "cockpit modo cockpit" (rótulo + texto repetindo a palavra).
        expect(lines.join('\n')).not.toContain('cockpit modo cockpit');
        // nenhuma linha "órfã" da nota quebrada (`/fullscreen sai` sozinho, recuado).
        expect(lines.filter((l) => l.trim() === '/fullscreen sai')).toHaveLength(0);
      });
    }
  }

  it('estreito: a nota é truncada com `…` (não quebra); larga: fica inteira', () => {
    const note = {
      kind: 'note',
      title: 'cockpit',
      lines: [entered],
    } as SessionState['blocks'][number];
    const narrow = fitCockpitNoteToWidth(note, 80) as { lines: string[] };
    expect(narrow.lines[0]!.endsWith('…')).toBe(true);
    expect(displayWidth(narrow.lines[0]!) + 10).toBeLessThanOrEqual(80);
    const wide = fitCockpitNoteToWidth(note, 120) as { lines: string[] };
    expect(wide.lines[0]).toBe(entered);
  });
});

// ── emulador mínimo de tela (CUP / EL / ED / LF / texto) p/ provar o estado FINAL ────────
function makeScreen(rows: number, cols: number) {
  let grid: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let r = 0;
  let c = 0;
  const api = {
    resize(nr: number, nc: number): void {
      // o terminal CROPA/estende a grade preservando o topo-esquerda (reflow imperfeito).
      grid = Array.from({ length: nr }, (_, i) =>
        Array.from({ length: nc }, (_, j) => grid[i]?.[j] ?? ' '),
      );
      rows = nr;
      cols = nc;
    },
    write(s: string): void {
      for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (ch === '\x1b' && s[i + 1] === '[') {
          let j = i + 2;
          while (j < s.length && /[0-9;?]/.test(s[j]!)) j++;
          const params = s.slice(i + 2, j);
          const fin = s[j];
          if (fin === 'H') {
            const [pr, pc] = params.split(';');
            r = Math.min(rows - 1, (Number(pr) || 1) - 1);
            c = Math.min(cols - 1, (Number(pc) || 1) - 1);
          } else if (fin === 'K') {
            for (let k = c; k < cols; k++) grid[r]![k] = ' ';
          } else if (fin === 'J') {
            for (let k = c; k < cols; k++) grid[r]![k] = ' ';
            for (let q = r + 1; q < rows; q++) grid[q] = Array(cols).fill(' ');
          }
          i = j;
          continue;
        }
        if (ch === '\n') {
          r++;
          c = 0;
          if (r >= rows) {
            grid.shift();
            grid.push(Array(cols).fill(' '));
            r = rows - 1;
          }
        } else if (ch === '\r') c = 0;
        else if (c < cols) grid[r]![c++] = ch;
      }
    },
    lines: (): string[] => grid.map((row) => row.join('').trimEnd()),
  };
  return api;
}

const frame = (rows: number, cols: number, composer: string): string => {
  const out: string[] = [`header ${cols}`, '-'.repeat(cols)];
  while (out.length < rows - 2) out.push(`corpo ${out.length}`);
  out.push('-'.repeat(cols), composer);
  return `${CSI}2J${CSI}3J${CSI}H${out.join('\n')}\n`;
};

describe('createCockpitDiffer — resize não deixa linhas velhas/duplicadas', () => {
  it('100x30 → 80x24: o 1º frame da dimensão nova é full-paint (estado final == frame)', () => {
    let rows = 30;
    let cols = 100;
    const differ = createCockpitDiffer(
      () => rows,
      () => rows,
      () => cols,
    );
    const scr = makeScreen(rows, cols);
    scr.write(differ.transform(frame(30, 100, '❯ digite um objetivo ou /comando…')));
    // o terminal redimensiona ANTES de a App ter chance de resetar o differ (useEffect).
    rows = 24;
    cols = 80;
    scr.resize(24, 80);
    // lixo de reflow que o terminal deixa para trás:
    scr.write(`${CSI}5;1Hlixo velho do reflow${CSI}24;1H`);
    scr.write(differ.transform(frame(24, 80, '❯ digite um objetivo ou /comando…')));
    const got = scr.lines();
    const want = frame(24, 80, '❯ digite um objetivo ou /comando…')
      .replace(ANSI, '')
      .split('\n')
      .slice(0, 24)
      .map((l) => l.trimEnd());
    expect(got).toEqual(want);
    expect(got.filter((l) => l.includes('digite um objetivo ou'))).toHaveLength(1);
    expect(got[0]).toBe('header 80');
  });

  it('só as COLUNAS mudam (rows iguais): também full-paint', () => {
    let cols = 100;
    const differ = createCockpitDiffer(
      () => 24,
      () => 24,
      () => cols,
    );
    differ.transform(frame(24, 100, '❯ x'));
    cols = 120;
    const out = differ.transform(frame(24, 120, '❯ x'));
    expect(out.startsWith(`${CSI}H`)).toBe(true);
    expect(out).toContain('header 120');
  });

  it('frame mais alto que o terminal real é clipado (nunca rola a tela)', () => {
    const differ = createCockpitDiffer(
      () => 24,
      () => 30, // layout "velho" ainda em 30 enquanto o terminal já tem 24
      () => 80,
    );
    const scr = makeScreen(24, 80);
    const out = differ.transform(frame(30, 80, '❯ fim'));
    // 24 linhas ⇒ no máximo 23 LF: um a mais ROLARIA a tela e dessincronizaria o CUP-absoluto.
    expect(out.split('\n').length - 1).toBeLessThanOrEqual(23);
    scr.write(out);
    const lines = scr.lines();
    expect(lines).toHaveLength(24);
    expect(lines[23]).toBe('❯ fim');
  });
});

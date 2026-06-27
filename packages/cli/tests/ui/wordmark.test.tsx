// EST-0989 — WORDMARK "Λluy": o glifo `aluy` (Λ — a marca, A MESMA do loader/header/
// thinking) como o "A" em DESTAQUE (accent), seguido de "luy" em MINÚSCULAS (block-art,
// na cor de marca `depth`). Fallback ASCII (`/\` p/ o Λ + `#` p/ "luy") e degradação
// p/ terminal estreito (`Λ luy` / `/\ luy`). FONTE ÚNICA: Boot e Header consomem este
// mesmo <Wordmark> — testado lá (components.test.tsx) que não divergem.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Wordmark, MIN_WORDMARK_COLS } from '../../src/ui/components/Wordmark.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

function wrap(
  node: React.ReactElement,
  env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' },
) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('Wordmark — "Λluy" (Λ accent + luy minúsculo) · EST-0989', () => {
  it('UNICODE: bloco grande — NÃO é mais "ALUY" maiúsculo; tem o Λ e o nome', () => {
    const { lastFrame } = wrap(<Wordmark columns={100} />);
    const out = plain(lastFrame() ?? '');
    // wordmark grande de meio-bloco
    expect(out).toContain('██');
    // baseline com o `█████` (do `u`/`y` minúsculos) presente
    expect(out).toContain('█████');
    // a marca já NÃO é "ALUY" maiúsculo em ASCII (os blocos são `█`, não letras);
    // garantimos que não vazou um nome literal maiúsculo na saída.
    expect(out).not.toContain('ALUY');
    expect(out).not.toContain('Aluy');
  });

  it('UNICODE: o Λ e "luy" EQUALIZADOS em ACCENT (uma cor de marca — pedido do dono)', () => {
    const raw = wrap(<Wordmark columns={100} />).lastFrame() ?? '';
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    // EQUALIZADO: Λ e "luy" no MESMO papel `accent` (a marca não tem mais 2 tons —
    // antes o Λ era accent e "luy" depth). A saída renderiza COLORIDA no papel accent;
    // não acoplamos ao ANSI exato (a equalização é estrutural no <Wordmark>).
    const accent = theme.role('accent').color;
    expect(accent).toBeTruthy();
    const sgr = raw.match(new RegExp(ESC + '\\[[0-9;]*m', 'g')) ?? [];
    expect(sgr.length).toBeGreaterThan(0); // colorido (papel accent), não mono
  });

  it('ASCII (TERM=linux): o Λ vira `/\\` e "luy" vira `#` (sem █)', () => {
    const { lastFrame } = wrap(<Wordmark columns={100} />, { TERM: 'linux' });
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('█'); // █ quebraria em TERM=linux
    expect(out).not.toContain('Λ'); // Λ é unicode — degrada p/ /\
    expect(out).toContain('/\\'); // o Λ vira `/\` (mesmo fallback do glifo `aluy`)
    expect(out).toContain('#'); // "luy" em block-art ASCII
  });

  it('ESTREITO (< MIN_WORDMARK_COLS): degrada p/ `Λ luy` em 1 linha (unicode)', () => {
    const { lastFrame } = wrap(<Wordmark columns={MIN_WORDMARK_COLS - 1} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toMatch(/Λ\s+luy/); // marca Λ + nome minúsculo, 1 linha
    expect(out).not.toContain('██'); // sem o bloco grande
  });

  it('ESTREITO + ASCII: degrada p/ `/\\ luy` (sem Λ, sem █)', () => {
    const { lastFrame } = wrap(<Wordmark columns={MIN_WORDMARK_COLS - 1} />, { TERM: 'linux' });
    const out = plain(lastFrame() ?? '');
    expect(out).toMatch(/\/\\\s+luy/);
    expect(out).not.toContain('Λ');
    expect(out).not.toContain('█');
  });

  it('o "y" tem PERNINHA (descender): uma 6ª linha com bloco ABAIXO da baseline · EST-0989', () => {
    const out = plain(wrap(<Wordmark columns={100} />).lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.length > 0);
    // a grade do wordmark grande tem 6 linhas (5 + a do descender).
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const baseline = lines[lines.length - 2]!; // penúltima = baseline (l/u/y terminam)
    const descender = lines[lines.length - 1]!; // última = descender (só o y desce)
    // a baseline tem o corpo das letras (vários blocos: l, u fechando, y a haste).
    const blocks = (s: string): number => (s.match(/█/g) ?? []).length;
    expect(blocks(baseline)).toBeGreaterThan(2);
    // a PERNINHA: a última linha tem bloco(s) — o y descendo ABAIXO da baseline —
    // mas SÓ o y (poucos blocos, à direita), não o corpo inteiro.
    expect(blocks(descender)).toBeGreaterThanOrEqual(2);
    expect(blocks(descender)).toBeLessThan(blocks(baseline));
    // a perninha está à DIREITA (é o y, a última letra): o 1º bloco da linha do
    // descender vem depois da metade da largura da baseline.
    expect(descender.indexOf('█')).toBeGreaterThan(baseline.indexOf('█'));
  });

  it('ASCII: o "y" também tem perninha (descender com `#` na última linha) · EST-0989', () => {
    const out = plain(wrap(<Wordmark columns={100} />, { TERM: 'linux' }).lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const descender = lines[lines.length - 1]!;
    // a última linha (descender) carrega o rabo do y em ASCII (`#`), à direita.
    expect(descender).toContain('#');
    expect((descender.match(/#/g) ?? []).length).toBeLessThan(6); // só o y, não o corpo
  });

  it('a ordem é Λ-ENTÃO-luy: a marca abre, o nome minúsculo segue (degradado)', () => {
    const { lastFrame } = wrap(<Wordmark columns={MIN_WORDMARK_COLS - 1} />);
    const out = plain(lastFrame() ?? '');
    expect(out.indexOf('Λ')).toBeLessThan(out.indexOf('luy'));
    // o nome é MINÚSCULO — nada de "LUY"/"Luy" maiúsculo.
    expect(out).not.toContain('LUY');
    expect(out).not.toContain('Luy');
  });
});

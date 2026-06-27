// EST-0965 — render de TABELA (ink-testing-library). Prova: a tabela do Tiago
// ALINHA, o cabeçalho fica em destaque, CABE em ≤ columns, e em terminal estreito
// (columns=40) TRUNCA sem estourar. Alinhamento L/C/R respeitado. Snapshot do
// alinhamento. Fallbacks (mono / ASCII) cobertos.
//
// FORCE_COLOR=3 (vitest.config.ts) ⇒ a Ink emite ANSI truecolor real; asserções de
// texto usam plain() (sem ANSI) e de COR usam a saída crua.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../src/ui/theme/context.js';
import { resolveTheme } from '../../../src/ui/theme/theme.js';
import { Markdown } from '../../../src/ui/markdown/Markdown.js';
import { displayWidth } from '../../../src/session/visual-lines.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
const ASCII = { TERM: 'linux' };

function frame(node: React.ReactElement, env: NodeJS.ProcessEnv): string {
  const theme = resolveTheme({ env });
  const { lastFrame } = render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
  return lastFrame() ?? '';
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

// A tabela REAL que o Tiago reclamou (listagem de arquivos).
const TIAGO = [
  '| Tipo | Nome | Tamanho | Modificação |',
  '| --- | --- | --- | --- |',
  '| dir | src | - | hoje |',
  '| arquivo | README.md | 2.1 KB | ontem |',
  '| arquivo | package.json | 1.4 KB | semana passada |',
].join('\n');

/** Maior largura de exibição entre as linhas (sem ANSI). */
function maxLineWidth(out: string): number {
  return Math.max(0, ...plain(out).split('\n').map(displayWidth));
}

describe('TableBlock — render da tabela do Tiago', () => {
  it('columns=100: cabeçalho + linhas presentes, colunas ALINHADAS, cabe em ≤ columns', () => {
    const out = frame(<Markdown text={TIAGO} columns={100} />, TRUECOLOR);
    const p = plain(out);
    // conteúdo presente
    expect(p).toContain('Tipo');
    expect(p).toContain('Modificação');
    expect(p).toContain('README.md');
    expect(p).toContain('semana passada');
    // ALINHAMENTO: a coluna "Nome" começa na MESMA coluna em todas as linhas de dados.
    const lines = p.split('\n').filter((l) => l.includes('src') || l.includes('README.md'));
    const colOf = (line: string, needle: string): number => line.indexOf(needle);
    const srcLine = lines.find((l) => l.includes('src'))!;
    const readmeLine = lines.find((l) => l.includes('README.md'))!;
    // "src" e "README.md" são a 2ª coluna ⇒ começam alinhados (mesmo offset).
    expect(colOf(srcLine, 'src')).toBe(colOf(readmeLine, 'README.md'));
    // CABE: nenhuma linha excede a largura do terminal.
    expect(maxLineWidth(out)).toBeLessThanOrEqual(100);
  });

  it('columns=100: cabeçalho em DESTAQUE (accent truecolor) + régua separadora', () => {
    const out = frame(<Markdown text={TIAGO} columns={100} />, TRUECOLOR);
    // accent #DDA13F = 221;161;63 — o cabeçalho carrega a cor de destaque.
    expect(out).toContain('221;161;63');
    // régua separadora sutil (box-drawing) entre header e corpo.
    expect(plain(out)).toMatch(/─.*┼.*─/);
  });

  it('columns=40 (estreito): TRUNCA/encolhe sem estourar a largura', () => {
    const out = frame(<Markdown text={TIAGO} columns={40} />, TRUECOLOR);
    // NENHUMA linha visual passa de 40 colunas (anti-flicker: não re-flui).
    expect(maxLineWidth(out)).toBeLessThanOrEqual(40);
    // truncou ⇒ apareceu reticências em algum lugar.
    expect(plain(out)).toContain('…');
  });

  it('snapshot do alinhamento — columns=100 (plain, sem ANSI)', () => {
    expect(plain(frame(<Markdown text={TIAGO} columns={100} />, TRUECOLOR))).toMatchSnapshot();
  });

  it('snapshot do alinhamento — columns=40 estreito (plain)', () => {
    expect(plain(frame(<Markdown text={TIAGO} columns={40} />, TRUECOLOR))).toMatchSnapshot();
  });
});

describe('TableBlock — alinhamento por coluna L/C/R', () => {
  const ALIGNED = [
    '| esq | meio | dir |',
    '|:---|:--:|---:|',
    '| a | b | c |',
    '| aaaa | bbbb | cccc |',
  ].join('\n');

  it('right-aligned: valores curtos ganham espaço À ESQUERDA (encostam à direita)', () => {
    const p = plain(frame(<Markdown text={ALIGNED} columns={80} />, TRUECOLOR));
    const lines = p.split('\n');
    // a 3ª coluna é right: 'c' (curto) e 'cccc' (largo) terminam na MESMA coluna.
    const endOf = (needle: string): number => {
      const line = lines.find((l) => new RegExp(`\\b${needle}\\b`).test(l))!;
      return line.indexOf(needle) + needle.length;
    };
    expect(endOf('c')).toBe(endOf('cccc'));
  });
});

describe('TableBlock — fallbacks', () => {
  it('NO_COLOR: sem cor, mas estrutura/cabeçalho presentes (régua + texto)', () => {
    const out = frame(<Markdown text={TIAGO} columns={100} />, NOCOLOR);
    expect(out).not.toMatch(/\[38;2;/); // sem truecolor
    expect(plain(out)).toContain('Tipo');
    expect(plain(out)).toContain('README.md');
  });

  it('ASCII (TERM=linux): régua degrada p/ -+- (sem box unicode)', () => {
    const p = plain(frame(<Markdown text={TIAGO} columns={100} />, ASCII));
    expect(p).toContain('-+-'); // cruzamento ASCII
    expect(p).not.toContain('┼'); // sem tê unicode
    expect(p).toContain('Tipo');
  });

  it('sem columns (largura desconhecida): usa natural, não quebra', () => {
    const p = plain(frame(<Markdown text={TIAGO} />, TRUECOLOR));
    expect(p).toContain('semana passada'); // largura natural ⇒ nada truncado
  });
});

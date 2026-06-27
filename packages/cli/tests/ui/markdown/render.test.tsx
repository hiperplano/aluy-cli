// EST · acabamento TUI — render de markdown/code-block (ink-testing-library) +
// fallbacks OBRIGATÓRIOS (NO_COLOR / não-TTY-ASCII / 16-cores). Snapshots da
// SAÍDA (com ANSI em truecolor; sem ANSI em mono).
//
// Cor: a suíte roda com FORCE_COLOR=3 (vitest.config.ts) p/ que a Ink emita a
// SAÍDA ANSI truecolor REAL. Em truecolor as cores fragmentam substrings, então
// asserções de texto contíguo usam `plain()` (sem ANSI); asserções de COR usam
// a saída crua.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../src/ui/theme/context.js';
import { resolveTheme } from '../../../src/ui/theme/theme.js';
import { Markdown } from '../../../src/ui/markdown/Markdown.js';
import { CodeBlock } from '../../../src/ui/markdown/CodeBlock.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
const ASCII = { TERM: 'linux' }; // 16-cores SEM unicode (console linux)

function frame(node: React.ReactElement, env: NodeJS.ProcessEnv): string {
  const theme = resolveTheme({ env });
  const { lastFrame } = render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
  return lastFrame() ?? '';
}

// Remove sequências ANSI (SGR) p/ afirmar ESTRUTURA/texto contíguo independente
// de cor — em truecolor as cores fragmentam substrings adjacentes.
const ESC = String.fromCharCode(27); // ESC: prefixo de toda sequencia ANSI
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

const SAMPLE = [
  '# Titulo',
  '',
  'um **negrito**, um *italico* e um `codigo`.',
  '',
  '- item um',
  '- item dois',
  '',
  '> citacao',
  '',
  'link [ADR](https://aluy.dev/41).',
  '',
  '```ts',
  'const x = 1; // ok',
  '```',
].join('\n');

describe('Markdown — render truecolor (acabamento)', () => {
  it('mostra negrito/lista/titulo/citacao/link e o bloco realcado', () => {
    const out = frame(<Markdown text={SAMPLE} />, TRUECOLOR);
    const p = plain(out);
    expect(p).toContain('Titulo');
    expect(p).toContain('negrito');
    expect(p).toContain('codigo');
    expect(p).toContain('• item um'); // bullet unicode •
    expect(p).toContain('citacao');
    expect(p).toContain('ADR');
    expect(p).toContain('(https://aluy.dev/41)'); // URL dim ao lado
    expect(p).toContain('typescript'); // cabecalho do code-block
    // ACABAMENTO ligado: a saida CRUA carrega ANSI de cor truecolor…
    expect(out).toMatch(/\[38;2;/);
    // …e a keyword `const` esta realcada em accent (#DDA13F = 221;161;63).
    expect(out).toContain('221;161;63');
  });

  it('snapshot estavel da saida truecolor', () => {
    expect(frame(<Markdown text={SAMPLE} />, TRUECOLOR)).toMatchSnapshot();
  });
});

describe('Markdown — FALLBACK NO_COLOR (a11y): formatado, sem cor, marcas visiveis', () => {
  it('nao emite NENHUM codigo de cor (SGR de cor), mas mantem formato', () => {
    const out = frame(<Markdown text={SAMPLE} />, NOCOLOR);
    // SEM cor: nada de `38;2;` (truecolor) nem cor ANSI basica 30-37.
    expect(out).not.toMatch(/\[38;2;/);
    expect(out).not.toMatch(/\[3[0-7]m/);
    // marcas VISIVEIS (o sentido nao pode morar so na cor).
    expect(out).toContain('*negrito*');
    expect(out).toContain('_italico_');
    expect(out).toContain('`codigo`');
    expect(out).toContain('# Titulo'); // nivel do titulo preservado em texto
    expect(out).toContain('(https://aluy.dev/41)'); // URL visivel
  });

  it('snapshot da saida NO_COLOR', () => {
    expect(frame(<Markdown text={SAMPLE} />, NOCOLOR)).toMatchSnapshot();
  });
});

describe('Markdown — FALLBACK nao-TTY / ASCII (TERM=linux)', () => {
  it('degrada box e bullets p/ ASCII, texto cru legivel', () => {
    const p = plain(frame(<Markdown text={SAMPLE} />, ASCII));
    expect(p).toContain('- item um'); // bullet ascii
    expect(p).toContain('| const x = 1'); // box ascii do code-block
    expect(p).toContain('+- typescript');
    expect(p).not.toContain('•'); // sem bullet unicode •
    expect(p).not.toContain('╭'); // sem canto de box unicode ╭
  });
});

describe('CodeBlock — moldura + realce + cerca aberta', () => {
  it('cerca aberta (streaming) mostra reticencias no cabecalho', () => {
    const p = plain(frame(<CodeBlock code={'const x = 1'} lang="ts" open />, TRUECOLOR));
    expect(p).toContain('typescript …'); // typescript …
  });

  it('linguagem desconhecida ⇒ rotulo cru + conteudo em fg (sem quebrar)', () => {
    const p = plain(frame(<CodeBlock code={'algo'} lang="naoexiste" />, TRUECOLOR));
    expect(p).toContain('naoexiste');
    expect(p).toContain('algo');
  });

  it('baseRole fgDim (turno passado) propaga dim ao texto comum', () => {
    const out = frame(<Markdown text={'so texto'} baseRole="fgDim" />, TRUECOLOR);
    // fgDim usa dimColor (SGR 2) — presenca do dim prova a cronologia esmaecida.
    expect(out).toMatch(/\[2m/);
  });
});

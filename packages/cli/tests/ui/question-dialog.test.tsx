// EST-1110 · ADR-0114 · CA-8 — render do <QuestionDialog> (single/multi/text + "Outro").
// Apresentação PURA (a captura de teclas é do App). Prova: os 3 formatos renderizam a
// pergunta + as opções/campo; o cursor e as marcações de multi aparecem; "Outro" surge;
// tudo legível inclusive em NO_COLOR (mono) — a11y (glifo/texto, não só cor).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { QuestionDialog, OTHER_INDEX } from '../../src/ui/components/QuestionDialog.js';
import type { QuestionSpec } from '@hiperplano/aluy-cli-core';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };

const single: QuestionSpec = {
  kind: 'single',
  question: 'Qual stack?',
  options: [{ label: 'Next' }, { label: 'Remix', description: 'web fullstack' }],
  allowOther: true,
};
const multi: QuestionSpec = {
  kind: 'multi',
  question: 'Quais checks?',
  options: [{ label: 'lint' }, { label: 'test' }, { label: 'build' }],
  allowOther: true,
};
const text: QuestionSpec = { kind: 'text', question: 'Descreva o bug', allowOther: true };

describe('QuestionDialog — render dos 3 formatos (a11y, tokens-only)', () => {
  it('single: mostra a pergunta, as opções e o cabeçalho da tool', () => {
    const { lastFrame } = wrap(<QuestionDialog spec={single} cursor={0} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Pergunta'); // título da tool (substantivo, capitalizado)
    expect(out).toContain('Qual stack?');
    expect(out).toContain('Next');
    expect(out).toContain('Remix');
    expect(out).toContain('web fullstack'); // descrição da opção
    expect(out).toContain('Outro'); // entrada de resposta livre (allowOther)
  });

  it('caixa SIMÉTRICA: TOPO, separador e base fecham no MESMO codepoint (cantos alinham)', () => {
    const { lastFrame } = wrap(<QuestionDialog spec={single} cursor={0} />, UTF8);
    const lines = (lastFrame() ?? '').split('\n').map((l) => plain(l).replace(/^\s+/, ''));
    // topo (╭…╮), separador (├…┤) e base (╰…╯) — as TRÊS bordas horizontais.
    const top = lines.find((l) => /^[╭+].*[╮+]\s*$/.test(l.trimEnd()));
    const sep = lines.find((l) => /^[├+].*[┤+]\s*$/.test(l.trimEnd()) && /─|-/.test(l));
    const bottom = lines.find((l) => /^[╰+].*[╯+]\s*$/.test(l.trimEnd()));
    expect(top, 'topo presente').toBeDefined();
    expect(sep, 'separador presente').toBeDefined();
    expect(bottom, 'base presente').toBeDefined();
    // codepoints (Array.from): o `⚠` conta 1; o topo fecha no MESMO codepoint que a base.
    // (regressão: o `−12` antigo deixava o topo 1 codepoint mais longo.)
    const cps = (s: string) => Array.from(s.trimEnd()).length;
    expect(cps(top!), 'topo == base').toBe(cps(bottom!));
    expect(cps(sep!), 'separador == base').toBe(cps(bottom!));
  });

  it('single: o cursor (›) marca a linha sob foco — a11y NÃO só por cor', () => {
    const { lastFrame } = wrap(<QuestionDialog spec={single} cursor={1} />, NOCOLOR);
    const out = plain(lastFrame() ?? '');
    // o marcador de cursor `›` aparece (independe de cor) e o footer ensina a navegação
    expect(out).toContain('›');
    expect(out).toContain('navega');
  });

  it('multi: mostra caixas [ ]/[x] e o footer com "espaço marca"', () => {
    const selected = new Set<number>([1]);
    const { lastFrame } = wrap(
      <QuestionDialog spec={multi} cursor={0} selected={selected} />,
      NOCOLOR,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('[x]'); // 'test' marcado
    expect(out).toContain('[ ]'); // os não marcados
    expect(out).toContain('espaço marca');
  });

  it('text (digitando): mostra o campo livre, o rascunho e o footer de digitação', () => {
    const { lastFrame } = wrap(
      <QuestionDialog spec={text} cursor={0} editing draft="já" />,
      NOCOLOR,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Descreva o bug');
    expect(out).toContain('já'); // o rascunho aparece
    expect(out).toContain('enter confirma'); // footer da digitação livre
  });

  it('text (sem editing): footer ensina a digitar', () => {
    const { lastFrame } = wrap(<QuestionDialog spec={text} cursor={0} />, NOCOLOR);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('digite a resposta');
  });

  it('"Outro" em digitação mostra o rascunho (cursor sob OTHER_INDEX)', () => {
    const { lastFrame } = wrap(
      <QuestionDialog spec={single} cursor={OTHER_INDEX} editing draft="GraphQL" />,
      NOCOLOR,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('GraphQL');
  });

  it('allowOther:false ⇒ NÃO mostra a entrada "Outro"', () => {
    const { lastFrame } = wrap(
      <QuestionDialog spec={{ ...single, allowOther: false }} cursor={0} />,
      NOCOLOR,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('Outro');
  });
});

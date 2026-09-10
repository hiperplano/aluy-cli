// A moldura dos seletores nunca encosta no limite do terminal.
//
// O dono, em 08-09/09: "por que não aparece a borda da direita do menu". Aqui a moldura
// fecha dos dois lados em 200, 120, 100, 90 e 80 colunas — medi em sessão real de tmux —,
// então o desenho está certo e a causa é a moldura ocupar EXATAMENTE `columns` enquanto o
// terminal dele conta uma coluna a menos de espaço útil (última coluna que dispara
// auto-wrap, ou glifo que medimos com 1 e ele desenha com 2 — `⚠`/`◈`/setas, comum no
// Windows Terminal).
//
// HONESTIDADE: isto é MITIGAÇÃO. Não reproduzi o defeito dele em largura nenhuma; o que
// estes casos travam é o INVARIANTE (a moldura deixa uma coluna de folga), não a afirmação
// de que o invariante é a causa do que ele vê.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PickerFrame,
  larguraDaMoldura,
  FOLGA_DIREITA,
} from '../../src/ui/components/PickerFrame.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';
import { Text } from 'ink';

/** Renderiza a moldura numa largura dada e devolve as linhas sem códigos de cor. */
function linhas(columns: number): string[] {
  const { lastFrame } = render(
    <ThemeProvider theme={resolveTheme('escuro')}>
      <PickerFrame columns={columns}>
        <Text>item</Text>
      </PickerFrame>
    </ThemeProvider>,
  );
  // O ESC precisa entrar no padrão: sem ele sobra o \x1b de cada sequência e a CONTAGEM
  // de colunas fica 2 a mais por linha colorida — foi assim que a primeira versão deste
  // arquivo mediu 121 onde havia 119 e acusou a moldura de estourar.
  // eslint-disable-next-line no-control-regex
  return (lastFrame() ?? '').replace(/\u001b\[[0-9;]*m/g, '').split('\n');
}

describe('larguraDaMoldura (PURA)', () => {
  it('deixa exatamente uma coluna de folga', () => {
    expect(larguraDaMoldura(120)).toBe(120 - FOLGA_DIREITA);
    expect(larguraDaMoldura(80)).toBe(80 - FOLGA_DIREITA);
  });

  it('sem largura conhecida (não-TTY) não impõe nada', () => {
    expect(larguraDaMoldura(undefined)).toBeUndefined();
    expect(larguraDaMoldura(Number.NaN)).toBeUndefined();
  });

  it('terminal minúsculo: melhor largura nenhuma que uma inútil', () => {
    expect(larguraDaMoldura(10)).toBeUndefined();
    expect(larguraDaMoldura(19)).toBeUndefined();
    expect(larguraDaMoldura(20)).toBe(19);
  });
});

describe('a moldura desenhada', () => {
  it('FECHA dos dois lados e NÃO ocupa a última coluna', () => {
    for (const columns of [200, 120, 100, 90, 80, 40]) {
      const desenhadas = linhas(columns).filter((l) => l.trim() !== '');
      expect(desenhadas.length, `largura ${String(columns)}`).toBeGreaterThan(0);
      for (const l of desenhadas) {
        expect(l.length, `largura ${String(columns)}: "${l.slice(0, 24)}…"`).toBeLessThanOrEqual(
          columns - FOLGA_DIREITA,
        );
      }
      const topo = desenhadas[0] ?? '';
      const base = desenhadas[desenhadas.length - 1] ?? '';
      expect(topo.startsWith('╭'), `topo em ${String(columns)}`).toBe(true);
      expect(topo.endsWith('╮'), `topo FECHADO em ${String(columns)}`).toBe(true);
      expect(base.endsWith('╯'), `base FECHADA em ${String(columns)}`).toBe(true);
    }
  });

  it('a folga é REAL — a moldura para uma coluna antes do limite', () => {
    // Sem esta asserção o caso acima passaria com a moldura ocupando tudo (o `<=` seria
    // satisfeito por uma moldura menor por outro motivo qualquer).
    const topo = linhas(120).filter((l) => l.trim() !== '')[0] ?? '';
    expect(topo.length).toBe(119);
  });
});

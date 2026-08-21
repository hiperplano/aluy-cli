// F-PROFUNDIDADE — o contrato ATUAL do `<Divider>`: ele não desenha mais régua nenhuma,
// mas continua ocupando UMA linha.
//
// Este arquivo travava o desenho anterior (régua de largura total no chrome e traço curto
// entre turnos). O dono pediu os dois fora — "as linhas no CLI deixam uma cara muito ruim",
// e depois "um ____________ não está legal separando as seções de conversa" — e a separação
// passou a vir da moldura das caixas e do espaço em volta dos rótulos.
//
// O que segue sendo INVARIANTE, e é o que este arquivo protege agora: a ALTURA. O cockpit
// soma a altura de cada região para fechar o grid sem tremer (ADR-0076 §5); um `<Divider>`
// que devolvesse zero linha faria o layout refluir e traria de volta o jitter que aquele
// desenho existe para matar. É por isso que ele devolve uma linha VAZIA em vez de nada.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Divider } from '../../src/ui/components/Divider.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';

/** Renderiza o divisor e devolve o frame já sem códigos de cor. */
function frameDe(node: React.ReactElement): string {
  const { lastFrame } = render(<ThemeProvider theme={resolveTheme('escuro')}>{node}</ThemeProvider>);
  // eslint-disable-next-line no-control-regex
  return (lastFrame() ?? '').replace(/\[[0-9;]*m/g, '');
}

describe('<Divider> — sem régua, com altura', () => {
  it('não desenha traço algum', () => {
    expect(frameDe(<Divider columns={80} />).trim()).toBe('');
  });

  it('ocupa exatamente UMA linha — o cockpit soma alturas para fechar o grid', () => {
    expect(frameDe(<Divider columns={80} />).split('\n')).toHaveLength(1);
  });

  it('a altura não depende da largura (nem em terminal estreito ou largo)', () => {
    for (const columns of [1, 20, 80, 200]) {
      expect(frameDe(<Divider columns={columns} />).split('\n')).toHaveLength(1);
    }
  });

  it('a variante `subtle` também saiu — mesma linha vazia, mesma altura', () => {
    expect(frameDe(<Divider columns={80} subtle />).trim()).toBe('');
    expect(frameDe(<Divider columns={80} subtle />).split('\n')).toHaveLength(1);
  });

  it('sem `columns` (não-TTY) não quebra e mantém a linha', () => {
    expect(frameDe(<Divider />).split('\n')).toHaveLength(1);
  });

  it('o papel não reintroduz desenho — `depth` e `fgDim` saem iguais', () => {
    expect(frameDe(<Divider columns={80} role="depth" />).trim()).toBe('');
    expect(frameDe(<Divider columns={80} role="fgDim" />).trim()).toBe('');
  });
});

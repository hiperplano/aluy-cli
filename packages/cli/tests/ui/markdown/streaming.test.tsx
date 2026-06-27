// EST · acabamento TUI — NÃO REGRIDE o stream: o markdown/realce aplica no TEXTO
// ACUMULADO do turno, o cursor de trabalho ● (EST-0965) segue na ponta e uma cerca
// ``` ainda aberta no meio do stream realça o que já chegou sem "vazar" markdown.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../../src/ui/theme/context.js';
import { resolveTheme } from '../../../src/ui/theme/theme.js';
import { AluyBlock } from '../../../src/ui/components/TurnBlock.js';

const TRUECOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };

function frame(node: React.ReactElement, env = TRUECOLOR): string {
  const theme = resolveTheme({ env });
  const { lastFrame } = render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
  return lastFrame() ?? '';
}

describe('AluyBlock — markdown no acumulado, stream fluido', () => {
  it('streaming mostra o cursor de trabalho ● na ponta da fala já renderizada', () => {
    const out = frame(<AluyBlock text={'pensando em **isto**'} streaming frame={0} />);
    expect(out).toContain('aluy');
    expect(out).toContain('isto'); // markdown aplicado mesmo durante o stream
    expect(out).toContain('●'); // cursor de trabalho presente (EST-0965)
  });

  it('cerca ``` aberta (meio do stream): realça o já-chegado, sem vazar markdown', () => {
    const partial = ['aqui vai:', '```ts', 'const x = 1; // **não** é negrito'].join('\n');
    const out = frame(<AluyBlock text={partial} streaming frame={0} />);
    // cabeçalho do bloco com "…" (cerca aberta)
    expect(out).toContain('typescript …');
    // o `**não**` está DENTRO do código: aparece literal, NÃO vira negrito
    expect(out).toContain('**não**');
  });

  it('turno passado (isCurrent=false) propaga fgDim e não mostra cursor', () => {
    const out = frame(<AluyBlock text={'texto antigo'} streaming={false} isCurrent={false} />);
    expect(out).toMatch(/\[2m/); // dimColor (cronologia esmaecida)
    expect(out).not.toContain('●'); // sem cursor de trabalho fora do stream (EST-0965)
  });

  // EST-0965 — TABELA streaming-safe: chegando token-a-token, a tabela INCOMPLETA
  // (header sem o separador `|---|` ainda) NÃO renderiza quebrada — sai como texto
  // cru/parcial; quando o separador chega, vira a tabela alinhada.
  it('tabela INCOMPLETA (só header, sem separador) ⇒ texto cru, sem régua de tabela', () => {
    const partial = '| Tipo | Nome |';
    const out = frame(<AluyBlock text={partial} streaming frame={0} columns={80} />);
    expect(out).toContain('| Tipo | Nome |'); // pipes crus visíveis (ainda é texto)
    expect(out).not.toMatch(/┼/); // NÃO há régua de tabela ⇒ não renderizou quebrada
  });

  it('tabela COMPLETA (header+separador+linhas) ⇒ alinha, com régua, sem pipes crus de borda', () => {
    const full = ['| Tipo | Nome |', '|---|---|', '| dir | src |'].join('\n');
    const out = frame(<AluyBlock text={full} streaming={false} columns={80} />);
    expect(out).toMatch(/┼/); // régua de tabela presente ⇒ renderizou como tabela
    expect(out).toContain('Tipo');
    expect(out).toContain('src');
  });
});

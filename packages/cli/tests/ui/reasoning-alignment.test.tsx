// O "⋯ pensando" / "⋯ pensou N caracteres" ALINHADOS com o nome e com a fala.
//
// Relato do dono (16/09): "aquele ...pensando e o ...pensou ficam desposicionados em relação
// ao aluy e também em relação ao texto da caixa". Na tela:
//
//     ┃ Λluy  ✔ 20.8k tokens · 42% cache · 10.3s
//     ┃⋯ pensou 323 caracteres          ← colado na barra
//     ┃ Olá! 👋 Tudo bem?
//
// O cabeçalho e a fala (`<Markdown>`) começam com 1 coluna de respiro depois da barra; as linhas
// do raciocínio eram desenhadas sem ele.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';

const ESC = String.fromCharCode(27);
const stripAnsi = (s: string): string => s.replace(new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g'), '');

/** Coluna (0-based) do 1º caractere não-branco DEPOIS da barra, na linha que contém `trecho`. */
function columnAfterBar(frame: string, snippet: string): number {
  const line = frame.split('\n').find((l) => l.includes(snippet));
  if (line === undefined) throw new Error(`linha com "${snippet}" não encontrada:\n${frame}`);
  const withoutBar = line.replace(/^[┃|]/, '');
  return withoutBar.search(/\S/);
}

const themes = {
  'com fundo (aluyBg)': resolveTheme({
    theme: 'escuro',
    env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  } as never),
  'sem cor (NO_COLOR)': resolveTheme({ env: { TERM: 'xterm-256color', NO_COLOR: '1' } } as never),
};

describe.each(Object.entries(themes))('raciocínio alinhado — %s', (_nome, theme) => {
  const renderPlain = (node: React.ReactElement): string =>
    stripAnsi(render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '');

  it('"⋯ pensou" começa na MESMA coluna da fala e do nome', () => {
    const out = renderPlain(
      <AluyBlock text="Olá! Tudo bem?" reasoning={'x'.repeat(323)} columns={80} />,
    );
    const speech = columnAfterBar(out, 'Olá!');
    expect(columnAfterBar(out, 'pensou 323')).toBe(speech);
    expect(columnAfterBar(out, 'luy')).toBe(speech);
  });

  it('"⋯ pensando" (ao vivo) também', () => {
    const out = renderPlain(
      <AluyBlock text="começando" streaming reasoning="rascunho" columns={80} />,
    );
    expect(columnAfterBar(out, 'pensando')).toBe(columnAfterBar(out, 'começando'));
  });

  it('o raciocínio exibido quando NÃO houve fala segue a mesma margem', () => {
    const out = renderPlain(<AluyBlock text="" reasoning="pensei e não conclui" columns={80} />);
    const header = columnAfterBar(out, 'só produziu raciocínio');
    expect(columnAfterBar(out, 'pensei e não conclui')).toBe(header);
    expect(columnAfterBar(out, 'luy')).toBe(header);
  });
});

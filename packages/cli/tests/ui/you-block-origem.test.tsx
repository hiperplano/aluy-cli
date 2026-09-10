// O DISTINTIVO DE ORIGEM no bloco `você` (pedido do dono: "deveria ter algum jeito de
// mostrar que a msg chegou pelo telegram... ao invés de mostrar você deveria mostrar algo
// como telegram").
//
// Sem ele, uma mensagem que chegou do celular sai na transcrição IDÊNTICA a algo digitado
// no terminal — e o dono perde a única pista de por onde a conversa está acontecendo.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { YouBlock } from '../../src/ui/components/TurnBlock.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';

const SGR = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');

function frameDe(node: React.ReactElement): string {
  const { lastFrame } = render(
    <ThemeProvider theme={resolveTheme('escuro')}>{node}</ThemeProvider>,
  );
  return (lastFrame() ?? '').replace(SGR, '');
}

describe('YouBlock — distintivo de origem', () => {
  it('SEM origem: o cabeçalho é `você` puro (o caso normal não regride)', () => {
    const f = frameDe(<YouBlock text="ola" columns={80} />);
    expect(f).toContain('você');
    expect(f).not.toContain('·');
  });

  it('COM origem `telegram`: o cabeçalho DIZ de onde veio', () => {
    const f = frameDe(<YouBlock text="ola" columns={80} origem="telegram" />);
    expect(f).toContain('telegram');
  });

  it('o TEXTO da mensagem continua aparecendo', () => {
    const f = frameDe(<YouBlock text="me manda um status" columns={80} origem="telegram" />);
    expect(f).toContain('me manda um status');
  });

  it('sem `columns` (terminal sem largura) o distintivo também sai', () => {
    const f = frameDe(<YouBlock text="ola" origem="telegram" />);
    expect(f).toContain('telegram');
  });

  it('origem vazia/só espaço não desenha nada', () => {
    expect(frameDe(<YouBlock text="ola" columns={80} origem="   " />)).not.toContain('·');
  });

  it('a linha pintada NÃO estoura a largura (o quadradinho solto do dono)', () => {
    const cols = 60;
    const f = frameDe(<YouBlock text="ola" columns={cols} origem="telegram" />);
    for (const linha of f.split('\n')) {
      expect(linha.length, `linha larga demais: ${JSON.stringify(linha)}`).toBeLessThanOrEqual(
        cols,
      );
    }
  });
});

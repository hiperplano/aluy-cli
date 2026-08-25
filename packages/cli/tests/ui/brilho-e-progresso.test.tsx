// REDUNDÂNCIA DO PROGRESSO — o dono, vendo a tela: "na caixa do Aluy quando ele tá pensando
// nao esta fazendo o efeito que faz nos agentes... o brilho deveria aparecer na conversacao"
// e "eu falei que nao precisava ter mais a barra de progresso, acho redundante a barra de
// progresso e o efeito brilho juntos".
//
// Eram três coisas dizendo "há trabalho" ao mesmo tempo, e a mais óbvia — a caixa da própria
// resposta — era a única PARADA: o cabeçalho animava só o `Λ` e deixava o `luy` estático.
//
// A divisão que este arquivo trava:
//   · ele FALA  ⇒ o brilho corre pelo nome no cabeçalho da caixa (é a resposta que indica);
//   · ele PENSA ⇒ não há caixa nenhuma, e aí a linha de progresso existe para o vazio;
//   · os AGENTES ⇒ moram no rodapé, não numa terceira coisa na conversa.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';

function quadro(node: React.ReactElement): string {
  const { lastFrame } = render(<ThemeProvider theme={resolveTheme('escuro')}>{node}</ThemeProvider>);
  return lastFrame() ?? '';
}
// eslint-disable-next-line no-control-regex
const semCor = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');

describe('cabeçalho da caixa — o brilho corre pelo NOME enquanto ele fala', () => {
  it('streaming: o nome inteiro está lá e os quadros DIFEREM (o brilho corre)', () => {
    const quadros = [0, 1, 2, 3].map((f) => quadro(<AluyBlock text="oi" streaming frame={f} />));
    for (const q of quadros) expect(semCor(q)).toContain('Λluy');
    // O brilho é COR: comparar sem cor não distingue. Com cor, os quadros diferem.
    expect(new Set(quadros).size).toBeGreaterThan(1);
  });

  it('a LARGURA do cabeçalho não muda entre quadros (nenhuma letra some)', () => {
    const larguras = new Set(
      [0, 1, 2, 3, 4].map((f) => semCor(quadro(<AluyBlock text="oi" streaming frame={f} />)).length),
    );
    expect(larguras.size).toBe(1);
  });

  it('parado: a marca é sólida e o nome continua inteiro', () => {
    const q = semCor(quadro(<AluyBlock text="pronto" frame={3} />));
    expect(q).toContain('Λluy');
  });
});

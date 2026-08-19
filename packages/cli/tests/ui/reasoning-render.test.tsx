// F-RAC · degrau 5 — o que o USUÁRIO vê. O bug de origem era visual: `Λ aluy` e nada.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { ThemeProvider, resolveTheme } from '../../src/ui/theme/index.js';

const theme = resolveTheme('escuro');
const pinta = (node: React.ReactElement): string =>
  render(<ThemeProvider theme={theme}>{node}</ThemeProvider>).lastFrame() ?? '';

describe('AluyBlock — o raciocínio na tela', () => {
  it('AO VIVO mostra o pensamento (em vez de um bloco vazio enquanto o modelo trabalha)', () => {
    const out = pinta(
      <AluyBlock text="" streaming reasoning="estou analisando o pedido" columns={80} />,
    );
    expect(out).toContain('pensando');
    expect(out).toContain('estou analisando o pedido');
  });

  it('TERMINADO com fala, o rascunho vira UMA linha-resumo (não polui o histórico)', () => {
    const out = pinta(
      <AluyBlock text="a resposta" streaming={false} reasoning={'z'.repeat(120)} columns={80} />,
    );
    expect(out).toContain('a resposta');
    expect(out).toContain('120 caracteres');
    expect(out).not.toContain('zzzzzzzzzz'); // o rascunho em si NÃO é re-exibido
  });

  it('A ORIGEM — terminado SEM fala, o pensamento FICA e é dito o porquê', () => {
    // Sem isto o bloco volta a ser o `Λ aluy` mudo que motivou o conserto.
    const out = pinta(
      <AluyBlock text="" streaming={false} reasoning="pensei e não conclui" columns={80} />,
    );
    expect(out).toContain('só produziu raciocínio');
    expect(out).toContain('pensei e não conclui');
  });

  it('sem raciocínio, o bloco é idêntico ao de antes (não-regressão)', () => {
    const out = pinta(<AluyBlock text="oi" streaming={false} columns={80} />);
    expect(out).toContain('oi');
    expect(out).not.toContain('pensando');
    expect(out).not.toContain('caracteres');
  });
});

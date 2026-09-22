// F-BG — a dica do Ctrl+B NA LINHA VIVA do comando, como o Claude Code faz.
//
// Pedido do dono (22/09/2026), depois de testar o Ctrl+B: "quando ele entra nesse estado
// eu precisaria ter alguma indicação visual que posso usar o ctrl b". O rodapé já anuncia,
// mas o rodapé é longe; quem está olhando é a linha `◌ rodando <comando>…`. A dica entra
// como SUFIXO dela — e só onde a tecla age: comando de shell (`run_command`) e `!comando`.
// Uma leitura em voo (`read`) não solta nada, então não promete.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ToolLine } from '../../src/ui/components/ToolLine.js';
import { BangBlock } from '../../src/ui/components/BangBlock.js';
import { liveOverheadLines } from '../../src/session/live-budget.js';
import type { SessionBlock } from '../../src/session/model.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string) => (s ?? '').replace(ANSI, '');
function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: ENV });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('dica do Ctrl+B na linha viva', () => {
  it('comando de shell rodando ⇒ "ctrl-b solta" na própria linha', () => {
    const out = plain(
      wrap(
        <ToolLine verb="bash" target="npm run dev" result="" status="running" verbGerund="rodando" />,
      ).lastFrame() ?? '',
    );
    expect(out).toContain('rodando npm run dev');
    expect(out).toContain('ctrl-b solta');
  });

  it('leitura em voo NÃO promete (não há o que soltar)', () => {
    const out = plain(
      wrap(<ToolLine verb="read" target="a.ts" result="" status="running" verbGerund="lendo" />)
        .lastFrame() ?? '',
    );
    expect(out).not.toContain('ctrl-b');
  });

  it('comando concluído NÃO mostra a dica (só em voo)', () => {
    const out = plain(
      wrap(<ToolLine verb="bash" target="ls" result="0 erros" status="ok" />).lastFrame() ?? '',
    );
    expect(out).not.toContain('ctrl-b');
  });

  it('`!comando` rodando ⇒ a mesma dica', () => {
    const out = plain(
      wrap(<BangBlock command="npm test" status="running" />).lastFrame() ?? '',
    );
    expect(out).toContain('ctrl-b solta');
  });
});

describe('orçamento anti-flicker conta a dica (senão a linha quebra fora da conta)', () => {
  const rodando = (verb: string): SessionBlock => ({
    kind: 'tool',
    verb,
    target: 'x'.repeat(50),
    result: '',
    status: 'running',
    verbGerund: 'rodando',
  });
  const altura = (b: SessionBlock, columns: number) =>
    liveOverheadLines({ live: [b], phase: 'streaming', hasBlocks: true, columns, rows: 30 });

  it('a linha de um `bash` em voo custa mais colunas que a de um `read` — e pode custar 1 linha a mais', () => {
    // `rodando ` (8) + 50 de alvo + 14 de cromo = 72: cabe em 80. Com a dica (+16) = 88 ⇒ 2 linhas.
    expect(altura(rodando('read'), 80)).toBe(altura(rodando('bash'), 80) - 1);
  });

  it('em terminal largo os dois custam o mesmo (não-regressão)', () => {
    expect(altura(rodando('read'), 160)).toBe(altura(rodando('bash'), 160));
  });
});

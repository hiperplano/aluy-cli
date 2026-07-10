// EST-MCP-STATUSBAR (pedido do dono) — o progresso da conexão MCP em background vive
// SÓ na StatusBar (nunca como nota na conversa): uma barrinha `MCP ▰▰▱ 2/3` enquanto
// conecta, e um ✓/aviso rápido quando `done`. Espelha o estilo de `status-bar-cycle.test.tsx`.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

describe('StatusBar — progresso de conexão MCP (EST-MCP-STATUSBAR)', () => {
  it('sem mcpProgress (uso simples / sem MCP) ⇒ NÃO mostra indicador', () => {
    const { lastFrame } = wrap(
      <StatusBar cwd="/proj" tier="aluy-strata" tokens={0} windowPct={0} columns={120} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('MCP');
  });

  it('conectando (done:false) ⇒ mostra a barrinha + contagem `connected+failed/total`', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        mcpProgress={{ connected: 1, total: 3, failed: 0, done: false }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('MCP');
    expect(out).toContain('1/3');
    // NÃO é o ✓ de concluído ainda.
    expect(out).not.toContain('✓ MCP');
  });

  it('concluído sem falha (done:true, failed:0) ⇒ mostra ✓ MCP N/N', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        mcpProgress={{ connected: 3, total: 3, failed: 0, done: true }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('✓');
    expect(out).toContain('MCP 3/3');
    expect(out).not.toContain('falhou');
  });

  it('concluído com falha (done:true, failed>0) ⇒ mostra o aviso discreto "N falhou"', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={120}
        mcpProgress={{ connected: 4, total: 5, failed: 1, done: true }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('MCP 4/5');
    expect(out).toContain('1 falhou');
  });

  it('cai no narrow (<60 col) — indicador supplementar, como o <BusyPulse>', () => {
    const { lastFrame } = wrap(
      <StatusBar
        cwd="/proj"
        tier="aluy-strata"
        tokens={0}
        windowPct={0}
        columns={50}
        mcpProgress={{ connected: 1, total: 2, failed: 0, done: false }}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('MCP');
    expect(out).toContain('aluy-strata'); // o tier segue, nunca cai
  });
});

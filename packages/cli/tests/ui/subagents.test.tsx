// EST-0969 (display) — render do INDICADOR de sub-agentes paralelos.
//
// Prova de a11y + anti-interleave: o bloco mostra STATUS por filho (a PALAVRA
// `rodando`/`pronto`/`falhou`/`timeout` carrega o sentido, não só a cor), rotulado
// por ORIGEM (`[rust]`), com resumo curto quando concluído — NUNCA o corpo/stream
// cru de cada filho. Vale UTF-8 e mono (NO_COLOR).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { SubAgents } from '../../src/ui/components/SubAgents.js';
import type { SubAgentChildView } from '../../src/ui/components/SubAgents.js';

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

describe('SubAgents — indicador compacto, status por filho (a11y)', () => {
  const three: readonly SubAgentChildView[] = [
    { label: 'rust', status: 'running' },
    { label: 'go', status: 'done', summary: '1.2k tokens · 3 tools', stop: 'final' },
    { label: 'zig', status: 'fail', summary: '4 tokens', stop: 'timeout' },
  ];

  it('cabeçalho compacto: "N sub-agentes:" + rótulo de origem por filho', () => {
    const { lastFrame } = wrap(<SubAgents childrenStatus={three} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toMatch(/3 sub-agentes:/);
    expect(out).toContain('[rust]');
    expect(out).toContain('[go]');
    expect(out).toContain('[zig]');
  });

  it('a PALAVRA do estado carrega o sentido (não só a cor) — rodando/pronto/timeout', () => {
    const { lastFrame } = wrap(<SubAgents childrenStatus={three} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('rodando'); // running
    expect(out).toContain('pronto'); // done
    expect(out).toContain('timeout'); // fail por timeout
  });

  it('mostra o resumo CURTO do concluído (tokens · tools), NUNCA o corpo do filho', () => {
    const { lastFrame } = wrap(<SubAgents childrenStatus={three} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('1.2k tokens · 3 tools');
    // o filho rodando não tem resumo (não há desfecho ainda).
    expect(out).not.toMatch(/rust].*tokens/);
  });

  it('mono (NO_COLOR): a palavra do estado continua visível — a11y sem cor', () => {
    const { lastFrame } = wrap(<SubAgents childrenStatus={three} />, NOCOLOR);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('rodando');
    expect(out).toContain('pronto');
    expect(out).toMatch(/3 sub-agentes:/);
  });

  it('singular: 1 filho ⇒ "1 sub-agente:" (sem o "s")', () => {
    const one: readonly SubAgentChildView[] = [{ label: 'rust', status: 'running' }];
    const { lastFrame } = wrap(<SubAgents childrenStatus={one} />, UTF8);
    expect(plain(lastFrame() ?? '')).toMatch(/1 sub-agente:/);
  });
});

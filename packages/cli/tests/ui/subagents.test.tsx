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

// ADR-0146 (D5) — o rótulo de tier/modelo RESOLVIDO aparece na linha do filho,
// visível ENQUANTO `status==='running'` e MANTIDO no resumo final. NUNCA
// provider/base_url/credencial — só a chave de tier/slug (mesmo filtro da status
// bar do pai).
describe('SubAgents — rótulo de tier/modelo resolvido (ADR-0146 D5)', () => {
  it('running: mostra o tier ao lado do status (antes do resumo, que ainda não existe)', () => {
    const running: readonly SubAgentChildView[] = [
      { label: 'rust', status: 'running', model: 'aluy-strata' },
    ];
    const out = plain(wrap(<SubAgents childrenStatus={running} />, UTF8).lastFrame() ?? '');
    expect(out).toContain('[rust]');
    expect(out).toContain('rodando');
    expect(out).toContain('aluy-strata');
  });

  it('done: o rótulo do tier fica MANTIDO junto do resumo final', () => {
    const done: readonly SubAgentChildView[] = [
      {
        label: 'go',
        status: 'done',
        model: 'custom · meta-llama/llama-3.3-70b',
        summary: '1.2k tokens · 3 tools',
        stop: 'final',
      },
    ];
    const out = plain(wrap(<SubAgents childrenStatus={done} />, UTF8).lastFrame() ?? '');
    expect(out).toContain('custom · meta-llama/llama-3.3-70b');
    expect(out).toContain('1.2k tokens · 3 tools');
  });

  it('herança: mostra "herdado (...)" quando o filho não declarou model próprio', () => {
    const inherited: readonly SubAgentChildView[] = [
      { label: 'zig', status: 'running', model: 'herdado (aluy-flux)' },
    ];
    const out = plain(wrap(<SubAgents childrenStatus={inherited} />, UTF8).lastFrame() ?? '');
    expect(out).toContain('herdado (aluy-flux)');
  });

  it('GS-SAM4 — NUNCA renderiza provider/base_url/api_key/token/secret, mesmo se o rótulo os carregasse por engano', () => {
    const suspicious: readonly SubAgentChildView[] = [
      { label: 'x', status: 'running', model: 'aluy-strata' },
    ];
    const out = plain(wrap(<SubAgents childrenStatus={suspicious} />, UTF8).lastFrame() ?? '');
    expect(out).not.toMatch(/\b(provider|base_?url|api[_-]?key|token|secret|authorization)\b/i);
  });

  it('AUSENTE (model undefined) ⇒ a linha renderiza normalmente, sem o sufixo de tier', () => {
    const noModel: readonly SubAgentChildView[] = [{ label: 'rust', status: 'running' }];
    const out = plain(wrap(<SubAgents childrenStatus={noModel} />, UTF8).lastFrame() ?? '');
    expect(out).toContain('[rust]');
    expect(out).toContain('rodando');
  });
});

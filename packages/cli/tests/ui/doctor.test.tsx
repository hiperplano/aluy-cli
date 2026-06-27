// EST-0970 (ticks AO VIVO) — render da CHECKLIST PROGRESSIVA do `/doctor`.
//
// Prova: cada item pendente mostra um spinner (1ª frame braille ⠋) e a palavra
// "testando"; os resolvidos mostram o glifo ✓/⚠/✗ + o detalhe + (em ⚠/✗) a dica de
// conserto. a11y: a PALAVRA/detalhe carrega o sentido (não só a cor), vale em NO_COLOR.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Doctor } from '../../src/ui/components/Doctor.js';
import type { DoctorCheckView } from '../../src/ui/components/Doctor.js';

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

describe('Doctor — checklist progressiva (ticks ao vivo)', () => {
  const pending: readonly DoctorCheckView[] = [
    { id: 'auth', label: 'credencial', status: 'pending' },
    { id: 'broker', label: 'broker', status: 'pending' },
  ];

  it('itens PENDING mostram a palavra "testando…" (spinner ao lado)', () => {
    const { lastFrame } = wrap(<Doctor checks={pending} frame={0} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('doctor — diagnóstico');
    expect(out).toContain('credencial:');
    expect(out).toMatch(/testando/);
    expect(out).toContain('(2 testando)');
  });

  it('itens RESOLVIDOS mostram glifo + detalhe; ⚠/✗ trazem a dica (→)', () => {
    const resolved: readonly DoctorCheckView[] = [
      { id: 'auth', label: 'credencial', status: 'ok', detail: 'u · autenticado' },
      {
        id: 'config',
        label: 'config',
        status: 'warn',
        detail: 'tema "x" não está no catálogo',
        fix: 'rode /theme',
      },
      {
        id: 'mcp',
        label: 'MCP',
        status: 'fail',
        detail: 'broke: ENOENT',
        fix: 'cheque o command',
      },
    ];
    const { lastFrame } = wrap(
      <Doctor checks={resolved} frame={0} summary="1 ok · 1 aviso · 1 falha" />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('u · autenticado');
    expect(out).toContain('✓');
    expect(out).toContain('⚠');
    expect(out).toContain('✗');
    expect(out).toContain('→ rode /theme');
    expect(out).toContain('→ cheque o command');
    expect(out).toContain('resumo: 1 ok · 1 aviso · 1 falha');
  });

  it('mono (NO_COLOR): o detalhe/dica continuam visíveis — a11y sem cor', () => {
    const resolved: readonly DoctorCheckView[] = [
      { id: 'auth', label: 'credencial', status: 'fail', detail: 'recusou', fix: 'aluy login' },
    ];
    const { lastFrame } = wrap(<Doctor checks={resolved} frame={0} />, NOCOLOR);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('credencial:');
    expect(out).toContain('recusou');
    expect(out).toContain('aluy login');
  });
});

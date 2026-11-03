// Auditoria — SubAgents: palavra "pausado (cota)", "em segundo plano" quando assentado,
// segundos só no filho VIVO (e correto: agora − início), brilho só enquanto roda.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { SubAgents } from '../../src/ui/components/SubAgents.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

function quadro(node: React.ReactElement, env: NodeJS.ProcessEnv = UTF8): string {
  const r = render(<ThemeProvider theme={resolveTheme({ env })}>{node}</ThemeProvider>);
  const out = r.lastFrame() ?? '';
  r.unmount();
  return out;
}

describe('SubAgents · pausa por cota e lote assentado', () => {
  it('filho pausado pela cota diz "pausado (cota)" — não "parado" nem "falhou"', () => {
    const out = plain(
      quadro(<SubAgents childrenStatus={[{ label: 'f', status: 'cancelled', stop: 'paused' }]} />),
    );
    expect(out).toContain('pausado (cota)');
    expect(out).not.toContain('falhou');
  });

  it('cancelado pelo usuário (sem ser pausa) NÃO diz "pausado"', () => {
    const out = plain(
      quadro(
        <SubAgents childrenStatus={[{ label: 'f', status: 'cancelled', stop: 'cancelled' }]} />,
      ),
    );
    expect(out).not.toContain('pausado');
  });

  it('lote já no histórico (settled): filho "rodando" vira "em segundo plano" e sem relógio', () => {
    const out = plain(
      quadro(
        <SubAgents
          settled
          childrenStatus={[{ label: 'f', status: 'running', startedAt: Date.now() - 9_000 }]}
        />,
      ),
    );
    expect(out).toContain('em segundo plano');
    expect(out).not.toMatch(/ · \d+s/);
  });
});

describe('SubAgents · relógio do filho vivo', () => {
  it('mostra agora − início (≈ 12s), não o carimbo cru', () => {
    const out = plain(
      quadro(
        <SubAgents
          childrenStatus={[{ label: 'f', status: 'running', startedAt: Date.now() - 12_300 }]}
        />,
      ),
    );
    expect(out).toMatch(/ · 12s/);
  });

  it('filho vivo SEM startedAt não inventa relógio', () => {
    const out = plain(quadro(<SubAgents childrenStatus={[{ label: 'f', status: 'running' }]} />));
    expect(out).toContain('rodando');
    expect(out).not.toMatch(/ · \d+s/);
  });
});

describe('SubAgents · brilho (shimmer) só enquanto roda', () => {
  const COR = { ...UTF8, COLORTERM: 'truecolor' };

  it('o rótulo do filho VIVO muda de cor entre frames; o do terminado não', () => {
    const rodando = (frame: number): string =>
      quadro(
        <SubAgents frame={frame} childrenStatus={[{ label: 'rastreador', status: 'running' }]} />,
        COR,
      );
    expect(rodando(0)).not.toBe(rodando(5));

    const pronto = (frame: number): string =>
      quadro(
        <SubAgents
          frame={frame}
          childrenStatus={[{ label: 'rastreador', status: 'done', summary: '1k tokens' }]}
        />,
        COR,
      );
    expect(pronto(0)).toBe(pronto(5));
  });

  it('lote assentado não brilha mesmo com filho "rodando"', () => {
    const f = (frame: number): string =>
      quadro(
        <SubAgents
          settled
          frame={frame}
          childrenStatus={[{ label: 'rastreador', status: 'running' }]}
        />,
        COR,
      );
    expect(f(0)).toBe(f(5));
  });
});

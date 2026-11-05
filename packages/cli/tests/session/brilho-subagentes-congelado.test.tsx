// BRILHO DOS SUB-AGENTES — mandar uma mensagem com filhos vivos NÃO pode parar o brilho.
//
// Causa-raiz: o bloco `subagents` da conversa vai para o `<Static>` assim que algo
// concluído vem depois dele (a fala do dono, a resposta do pai). Escrito UMA vez no
// scrollback, ele nunca mais repinta — os filhos que seguem trabalhando paravam de
// brilhar e pareciam travados. A cópia animada do rodapé só aparecia se o original
// rolasse para fora da tela, e no modo de rodapé `compact`/`hidden` nem existia.

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

let frameAtual = 0;
const tickCalls: Array<{ intervalMs: number; enabled: boolean }> = [];
vi.mock('../../src/ui/hooks/useTick.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ui/hooks/useTick.js')>();
  return {
    ...actual,
    useTick: (opts: { enabled?: boolean; intervalMs?: number } = {}): number => {
      tickCalls.push({
        intervalMs: opts.intervalMs ?? actual.DEFAULT_TICK_MS,
        enabled: opts.enabled ?? true,
      });
      return frameAtual;
    },
  };
});

import { render } from 'ink-testing-library';
import chalk from 'chalk';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { DEFAULT_TICK_MS } from '../../src/ui/hooks/useTick.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { copiaDoRodapeVale } from '../../src/session/subagentes-visiveis.js';
import type { SessionBlock } from '../../src/session/model.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

const ports: ToolPorts = {
  fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
  shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  search: { search: async () => [] },
};

function blocosCongelados(status: 'running' | 'done'): SessionBlock[] {
  const child = (label: string) =>
    ({ label, status, summary: '0 tokens', model: 'herdado (x)' }) as never;
  return [
    { kind: 'subagents', children: [child('a1'), child('a2'), child('a3')] } as SessionBlock,
    { kind: 'you', text: 'como estão os agentes?' } as SessionBlock,
    { kind: 'aluy', text: 'Estão rodando.', streaming: false } as SessionBlock,
  ];
}

function montar(statusline: 'full' | 'compact' | 'hidden', status: 'running' | 'done') {
  const model: ModelCaller = {
    async call() {
      throw new Error('sem chamada');
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  controller.dismissBoot();
  const blocks = blocosCongelados(status);
  const vivo = status === 'running';
  (controller as unknown as { patch(p: Record<string, unknown>): void }).patch({
    blocks,
    ...(vivo
      ? {
          detachedSubagents: 3,
          liveSubagents: ['a1', 'a2', 'a3'].map((label) => ({
            label,
            phase: 'thinking',
            tokens: 0,
          })),
        }
      : {}),
  });
  const theme = resolveTheme({ env: ENV });
  const ui = () => (
    <ThemeProvider theme={theme}>
      <App controller={controller} animate bootMs={0} initialStatusline={statusline} />
    </ThemeProvider>
  );
  const r = render(ui());
  return { r, ui };
}

/** Linhas dos filhos do RODAPÉ (as de baixo; as do histórico dizem "em segundo plano"). */
function linhasRodando(frame: string | undefined): string[] {
  return (frame ?? '')
    .split('\n')
    .filter((l) => /\[a[123]\]/.test(l) && !l.includes('segundo plano'));
}

const ultimoEnabled = (): boolean | undefined =>
  [...tickCalls].reverse().find((c) => c.intervalMs === DEFAULT_TICK_MS)?.enabled;

describe('brilho dos sub-agentes sobrevive à mensagem do dono', () => {
  const nivel = chalk.level;
  for (const modo of ['full', 'compact', 'hidden'] as const) {
    it(`rodapé ${modo}: bloco congelado + filhos rodando ⇒ linhas vivas animam com o frame`, async () => {
      chalk.level = 3;
      try {
        tickCalls.length = 0;
        frameAtual = 0;
        const { r, ui } = montar(modo, 'running');
        await new Promise((x) => setTimeout(x, 20));
        const a = linhasRodando(r.lastFrame());
        expect(a.length).toBe(3);
        expect(ultimoEnabled()).toBe(true);
        frameAtual = 7;
        r.rerender(ui());
        await new Promise((x) => setTimeout(x, 20));
        const b = linhasRodando(r.lastFrame());
        expect(b.length).toBe(3);
        expect(b).not.toEqual(a); // o brilho andou
        r.unmount();
      } finally {
        chalk.level = nivel;
      }
    });
  }

  it('filhos TERMINADOS: nada anima (linhas idênticas entre frames, sem cópia viva)', async () => {
    chalk.level = 3;
    try {
      frameAtual = 0;
      const { r, ui } = montar('hidden', 'done');
      await new Promise((x) => setTimeout(x, 20));
      const a = r.lastFrame();
      frameAtual = 7;
      r.rerender(ui());
      await new Promise((x) => setTimeout(x, 20));
      expect(r.lastFrame()).toEqual(a);
      expect((a ?? '').split('\n').filter((l) => l.includes('[a1]')).length).toBe(1); // só o histórico
      r.unmount();
    } finally {
      chalk.level = nivel;
    }
  });
});

describe('copiaDoRodapeVale (pura)', () => {
  const args = (status: 'running' | 'done', extra: SessionBlock[] = []) => ({
    blocks: [...blocosCongelados(status), ...extra],
    rows: 60,
    columns: 100,
    linhasDoRodape: 8,
  });
  it('congelado no Static + filho rodando ⇒ vale, mesmo com o original visível', () => {
    expect(copiaDoRodapeVale(args('running'))).toBe(true);
  });
  it('congelado + todos terminados + original visível ⇒ não vale (sem redundância)', () => {
    expect(copiaDoRodapeVale(args('done'))).toBe(false);
  });
  it('bloco ainda VIVO (último da lista) ⇒ ele mesmo anima, sem cópia', () => {
    const so = [blocosCongelados('running')[0]!];
    expect(copiaDoRodapeVale({ blocks: so, rows: 60, columns: 100, linhasDoRodape: 8 })).toBe(
      false,
    );
  });
});

// LOG do cockpit/split: `▼ [filho] pensando · …` também brilha enquanto o filho vive.
import { ActivityLog } from '../../src/ui/components/ActivityLog.js';
import type { LogSection } from '../../src/session/activity-log.js';

describe('ActivityLog — cabeçalho do filho vivo brilha', () => {
  const secao = (phase: LogSection['phase']): LogSection => ({
    id: 'root/a1',
    kind: 'subagent',
    label: 'a1',
    phase,
    tokens: 0,
    toolCalls: 0,
    durationMs: 73000,
    collapsed: false,
    events: [],
  });
  const quadro = (phase: LogSection['phase'], frame: number | undefined): string | undefined => {
    const theme = resolveTheme({ env: ENV });
    const r = render(
      <ThemeProvider theme={theme}>
        <ActivityLog
          sections={[secao(phase)]}
          visibleRows={5}
          scrollOffset={0}
          focused={false}
          columns={60}
          {...(frame !== undefined ? { frame } : {})}
        />
      </ThemeProvider>,
    );
    const f = r.lastFrame();
    r.unmount();
    return f;
  };
  it('filho pensando: quadros diferentes em frames diferentes; terminado: idêntico', () => {
    const nivel = chalk.level;
    chalk.level = 3;
    try {
      expect(quadro('thinking', 0)).not.toEqual(quadro('thinking', 3));
      expect(quadro('done', 0)).toEqual(quadro('done', 3));
      expect(quadro('thinking', undefined)).toEqual(quadro('thinking', undefined));
    } finally {
      chalk.level = nivel;
    }
  });
});

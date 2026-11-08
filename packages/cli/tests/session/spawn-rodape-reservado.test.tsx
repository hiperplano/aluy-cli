// A tool-line `processando N agentes` entra no quadro ANTES do lote existir. O bloco de agentes do
// rodapé (1+N linhas ABAIXO do composer) chegava depois, em outro quadro: o composer descia 1
// (tool-line) e subia N+1 (bloco) — o sobe-e-desce que o dono via a cada disparo de agentes.
// Agora as linhas do bloco são reservadas no MESMO quadro da tool-line.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SessionBlock } from '../../src/session/model.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const plain = (s: string | undefined): string =>
  (s ?? '').replace(new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g'), '');
const ports: ToolPorts = {
  fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
  shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
  search: { search: async () => [] },
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function abaixoDoComposer(frame: string | undefined): number {
  const ls = plain(frame).split('\n');
  const i = ls.findIndex((l) => /^[┃|]\s*[❯>]/.test(l));
  if (i < 0) throw new Error(`composer não encontrado:\n${plain(frame)}`);
  return ls.length - 1 - i;
}

describe('rodapé de agentes: linhas reservadas junto da tool-line de spawn', () => {
  it('as linhas abaixo do composer são as mesmas com a tool-line (sem lote) e com o lote', async () => {
    const controller = new SessionController({
      model: {
        call: async () => ({ request_id: 'r', content: '', finish_reason: 'stop' }),
      } as ModelCaller,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });
    controller.dismissBoot();
    const patch = (p: Record<string, unknown>): void =>
      (controller as unknown as { patch(p: Record<string, unknown>): void }).patch(p);
    const voce = { kind: 'you', text: 'dispare dois agentes' } as SessionBlock;
    const tool = {
      kind: 'tool',
      verb: 'spawn_agent',
      target: '2 agentes: um, dois',
      result: '',
      status: 'running',
      verbGerund: 'processando',
    } as SessionBlock;
    patch({
      blocks: [voce, tool],
      phase: 'thinking',
      workingLabel: 'pensando',
      workingSince: Date.now(),
    });
    const r = render(
      <ThemeProvider theme={resolveTheme({ env: ENV })}>
        <App controller={controller} animate={false} bootMs={0} initialStatusline="full" />
      </ThemeProvider>,
    );
    await tick();
    const semLote = abaixoDoComposer(r.lastFrame());

    const filho = (label: string) => ({ label, status: 'running', summary: '0 tokens' }) as never;
    patch({
      blocks: [
        voce,
        { kind: 'subagents', children: [filho('um'), filho('dois')] } as SessionBlock,
        tool,
      ],
      detachedSubagents: 2,
      liveSubagents: ['um', 'dois'].map((label) => ({ label, phase: 'thinking', tokens: 0 })),
    });
    await tick();
    const comLote = abaixoDoComposer(r.lastFrame());
    expect(plain(r.lastFrame())).toContain('[um]');
    expect(comLote, 'o composer sobe quando o bloco de agentes chega').toBe(semLote);
    r.unmount();
    controller.dispose();
  });
});

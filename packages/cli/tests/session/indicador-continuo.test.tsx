// SEM AR MORTO ENTRE PASSOS — depois de CADA resultado de tool, enquanto o modelo calcula o
// PRÓXIMO passo, a linha `Λluy pensando… M:SS` precisa estar na tela (medido em tmux: ela
// sumia por 5–9s a partir da 2ª chamada de modelo, porque a fase herdava `streaming`).
//
// Estes testes dirigem várias iterações (modelo → tool → modelo → tool → final) e afirmam o
// indicador entre o fim da tool e a próxima atividade do modelo; e que NÃO há indicador
// duplicado enquanto a própria linha da tool está rodando.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ports = {
  fs: {
    async readFile() {
      await sleep(60);
      return 'conteudo';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as unknown as ToolPorts;

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

interface Seen {
  readonly phase: string;
  readonly label: string | undefined;
  readonly since: number | undefined;
  readonly tela: string;
}

function monta() {
  let t = 5_000_000;
  const seen: Seen[] = [];
  let n = 0;
  let ctrl: SessionController | null = null;
  let frame: () => string = () => '';
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      const k = n++;
      const c = ctrl!;
      // O que o dono veria enquanto o modelo ainda calcula o passo `k` (antes do 1º token).
      await sleep(80);
      t += 4000;
      await sleep(80);
      seen.push({
        phase: c.current.phase,
        label: c.current.workingLabel,
        since: c.current.workingSince,
        tela: plain(frame()),
      });
      // 1º token do passo ⇒ o caller real chama onStart/onDelta/onDone no sink.
      c.sink.onStart();
      c.sink.onDelta(k < 2 ? `passo ${k}` : 'pronto');
      c.sink.onDone();
      if (k < 2) {
        return {
          request_id: `r${k}`,
          content: `passo ${k}`,
          finish_reason: 'tool_calls',
          tool_calls: [{ id: `c${k}`, name: 'read_file', input: { path: `a${k}.txt` } }],
        } as ModelCallResult;
      }
      return { request_id: 'rf', content: 'pronto', finish_reason: 'stop' };
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports,
    askResolver: approveAll,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
    clock: () => t,
  });
  ctrl = controller;
  return { controller, seen, now: () => t, setFrame: (f: () => string) => (frame = f) };
}

describe('indicador contínuo entre passos (controller)', () => {
  it('cada model-call reabre `thinking`/`pensando` com o relógio ZERADO; a tool não duplica', async () => {
    const { controller, seen } = monta();
    const fases: string[] = [];
    controller.subscribe((s) => {
      const rodando = s.blocks.some((b) => b.kind === 'tool' && b.status === 'running');
      if (rodando) fases.push(s.phase);
    });
    await controller.submit('leia');
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.phase).toBe('thinking');
      expect(s.label).toBe('pensando');
    }
    // relógio por passo: cada passo recomeça (não herda o `since` do anterior)
    expect(new Set(seen.map((s) => s.since)).size).toBe(3);
    // enquanto a linha da tool roda, a fase NÃO é `thinking` (sem Λluy pensando duplicado)
    expect(fases.length).toBeGreaterThan(0);
    expect(fases.every((p) => p !== 'thinking')).toBe(true);
    controller.dispose();
  });
});

describe('indicador contínuo entre passos (App renderizada)', () => {
  it('modelo → tool → modelo → tool → final: `pensando…` está na tela em TODO passo', async () => {
    const { controller, seen, now, setFrame } = monta();
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    const r = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} now={now} />
      </ThemeProvider>,
    );
    setFrame(() => r.lastFrame() ?? '');
    controller.dismissBoot();
    await sleep(100);
    const deadline = Date.now() + 3000;
    while (controller.current.phase !== 'thinking') {
      if (Date.now() > deadline) throw new Error('submit não assentou');
      r.stdin.write('ola\r');
      await sleep(10);
    }
    const fim = Date.now() + 8000;
    while (seen.length < 3 && Date.now() < fim) await sleep(20);
    expect(seen).toHaveLength(3);
    for (const [i, s] of seen.entries()) {
      expect(s.tela, `passo ${i}`).toMatch(/pensando… \d:\d\d/);
    }
    r.unmount();
    controller.dispose();
  });
});

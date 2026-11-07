// PAUSA POR COTA na TUI — teclas e texto. Durante a pausa a linha estática substitui a linha de
// trabalho; ↵ (composer vazio) = tentar agora; Ctrl+G = parar salvando; esc = cancela o turno
// (o freio de sempre); ↵ com texto digitado NÃO retoma (não rouba a digitação). A variante de
// saldo esgotado manda recarregar. Sem rede; os verbos do controller são espiados.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type QuotaPauseView,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

const ports = {
  fs: {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return [];
    },
  },
} as unknown as ToolPorts;

const view = (over: Partial<QuotaPauseView> = {}): QuotaPauseView => ({
  scope: 'janela',
  reason: 'x',
  manual: false,
  probing: false,
  agents: [],
  resetAtMs: Date.now() + 3_600_000,
  nextProbeAtMs: Date.now() + 60_000,
  deadlineAtMs: Date.now() + 7_200_000,
  ...over,
});

async function esperar(cond: () => boolean, ms = 2000): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('waitFor timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function montar(v: QuotaPauseView) {
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'x', finish_reason: 'stop' };
    },
  };
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const chamadas = { resume: 0, stop: 0, interrupt: 0 };
  c.quotaResumeNow = (): void => {
    chamadas.resume += 1;
  };
  c.quotaStopSaving = (): void => {
    chamadas.stop += 1;
  };
  const interruptReal = c.interrupt.bind(c);
  c.interrupt = (): void => {
    chamadas.interrupt += 1;
    interruptReal();
  };
  c.dismissBoot();
  (c as unknown as { patch(p: object): void }).patch({
    phase: 'thinking',
    workingLabel: 'pausado',
    workingSince: Date.now(),
    quotaPause: v,
  });
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <App controller={c} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return { c, r, chamadas };
}

describe('pausa por cota · teclas na TUI', () => {
  it('↵ com o composer vazio = tentar agora (quotaResumeNow)', async () => {
    const { c, r, chamadas } = montar(view());
    await esperar(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    r.stdin.write('\r');
    await esperar(() => chamadas.resume === 1);
    expect(chamadas.stop).toBe(0);
    r.unmount();
    c.dispose();
  });

  it('Ctrl+G = parar salvando (quotaStopSaving), sem retomar', async () => {
    const { c, r, chamadas } = montar(view());
    await esperar(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    r.stdin.write(String.fromCharCode(7));
    await esperar(() => chamadas.stop === 1);
    expect(chamadas.resume).toBe(0);
    r.unmount();
    c.dispose();
  });

  it('esc cancela o turno (interrupt), não retoma nem salva', async () => {
    const { c, r, chamadas } = montar(view());
    await esperar(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    await new Promise((res) => setTimeout(res, 50));
    r.stdin.write(ESC);
    await esperar(() => chamadas.interrupt >= 1);
    expect(chamadas.resume).toBe(0);
    expect(chamadas.stop).toBe(0);
    r.unmount();
    c.dispose();
  });

  it('↵ com texto já digitado NÃO retoma a pausa (não rouba a digitação)', async () => {
    const { c, r, chamadas } = montar(view());
    await esperar(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    r.stdin.write('oi');
    await esperar(() => plain(r.lastFrame()).includes('oi'));
    await new Promise((res) => setTimeout(res, 100));
    r.stdin.write('\r');
    await new Promise((res) => setTimeout(res, 80));
    expect(chamadas.resume).toBe(0);
    r.unmount();
    c.dispose();
  });
});

describe('pausa por cota · texto na tela', () => {
  it('cota com horário: título, horário e as teclas; sem o relógio do turno', async () => {
    const { c, r } = montar(view());
    await esperar(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    const f = plain(r.lastFrame());
    expect(f).toContain('tentando de novo a cada ~5 min');
    expect(f).not.toContain('volta às');
    expect(f).toContain('↵ tentar agora');
    expect(f).not.toContain('esc interromper');
    r.unmount();
    c.dispose();
  });

  it('saldo esgotado (manual): manda recarregar e não promete voltar sozinho', async () => {
    const { c, r } = montar(view({ manual: true, resetAtMs: undefined }));
    await esperar(() => plain(r.lastFrame()).includes('pausado — saldo esgotado'));
    const f = plain(r.lastFrame());
    expect(f).toContain('recarregue no provedor');
    expect(f).not.toContain('volta às');
    expect(f).not.toContain('cota esgotada');
    r.unmount();
    c.dispose();
  });

  it('sem pausa a linha não aparece', async () => {
    const { c, r } = montar(view());
    await esperar(() => plain(r.lastFrame()).includes('pausado — cota esgotada'));
    (c as unknown as { patch(p: object): void }).patch({
      quotaPause: undefined,
      phase: 'idle',
      workingLabel: undefined,
    });
    await esperar(() => !plain(r.lastFrame()).includes('pausado —'));
    r.unmount();
    c.dispose();
  });
});

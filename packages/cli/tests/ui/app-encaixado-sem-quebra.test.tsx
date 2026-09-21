// Relato do dono (21/09/2026, com print da tela): mandar DUAS mensagens no meio do turno
// rendia
//
//     ↳ encaixado: pq vc ta usando o grafo?
//                                              ← linha em branco
//     ↳ encaixado: eu quero que vc mesmo conduzisse
//
// Cada nota carregava o próprio `paddingBottom`, então duas seguidas saíam partidas ao
// meio — lendo como dois eventos soltos em vez de uma lista. Seguidas, elas ficam coladas,
// e o respiro existe só depois da ÚLTIMA.
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
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function buildController(): SessionController {
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
  const ports = {
    fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    search: { search: async () => [] },
  } as unknown as ToolPorts;
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Empurra blocos pelo MESMO caminho do produto (`pushBlock` é privado — é teste de render). */
function empurrar(controller: SessionController, blocos: readonly Record<string, unknown>[]) {
  const c = controller as unknown as { pushBlock(b: Record<string, unknown>): void };
  for (const b of blocos) c.pushBlock(b);
}

/** As linhas da tela a partir da 1ª nota "encaixado", sem espaços à direita. */
function linhasDesdeOPrimeiro(frame: string): string[] {
  const linhas = plain(frame)
    .split('\n')
    .map((l) => l.trimEnd());
  const i = linhas.findIndex((l) => l.includes('↳ encaixado'));
  return i < 0 ? [] : linhas.slice(i);
}

function montar(controller: SessionController) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
}

describe('App — notas "↳ encaixado" consecutivas', () => {
  it('DUAS seguidas ficam COLADAS (a regressão exata do print do dono)', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = montar(controller);
    controller.dismissBoot();
    empurrar(controller, [
      { kind: 'inject', text: 'pq vc ta usando o grafo?' },
      { kind: 'inject', text: 'eu quero que vc mesmo conduzisse' },
    ]);
    await waitFor(() => plain(lastFrame() ?? '').includes('eu quero que vc mesmo'));

    const l = linhasDesdeOPrimeiro(lastFrame() ?? '');
    expect(l[0]).toContain('↳ encaixado: pq vc ta usando o grafo?');
    // A linha IMEDIATAMENTE seguinte é a 2ª nota — não uma linha em branco.
    expect(l[1]).toContain('↳ encaixado: eu quero que vc mesmo conduzisse');
    unmount();
  });

  it('TRÊS seguidas: nenhuma linha em branco no meio', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = montar(controller);
    controller.dismissBoot();
    empurrar(controller, [
      { kind: 'inject', text: 'um' },
      { kind: 'inject', text: 'dois' },
      { kind: 'inject', text: 'tres' },
    ]);
    await waitFor(() => plain(lastFrame() ?? '').includes('encaixado: tres'));

    const l = linhasDesdeOPrimeiro(lastFrame() ?? '');
    expect(l.slice(0, 3).map((x) => x.trim())).toEqual([
      '↳ encaixado: um',
      '↳ encaixado: dois',
      '↳ encaixado: tres',
    ]);
    unmount();
  });

  // O respiro não some — só sai do MEIO. Depois da última nota ele continua lá, senão o
  // bloco seguinte grudaria na lista.
  it('depois da ÚLTIMA nota o respiro continua', async () => {
    const controller = buildController();
    const { lastFrame, unmount } = montar(controller);
    controller.dismissBoot();
    empurrar(controller, [
      { kind: 'inject', text: 'um' },
      { kind: 'inject', text: 'dois' },
      { kind: 'note', title: 'marco', lines: ['depois'] },
    ]);
    await waitFor(() => plain(lastFrame() ?? '').includes('marco'));

    const l = linhasDesdeOPrimeiro(lastFrame() ?? '');
    expect(l[1]).toContain('↳ encaixado: dois');
    expect(l[2]).toBe(''); // o respiro, agora só aqui
    unmount();
  });
});

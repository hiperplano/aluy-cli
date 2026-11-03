// Auditoria — `/comando` DESCONHECIDO: Enter fecha o menu, limpa o composer e AVISA qual comando
// não existe — e nunca vira objetivo do modelo (não gasta turno). Tab sem correspondência é
// no-op. Esc fecha o menu sem executar nada.

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

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function montar() {
  let chamadasAoModelo = 0;
  const comandos: string[] = [];
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      chamadasAoModelo += 1;
      return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
    },
  };
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
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <App controller={c} animate={false} bootMs={0} onCommand={(cmd) => comandos.push(cmd.id)} />
    </ThemeProvider>,
  );
  c.dismissBoot();
  const notas = (): string[] => c.current.blocks.flatMap((b) => (b.kind === 'note' ? b.lines : []));
  return { c, r, notas, modelo: () => chamadasAoModelo, comandos };
}

async function digitar(r: ReturnType<typeof render>, ...teclas: string[]): Promise<void> {
  for (const t of teclas) {
    await sleep(90);
    r.stdin.write(t);
  }
  await sleep(120);
}

describe('/comando desconhecido', () => {
  it('Enter avisa "comando desconhecido: /xyz", limpa o composer e NÃO chama o modelo', async () => {
    const { c, r, notas, modelo, comandos } = montar();
    await sleep(80);
    await digitar(r, '/xyz');
    expect(plain(r.lastFrame())).toContain('nenhum comando encontrado');
    await digitar(r, '\r');
    expect(notas().join(' ')).toContain('comando desconhecido: /xyz');
    expect(modelo()).toBe(0);
    expect(comandos).toEqual([]);
    expect(c.current.blocks.some((b) => b.kind === 'you')).toBe(false);
    expect(plain(r.lastFrame())).not.toContain('nenhum comando encontrado'); // menu fechado
    r.unmount();
    c.dispose();
  });

  it('Tab sem correspondência é no-op (não avisa, não limpa, não executa)', async () => {
    const { c, r, notas, comandos } = montar();
    await sleep(80);
    await digitar(r, '/xyz', '\t');
    expect(notas().join(' ')).not.toContain('desconhecido');
    expect(comandos).toEqual([]);
    expect(plain(r.lastFrame())).toContain('/xyz');
    r.unmount();
    c.dispose();
  });

  it('Esc fecha o menu sem executar nada', async () => {
    const { c, r, comandos } = montar();
    await sleep(80);
    await digitar(r, '/mo');
    expect(plain(r.lastFrame())).toContain('/model');
    await digitar(r, ESC);
    expect(comandos).toEqual([]);
    r.unmount();
    c.dispose();
  });
});

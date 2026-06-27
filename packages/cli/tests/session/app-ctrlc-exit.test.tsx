// EST-1015 (dono, dogfooding) — DUPLO Ctrl+C p/ sair. Um único Ctrl+C no composer ocioso
// derrubava a app na hora ("uma vez já mata"). Agora:
//   · composer VAZIO + 1º Ctrl+C ⇒ ARMA a saída (footer: "ctrl-c de novo para sair"), NÃO sai;
//   · qualquer outra tecla ⇒ DESARMA;
//   · composer COM TEXTO + Ctrl+C ⇒ LIMPA o texto (não arma, não sai).
// O 2º Ctrl+C (dentro da janela) encerra de fato — caminho de exit() do useApp, coberto
// pela lógica; aqui provamos o que é OBSERVÁVEL sem desmontar (a 1ª não sai + a dica arma).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const CTRL_C = '\x03';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return [];
    },
  };
  return { fs, shell, search };
}

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

function buildController(): SessionController {
  return new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

function mount(): ReturnType<typeof render> & { controller: SessionController } {
  const controller = buildController();
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { ...r, controller } as never;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

describe('App — duplo Ctrl+C p/ sair (EST-1015)', () => {
  it('1º Ctrl+C no composer VAZIO NÃO sai: arma a saída e mostra "ctrl-c de novo"', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write(CTRL_C);
    await flush();
    // a app SEGUE montada (não saiu) e o footer pede confirmação.
    expect(plain(lastFrame())).toContain('de novo');
    controller.dispose();
  });

  it('uma tecla qualquer DESARMA a saída pendente (a dica some)', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write(CTRL_C);
    await flush();
    expect(plain(lastFrame())).toContain('de novo'); // armado
    stdin.write('x'); // atividade ⇒ desarma
    await flush();
    expect(plain(lastFrame())).not.toContain('de novo');
    controller.dispose();
  });

  it('Ctrl+C com TEXTO no composer LIMPA o texto (não arma a saída)', async () => {
    const { stdin, lastFrame, controller } = mount();
    await flush();
    stdin.write('rascunho'); // digita algo
    await flush();
    expect(plain(lastFrame())).toContain('rascunho');
    stdin.write(CTRL_C); // 1º Ctrl+C ⇒ limpa, não arma
    await flush();
    const f = plain(lastFrame());
    expect(f).not.toContain('rascunho'); // texto sumiu
    expect(f).not.toContain('de novo'); // e NÃO armou a saída
    controller.dispose();
  });
});

// EST-0961 — integração da command palette na <App> (drive real via stdin):
//   • Ctrl+P ABRE a palette;
//   • digitar FILTRA (fuzzy) os comandos;
//   • Enter EXECUTA o comando selecionado (onCommand recebe o certo);
//   • Esc FECHA;
//   • a palette compartilha o REGISTRO com o slash-menu (comando do usuário
//     aparece nos dois);
//   • GATING: Ctrl+P não abre a palette enquanto o slash-menu está aberto
//     (sem conflito de teclas, como o Tab já é gated).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type ModelCaller,
  type ModelCallResult,
} from '@aluy/cli-core';
import { ThemeRoot } from '../../src/session/ThemeRoot.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SlashCommand } from '../../src/slash/commands.js';

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

const idleCaller: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

function buildController(): SessionController {
  return new SessionController({
    model: idleCaller,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const ENV = { COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const CTRL_P = '\x10'; // Ctrl+P
const CTRL_X = '\x18'; // Ctrl+X (leader alternativo)
const ENTER = '\r';
const DOWN = '\x1b[B';
const ESC = '\x1b';

async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
}

type Harness = {
  stdin: { write(s: string): void };
  lastFrame: () => string | undefined;
  unmount: () => void;
  commands: { cmd: SlashCommand; args: string }[];
  controller: SessionController;
};

function mount(userCommands?: readonly SlashCommand[]): Harness {
  const controller = buildController();
  const commands: { cmd: SlashCommand; args: string }[] = [];
  const r = render(
    <ThemeRoot
      initialTheme="aluy-dark"
      env={ENV}
      controller={controller}
      animate={false}
      bootMs={0}
      onCommand={(cmd, args) => commands.push({ cmd, args })}
      {...(userCommands !== undefined ? { userCommands } : {})}
    />,
  );
  controller.dismissBoot();
  return { stdin: r.stdin, lastFrame: r.lastFrame, unmount: r.unmount, commands, controller };
}

describe('App — command palette (Ctrl+P)', () => {
  it('Ctrl+P ABRE a palette (dica de busca visível)', async () => {
    const h = mount();
    await flush();
    h.stdin.write(CTRL_P);
    await flush();
    expect(h.lastFrame()).toContain('buscar comando');
    h.unmount();
  });

  it('o leader Ctrl+X também abre (alias trivial)', async () => {
    const h = mount();
    await flush();
    h.stdin.write(CTRL_X);
    await flush();
    expect(h.lastFrame()).toContain('buscar comando');
    h.unmount();
  });

  it('digitar FILTRA por fuzzy e Enter EXECUTA o comando certo', async () => {
    const h = mount();
    await flush();
    h.stdin.write(CTRL_P);
    await flush();
    for (const ch of 'usage') h.stdin.write(ch);
    await flush();
    // o melhor match (/usage) está no topo ⇒ Enter o executa.
    h.stdin.write(ENTER);
    await flush();
    expect(h.commands.map((c) => c.cmd.name)).toContain('usage');
    h.unmount();
  });

  it('navega ↓ e executa o item selecionado', async () => {
    const h = mount();
    await flush();
    h.stdin.write(CTRL_P);
    await flush();
    // sem filtro: o 1º item é /help (1º nativo); ↓ vai p/ /login.
    h.stdin.write(DOWN);
    await flush();
    h.stdin.write(ENTER);
    await flush();
    expect(h.commands.map((c) => c.cmd.name)).toContain('login');
    h.unmount();
  });

  it('Esc FECHA a palette sem executar', async () => {
    const h = mount();
    await flush();
    h.stdin.write(CTRL_P);
    await flush();
    expect(h.lastFrame()).toContain('buscar comando');
    h.stdin.write(ESC);
    await flush();
    expect(h.lastFrame()).not.toContain('buscar comando');
    expect(h.commands).toHaveLength(0);
    h.unmount();
  });

  it('compartilha o REGISTRO com o slash-menu: um comando do usuário aparece na palette', async () => {
    const USER: readonly SlashCommand[] = [
      { name: 'deploy', summary: 'sobe pra staging', source: 'user' },
    ];
    const h = mount(USER);
    await flush();
    h.stdin.write(CTRL_P);
    await flush();
    for (const ch of 'deploy') h.stdin.write(ch);
    await flush();
    expect(h.lastFrame()).toContain('/deploy');
    h.unmount();
  });

  it('GATING: Ctrl+P NÃO abre a palette enquanto o slash-menu está aberto', async () => {
    const h = mount();
    await flush();
    // abre o slash-menu digitando `/`
    h.stdin.write('/');
    await flush();
    h.stdin.write(CTRL_P); // deve ser ignorado (sem conflito)
    await flush();
    // a palette NÃO abriu (sua dica própria não aparece)…
    expect(h.lastFrame()).not.toContain('buscar comando');
    h.unmount();
  });

  it('GATING: Ctrl+P NÃO abre a palette enquanto o file-picker @ está aberto', async () => {
    const h = mount();
    await flush();
    // abre o file-picker `@` digitando `@a`
    h.stdin.write('@');
    h.stdin.write('a');
    await flush();
    // o picker `@` está aberto (sua dica própria aparece)
    expect(h.lastFrame()).toContain('anexar arquivo');
    h.stdin.write(CTRL_P); // deve ser ignorado
    await flush();
    expect(h.lastFrame()).not.toContain('buscar comando');
    h.unmount();
  });
});

// EST-0948/EST-0983 (composer/sessão) — `/clear` LIMPA A TELA de verdade. O Ink
// escreve cada item do <Static> UMA vez no scrollback e nunca mais o re-renderiza:
// esvaziar o estado NÃO tira o que já está na tela. A App expõe o `clearScreen`
// (emite `\x1b[2J\x1b[3J\x1b[H` no stdout + REMONTA o <Static> via bump da `key`) ao
// WIRING (registerClearScreen); o wiring o dispara QUANDO a sessão de fato zera —
// `/clear` puro sempre (EST-0983 manteve isto). Provamos as DUAS coisas: o stdout
// recebeu a sequência de clear, e o <Static> foi REMONTADO (novo MOUNT, não re-render).

import React from 'react';
import { describe, expect, it, vi } from 'vitest';

// Mock do <Static>: conta MOUNTS (montagem real, via useEffect com deps []). Um
// re-render NÃO incrementa; só uma remontagem (key nova ⇒ árvore nova) incrementa.
let staticMounts = 0;
const staticItemsLog: unknown[][] = [];
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  const ReactLib = await import('react');
  return {
    ...actual,
    Static: ({ items }: { items: unknown[]; children: unknown }) => {
      staticItemsLog.push(items);
      ReactLib.useEffect(() => {
        staticMounts += 1;
      }, []);
      return null;
    },
  };
});

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
import { parseClearCommand, runClearCommand } from '../../src/slash/clear.js';
import { AgentMemory, type MemoryFact, type MemoryStorePort } from '@aluy/cli-core';
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

function scriptedCaller(text: string): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
}

function buildController(): SessionController {
  let ctrl: SessionController | null = null;
  const controller = new SessionController({
    model: scriptedCaller('resposta do agente'),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  ctrl = controller;
  void ctrl;
  return controller;
}

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function pressUntil(write: () => void, cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Memória fake (vazia) — o `/clear` puro nem a toca; existe só p/ montar a AgentMemory.
function emptyMemory(): AgentMemory {
  let facts: MemoryFact[] = [];
  const store: MemoryStorePort = {
    async readAll() {
      return facts;
    },
    async append(f) {
      facts.push(f);
    },
    async remove(id) {
      facts = facts.filter((f) => f.id !== id);
    },
    async update(f) {
      facts = facts.map((x) => (x.id === f.id ? f : x));
    },
    async clearAll() {
      facts = [];
    },
  };
  return new AgentMemory({ store });
}

// O wiring REAL do /clear (EST-0983): o onCommand do run.tsx roteia `/clear` p/
// `runClearCommand` (que zera a sessão) e, quando a sessão de fato limpa, dispara o
// `clearScreen` registrado pela App. Reproduzimos esse contrato aqui.
function onCommandWiring(controller: SessionController, getClearScreen: () => (() => void) | null) {
  const memory = emptyMemory();
  return (command: SlashCommand, args = ''): void => {
    if (command.id !== 'clear') return;
    const cmd = parseClearCommand(args);
    void runClearCommand(cmd, { clearSession: () => controller.clear(), memory }, false).then(
      (outcome) => {
        if (outcome.note.lines.length > 0) {
          controller.pushNote(outcome.note.title, outcome.note.lines);
        }
        if (outcome.cleared) getClearScreen()?.();
      },
    );
  };
}

describe('App — `/clear` limpa a TELA (terminal + remonta o Static) — EST-0948', () => {
  it('digitar `/clear` + Enter ⇒ stdout recebe o clear de tela+scrollback E o Static REMONTA', async () => {
    staticMounts = 0;
    staticItemsLog.length = 0;
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    // O wiring guarda o `clearScreen` que a App registra (registerClearScreen) e o
    // dispara quando a sessão zera — exatamente como o run.tsx real.
    let clearScreenFn: (() => void) | null = null;
    const { stdin, stdout, unmount } = render(
      <ThemeProvider theme={theme}>
        <App
          controller={controller}
          animate={false}
          bootMs={0}
          onCommand={onCommandWiring(controller, () => clearScreenFn)}
          registerClearScreen={(fn) => {
            clearScreenFn = fn;
          }}
        />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    const writeSpy = vi.spyOn(stdout, 'write');

    // uma conversa de 1 turno (deixa blocos no histórico).
    await controller.submit('faça');
    await waitFor(() => controller.current.phase === 'done' && controller.blocks.length > 0);
    const mountsBeforeClear = staticMounts;

    // digita `/clear` e dá Enter — o caminho real do composer.
    await pressUntil(
      () => stdin.write('/clear\r'),
      () => controller.blocks.length === 0,
    );

    // (a) o stdout recebeu o clear de TELA + SCROLLBACK + home.
    const wrote = writeSpy.mock.calls.map((c) => String(c[0])).join('');
    expect(wrote).toContain('\x1b[2J'); // limpa a tela
    expect(wrote).toContain('\x1b[3J'); // limpa o scrollback
    expect(wrote).toContain('\x1b[H'); // cursor no topo

    // (b) o Static REMONTOU (novo mount após o /clear) — o Ink esquece o commitado.
    await waitFor(() => staticMounts > mountsBeforeClear);
    expect(staticMounts).toBeGreaterThan(mountsBeforeClear);

    // e o estado de blocos zerou (a base da tela limpa).
    expect(controller.blocks.length).toBe(0);
    writeSpy.mockRestore();
    unmount();
  });
});

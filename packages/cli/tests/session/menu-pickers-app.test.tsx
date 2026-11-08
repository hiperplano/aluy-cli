// Seletores dos comandos sem argumento (`/notify`, `/clear`, `/memory`…): abrem sobre o
// PickerFrame, marcam o valor atual e rodam o MESMO runCommand que o comando digitado
// (revisão de UX dos menus, §6.2).

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
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App, type AppProps } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { SlashCommand } from '../../src/slash/commands.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

async function warmup(
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!plain(lastFrame()).includes('❯ x')) {
    if (Date.now() > deadline) throw new Error('warmup: stdin do Ink não anexou no prazo');
    stdin.write('x');
    await sleep(20);
  }
  stdin.write('\x7f');
  await sleep(40);
}

async function type(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  for (const ch of text) {
    stdin.write(ch);
    await sleep(35);
  }
  await sleep(40);
}

type Extra = Partial<AppProps>;

async function mountWith(extra: Extra = {}) {
  const controller = buildController();
  const calls: { name: string; args: string }[] = [];
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        onCommand={(c: SlashCommand, a: string) => calls.push({ name: c.name, args: a })}
        {...extra}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  await waitFor(() => plain(r.lastFrame()).length > 0);
  await warmup(r.stdin, r.lastFrame);
  return { controller, calls, ...r };
}

const frame = (lf: () => string | undefined): string => plain(lf());
const ENTER = '\r';
const DOWN = '\u001B[B';
const ESCK = '\u001B';
const UP = '\u001B[A';

/** Tecla de navegação. Espera o Ink reassinar o handler depois do último render do seletor. */
async function press(stdin: { write: (s: string) => void }, k: string): Promise<void> {
  await sleep(70);
  stdin.write(k);
}

/** Digita o texto e dá Enter (o menu `/` executa o 1º item = o comando). */
async function run(stdin: { write: (s: string) => void }, text: string): Promise<void> {
  // deixa o Ink reassinar o handler de teclas depois de um seletor fechar (throttle do render)
  await sleep(150);
  await type(stdin, text);
  stdin.write(ENTER);
  await sleep(60);
}

describe('seletores dos comandos', () => {
  it('/notify abre o seletor com rótulos PT-BR, marca o atual e roda o MESMO comando', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith({
      currentNotify: () => 'attention',
    });
    await run(stdin, '/notify');
    await waitFor(() => frame(lastFrame).includes('quando o aluy avisa'));
    const f = frame(lastFrame);
    expect(f).toContain('tudo');
    expect(f).toContain('só atenção');
    expect(f).toContain('nada');
    expect(f).toMatch(/● só atenção/); // valor atual marcado
    expect(f).toMatch(/› .*só atenção/); // e a seleção já nasce nele
    expect(calls).toHaveLength(0); // abrir o seletor não executa nada
    await press(stdin, DOWN); // → nada
    await press(stdin, ENTER);
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ name: 'notify', args: 'off' }); // rótulo PT-BR → arg em inglês
    expect(frame(lastFrame)).not.toContain('quando o aluy avisa');
    unmount();
  });

  it('argumento digitado segue direto, sem seletor', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith();
    await run(stdin, '/notify off');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ name: 'notify', args: 'off' });
    expect(frame(lastFrame)).not.toContain('quando o aluy avisa');
    unmount();
  });

  it('esc fecha o seletor sem rodar nada', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith();
    await run(stdin, '/notify');
    await waitFor(() => frame(lastFrame).includes('quando o aluy avisa'));
    await press(stdin, ESCK);
    await waitFor(() => !frame(lastFrame).includes('quando o aluy avisa'));
    expect(calls).toHaveLength(0);
    unmount();
  });

  it('/statusline: escolher "compacto" aplica e persiste (compact)', async () => {
    const seen: string[] = [];
    const { stdin, lastFrame, unmount } = await mountWith({
      initialStatusline: 'full',
      onStatuslineChange: (m) => seen.push(m),
    });
    await run(stdin, '/statusline');
    await waitFor(() => frame(lastFrame).includes('1 linha'));
    expect(frame(lastFrame)).toMatch(/● completo/);
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    await waitFor(() => seen.length > 0);
    expect(seen[seen.length - 1]).toBe('compact');
    unmount();
  });

  it('/suggest: "desligada" desliga (valor atual vem marcado)', async () => {
    const seen: boolean[] = [];
    const { stdin, lastFrame, unmount } = await mountWith({
      initialSuggestions: true,
      onSuggestionsChange: (on) => seen.push(on),
    });
    await run(stdin, '/suggest');
    await waitFor(() => frame(lastFrame).includes('sugestão do próximo prompt'));
    expect(frame(lastFrame)).toMatch(/● ligada/);
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    await waitFor(() => seen.length > 0);
    expect(seen[seen.length - 1]).toBe(false);
    unmount();
  });

  it('/split: "mostrar log" liga; escolher o que já vale não alterna', async () => {
    const seen: boolean[] = [];
    const { stdin, lastFrame, unmount } = await mountWith({
      initialSplitView: false,
      onSplitViewChange: (on) => seen.push(on),
    });
    await run(stdin, '/split');
    await waitFor(() => frame(lastFrame).includes('painel de log ao lado do chat'));
    expect(frame(lastFrame)).toMatch(/● ocultar log/);
    await press(stdin, UP); // o seletor nasce no ATUAL (ocultar): sobe p/ "mostrar log"
    await press(stdin, ENTER);
    await waitFor(() => seen.length > 0);
    expect(seen).toEqual([true]);
    // agora o log está ligado: escolher "mostrar" de novo não pode desligar
    await run(stdin, '/split');
    await waitFor(() => frame(lastFrame).includes('painel de log ao lado do chat'));
    await press(stdin, ENTER);
    await sleep(150);
    expect(seen).toEqual([true]);
    unmount();
  });

  it('/window: "128k" roda /window 128k; "outro valor" preenche o composer', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith();
    await run(stdin, '/window');
    await waitFor(() => frame(lastFrame).includes('janela de contexto do modelo'));
    await press(stdin, DOWN);
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ name: 'window', args: '128k' });
    await run(stdin, '/window');
    await waitFor(() => frame(lastFrame).includes('janela de contexto do modelo'));
    for (let i = 0; i < 5; i++) {
      await press(stdin, DOWN);
      await sleep(25);
    }
    await press(stdin, ENTER);
    await waitFor(() => !frame(lastFrame).includes('janela de contexto do modelo'));
    expect(calls).toHaveLength(1);
    expect(frame(lastFrame)).toContain('/window');
    unmount();
  });

  it('/clear: destrutivo pede confirmação; "cancelar" não roda; "sim" roda 2x (arma + confirma)', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith();
    await run(stdin, '/clear');
    await waitFor(() => frame(lastFrame).includes('só a memória'));
    await press(stdin, DOWN); // conversa + memória
    await press(stdin, ENTER);
    await waitFor(() => frame(lastFrame).includes('apagar a conversa E a memória?'));
    expect(calls).toHaveLength(0);
    await press(stdin, DOWN); // cancelar
    await press(stdin, ENTER);
    await sleep(80);
    expect(calls).toHaveLength(0);
    // de novo, agora confirmando
    await run(stdin, '/clear');
    await waitFor(() => frame(lastFrame).includes('só a memória'));
    await press(stdin, DOWN);
    await press(stdin, ENTER);
    await waitFor(() => frame(lastFrame).includes('apagar a conversa E a memória?'));
    await press(stdin, ENTER); // sim
    await waitFor(() => calls.length === 2);
    expect(calls).toEqual([
      { name: 'clear', args: 'full' },
      { name: 'clear', args: 'full' },
    ]);
    unmount();
  });

  it('/clear → "só a conversa" roda /clear sem argumento (sem reabrir o seletor)', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith();
    await run(stdin, '/clear');
    await waitFor(() => frame(lastFrame).includes('só a memória'));
    await press(stdin, ENTER);
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ name: 'clear', args: '' });
    expect(frame(lastFrame)).not.toContain('só a memória');
    unmount();
  });

  it('/memory: escolhe o fato, depois a ação — sem digitar id; esquecer confirma', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith({
      menuData: {
        memory: async () => [
          { id: 'ab12', label: 'usa pnpm no projeto', hint: 'projeto', flag: false },
          { id: 'cd34', label: 'prefere respostas curtas', hint: 'global', flag: true },
        ],
      },
    });
    await run(stdin, '/memory');
    await waitFor(() => frame(lastFrame).includes('usa pnpm no projeto'));
    expect(frame(lastFrame)).toContain('prefere respostas curtas');
    await press(stdin, ENTER); // 1º fato
    await waitFor(() => frame(lastFrame).includes('esquecer'));
    expect(frame(lastFrame)).toContain('fixar');
    await press(stdin, DOWN);
    await press(stdin, DOWN); // esquecer
    await press(stdin, ENTER);
    await waitFor(() => frame(lastFrame).includes('esquecer este fato?'));
    expect(calls).toHaveLength(0);
    await press(stdin, ENTER); // sim
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ name: 'memory', args: 'forget ab12' });
    unmount();
  });

  it('/memory sem a lista injetada segue como antes (sem seletor)', async () => {
    const { stdin, lastFrame, calls, unmount } = await mountWith();
    await run(stdin, '/memory');
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ name: 'memory', args: '' });
    expect(frame(lastFrame)).not.toContain('memória do agente');
    unmount();
  });

  it('/secret: lista só os NOMES salvos para remover, com confirmação', async () => {
    const removed: string[] = [];
    const { stdin, lastFrame, calls, unmount } = await mountWith({
      secrets: {
        list: () => [{ name: 'GH_TOKEN', saved: true }],
        remove: (n: string) => {
          removed.push(n);
          return { removed: true, wasSaved: true };
        },
      } as unknown as AppProps['secrets'],
    });
    await run(stdin, '/secret');
    await waitFor(() => frame(lastFrame).includes('listar os nomes salvos'));
    await press(stdin, DOWN); // remover um segredo
    await press(stdin, ENTER);
    await waitFor(() => frame(lastFrame).includes('GH_TOKEN'));
    await press(stdin, ENTER);
    await waitFor(() => frame(lastFrame).includes('remover GH_TOKEN?'));
    await press(stdin, ENTER); // sim
    await waitFor(() => !frame(lastFrame).includes('remover GH_TOKEN?'));
    expect(removed).toEqual(['GH_TOKEN']); // o MESMO `/secret remove GH_TOKEN`
    expect(calls).toHaveLength(0); // /secret é da App (nunca vai ao onCommand)
    unmount();
  });
});

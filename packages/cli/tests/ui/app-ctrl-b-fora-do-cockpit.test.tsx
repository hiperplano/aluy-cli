// F-BG — o Ctrl+B tem de funcionar na TUI NORMAL, não só no `/fullscreen`.
//
// A REGRESSÃO que este arquivo guarda (rc.184, relatada pelo dono: "tentei usar o ctrl+b
// e nada, todas as minhas msgs depois ficaram esperando para serem encaixadas"): o handler
// nasceu DENTRO do bloco `if (cockpitActive …)` do `useInput`, colado ao Ctrl+S — que é
// exclusivo do cockpit por desenho. Na TUI normal a tecla nunca chegava ao controller.
//
// Por que os testes da rc.184 não pegaram: cobriam a PORTA de shell (processos reais) e o
// CANAL (DetachHub), e nenhum apertava a tecla na App montada. Medido depois por rastro na
// TUI real: a porta recebia o `detachSignal`, o `useInput` via `char="b" ctrl=true`, e o
// `soltarParaSegundoPlano` jamais era chamado. Este teste aperta a tecla.
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
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
const CTRL_B = String.fromCharCode(2);
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function fakePorts(): ToolPorts {
  return {
    fs: { readFile: async () => '', writeFile: async () => {}, exists: async () => false },
    shell: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    search: { search: async () => [] },
  } as unknown as ToolPorts;
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
    if (Date.now() > deadline) throw new Error('pressUntil: efeito da tecla não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function montar(controller: SessionController) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
}

describe('App — Ctrl+B na TUI NORMAL (fora do cockpit)', () => {
  it('a tecla CHEGA ao controller (a regressão exata da rc.184)', async () => {
    const controller = buildController();
    const spy = vi.spyOn(controller, 'soltarParaSegundoPlano');
    const { stdin, lastFrame, unmount } = montar(controller);
    controller.dismissBoot();
    await waitFor(() => plain(lastFrame() ?? '').includes('digite um objetivo'));

    await pressUntil(
      () => stdin.write(CTRL_B),
      () => spy.mock.calls.length > 0,
    );
    expect(spy).toHaveBeenCalled();
    unmount();
  });

  // Sem nada rodando o controller devolve `false` ⇒ a tecla NÃO é consumida: o Ctrl+B
  // segue sendo o que sempre foi no composer, e nada de nota ou ruído aparece na conversa.
  it('sem nada rodando: não faz barulho na tela', async () => {
    const controller = buildController();
    const { stdin, lastFrame, unmount } = montar(controller);
    controller.dismissBoot();
    await waitFor(() => plain(lastFrame() ?? '').includes('digite um objetivo'));
    const antes = plain(lastFrame() ?? '');

    stdin.write(CTRL_B);
    await new Promise((r) => setTimeout(r, 60));

    expect(plain(lastFrame() ?? '')).toBe(antes);
    expect(plain(lastFrame() ?? '')).not.toContain('segundo plano');
    unmount();
  });

  // Com algo armado, a tecla SOLTA — e é consumida (não vaza para o composer).
  it('com uma tool armada: o sinal de soltar dispara', async () => {
    const controller = buildController();
    const armado = new AbortController();
    (controller as unknown as { detachAtual: AbortController }).detachAtual = armado;
    const { stdin, lastFrame, unmount } = montar(controller);
    controller.dismissBoot();
    await waitFor(() => plain(lastFrame() ?? '').includes('digite um objetivo'));

    await pressUntil(
      () => stdin.write(CTRL_B),
      () => armado.signal.aborted,
    );
    expect(armado.signal.aborted).toBe(true);
    unmount();
  });
});

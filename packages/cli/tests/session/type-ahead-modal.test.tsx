// F6 — TYPE-AHEAD sob modais: texto digitado durante o splash, a pergunta de retomar e a
// caixa de permissão NÃO some. Regra: as teclas de RESPOSTA só respondem como PRIMEIRA tecla
// (rascunho vazio); com rascunho em curso tudo que é imprimível é texto, Enter é ignorado e
// Esc apaga o rascunho (não responde).

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
import { SplashApp, createSplashStore } from '../../src/session/splash-controller.js';
import type { BootPrompt } from '../../src/ui/components/SplashScreen.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ANSI = new RegExp('\\x1b' + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await sleep(5);
  }
}

const PROMPT: BootPrompt = {
  title: '↻ retomar sessão',
  body: ['retomar a conversa anterior?'],
  options: 'Enter retomar · n nova',
};

function mountSplash(store: ReturnType<typeof createSplashStore>) {
  const theme = resolveTheme({ env: ENV });
  return render(
    <ThemeProvider theme={theme}>
      <SplashApp store={store} />
    </ThemeProvider>,
  );
}

function askBoot(store: ReturnType<typeof createSplashStore>): { answered: () => boolean | null } {
  let answer: boolean | null = null;
  store.set((s) => ({
    ...s,
    prompt: PROMPT,
    resolve: (a: boolean) => {
      answer = a;
    },
  }));
  return { answered: () => answer };
}

describe('F6 — splash / pergunta de retomar guardam o que foi digitado', () => {
  it('sem pergunta: o texto digitado fica guardado (e a tecla pula o piso)', async () => {
    const store = createSplashStore();
    let skipped = false;
    const theme = resolveTheme({ env: ENV });
    const { stdin, unmount } = render(
      <ThemeProvider theme={theme}>
        <SplashApp
          store={store}
          onSkip={() => {
            skipped = true;
          }}
        />
      </ThemeProvider>,
    );
    await sleep(60);
    stdin.write('ola');
    await waitFor(() => store.get().typed === 'ola');
    expect(skipped).toBe(true);
    unmount();
  });

  it('com pergunta: 1ª tecla de resposta (n) RESPONDE; texto comum começa rascunho', async () => {
    const store = createSplashStore();
    const { stdin, unmount } = mountSplash(store);
    const a = askBoot(store);
    await sleep(60);
    stdin.write('o');
    await waitFor(() => store.get().typed === 'o');
    // com rascunho em curso, 'n' e Enter NÃO respondem
    stdin.write('n');
    await waitFor(() => store.get().typed === 'on');
    stdin.write('\r');
    await sleep(60);
    expect(a.answered()).toBeNull();
    expect(store.get().typed).toBe('on');
    // Esc apaga o rascunho (não responde)
    stdin.write('\x1b');
    await waitFor(() => store.get().typed === '');
    expect(a.answered()).toBeNull();
    // agora a 1ª tecla de resposta volta a valer
    stdin.write('n');
    await waitFor(() => a.answered() === false);
    unmount();
  });
});

// ── caixa de permissão (App) ──────────────────────────────────────────────────────────────

function buildController(): SessionController {
  const ports: ToolPorts = {
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
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return [];
      },
    },
  };
  // F15 — o `!cmd` do usuário não abre mais caixa; o ask vem de um run_command DO MODELO.
  let n = 0;
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      n += 1;
      const content =
        n === 1
          ? '<<<ALUY_TOOL_CALL\n{"name":"run_command","input":{"command":"ls"}}\nALUY_TOOL_CALL>>>'
          : 'pronto.';
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('F6 — caixa de permissão: type-ahead sem resposta acidental', () => {
  it('texto digitado vira rascunho no composer; a/n/Enter/Esc dentro dele NÃO respondem', async () => {
    const controller = buildController();
    const theme = resolveTheme({ env: ENV });
    const { stdin, lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await sleep(30);
    void controller.submit('liste');
    await waitFor(() => controller.current.phase === 'asking');
    await sleep(30);

    stdin.write('x'); // não é tecla de resposta ⇒ começa o rascunho
    await waitFor(() => plain(lastFrame()).includes('x'));
    stdin.write('a'); // com rascunho, 'a' é TEXTO (não aprova)
    stdin.write('n');
    await sleep(60);
    stdin.write('\r'); // Enter ignorado
    await sleep(60);
    expect(controller.current.phase).toBe('asking');
    expect(plain(lastFrame())).toContain('xan');

    stdin.write('\x1b'); // Esc apaga o rascunho, NÃO nega
    await sleep(60);
    expect(controller.current.phase).toBe('asking');
    expect(plain(lastFrame())).not.toContain('xan');

    stdin.write('a'); // composer vazio ⇒ 'a' volta a aprovar
    await waitFor(() => controller.current.phase !== 'asking');
    unmount();
  });
});

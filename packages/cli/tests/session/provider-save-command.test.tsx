// F-PROV-FIX — dono, dogfooding: "pq quando muda o provider dentro da sessão ele não
// fixa (persiste)?". O DEFAULT continua session-only (EST-0962/F-PROV, zero
// regressão); `/provider save` é o ATO EXPLÍCITO novo. Prova aqui SÓ o ROTEAMENTO
// na App (o verbo "save" nunca é confundido com um NOME de provider real, e chama
// `onSaveProvider` em vez de `onSelectProvider`) — a lógica de O QUE persistir
// (`planSaveProvider`) e a escrita (`UserConfigStore.saveLocalProvider`) têm testes
// próprios e mais diretos (`save-provider.test.ts` / `user-config-local-provider.test.ts`).

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
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

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
      return { matches: [], truncated: {} };
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(opts: { onSaveProvider?: () => void }): {
  stdin: ReturnType<typeof render>['stdin'];
  lastFrame: ReturnType<typeof render>['lastFrame'];
  controller: SessionController;
  selectProviderCalls: string[];
} {
  const controller = new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  });
  const selectProviderCalls: string[] = [];
  const theme = resolveTheme({ env: ENV });
  const { stdin, lastFrame } = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        catalog={undefined}
        onSelectProvider={(p) => selectProviderCalls.push(p)}
        {...(opts.onSaveProvider ? { onSaveProvider: opts.onSaveProvider } : {})}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { stdin, lastFrame, controller, selectProviderCalls };
}

describe('F-PROV-FIX — `/provider save` roteia na App (ato EXPLÍCITO, não side-effect)', () => {
  it('com `onSaveProvider` wireado: chama-o DIRETO, nunca tenta casar "save" como nome de provider', async () => {
    let saveCalls = 0;
    const { stdin, controller, selectProviderCalls } = mount({
      onSaveProvider: () => {
        saveCalls += 1;
      },
    });
    await flush();
    stdin.write('/provider save');
    await flush();
    stdin.write('\r');
    await flush();

    expect(saveCalls).toBe(1);
    expect(selectProviderCalls).toEqual([]); // NUNCA tentou setar um provider "save"
    controller.dispose();
  });

  it('MAIÚSCULO/espaços (`/provider SAVE`) também roteia (case-insensitive, trim)', async () => {
    let saveCalls = 0;
    const { stdin, controller, selectProviderCalls } = mount({
      onSaveProvider: () => {
        saveCalls += 1;
      },
    });
    await flush();
    stdin.write('/provider   SAVE');
    await flush();
    stdin.write('\r');
    await flush();

    expect(saveCalls).toBe(1);
    expect(selectProviderCalls).toEqual([]);
    controller.dispose();
  });

  it('SEM `onSaveProvider` wireado: nota honesta "indisponível" (degradação segura, nunca crash)', async () => {
    const { stdin, lastFrame, controller, selectProviderCalls } = mount({});
    await flush();
    stdin.write('/provider save');
    await flush();
    stdin.write('\r');
    await flush();

    expect(plain(lastFrame())).toContain('indisponível');
    expect(selectProviderCalls).toEqual([]);
    controller.dispose();
  });

  it('regressão: `/provider deepseek` (nome REAL) continua chamando onSelectProvider normalmente', async () => {
    const { stdin, controller, selectProviderCalls } = mount({});
    await flush();
    stdin.write('/provider deepseek');
    await flush();
    stdin.write('\r');
    await flush();

    expect(selectProviderCalls).toEqual(['deepseek']);
    controller.dispose();
  });
});

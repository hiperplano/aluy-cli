// F-PROV-RETRY — o 401 na troca de provider REABRE o campo de chave.
//
// Relato do dono, com print: trocou para `tokenrouter`, o teste de conexão devolveu
// HTTP 401 ("Invalid token"), e a TUI só empurrou uma nota — `nada mudou (fail-closed)`
// mais "se a chave está velha, rode `aluy login --provider tokenrouter`". Ou seja: o
// campo de chave estava a UM passo dali (o picker acabara de fechar) e mandamos ele SAIR
// do CLI. Pedido literal: "quando a chave não funciona, ele deveria dar a opção de
// alterar a key".
//
// O que este arquivo trava é a LIGAÇÃO, não a peça. `retryCredential`/`planCredentialRetry`
// já existiam no hook, COM teste próprio (`use-provider-picker-credential.test.tsx`) — e
// nunca eram chamados por ninguém. Funcionalidade pronta, testada e desligada: o teste do
// hook passava, o gate ficava verde, e o comportamento não existia para quem usa. Um teste
// de unidade não pega isso; só o de integração pega.

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
  type LocalProviderEntry,
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

const DETALHE_401 =
  'provider "tokenrouter" NÃO respondeu ao teste: HTTP 401 — chave inválida?';

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
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Catálogo mínimo: um provider que EXIGE apikey e um KEYLESS (p/ o contraste). */
const CATALOGO: readonly LocalProviderEntry[] = [
  {
    id: 'tokenrouter',
    label: 'tokenrouter',
    wireFormat: 'openai-compat',
    baseUrl: 'https://api.tokenrouter.com/v1',
    auth: ['apikey'],
    defaultModel: 'deepseek/deepseek-v4-pro',
    models: ['deepseek/deepseek-v4-pro'],
  },
  {
    id: 'ollama',
    label: 'ollama',
    wireFormat: 'openai-compat',
    baseUrl: 'http://localhost:11434/v1',
    auth: ['none'], // KEYLESS — falha aqui é rede, não credencial
    defaultModel: 'llama3',
    models: ['llama3'],
  },
];

function mount(resultado: (p: string) => void | Promise<unknown>): {
  stdin: ReturnType<typeof render>['stdin'];
  lastFrame: ReturnType<typeof render>['lastFrame'];
  controller: SessionController;
} {
  const controller = new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  });
  const theme = resolveTheme({ env: ENV });
  const { stdin, lastFrame } = render(
    <ThemeProvider theme={theme}>
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        catalog={undefined}
        localProviderCatalog={() => CATALOGO}
        hasStoredKey={() => true} // já HÁ chave guardada — a velha, que o 401 reprova
        storeCredential={() => {}}
        onSelectProvider={resultado}
      />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { stdin, lastFrame, controller };
}

describe('F-PROV-RETRY — chave reprovada reabre o campo, em vez de mandar sair do CLI', () => {
  it('troca reprovada com 401 ⇒ campo de chave REABRE, com o motivo visível', async () => {
    const { stdin, lastFrame, controller } = mount(async () => ({
      ok: false as const,
      detail: DETALHE_401,
    }));
    await flush();
    stdin.write('/provider');
    await flush();
    stdin.write('\r'); // abre o picker
    await flush();
    stdin.write('\r'); // confirma o 1º item (tokenrouter)
    await flush();
    await flush();

    const tela = plain(lastFrame());
    // O campo voltou (rótulo do passo de credencial) …
    expect(tela).toContain('API key de tokenrouter');
    // … e diz POR QUE, sem obrigar o dono a decorar o 401 da nota.
    expect(tela).toContain('401');
    controller.dispose();
  });

  it('troca APROVADA não abre campo nenhum (não incomoda quem está com a chave boa)', async () => {
    const { stdin, lastFrame, controller } = mount(async () => true);
    await flush();
    stdin.write('/provider');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('\r');
    await flush();
    await flush();

    expect(plain(lastFrame())).not.toContain('API key de tokenrouter');
    controller.dispose();
  });

  // Provider KEYLESS que falha é rede/serviço fora do ar — pedir uma chave que não existe
  // seria confuso. Quem decide é `planCredentialRetry`; aqui provamos que a ligação
  // respeita essa decisão em vez de reabrir o campo para todo mundo.
  it('falha em provider KEYLESS (ollama) NÃO abre campo de chave', async () => {
    const { stdin, lastFrame, controller } = mount(async () => ({
      ok: false as const,
      detail: 'connection refused',
    }));
    await flush();
    stdin.write('/provider');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('\u001b[B'); // ↓ até o ollama (keyless)
    await flush();
    stdin.write('\r');
    await flush();
    await flush();

    expect(plain(lastFrame())).not.toContain('API key de ollama');
    controller.dispose();
  });
});

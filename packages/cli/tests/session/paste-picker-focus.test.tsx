// BUG (relato do dono) — em `/provider` → "+ adicionar provider custom", colar a URL
// da API caía no COMPOSER de cima, não no campo do formulário. Causa: o canal de
// bracketed-paste roda ANTES do Ink, direto no `stdin` (`onPasteData` em App.tsx) — não
// passava pelo MESMO switch de foco que o `useInput` usa pra rotear cada TECLA ao modal
// certo, então a colagem sempre ia parar em `insertPaste` (composer), mesmo com um
// campo de texto aberto por cima. Não é só o provider picker: `useLocalModelPicker`
// (slug do `/model` sob backend local) tem o MESMO campo de texto próprio e o MESMO
// furo.
//
// Prova aqui, na <App> real (mesmo harness de bracketed-paste-app.test.tsx):
//   1. provider picker, formulário "+ adicionar" — a colagem tem que ir pro campo `id`.
//   2. local model picker (slug livre) — idem, pro `query`.
//   3. um picker SEM campo de texto (theme, lista pura) — a colagem não pode vazar pro
//      composer escondido atrás (melhor ignorar que ir pro lugar errado).
//
// Cada `it` comenta o que aconteceria SEM o fix (o motivo certo do teste falhar antes).

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
import { PASTE_START, PASTE_END } from '../../src/session/bracketed-paste.js';
import type { AddCustomProviderInput } from '../../src/ui/hooks/useProviderPicker.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string | undefined): string {
  return (s ?? '').replace(ANSI, '');
}
// placeholder do composer VAZIO ('composer.placeholder', pt-BR.ts) — sinal de que
// NADA foi digitado/colado nele.
const COMPOSER_PLACEHOLDER = 'digite um objetivo';

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

function localEntry(id: string): LocalProviderEntry {
  return {
    id,
    label: id,
    wireFormat: 'openai-compat',
    baseUrl: `https://api.${id}.example/v1`,
    auth: ['apikey'],
    defaultModel: `${id}-default`,
    models: [`${id}-default`],
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
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
    if (Date.now() > deadline) throw new Error('pressUntil: efeito não assentou no prazo');
    write();
    await new Promise((r) => setTimeout(r, 10));
  }
}

function mountApp(extra: Record<string, unknown> = {}) {
  const controller = new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  });
  const theme = resolveTheme({ env: ENV });
  const { stdin, lastFrame, unmount } = render(
    <ThemeProvider theme={theme}>
      <App controller={controller} animate={false} bootMs={0} {...extra} />
    </ThemeProvider>,
  );
  controller.dismissBoot();
  return { controller, stdin, lastFrame, unmount };
}

describe('paste-picker-focus — colagem vai pro campo com FOCO, nunca pro composer escondido', () => {
  it('/provider → "+ adicionar provider custom": colar a URL vai pro campo `id`, não pro composer', async () => {
    const addCustomCalls: AddCustomProviderInput[] = [];
    const { controller, stdin, lastFrame, unmount } = mountApp({
      onSelectProvider: () => {},
      localProviderCatalog: () => [localEntry('meuprovider')],
      onAddCustomProvider: (input: AddCustomProviderInput) => addCustomCalls.push(input),
    });
    await flush();

    // abre o /provider (SEM arg abre o picker — precisa de onSelectProvider wireado).
    stdin.write('/provider');
    await flush();
    stdin.write('\r');
    await flush();

    // desce até o ÚLTIMO item da lista (o sentinela "+ adicionar…") — `move()` clampeia,
    // então um excesso de downArrow pousa nele independente do tamanho exato da lista.
    for (let i = 0; i < 20; i++) {
      stdin.write('\x1b[B'); // downArrow
      await flush();
    }
    // confirma o sentinela ⇒ entra no formulário (passo 'id').
    await pressUntil(
      () => stdin.write('\r'),
      () => plain(lastFrame() ?? '').includes('id do provider'),
    );

    // cola a URL — hoje (BUG) isso ia inteiro pro composer, que é o alvo padrão do
    // canal cru de paste (`insertPaste`), porque o roteamento não perguntava "quem
    // tem o foco".
    const PASTED = 'meuprovider-colado';
    await pressUntil(
      () => stdin.write(`${PASTE_START}${PASTED}${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes(PASTED),
    );

    const frame = plain(lastFrame() ?? '');
    // o composer segue VAZIO (placeholder intacto) — a colagem NÃO vazou pra ele.
    expect(frame).toContain(COMPOSER_PLACEHOLDER);

    // e o campo `id` recebeu o texto de fato: Enter agora AVANÇA pro passo `baseUrl`
    // (com o bug, o campo `id` ficava vazio e o Enter era NO-OP — `confirmAddCustom`
    // não avança um campo obrigatório vazio).
    await pressUntil(
      () => stdin.write('\r'),
      () => plain(lastFrame() ?? '').includes('base URL'),
    );

    // completa o formulário com digitação normal (não-paste) pra fechar o ciclo e
    // confirmar, pela DATA (não só pela tela), que o `id` persistido é o texto COLADO.
    stdin.write('https://x.example/v1');
    await flush();
    stdin.write('\r');
    await pressUntil(
      () => stdin.write('\r'), // passo 'model' aceita vazio — Enter finaliza
      () => addCustomCalls.length > 0,
    );

    expect(addCustomCalls[0]?.id).toBe(PASTED);
    controller.dispose();
    unmount();
  });

  it('/model (backend local) — colar um slug vai pro campo de busca do LocalModelPicker', async () => {
    const selectTierCalls: Array<[string, string?]> = [];
    const { controller, stdin, lastFrame, unmount } = mountApp({
      onSelectTier: (tier: string, slug?: string) => selectTierCalls.push([tier, slug]),
    });
    await flush();

    stdin.write('/model');
    await flush();
    stdin.write('\r');
    await flush();

    const PASTED = 'meu/slug-colado';
    await pressUntil(
      () => stdin.write(`${PASTE_START}${PASTED}${PASTE_END}`),
      () => plain(lastFrame() ?? '').includes(PASTED),
    );
    // composer intacto — a colagem foi pro campo de busca do picker, não pra ele.
    expect(plain(lastFrame() ?? '')).toContain(COMPOSER_PLACEHOLDER);

    // sem hit realçado (catálogo vazio nesta sessão), confirm() devolve o texto DIGITADO
    // literal — com o bug, a "digitação" nunca chegou (foi pro composer) e o campo
    // seguia vazio ⇒ confirm() com input vazio + sem hit devolve `null` (no-op, o
    // picker não fecha, `onSelectTier` nunca é chamado).
    stdin.write('\r');
    await flush();

    expect(selectTierCalls).toEqual([['custom', PASTED]]);
    controller.dispose();
    unmount();
  });

  it('/theme (lista PURA, sem campo de texto) — colar não vaza pro composer escondido', async () => {
    const { controller, stdin, lastFrame, unmount } = mountApp({
      onSelectTheme: () => {},
    });
    await flush();

    stdin.write('/theme');
    await flush();
    stdin.write('\r');
    await waitFor(() => plain(lastFrame() ?? '').includes('trocar tema'));
    // `lastFrame()` reflete o COMMIT; o listener cru (`onPasteData`) só re-assina com o
    // fecho NOVO (`themePicker.open` atualizado) no efeito PASSIVO seguinte — um instante
    // depois do commit. Um paste no MESMÍSSIMO microtask do Enter que abriu o picker é
    // teórico (nenhum terminal cola essa rápido); dar um respiro aqui evita testar essa
    // janela irreal em vez do roteamento em si.
    await flush();
    await flush();

    // "ignora" não tem um sinal de "assentou" pra esperar (é ausência de efeito) — reescreve
    // o MESMO chunk algumas vezes (idempotente: reprocessar um paste IGNORADO não muda
    // nada) só pra dar tempo do canal cru processar, como os outros testes de paste da
    // suíte já fazem.
    const PASTED = 'ISTO-NAO-PODE-APARECER-EM-LUGAR-NENHUM';
    for (let i = 0; i < 15; i++) {
      stdin.write(`${PASTE_START}${PASTED}${PASTE_END}`);
      await new Promise((r) => setTimeout(r, 10));
    }

    // nem no composer (que segue renderizado, só sem foco, atrás do overlay), nem em
    // lugar nenhum: o /theme não tem campo de texto, então a colagem é DESCARTADA —
    // melhor que cair, invisível, num composer que o usuário não está olhando.
    expect(plain(lastFrame() ?? '')).not.toContain(PASTED);
    // o picker segue aberto e intacto (a colagem não o afetou nem o fechou).
    expect(plain(lastFrame() ?? '')).toContain('trocar tema');

    controller.dispose();
    unmount();
  });
});

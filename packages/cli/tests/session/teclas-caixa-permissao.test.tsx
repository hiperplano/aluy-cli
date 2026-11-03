// Auditoria — a FIAÇÃO das teclas nas caixas de permissão e pergunta (App → controller):
// ESC interrompe o turno (não nega-e-segue), `n` nega, `e` nega (editar não é aplicado), `a`
// aprova uma vez, `l` lembra só quando pode (nunca categoria sempre-ask nem run_command), e
// com rascunho no composer as teclas viram texto (digitar "aprovar" nunca aprova por acidente).
// Os efeitos no controller já eram testados; faltava provar que a TECLA chega neles.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type AskRequest,
  type AskResolution,
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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
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

const pedido = (tool: string, alwaysAsk: boolean): AskRequest => ({
  call: { name: tool, input: { x: 1 } },
  effect: { kind: 'command', exact: `$ ${tool}` },
  category: 'tool:exec' as AskRequest['category'],
  reason: 'teste',
  alwaysAsk,
});

function montar(fase: 'asking' | 'questioning', req?: AskRequest) {
  const model: ModelCaller = {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'x', finish_reason: 'stop' };
    },
  };
  const c = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
  const resolucoes: AskResolution[] = [];
  let interrupcoes = 0;
  c.resolveAsk = (r: AskResolution): void => {
    resolucoes.push(r);
  };
  c.interruptFromPrompt = (): void => {
    interrupcoes += 1;
  };
  c.dismissBoot();
  (c as unknown as { patch(p: object): void }).patch(
    fase === 'asking'
      ? { phase: 'asking', pendingAsk: { request: req } }
      : {
          phase: 'questioning',
          pendingQuestion: {
            spec: {
              kind: 'single',
              question: 'qual?',
              options: [{ label: 'um' }, { label: 'dois' }],
            },
          },
        },
  );
  const r = render(
    <ThemeProvider theme={resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } })}>
      <App controller={c} animate={false} bootMs={0} />
    </ThemeProvider>,
  );
  return { c, r, resolucoes, interrupcoes: () => interrupcoes };
}

async function tecla(r: ReturnType<typeof render>, t: string): Promise<void> {
  await sleep(120);
  r.stdin.write(t);
  await sleep(120);
}

describe('caixa de permissão · teclas', () => {
  it('ESC interrompe o turno (interruptFromPrompt) e NÃO resolve a caixa como negação', async () => {
    const { c, r, resolucoes, interrupcoes } = montar('asking', pedido('web_fetch', false));
    await tecla(r, ESC);
    expect(interrupcoes()).toBe(1);
    expect(resolucoes).toEqual([]);
    r.unmount();
    c.dispose();
  });

  it('n NEGA e segue (deny com motivo do usuário), sem interromper', async () => {
    const { c, r, resolucoes, interrupcoes } = montar('asking', pedido('web_fetch', false));
    await tecla(r, 'n');
    expect(resolucoes).toHaveLength(1);
    expect(resolucoes[0]).toMatchObject({ kind: 'deny', reason: 'negado pelo usuário' });
    expect(interrupcoes()).toBe(0);
    r.unmount();
    c.dispose();
  });

  it('e (editar) NEGA — editar não é aplicado e nunca executa por inação', async () => {
    const { c, r, resolucoes } = montar('asking', pedido('web_fetch', false));
    await tecla(r, 'e');
    expect(resolucoes[0]).toMatchObject({ kind: 'deny' });
    r.unmount();
    c.dispose();
  });

  it('a aprova uma vez; s aprova pela sessão', async () => {
    const um = montar('asking', pedido('web_fetch', false));
    await tecla(um.r, 'a');
    expect(um.resolucoes).toEqual([{ kind: 'approve-once' }]);
    um.r.unmount();
    um.c.dispose();

    const dois = montar('asking', pedido('web_fetch', false));
    await tecla(dois.r, 's');
    expect(dois.resolucoes).toEqual([{ kind: 'approve-session' }]);
    dois.r.unmount();
    dois.c.dispose();
  });

  it('categoria sempre-ask: `s` e `l` NÃO fazem nada (a decisão cabe a cada ocorrência)', async () => {
    const { c, r, resolucoes } = montar('asking', pedido('web_fetch', true));
    await tecla(r, 's');
    await tecla(r, 'l');
    expect(resolucoes).toEqual([]);
    r.unmount();
    c.dispose();
  });

  it('`l` lembra uma tool que admite; run_command / edit_file / write_file NUNCA', async () => {
    const ok = montar('asking', pedido('web_fetch', false));
    await tecla(ok.r, 'l');
    expect(ok.resolucoes).toEqual([{ kind: 'approve-always' }]);
    ok.r.unmount();
    ok.c.dispose();

    for (const nome of ['run_command', 'edit_file', 'write_file']) {
      const nao = montar('asking', pedido(nome, false));
      await tecla(nao.r, 'l');
      expect(nao.resolucoes, nome).toEqual([]);
      nao.r.unmount();
      nao.c.dispose();
    }
  });

  it('com rascunho no composer as letras viram TEXTO: "aprovar" não aprova; ESC apaga o rascunho', async () => {
    const { c, r, resolucoes, interrupcoes } = montar('asking', pedido('web_fetch', false));
    await tecla(r, 'x'); // começa o rascunho (não é tecla de resposta)
    await tecla(r, 'a');
    await tecla(r, 'n');
    expect(resolucoes).toEqual([]);
    await tecla(r, ESC); // 1º ESC só apaga o rascunho
    expect(interrupcoes()).toBe(0);
    expect(resolucoes).toEqual([]);
    await tecla(r, 'n'); // sem rascunho, volta a responder
    expect(resolucoes).toHaveLength(1);
    r.unmount();
    c.dispose();
  });
});

describe('caixa de pergunta · ESC', () => {
  it('ESC interrompe o turno (não vira "sem resposta" + novo turno)', async () => {
    const { c, r, interrupcoes } = montar('questioning');
    await tecla(r, ESC);
    expect(interrupcoes()).toBe(1);
    r.unmount();
    c.dispose();
  });
});

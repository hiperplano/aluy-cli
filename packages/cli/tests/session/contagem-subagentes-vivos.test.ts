// CONTAGEM-VIVOS — o número de sub-agentes no rodapé tem de bater com a realidade.
//
// Teste do dono, que expôs DOIS furos de uma vez: "disparei 3 agentes e antes que
// terminassem pedi que disparassem mais 3, porém não atualizou o status embaixo de 3 para
// 6; quando terminou os 3 primeiros o status amarelo onde tem a tecla F8 sumiu".
//
// A causa: o número vinha de um contador mantido À MÃO que só sabia dos DESACOPLADOS e só
// era publicado em eventos de desacople. O 2º lote rodou ACOPLADO e nunca entrou na conta;
// depois o 1º lote terminou, o contador foi a zero e o aviso sumiu — com 3 filhos ainda
// trabalhando.
//
// Um número que o dono usa para decidir se aperta F8 não pode ser mantido em paralelo à
// verdade. A árvore de fluxo já sabe quem está vivo; a contagem passou a perguntar a ela.

import { describe, expect, it } from 'vitest';
import { SessionController } from '../../src/session/controller.js';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

function ports(): ToolPorts {
  return {
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
        return { matches: [], truncated: {} };
      },
    },
  };
}

function ctl(): SessionController {
  return new SessionController({
    model: {
      async call(): Promise<ModelCallResult> {
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    } as ModelCaller,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  } as never);
}

/** Acesso ao interno mínimo p/ montar a árvore sem rodar um turno inteiro. */
type Arvore = {
  ensureChild(l: string, k: string): { finish(s: string): void; isTerminal(): boolean };
};
type Interno = { flowTree: Arvore | null; publishDetachedCount(): void };

/** Monta a árvore de fluxo sem rodar um turno inteiro.
 *
 *  A 1ª versão deste arquivo fazia `if (flowTree === null) return` — e num controller
 *  recém-criado a árvore É nula, então os três casos saíam antes de testar coisa alguma e
 *  o arquivo passava com o defeito presente. Escotilha assim é pior que teste ausente:
 *  ela dá a impressão de cobertura. Agora a árvore é criada, e se um dia isso deixar de
 *  funcionar o `expect` abaixo reprova em vez de sair de fininho. */
async function comArvore(c: SessionController): Promise<Arvore> {
  const { FlowTree } = await import('@hiperplano/aluy-cli-core');
  const i = c as unknown as { flowTree: unknown };
  i.flowTree = new FlowTree({ clock: () => Date.now() });
  expect(i.flowTree).not.toBeNull();
  return i.flowTree as Arvore;
}

describe('contagem de sub-agentes vivos no rodapé', () => {
  it('3 + mais 3 ⇒ conta SEIS (o furo: o 2º lote não entrava)', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    for (const n of ['a1', 'a2', 'a3']) arv.ensureChild(n, 'subagent');
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(3);
    for (const n of ['b1', 'b2', 'b3']) arv.ensureChild(n, 'subagent');
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(6);
    c.dispose();
  });

  it('terminando o 1º lote, o aviso PERMANECE com os que sobraram', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const primeiros = ['a1', 'a2', 'a3'].map((n) => arv.ensureChild(n, 'subagent'));
    for (const n of ['b1', 'b2', 'b3']) arv.ensureChild(n, 'subagent');
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(6);
    for (const no of primeiros) no.finish('final');
    i.publishDetachedCount();
    // O FURO era virar `undefined` aqui — o amarelo sumia com 3 ainda trabalhando.
    expect(c.current.detachedSubagents).toBe(3);
    c.dispose();
  });

  it('todos terminados ⇒ o aviso some (não fica pendurado)', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const todos = ['a1', 'a2'].map((n) => arv.ensureChild(n, 'subagent'));
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(2);
    for (const no of todos) no.finish('final');
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBeUndefined();
    c.dispose();
  });
});

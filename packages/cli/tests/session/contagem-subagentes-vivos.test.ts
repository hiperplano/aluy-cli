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

import { describe, expect, it, vi } from 'vitest';
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

  // O sumiço é ATRASADO de propósito (~900ms) desde que o dono relatou tremor: "quando
  // mando mensagens e tem agentes processando, depois que eles terminam a tela fica
  // tremendo". O indicador e a linha do F8 somam ~3 linhas da região viva; a contagem
  // caindo a zero entre dois lotes mudava a ALTURA e o Ink limpava e redesenhava.
  //
  // O invariante deste arquivo é "não fica PENDURADO" — o aviso não pode sobreviver ao
  // último filho. 900ms não é pendurado. O que mudou foi o mecanismo, não o contrato, e
  // por isso o teste passou a cobrir os DOIS lados: segura no instante, e some depois.
  it('todos terminados ⇒ o aviso some (não fica pendurado)', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const todos = ['a1', 'a2'].map((n) => arv.ensureChild(n, 'subagent'));
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(2);

    vi.useFakeTimers();
    try {
      for (const no of todos) no.finish('final');
      i.publishDetachedCount();
      // Anti-tremor: no MESMO tick o aviso continua lá — é o que impede a altura de
      // oscilar quando um lote novo chega logo em seguida.
      expect(c.current.detachedSubagents).toBe(2);
      vi.advanceTimersByTime(1_000);
      // Passada a janela, some de verdade. Sem isto o aviso ficaria pendurado.
      expect(c.current.detachedSubagents).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    c.dispose();
  });

  // O CASO QUE A HISTERESE EXISTE PARA COBRIR — o relato do dono é exatamente este: um
  // lote termina e outro começa em seguida. Sem cancelar a descida pendente, o aviso
  // piscaria (some, volta) e a tela tremeria. Com ela, a altura NUNCA muda.
  it('lote novo dentro da janela cancela a descida — o aviso não pisca', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const lote1 = ['a1', 'a2'].map((n) => arv.ensureChild(n, 'subagent'));
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(2);

    vi.useFakeTimers();
    try {
      for (const no of lote1) no.finish('final');
      i.publishDetachedCount();
      vi.advanceTimersByTime(300); // ainda DENTRO da janela

      const lote2 = ['b1', 'b2', 'b3'].map((n) => arv.ensureChild(n, 'subagent'));
      i.publishDetachedCount();
      expect(c.current.detachedSubagents).toBe(3);

      // O ponto: a descida agendada pelo lote 1 tem de ter sido CANCELADA. Se ela
      // sobreviver, dispara aqui e apaga o aviso com três filhos vivos — o furo original
      // deste arquivo, de volta por outro caminho.
      vi.advanceTimersByTime(2_000);
      expect(c.current.detachedSubagents).toBe(3);

      for (const no of lote2) no.finish('final');
      i.publishDetachedCount();
      vi.advanceTimersByTime(1_000);
      expect(c.current.detachedSubagents).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
    c.dispose();
  });
});

// PROVA DE FIO do rodapé de agentes — a lista tem de chegar ao ESTADO, não só existir.
//
// O componente `<FooterAgents>` tinha teste e passava; o bloco nunca apareceu na tela do
// dono ("eu nao vi ainda os agentes no footer apesar de ter instalado"). A causa estava no
// meio: a lista era montada filtrando `phase === 'running'`, string que NÃO EXISTE neste
// vocabulário — filho vivo nasce em `thinking` e passa por `tool`/`asking`; terminal é
// `done`/`cancelled`/`failed`. A contagem usava `liveChildren()` e acertava; a lista usava
// a string e vinha SEMPRE VAZIA. Nada falhava: um `[]` renderiza como "sem agentes".
//
// Testar o componente prova o desenho. Só o fio prova que há o que desenhar.
describe('FOOTER-AGENTES — a lista chega ao estado junto da contagem', () => {
  it('filhos vivos ⇒ `liveSubagents` com os rótulos, na MESMA hora que a contagem', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    for (const n of ['analista', 'historiador', 'revisor']) arv.ensureChild(n, 'subagent');
    i.publishDetachedCount();

    expect(c.current.detachedSubagents).toBe(3);
    // O PONTO: a lista não pode estar vazia enquanto a contagem diz 3.
    expect(c.current.liveSubagents?.map((a) => a.label).sort()).toEqual([
      'analista',
      'historiador',
      'revisor',
    ]);
    c.dispose();
  });

  // A LISTA é o LOTE, a CONTAGEM é quem está vivo — deixaram de ser o mesmo número de
  // propósito. O rodapé precisa mostrar COMO cada um acabou (no relato do dono, 6 de 8
  // falharam); uma lista só-de-vivos apaga isso justamente quando passa a importar.
  it('filho que termina PERMANECE na lista, com o desfecho — só sai da contagem', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const a = arv.ensureChild('a', 'subagent');
    arv.ensureChild('b', 'subagent');
    i.publishDetachedCount();
    expect(c.current.liveSubagents).toHaveLength(2);

    a.finish('final');
    i.publishDetachedCount();
    expect(c.current.detachedSubagents).toBe(1); // vivos: só o `b`
    // mas os DOIS seguem na lista, e o `a` carrega como terminou.
    const porRotulo = new Map(c.current.liveSubagents?.map((x) => [x.label, x.phase]));
    expect([...porRotulo.keys()].sort()).toEqual(['a', 'b']);
    expect(porRotulo.get('a')).toBe('done');
    c.dispose();
  });

  it('a CONTAGEM é sempre o nº de VIVOS da lista (é assim que as duas não mentem juntas)', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const nos = ['a', 'b', 'c', 'd'].map((n) => arv.ensureChild(n, 'subagent'));
    const terminal = (p: string): boolean => p === 'done' || p === 'failed' || p === 'cancelled';
    for (let k = 0; k < nos.length; k += 1) {
      i.publishDetachedCount();
      const vivosNaLista = (c.current.liveSubagents ?? []).filter((x) => !terminal(x.phase)).length;
      expect(vivosNaLista).toBe(c.current.detachedSubagents ?? 0);
      // e o lote NUNCA encolhe — ninguém some da lista ao terminar.
      expect(c.current.liveSubagents ?? []).toHaveLength(4);
      nos[k]!.finish('final');
    }
    c.dispose();
  });
});

// CONSUMO AO VIVO — relato do dono: "a atualizacao do consumo de tokens na visualizacao dos
// agentes so aparece no fim, pelo menos nao vi atualizando o consumo durante o trabalho do
// agente".
//
// Ele estava certo, e a causa não era o número chegar tarde: o ÚNICO `setUsage` do nó do
// filho vivia no `onChildEnd`. O `ownUsage` já era atualizado a cada débito lá dentro do
// `runChild` — e nunca saía de lá. Então o valor ficava em ZERO a corrida inteira e saltava
// para o total no instante em que o filho acabava.
//
// O que este teste trava é o que ele viu: o número TEM de subir com o filho ainda vivo.
describe('CONSUMO AO VIVO — os tokens do filho sobem durante o trabalho', () => {
  it('o nó acumula ANTES de terminar, e o rodapé enxerga', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const filho = arv.ensureChild('pesquisador', 'subagent');

    i.publishDetachedCount();
    expect(c.current.liveSubagents?.[0]?.tokens).toBe(0);

    // Débito do meio da corrida (é o que o `onChildProgress` passa a reportar).
    filho.setUsage({ tokens: 1200, toolCalls: 1, iterations: 1 });
    i.publishDetachedCount();
    expect(c.current.liveSubagents?.[0]?.tokens).toBe(1200);
    // e ele CONTINUA VIVO — é esse o ponto: não é o número do fim.
    expect(c.current.detachedSubagents).toBe(1);

    // Segundo débito: sobe de novo.
    filho.setUsage({ tokens: 5400, toolCalls: 3, iterations: 2 });
    i.publishDetachedCount();
    expect(c.current.liveSubagents?.[0]?.tokens).toBe(5400);
    expect(c.current.detachedSubagents).toBe(1);

    c.dispose();
  });

  it('cada filho tem o SEU número (um não contamina o outro)', async () => {
    const c = ctl();
    const arv = await comArvore(c);
    const i = c as unknown as Interno;
    const a = arv.ensureChild('a', 'subagent');
    const b = arv.ensureChild('b', 'subagent');
    a.setUsage({ tokens: 900, toolCalls: 0, iterations: 1 });
    b.setUsage({ tokens: 30, toolCalls: 0, iterations: 1 });
    i.publishDetachedCount();
    const porRotulo = new Map(c.current.liveSubagents?.map((x) => [x.label, x.tokens]));
    expect(porRotulo.get('a')).toBe(900);
    expect(porRotulo.get('b')).toBe(30);
    c.dispose();
  });
});


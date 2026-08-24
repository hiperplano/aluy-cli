// INJECAO-ORFA — o que o dono encaixa durante um ciclo não pode ficar preso para sempre.
//
// Relato dele, com print: "quando tá com o ciclo ativado e eu coloco alguma coisa ele não
// processa, fica (encaixando)". Na tela, DEPOIS do ciclo parar, sobrava:
//
//     ◕ /cycle  parado por você — limpo, sem efeito a meio.
//     ↳ 1 encaixando… · incorporada(s) na próxima iteração
//       › oi
//
// O IMPASSE era estrutural, não um esquecimento isolado:
//   · durante o ciclo o `submit` é RECUSADO (guarda anti gasto-dobrado, EST-0981);
//   · então texto puro só tem um caminho: ENCAIXAR na fila VIVA, para a próxima iteração;
//   · o ciclo termina ⇒ NÃO existe próxima iteração ⇒ ninguém drena a fila viva.
// A mensagem ficava visível e inerte — o pior dos dois mundos: ocupa a tela dizendo que
// vai ser processada, e não é.
//
// A peça que resolve (`drainLiveInjectsToPending`) já existia — só o pump do fan-out a
// chamava. É o mesmo padrão que apareceu várias vezes nesta base: função pronta, ligada
// num lugar só.

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

function ctl(portao?: Promise<void>): SessionController {
  return new SessionController({
    model: {
      async call(): Promise<ModelCallResult> {
        // O turno precisa estar VIVO no instante da injeção — senão ela cai direto na
        // fila pendente e o teste passa sem exercitar o ramo do defeito (foi assim que a
        // 1ª versão deste caso ficou vazia). O portão segura a chamada até o teste injetar.
        if (portao) await portao;
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
      },
    } as ModelCaller,
    permission: new PolicyPermissionEngine(),
    ports: ports(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/p', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
    flush: { intervalMs: 0 },
  } as never);
}

type Interno = {
  liveInjected: readonly unknown[];
  pendingInjected: readonly unknown[];
  drainLiveInjectsToPending(): void;
};

describe('injeção feita durante um ciclo não fica órfã', () => {
  it('fila VIVA com o ciclo encerrado ⇒ move p/ a PENDENTE (o próximo submit a consome)', () => {
    const c = ctl();
    const i = c as unknown as Interno;
    c.injectInput('root', 'oi');
    // Sem turno vivo, a injeção já cai na pendente; forçamos o caso órfão (fila viva com
    // o ciclo terminando) para exercitar exatamente o ramo do defeito.
    (i as { liveInjected: unknown[] }).liveInjected = [{ role: 'user_inject', content: 'oi' }];
    expect(i.liveInjected).toHaveLength(1);

    i.drainLiveInjectsToPending();

    // O QUE O DEFEITO FAZIA: a viva continuava cheia e ninguém a drenava nunca mais.
    expect(i.liveInjected).toHaveLength(0);
    expect(i.pendingInjected.length).toBeGreaterThan(0);
    c.dispose();
  });

  // LIMITE DESTE ARQUIVO, dito às claras: ele cobre a FUNÇÃO e o caso do TURNO NORMAL —
  // e o turno normal já drenava sozinho (o `pollInjected` da iteração seguinte consome).
  // A drenagem que EU liguei no fim do turno é redundância defensiva; a que importa é a
  // do fim do CICLO, que é onde o dono viu a mensagem ficar presa.
  //
  // NÃO CONSEGUI escrever um teste que reprove sem ela: montar um `/cycle` real com o
  // juiz, o budget agregado e o CycleEngine dentro de um teste unitário passou do que
  // consegui fazer em tempo razoável, e três tentativas minhas passaram COM o defeito
  // presente (só descobri porque a mutação não reprovou). Então: a correção é raciocinada
  // do código e do print do dono, e VERIFICADA POR ELE em uso — não por mutação. Quem
  // mexer aqui depois merece saber disso em vez de confiar num verde que não prova.
  it('turno que TERMINA com injeção na fila viva ⇒ ela NÃO fica órfã', async () => {
    let liberar!: () => void;
    const portao = new Promise<void>((r) => {
      liberar = r;
    });
    const c = ctl(portao);
    const i = c as unknown as Interno;
    const turno = c.submit('faça algo');
    // Espera o turno ficar VIVO de verdade antes de injetar.
    for (
      let k = 0;
      k < 200 && c.current.phase !== 'thinking' && c.current.phase !== 'streaming';
      k++
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }
    c.injectInput('root', 'oi');
    expect(i.liveInjected.length).toBeGreaterThan(0); // provou que caiu na fila VIVA
    liberar();
    await turno;
    // ANTES: a fila viva seguia com a mensagem e ninguém a drenava — "↳ 1 encaixando…"
    // pendurado na tela para sempre, com o turno já encerrado.
    expect(i.liveInjected).toHaveLength(0);
    c.dispose();
  }, 20000);

  it('fila vazia ⇒ no-op (não inventa mensagem nem mexe na pendente)', () => {
    const c = ctl();
    const i = c as unknown as Interno;
    const antes = i.pendingInjected.length;
    i.drainLiveInjectsToPending();
    expect(i.pendingInjected).toHaveLength(antes);
    c.dispose();
  });
});

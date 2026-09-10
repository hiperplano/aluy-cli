// O PUMP não pode morrer calado — e, se morrer de vez, tem de AVISAR.
//
// O relato (dono, 01/09): "mandei uma msg, ele não viu; mandei outra, apareceu e
// respondeu; mandei uma terceira e quarta e nada". A medição fechou o caso: o processo da
// sessão segurava ZERO conexões TCP — nenhum long-poll no ar — enquanto a tela dizia
// "ponte ATIVA (1 chat autorizado)". O status olhava só se o OBJETO da ponte existia.
//
// A causa estrutural: o pump era um `for await` único dentro de um `try`. Qualquer erro —
// ou o simples FIM do iterador — caía no `catch`, escrevia UMA linha no stderr (que a TUI
// engole) e RETORNAVA. Sem reinício, sem sinal. Um long-poll cai por motivo banal e
// transitório (rede oscilou, 409 porque outro cliente pediu `getUpdates`), e morrer de vez
// por causa disso é desproporcional.
//
// O que estes testes travam: (1) cai ⇒ reergue com connector NOVO; (2) mensagem boa zera o
// recuo; (3) falha PERMANENTE não fica escondida atrás de reconexão infinita — estoura o
// teto e AVISA; (4) abortar encerra de verdade.

import { describe, expect, it, vi } from 'vitest';
import { TelegramBridge } from '../../src/connector/telegram-bridge.js';
import type { IngressSink } from '../../src/connector/telegram-bridge.js';

const META_OK = { id: 'telegram', nome: 'Telegram' };

function sinkFalso(): IngressSink {
  return { injectInstruction: vi.fn(), injectData: vi.fn() };
}

/**
 * Connector dublê. `roteiro[i]` descreve a i-ésima criação: lista de textos a emitir e se
 * termina LANÇANDO ou apenas acabando (os dois eram fatais antes).
 */
function fabricaDe(
  roteiro: readonly { readonly textos: readonly string[]; readonly lanca?: boolean }[],
  contador: { criadas: number },
) {
  return () => {
    const idx = contador.criadas;
    contador.criadas += 1;
    const passo = roteiro[Math.min(idx, roteiro.length - 1)] ?? { textos: [] };
    return {
      meta: META_OK,
      async *incoming() {
        for (const t of passo.textos) {
          yield {
            content: t,
            sender: '42',
            conversation: '42',
            provenance: { kind: 'author-direct' as const },
          };
        }
        if (passo.lanca === true) throw new Error('conexao caiu');
      },
      async send() {
        return true;
      },
    } as never;
  };
}

function ponte(
  roteiro: readonly { readonly textos: readonly string[]; readonly lanca?: boolean }[],
  extra: Record<string, unknown> = {},
) {
  const contador = { criadas: 0 };
  const sink = sinkFalso();
  const b = new TelegramBridge({
    connectorFactory: fabricaDe(roteiro, contador),
    allowlist: new Set(['42']),
    sink,
    redactor: { safeForLog: (t: string) => t },
    recuoMs: () => 0, // sem espera real: provar o reinício não pode custar segundos
    log: () => {},
    ...extra,
  } as never);
  return { b, sink, contador };
}

describe('pump — cai e REERGUE', () => {
  it('iterador que LANÇA ⇒ connector NOVO (o antigo já foi consumido)', async () => {
    const { b, contador } = ponte([{ textos: ['um'], lanca: true }, { textos: ['dois'] }]);
    const p = b.pump();
    // deixa algumas voltas do laço acontecerem, depois encerra
    await new Promise((r) => setTimeout(r, 30));
    b.stop();
    await p;
    expect(contador.criadas, 'tem de ter recriado o connector').toBeGreaterThan(1);
  });

  it('iterador que TERMINA sozinho encerra AVISANDO — não reergue, mas não cala', async () => {
    // Este caso mudou de ideia no meio, e os testes deste repo é que estavam certos: a
    // 1ª versão do conserto REERGUIA também no fim limpo, e isso fez 4 testes existentes
    // (dublês FINITOS) pendurarem 135s cada. O connector REAL só sai do laço em ABORT, ou
    // seja, "terminou sem erro e sem abort" não acontece em produção — reerguer ali era
    // exagero meu. O que NÃO pode voltar é o silêncio: encerrar aqui tem de AVISAR.
    const aoParar = vi.fn();
    const { b, contador } = ponte([{ textos: ['um'] }], { aoParar });
    await b.pump(); // resolve sozinho: não pendura
    expect(contador.criadas, 'não recria no fim limpo').toBe(1);
    expect(aoParar, 'o fim limpo TEM de ser anunciado').toHaveBeenCalledTimes(1);
    expect(String(aoParar.mock.calls[0]?.[0])).toContain('terminou sozinho');
    expect(b.diagnostico.polling).toBe(false);
  });

  it('as mensagens ANTES da queda são roteadas (nada se perde no caminho)', async () => {
    const { b, sink } = ponte([{ textos: ['ola'], lanca: true }, { textos: [] }]);
    const p = b.pump();
    await new Promise((r) => setTimeout(r, 30));
    b.stop();
    await p;
    expect(sink.injectInstruction).toHaveBeenCalledWith('ola');
  });
});

describe('pump — falha PERMANENTE não fica escondida', () => {
  it('estourado o teto, DESISTE e avisa pelo gancho `aoParar`', async () => {
    const aoParar = vi.fn();
    // Todo connector morre na hora: nada zera o contador ⇒ o teto é alcançado.
    const { b } = ponte([{ textos: [], lanca: true }], { aoParar });
    await b.pump(); // resolve sozinho ao desistir — sem stop()
    expect(aoParar, 'a morte da ponte TEM de ser anunciada').toHaveBeenCalledTimes(1);
    expect(String(aoParar.mock.calls[0]?.[0])).toContain('caiu');
  });

  it('ao desistir, o diagnóstico conta a verdade (polling=false, reinícios>0)', async () => {
    const { b } = ponte([{ textos: [], lanca: true }], { aoParar: () => {} });
    await b.pump();
    const d = b.diagnostico;
    expect(d.polling, 'não pode dizer que está polizando').toBe(false);
    expect(d.reinicios).toBeGreaterThan(0);
    expect(d.ultimaQueda).toBeDefined();
  });

  it('uma mensagem BOA zera o recuo — ponte saudável nunca chega ao teto', async () => {
    const aoParar = vi.fn();
    // Alterna: cai, entrega, cai, entrega… o contador nunca acumula até o teto.
    const roteiro = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0 ? { textos: ['ok'], lanca: true } : { textos: ['ok'], lanca: true },
    );
    const { b } = ponte(roteiro, { aoParar });
    const p = b.pump();
    await new Promise((r) => setTimeout(r, 60));
    b.stop();
    await p;
    expect(
      aoParar,
      'entregou mensagem a cada volta ⇒ não é falha permanente',
    ).not.toHaveBeenCalled();
  });
});

describe('pump — o abort continua encerrando de verdade', () => {
  it('stop() antes de começar ⇒ nem entra no laço', async () => {
    const { b, contador } = ponte([{ textos: ['x'] }]);
    b.stop();
    await b.pump();
    expect(contador.criadas, 'não recria connector depois de abortado').toBe(1);
    expect(b.diagnostico.polling).toBe(false);
  });

  it('stop() no meio encerra e o diagnóstico para de dizer que poliza', async () => {
    const { b } = ponte([{ textos: [], lanca: true }]);
    const p = b.pump();
    await new Promise((r) => setTimeout(r, 10));
    b.stop();
    await p;
    expect(b.diagnostico.polling).toBe(false);
  });
});

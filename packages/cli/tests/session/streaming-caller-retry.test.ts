// F-RETRY — o LAÇO concreto no `StreamingModelCaller` (a política pura vive no core e
// tem teste próprio; aqui provamos a costura).
//
// Provas:
//  1. falha TRANSITÓRIA ⇒ re-tenta e ENTREGA o resultado da tentativa seguinte;
//  2. a `Idempotency-Key` é a MESMA em todas as tentativas (é p/ isso que ela existe —
//     o broker deduplica o billing de um retry de transporte);
//  3. o provider NEGANDO (401) NÃO é re-tentado (determinístico + custa dinheiro);
//  4. `onRetry` alimenta o contador `n/N` da UI;
//  5. o teto para (não vira loop infinito);
//  6. Ctrl-C durante a ESPERA aborta na hora (não prende até o fim do timer).

import { describe, expect, it } from 'vitest';
import { StreamingModelCaller } from '../../src/session/streaming-caller.js';
import {
  BrokerError,
  BrokerTransportError,
  ModelCallAbortedError,
  type ModelClient,
} from '@hiperplano/aluy-cli-core';

const sink = { onDelta: () => {} };

/** Client roteirizado: cada item é um erro a lançar OU um texto a devolver. */
function client(script: readonly (Error | string)[]): ModelClient & { calls: string[] } {
  let i = 0;
  const calls: string[] = [];
  return {
    calls,
    async *stream(args: { idempotencyKey?: string }): AsyncGenerator<never> {
      calls.push(args.idempotencyKey ?? '(sem key)');
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      if (step instanceof Error) throw step;
      // sucesso: um delta e o done
      yield { type: 'delta', content: step } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as ModelClient & { calls: string[] };
}

function caller(
  script: readonly (Error | string)[],
  opts: { attempts?: number; onRetry?: (n: unknown) => void } = {},
): { c: StreamingModelCaller; cli: ModelClient & { calls: string[] } } {
  const cli = client(script);
  const c = new StreamingModelCaller({
    client: cli,
    tier: 'aluy-flux' as never,
    sink,
    // espera CURTA: o teste prova a MECÂNICA, não a duração (5s real travaria a suíte).
    retry: { attempts: opts.attempts ?? 3, waitMs: 5 },
    ...(opts.onRetry ? { onRetry: opts.onRetry as never } : {}),
  });
  return { c, cli };
}

describe('F-RETRY · laço de retentativa no StreamingModelCaller', () => {
  it('falha TRANSITÓRIA ⇒ re-tenta e entrega o resultado seguinte', async () => {
    const { c, cli } = caller([new BrokerTransportError('conexão recusada'), 'deu certo']);
    const res = await c.call({ messages: [], idempotencyKey: 'k1' });
    expect(res.content).toContain('deu certo');
    expect(cli.calls.length).toBe(2); // 1 falha + 1 sucesso
  });

  it('a Idempotency-Key é a MESMA em todas as tentativas (dedup de billing)', async () => {
    const { c, cli } = caller([new BrokerTransportError('x'), new BrokerTransportError('y'), 'ok']);
    await c.call({ messages: [], idempotencyKey: 'MESMA-KEY' });
    expect(cli.calls).toEqual(['MESMA-KEY', 'MESMA-KEY', 'MESMA-KEY']);
  });

  it('provider NEGANDO (401) ⇒ NÃO re-tenta (determinístico; retentar queima saldo)', async () => {
    const negou = new BrokerError({ status: 401, code: 'UNAUTHENTICATED', title: 'x' } as never);
    const { c, cli } = caller([negou, 'nunca chega aqui']);
    await expect(c.call({ messages: [], idempotencyKey: 'k' })).rejects.toThrow();
    expect(cli.calls.length).toBe(1); // UMA só chamada
  });

  it('`onRetry` alimenta o contador n/N da UI', async () => {
    const seen: { attempt: number; max: number; reason: string }[] = [];
    const { c } = caller([new BrokerTransportError('x'), new BrokerTransportError('y'), 'ok'], {
      attempts: 5,
      onRetry: (n) => seen.push(n as never),
    });
    await c.call({ messages: [], idempotencyKey: 'k' });
    expect(seen.map((s) => s.attempt)).toEqual([1, 2]);
    expect(seen[0]?.max).toBe(5);
    expect(seen[0]?.reason).toContain('rede');
  });

  it('o TETO para (não vira loop infinito)', async () => {
    const { c, cli } = caller([new BrokerTransportError('sempre falha')], { attempts: 3 });
    await expect(c.call({ messages: [], idempotencyKey: 'k' })).rejects.toThrow();
    expect(cli.calls.length).toBe(3); // 3 tentativas e desiste
  });

  it('Ctrl-C durante a ESPERA aborta na hora (não prende até o fim do timer)', async () => {
    const cli = client([new BrokerTransportError('x'), 'ok']);
    const c = new StreamingModelCaller({
      client: cli,
      tier: 'aluy-flux' as never,
      sink,
      retry: { attempts: 5, waitMs: 30_000 }, // espera LONGA de propósito
    });
    const ac = new AbortController();
    const p = c.call({ messages: [], idempotencyKey: 'k', signal: ac.signal });
    // deixa a 1ª tentativa falhar e entrar na espera, então cancela
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(ModelCallAbortedError);
    expect(cli.calls.length).toBe(1); // não chegou a re-tentar
  });
});

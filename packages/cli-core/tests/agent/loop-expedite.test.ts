// F191 — EXPEDITE ("acelerar o encaixe" / SOFT-INTERRUPT) no LOOP.
//
// Contraparte do "btw" (`pollInjected`): o dono já tem uma mensagem ESPERANDO encaixe
// e aperta ESC. O expedite deve CORTAR a chamada de modelo EM VOO da iteração corrente
// e fazer o loop SEGUIR (drenar o `user_inject` na volta seguinte, re-planejar), SEM
// parar a sessão. É DISTINTO do hard-abort (`signal`), que é o freio total.
//
// PROVAS (sem modelo real — caller controlado que respeita o signal):
//  1. o expedite disparado DURANTE a 1ª chamada de modelo: (a) a chamada foi CORTADA,
//     (b) o loop CONTINUOU (houve 2ª chamada), (c) o inject drenou na iteração seguinte
//     e a 2ª chamada o viu, (d) NÃO foi tratado como stop (o turno terminou `final`);
//  2. regressão — hard-abort (signal.abort()) ainda PARA o loop (rejeita com
//     ModelCallAbortedError), NÃO vira expedite;
//  3. sem porta `expedite` ⇒ baseline (o loop roda idêntico; `fire()` num sino não
//     ligado ao loop é inócuo);
//  4. emite o sinal de progresso `expedite` (gancho da UX p/ descartar o parcial).

import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  ExpediteSignal,
  type InjectedInputPort,
  type ModelCaller,
  type ModelCallResult,
  type ProgressSignal,
} from '../../src/agent/loop.js';
import { ModelCallAbortedError } from '../../src/model/errors.js';
import { injectedInputItem } from '../../src/agent/input-injection.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { HistoryItem } from '../../src/agent/context.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { allowAllEngine, makePorts } from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function finalResult(text: string): ModelCallResult {
  return {
    request_id: 'req-test',
    content: text,
    finish_reason: 'stop',
    usage: { request_id: 'req-test', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
  };
}

/** Uma promessa que só REJEITA quando o `signal` abortar (simula uma geração longa). */
function abortableForever(signal: AbortSignal | undefined): Promise<ModelCallResult> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelCallAbortedError());
      return;
    }
    signal?.addEventListener('abort', () => reject(new ModelCallAbortedError()), { once: true });
  });
}

/** Fila de injeção MUTÁVEL: começa VAZIA (nada esperando) e recebe o item quando o
 *  teste simula "o dono digitou durante o turno". Registra em QUE poll drenou. */
function mutableQueue(): {
  port: InjectedInputPort;
  push: (item: HistoryItem) => void;
  drainedAtPoll: number[];
} {
  let pending: HistoryItem[] = [];
  const drainedAtPoll: number[] = [];
  let polls = 0;
  return {
    drainedAtPoll,
    push: (item) => pending.push(item),
    port: () => {
      polls += 1;
      if (pending.length === 0) return [];
      drainedAtPoll.push(polls);
      const out = pending;
      pending = [];
      return out;
    },
  };
}

describe('F191 — EXPEDITE (soft-interrupt) no loop', () => {
  it('expedite DURANTE a chamada de modelo: corta o parcial, CONTINUA e drena o inject na volta seguinte', async () => {
    const { ports } = makePorts();
    const expedite = new ExpediteSignal();
    const q = mutableQueue();
    const call0Started = defer();
    const capturedUser: Array<string | undefined> = [];
    let call0Aborted = false;

    let n = 0;
    const model: ModelCaller = {
      async call(args) {
        const lastUser = [...args.messages].reverse().find((m) => m.role === 'user');
        capturedUser.push(lastUser?.content);
        const k = n;
        n += 1;
        if (k === 0) {
          // 1ª chamada: geração LONGA (bloqueia até o expedite cortar).
          call0Started.resolve();
          try {
            return await abortableForever(args.signal);
          } catch (e) {
            call0Aborted = true;
            throw e;
          }
        }
        // 2ª chamada: já com o inject no contexto ⇒ responde final.
        return finalResult('foco ajustado para X — pronto.');
      },
    };

    const progress: ProgressSignal[] = [];
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-expedite',
      pollInjected: q.port,
      expedite,
      onProgress: (s) => progress.push(s),
    });

    const runP = loop.run('faça a tarefa');
    // 1ª chamada de modelo EM VOO ⇒ o loop já está subscrito no sino de expedite.
    await call0Started.promise;
    // O dono digitou algo DURANTE o turno (inject esperando) e apertou ESC (expedite).
    const item = injectedInputItem('na verdade foca em X agora');
    expect(item).toBeDefined();
    q.push(item!);
    expedite.fire();

    const res = await runP;

    // (d) NÃO foi tratado como stop/abort — o turno terminou `final` (o loop seguiu).
    expect(res.stop.kind).toBe('final');
    // (a) a 1ª chamada foi CORTADA em voo.
    expect(call0Aborted).toBe(true);
    // (b) o loop CONTINUOU: houve uma 2ª chamada de modelo.
    expect(n).toBe(2);
    // (c) o inject drenou na iteração SEGUINTE (poll #2) e a 2ª chamada já o viu.
    expect(q.drainedAtPoll).toContain(2);
    expect(capturedUser[1]).toContain('foca em X agora');
    // A 1ª chamada NÃO tinha o inject (o dono só digitou depois que ela começou).
    expect(capturedUser[0] ?? '').not.toContain('foca em X agora');
    // UX: emitiu o sinal `expedite` (gancho p/ a TUI descartar o parcial).
    expect(progress.some((s) => s.kind === 'expedite')).toBe(true);
  });

  it('REGRESSÃO — hard-abort (signal.abort) ainda PARA o loop, NÃO vira expedite', async () => {
    const { ports } = makePorts();
    const expedite = new ExpediteSignal();
    const q = mutableQueue();
    const call0Started = defer();

    let n = 0;
    const model: ModelCaller = {
      async call(args) {
        const k = n;
        n += 1;
        if (k === 0) {
          call0Started.resolve();
          return abortableForever(args.signal); // rejeita quando o signal abortar
        }
        return finalResult('não deveria chegar aqui');
      },
    };

    const ctrl = new AbortController();
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-hardabort',
      pollInjected: q.port,
      expedite,
    });

    const runP = loop.run('faça a tarefa', ctrl.signal);
    await call0Started.promise;
    // Havia até um inject esperando — mas o HARD-abort tem precedência: PARA o loop.
    q.push(injectedInputItem('isto NÃO deve ser encaixado')!);
    ctrl.abort();

    // O hard-abort SOBE (rejeita) — o loop NÃO continua nem trata como expedite.
    await expect(runP).rejects.toBeInstanceOf(ModelCallAbortedError);
    // Só a 1ª chamada rodou; não houve 2ª (o loop parou, não re-planejou).
    expect(n).toBe(1);
  });

  it('SEM porta `expedite` ⇒ baseline: um `fire()` num sino não ligado é inócuo', async () => {
    const { ports } = makePorts();
    const orphan = new ExpediteSignal(); // NÃO passado ao loop
    let n = 0;
    const model: ModelCaller = {
      async call() {
        n += 1;
        return finalResult('pronto.');
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      sessionId: 'sess-baseline',
    });
    // Disparar o sino órfão não afeta nada (o loop não o ouve).
    orphan.fire();
    const res = await loop.run('tarefa');
    expect(res.stop.kind).toBe('final');
    expect(n).toBe(1);
  });
});

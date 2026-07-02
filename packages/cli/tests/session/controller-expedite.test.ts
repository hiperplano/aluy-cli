// F191 — `controller.expedite()` ("acelerar o encaixe" / soft-interrupt).
//
// O dono aperta ESC com uma mensagem JÁ ESPERANDO encaixe (`pendingInjects`). O
// controller expõe `expedite()`, que toca o "sino" passado ao loop — cortando a
// chamada de modelo EM VOO e fazendo o loop SEGUIR (drenar o `user_inject` na volta
// seguinte), SEM parar o turno. DISTINTO de `interrupt()` (freio total).
//
// PROVAS (ModelCaller MOCK — sem rede):
//  1. com uma chamada de modelo EM VOO e um inject pendente, `expedite()` corta a
//     chamada, o loop continua, a 2ª chamada VÊ o inject e o turno conclui normal
//     (não parado);
//  2. `expedite()` SEM chamada em voo é NO-OP (não lança; o próximo turno roda normal).

import { describe, expect, it } from 'vitest';
import {
  ModelCallAbortedError,
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

const meta = { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 };

function buildController(model: ModelCaller): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    flush: { intervalMs: 0 },
  });
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
    request_id: 'r',
    content: text,
    finish_reason: 'stop',
    usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
  };
}

function abortableForever(signal: AbortSignal | undefined): Promise<ModelCallResult> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new ModelCallAbortedError());
      return;
    }
    signal?.addEventListener('abort', () => reject(new ModelCallAbortedError()), { once: true });
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('F191 — controller.expedite() acelera o encaixe (soft-interrupt)', () => {
  it('corta a chamada de modelo em voo e drena o inject na volta seguinte — SEM parar o turno', async () => {
    const call0Started = defer();
    const capturedUser: string[] = [];
    let call0Aborted = false;
    let n = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const lastUser = [...args.messages].reverse().find((m) => m.role === 'user');
        capturedUser.push(lastUser?.content ?? '');
        const k = n;
        n += 1;
        if (k === 0) {
          call0Started.resolve();
          try {
            return await abortableForever(args.signal);
          } catch (e) {
            call0Aborted = true;
            throw e;
          }
        }
        return finalResult('foco ajustado para X — pronto.');
      },
    };
    const controller = buildController(model);

    const done = controller.submit('objetivo inicial');
    // 1ª chamada de modelo EM VOO (o loop já está subscrito no sino).
    await call0Started.promise;

    // O dono digitou algo DURANTE o turno vivo ⇒ vai p/ a fila viva (pendingInjects > 0).
    const accepted = controller.injectInput('root', 'na verdade foca em X agora');
    expect(accepted).toBe(true);
    await waitFor(() => controller.current.pendingInjects.length > 0);

    // ESC-com-inject-pendente ⇒ expedite: corta a chamada em voo e SEGUE.
    controller.expedite();

    await done;

    // A 1ª chamada foi CORTADA; houve uma 2ª (o loop continuou) que VIU o inject.
    expect(call0Aborted).toBe(true);
    expect(n).toBe(2);
    expect(capturedUser[1]).toContain('foca em X agora');
    // O turno terminou normalmente (não foi parado/interrompido).
    expect(['idle', 'done']).toContain(controller.current.phase);
    // O inject não sobrou pendente (foi encaixado).
    expect(controller.current.pendingInjects.length).toBe(0);
  });

  it('NO-OP sem chamada de modelo em voo: não lança e não afeta o próximo turno', async () => {
    let n = 0;
    const model: ModelCaller = {
      async call(): Promise<ModelCallResult> {
        n += 1;
        return finalResult('pronto.');
      },
    };
    const controller = buildController(model);

    // Nenhum turno vivo ⇒ nenhum ouvinte no sino ⇒ no-op (não lança).
    expect(() => controller.expedite()).not.toThrow();

    // O próximo turno roda IDÊNTICO ao baseline (o no-op não deixou resíduo).
    await controller.submit('tarefa');
    expect(n).toBe(1);
    expect(['idle', 'done']).toContain(controller.current.phase);
  });
});

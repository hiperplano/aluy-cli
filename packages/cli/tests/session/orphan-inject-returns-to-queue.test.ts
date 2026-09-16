// ENCAIXE ÓRFÃO — a mensagem mandada no fim do turno não pode exigir reenvio.
//
// Relato do dono (16/09): "quando está rodando alguns agentes ou processando algo e eu dou
// um esc, ele para tudo e aí eu mando uma nova msg, ele não processa essa msg, só processa
// quando eu repito e envio de novo". Reproduzido no tmux com o provider real: ESC no ask do
// `spawn_agent` (⇒ negado), o modelo segue escrevendo a resposta final, o dono manda
// "PING-1" — some da tela; ao mandar "PING-2", o modelo responde "PING-1 PING-2".
//
// A causa: com o turno VIVO o texto ENCAIXA na fila viva, que o loop só drena ENTRE
// iterações. Se a iteração corrente já é a resposta final, não existe próxima — o fim do
// turno movia a mensagem p/ `pendingInjected` e ela só entrava de carona no PRÓXIMO submit,
// que nada disparava.
//
// Contrato: o encaixe do COMPOSER (marcado com `markLastInjectFromComposer`) que o turno
// não consumiu é DEVOLVIDO à fila da TUI (`orphanInjects` sobe; `takeOrphanInjects()` entrega
// os textos). O controller
// NÃO abre turno sozinho — a fila da TUI é o único ponto que faz isso, com os freios dela.
// Fora do contrato (comportamento de antes): encaixe de outras origens (Telegram) e o que
// estava pendente numa parada explícita (interrupt / F8).

import { describe, expect, it } from 'vitest';
import {
  ModelCallAbortedError,
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (name: string, input: Record<string, unknown>): string =>
  `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;

function ports(): ToolPorts {
  return {
    fs: {
      async readFile() {
        return 'x';
      },
      async writeFile() {},
      async exists() {
        return true;
      },
    },
    shell: {
      async exec() {
        return { stdout: 'ok', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return { matches: [], truncated: {} };
      },
    },
  };
}

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };
const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

function result(content: string): ModelCallResult {
  return {
    request_id: 'r',
    content,
    finish_reason: 'stop',
    usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
  };
}

const settle = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Script = (n: number, c: SessionController, signal?: AbortSignal) => string | Promise<string>;

/** Controller com modelo roteirizado; `usuarios[n]` = falas `user` que a chamada n viu. */
function build(script: Script): { controller: SessionController; userTurns: string[][] } {
  const userTurns: string[][] = [];
  let ref: SessionController | null = null;
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      userTurns.push(args.messages.filter((m) => m.role === 'user').map((m) => m.content));
      return result(await script(userTurns.length - 1, ref!, args.signal));
    },
  };
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: ports(),
    askResolver: approveAll,
    meta,
  });
  ref = controller;
  return { controller, userTurns };
}

/** Encaixe como a TUI faz: `injectInput` + a marca de "veio do composer". */
function injectFromComposer(c: SessionController, texto: string): void {
  c.injectInput('root', texto);
  c.markLastInjectFromComposer();
}

describe('encaixe órfão do composer volta para a fila da TUI', () => {
  it('mensagem que chega durante a resposta FINAL é devolvida — sem reenvio, sem turno por fora', async () => {
    const { controller, userTurns } = build((n, c) => {
      if (n === 0) injectFromComposer(c, 'PING-1');
      return 'resposta final.';
    });

    await controller.submit('tarefa');
    await settle();

    // O controller avisou e NÃO abriu turno por conta própria.
    expect(controller.current.orphanInjects).toBeGreaterThan(0);
    expect(userTurns).toHaveLength(1);
    // A TUI busca o texto — que sai da fila pendente.
    expect(controller.takeOrphanInjects()).toEqual(['PING-1']);
    expect(controller.takeOrphanInjects()).toEqual([]);
    expect(controller.current.pendingInjects).toHaveLength(0);

    // Enviado pela fila (como fala do dono), o modelo vê o PING-1 UMA vez, sem carona dupla.
    await controller.submit('PING-1');
    const speechText = userTurns[1]!.join('\n');
    expect(speechText.match(/PING-1/g)).toHaveLength(1);
    controller.dispose();
  });

  it('várias órfãs voltam na ordem em que foram mandadas', async () => {
    const { controller } = build((n, c) => {
      if (n === 0) {
        injectFromComposer(c, 'primeira');
        injectFromComposer(c, 'segunda');
      }
      return 'ok.';
    });
    await controller.submit('tarefa');
    expect(controller.takeOrphanInjects()).toEqual(['primeira', 'segunda']);
    controller.dispose();
  });

  it('encaixe que o loop CONSUMIU não volta (não duplica)', async () => {
    const { controller, userTurns } = build((n, c) => {
      if (n === 0) {
        injectFromComposer(c, 'btw consumido');
        return toolCall('read_file', { path: 'a' }); // há próxima iteração ⇒ o loop drena
      }
      return 'pronto.';
    });
    await controller.submit('tarefa');
    expect(userTurns[1]!.join('\n')).toContain('btw consumido');
    expect(controller.current.orphanInjects).toBeUndefined();
    expect(controller.takeOrphanInjects()).toEqual([]);
    controller.dispose();
  });

  it('encaixe SEM a marca (Telegram etc.) segue como antes: fica p/ o próximo submit', async () => {
    const { controller, userTurns } = build((n, c) => {
      if (n === 0) c.injectInput('root', 'veio de fora');
      return 'ok.';
    });
    await controller.submit('tarefa');
    expect(controller.current.orphanInjects).toBeUndefined();
    expect(controller.takeOrphanInjects()).toEqual([]);
    await controller.submit('segunda');
    expect(userTurns[1]!.join('\n')).toContain('veio de fora');
    controller.dispose();
  });

  it('parada explícita (interrupt) não devolve o que estava pendente — parar é parar', async () => {
    const { controller, userTurns } = build((n, c, signal) => {
      if (n === 0) {
        injectFromComposer(c, 'pendente no stop');
        c.interrupt();
        if (signal?.aborted) throw new ModelCallAbortedError();
      }
      return 'ok.';
    });
    await controller.submit('tarefa');
    await settle();
    expect(controller.current.phase).toBe('idle');
    expect(controller.current.orphanInjects).toBeUndefined();
    expect(controller.takeOrphanInjects()).toEqual([]);
    expect(userTurns).toHaveLength(1);
    controller.dispose();
  });

  it('F8 (cancelAllFlows) também não devolve', async () => {
    const { controller } = build((n, c, signal) => {
      if (n === 0) {
        injectFromComposer(c, 'pendente no F8');
        c.cancelAllFlows();
        if (signal?.aborted) throw new ModelCallAbortedError();
      }
      return 'ok.';
    });
    await controller.submit('tarefa');
    await settle();
    expect(controller.current.orphanInjects).toBeUndefined();
    expect(controller.takeOrphanInjects()).toEqual([]);
    controller.dispose();
  });

  it('turno que termina em ERRO devolve à fila (visível), mas o controller não roda nada', async () => {
    let calls = 0;
    let ref: SessionController | null = null;
    const controller = new SessionController({
      model: {
        async call(): Promise<ModelCallResult> {
          calls += 1;
          injectFromComposer(ref!, 'PING-erro');
          throw new Error('HTTP 401');
        },
      },
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports(),
      askResolver: approveAll,
      meta,
    });
    ref = controller;
    await controller.submit('tarefa');
    await settle();
    expect(controller.current.phase).toBe('error');
    expect(calls).toBe(1);
    // Na fila da TUI ela fica à vista e só sai no repouso (a fila não drena em `error`).
    expect(controller.takeOrphanInjects()).toEqual(['PING-erro']);
    controller.dispose();
  });
});

describe('GUARDA — a TUI marca os encaixes do composer e busca os órfãos', () => {
  // App.tsx é excluído da cobertura (render/teclado); o precedente do repo para esse caminho é
  // a guarda de FONTE (ver mensagem-nao-some.test.ts). A prova de ponta a ponta é no tmux.
  it('injectIfPlainText marca o encaixe do composer e há um efeito que devolve à fila', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const fonte = readFileSync(join(__dirname, '..', '..', 'src', 'session', 'App.tsx'), 'utf8');
    const i = fonte.indexOf('const injectIfPlainText');
    expect(i, 'a âncora sumiu — atualize esta guarda').toBeGreaterThan(0);
    expect(fonte.slice(i, i + 2800)).toMatch(
      /const injected = controller\.injectInput\('root', route\.text\);\s*if \(injected\) controller\.markLastInjectFromComposer\(\);/,
    );
    const efeito =
      /const returned = controller\.takeOrphanInjects\(\);[\s\S]{0,200}setQueue\(\(q\) => \[\.\.\.returned, \.\.\.q\]\)/;
    expect(efeito.test(fonte), 'o efeito que devolve os órfãos à FRENTE da fila sumiu').toBe(true);
  });
});

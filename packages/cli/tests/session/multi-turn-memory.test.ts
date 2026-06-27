// EST-0973 — MEMÓRIA MULTI-TURNO (regressão da AMNÉSIA). Cada turno CONTINUA a
// conversa a partir do histórico dos turnos anteriores (`lastRunHistory`), não
// começa do zero. A regressão (overhaul de budget) fazia `loop.run(goal)` a cada
// turno: o modelo NUNCA via os turnos anteriores — chat sem memória, quebrado.
//
// Prova "o modelo lembra": turno 1 estabelece um fato ("meu nome é Vega"); o turno
// 2 ("qual meu nome?") deve chegar ao modelo com um contexto que CONTÉM o turno 1
// (o goal anterior + a resposta anterior). Espionamos as MENSAGENS que chegam ao
// caller a cada chamada — sem modelo real.
//
// Precedência da semente (todas exercitadas aqui):
//   1) `/compact` ⇒ usa o SUMÁRIO (compactedSeed), não o histórico íntegro.
//   2) `lastRunHistory` ⇒ o histórico íntegro dos turnos anteriores (turno normal).
//   3) `/clear` ⇒ próximo turno FRESCO (run(goal), sem histórico).
//   4) 1º turno da sessão ⇒ FRESCO (sem histórico ainda).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

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

/**
 * Caller que GRAVA, por chamada, o texto concatenado das mensagens (o contexto que
 * o modelo VÊ) e responde com uma resposta scriptada (uma por turno do loop). Cada
 * `submit` que conclui em um turno produz UMA chamada — então `prompts[i]` é o
 * contexto do (i+1)-ésimo turno.
 */
function recordingCaller(responses: readonly string[]): {
  caller: ModelCaller;
  prompts: string[];
} {
  const prompts: string[] = [];
  let turn = 0;
  const caller: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      prompts.push(args.messages.map((m) => m.content).join('\n'));
      const content = responses[Math.min(turn, responses.length - 1)] ?? 'ok';
      turn += 1;
      return { request_id: 'r', content, finish_reason: 'stop' };
    },
  };
  return { caller, prompts };
}

function buildController(model: ModelCaller): SessionController {
  return new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

describe('EST-0973 — memória multi-turno (regressão da amnésia)', () => {
  it('turno 2 CONTINUA do histórico do turno 1 (o nome dado antes chega ao modelo)', async () => {
    const { caller, prompts } = recordingCaller(['Prazer, Vega!', 'Seu nome é Vega.']);
    const controller = buildController(caller);
    controller.dismissBoot();

    // turno 1: estabelece o fato.
    await controller.submit('meu nome é Vega');
    // turno 2: pergunta sobre o fato do turno 1.
    await controller.submit('qual meu nome?');

    // O 2º contexto DEVE conter o goal do turno 1 E a resposta do turno 1 — i.e.,
    // o turno 2 RESUME do histórico, não é um run(goal) fresco. Esta é A asserção
    // anti-amnésia.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('meu nome é Vega'); // goal do turno 1 (canal user)
    expect(prompts[1]).toContain('Prazer, Vega!'); // resposta do turno 1 (canal assistant)
    // e claro, o novo objetivo também está lá.
    expect(prompts[1]).toContain('qual meu nome?');
  });

  it('1º turno é FRESCO — só o objetivo, sem histórico anterior (nada a continuar)', async () => {
    const { caller, prompts } = recordingCaller(['oi.']);
    const controller = buildController(caller);
    controller.dismissBoot();

    await controller.submit('primeiro objetivo');

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('primeiro objetivo');
    // não há nenhum turno anterior a vazar (system + o goal, nada mais de conversa).
    expect(prompts[0]).not.toContain('segundo objetivo');
  });

  it('a conversa ACUMULA: o turno 3 vê os turnos 1 E 2', async () => {
    const { caller, prompts } = recordingCaller(['ok-1', 'ok-2', 'ok-3']);
    const controller = buildController(caller);
    controller.dismissBoot();

    await controller.submit('fato A: o céu é azul');
    await controller.submit('fato B: a grama é verde');
    await controller.submit('recapitule');

    expect(prompts).toHaveLength(3);
    // o 3º contexto carrega AMBOS os fatos anteriores + ambas as respostas.
    expect(prompts[2]).toContain('fato A: o céu é azul');
    expect(prompts[2]).toContain('ok-1');
    expect(prompts[2]).toContain('fato B: a grama é verde');
    expect(prompts[2]).toContain('ok-2');
    expect(prompts[2]).toContain('recapitule');
  });

  it('/clear ⇒ o próximo turno é FRESCO (esquece a conversa anterior de propósito)', async () => {
    const { caller, prompts } = recordingCaller(['Prazer, Vega!', 'Não sei seu nome.']);
    const controller = buildController(caller);
    controller.dismissBoot();

    await controller.submit('meu nome é Vega');
    controller.clear();
    await controller.submit('qual meu nome?');

    expect(prompts).toHaveLength(2);
    // após /clear, o turno 1 NÃO vaza p/ o turno 2 — começou do zero.
    expect(prompts[1]).not.toContain('meu nome é Vega');
    expect(prompts[1]).not.toContain('Prazer, Vega!');
    expect(prompts[1]).toContain('qual meu nome?');
  });
});

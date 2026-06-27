// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — `/cycle` (autonomia REPETIDA) na
// INTEGRAÇÃO real (SessionController + AgentLoop + catraca + freio). A bateria do gate
// FORTE do `seguranca` (anti-runaway) END-TO-END, com os CASOS NEGATIVOS:
//   • "sem teto ⇒ NÃO inicia" — nenhum ciclo roda, nota honesta.
//   • roda os ciclos e PARA no teto (max-iterations).
//   • `--unsafe` ainda PARA nos tetos (não relaxa o anti-runaway).
//   • parável: interrupt() para limpo entre ciclos.
//   • Plan: cada ciclo só LÊ (efeito negado por-ciclo) — o run_command vira observação.
//   • grant NÃO persiste entre ciclos: sempre-ask re-pergunta a CADA ciclo (a confirmação
//     de um ciclo não destrava o próximo).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type AskResolver,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): { ports: ToolPorts; ran: string[]; reads: string[] } {
  const ran: string[] = [];
  const reads: string[] = [];
  const fs: FileSystemPort = {
    async readFile(p: string) {
      reads.push(p);
      return 'conteúdo';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec(c) {
      ran.push(c);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran, reads };
}

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

/**
 * Modelo roteirizado pelo TURNO DENTRO DO CICLO. O `/cycle` re-usa o MESMO loop
 * (mesmo sessionId), mas a iteração interna ZERA a cada `run()` — então o sufixo
 * `:N` da idempotency-key é o turno DO CICLO (`:0` = 1º turno de cada ciclo). Roteia
 * por esse sufixo (como um modelo real, stateless por chamada).
 */
function scriptedModel(turnScript: (turn: number) => string): ModelCaller {
  return {
    async call(args): Promise<ModelCallResult> {
      const key = args.idempotencyKey;
      const turn = Number(key.slice(key.lastIndexOf(':') + 1));
      return {
        request_id: 'r',
        content: turnScript(Number.isFinite(turn) ? turn : 0),
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 40, tokens_out: 60 },
      };
    },
  };
}

const approveAll: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

/** Acha a última nota `/cycle` no estado. */
function cycleNote(
  controller: SessionController,
): { title: string; lines: readonly string[] } | undefined {
  const blocks = controller.current.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'note' && b.title === '/cycle') return { title: b.title, lines: b.lines };
  }
  return undefined;
}

describe('EST-0981 · GS-L2/RES-L-1 — "sem teto ⇒ NÃO inicia" (caso negativo)', () => {
  it('recusa iniciar e NÃO roda nenhum ciclo quando não há teto', async () => {
    const { ports } = fakePorts();
    let modelCalls = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        modelCalls++;
        return scriptedModel(() => 'pronto.').call(args);
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    // sem intervalo, sem --por, sem --max-iter ⇒ não inicia.
    await controller.cycle('"rode os testes para sempre"');
    expect(modelCalls).toBe(0); // NENHUM ciclo rodou
    const note = cycleNote(controller);
    expect(note?.lines.join(' ')).toMatch(/sem teto|NÃO inicia/i);
  });
});

describe('EST-0981 · GS-L2 — roda os ciclos e PARA no teto de iterações', () => {
  it('com --max-iter 3, roda 3 ciclos e para fechado (cada ciclo é um loop completo)', async () => {
    const { ports } = fakePorts();
    // cada ciclo: turn0 = lê um arquivo, turn1 = conclui (sem declarar término ⇒ não-done).
    const model = scriptedModel((turn) =>
      turn === 0
        ? toolCall('read_file', { path: 'tests.log' })
        : `relatório do ciclo (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    await controller.cycle('--max-iter 3 "rode os testes e corrija o que quebrar"');
    const note = cycleNote(controller);
    expect(note?.lines.join(' ')).toMatch(/3 ciclo/);
    expect(note?.lines.join(' ')).toMatch(/iterações|fechado/i);
  });
});

describe('EST-0981 · GS-L3 — `--unsafe` ainda PARA nos tetos (não relaxa anti-runaway)', () => {
  it('mesmo em unsafe, o /cycle para no teto de iterações', async () => {
    const { ports } = fakePorts();
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('run_command', { command: 'echo oi' }) : `feito (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }), // --unsafe
      ports,
      askResolver: approveAll,
      meta,
    });
    await controller.cycle('--max-iter 2 "rode comandos sem parar"');
    const note = cycleNote(controller);
    expect(note?.lines.join(' ')).toMatch(/2 ciclo/);
    expect(note?.lines.join(' ')).toMatch(/iterações|fechado/i);
  });
});

describe('EST-0981 · GS-L5/RES-L-2 — parável (reusa o freio: interrupt entre ciclos)', () => {
  it('interrupt() durante o /cycle para limpo e reporta "parado por você"', async () => {
    const { ports } = fakePorts();
    let cyclesSeen = 0;
    const controller = new SessionController({
      model: {
        async call(args): Promise<ModelCallResult> {
          const key = args.idempotencyKey;
          // 1º turno de cada ciclo: conta o ciclo; no 2º ciclo, dispara o abort.
          if (key.endsWith(':0')) {
            cyclesSeen++;
            if (cyclesSeen === 2) controller.interrupt();
          }
          return {
            request_id: 'r',
            content: key.endsWith(':0')
              ? toolCall('read_file', { path: 'x' })
              : `ok (${Math.random()}).`,
            finish_reason: 'stop',
            usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
          };
        },
      },
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    await controller.cycle('--max-iter 50 "trabalho longo"');
    const note = cycleNote(controller);
    expect(note?.lines.join(' ')).toMatch(/parado por você|limpo/i);
  });
});

describe('EST-0981 · GS-L6 — Plan nega efeito POR CICLO (cada ciclo só lê)', () => {
  it('em Plan, o run_command de cada ciclo é NEGADO (vira observação) — nenhum shell roda', async () => {
    const { ports, ran } = fakePorts();
    // cada ciclo TENTA um run_command; em Plan a catraca nega ⇒ observação, sem efeito.
    const model = scriptedModel((turn) =>
      turn === 0
        ? toolCall('run_command', { command: 'rm -rf /' })
        : `só analisei (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'plan' }), // PLAN
      ports,
      askResolver: approveAll,
      meta,
    });
    await controller.cycle('--max-iter 2 "tente mexer no sistema"');
    // NENHUM comando de shell foi executado em NENHUM ciclo (Plan nega por-ciclo).
    expect(ran).toEqual([]);
  });
});

describe('EST-0981 · GS-L1 — grant NÃO persiste entre ciclos (sempre-ask re-pergunta)', () => {
  it('uma confirmação sempre-ask num ciclo NÃO destrava o efeito no ciclo seguinte', async () => {
    const { ports } = fakePorts();
    // a tarefa de cada ciclo: turn0 = LÊ um arquivo distinto (allow ⇒ executa ⇒ PROGRESSO,
    // evita o anti-loop-vazio); turn1 = TENTA um efeito SEMPRE-ASK (rede) ⇒ perguntado a
    // cada ciclo; turn2 = conclui (sem declarar término ⇒ não-done).
    let cyc = -1;
    const model = scriptedModel((turn) => {
      if (turn === 0) {
        cyc++;
        return toolCall('read_file', { path: `f${cyc}` }); // distinto por ciclo ⇒ progresso
      }
      if (turn === 1) return toolCall('run_command', { command: 'curl https://exemplo.com' });
      return `fim do ciclo ${cyc}.`;
    });
    // resolver que registra cada pergunta e nega (deny) — o efeito nunca roda, mas o
    // ponto é: ele é PERGUNTADO a CADA ciclo (grant não persiste).
    const asks: string[] = [];
    const denyResolver: AskResolver = {
      async resolve(req) {
        asks.push(req.category ?? 'default');
        return { kind: 'deny' as const };
      },
    };
    const controller = new SessionController({
      model,
      // modo normal: run_command de rede é sempre-ask (não relaxável)
      permission: new PolicyPermissionEngine({ mode: 'normal' }),
      ports,
      askResolver: denyResolver,
      meta,
    });
    await controller.cycle('--max-iter 3 "baixe a página e me avise"');
    // 3 ciclos ⇒ PELO MENOS 3 perguntas (uma por ciclo) — o grant de um ciclo NÃO
    // atravessa para o próximo (cada ciclo dispara a própria confirmação).
    expect(asks.length).toBeGreaterThanOrEqual(3);
  });
});

describe('EST-0981 · GS-L2/E-A2/FU-S3-RES1 — budget AGREGADO corta ATÔMICO (overshoot=0)', () => {
  it('para por budget AGREGADO de tokens DENTRO do limite — a soma cross-ciclo NÃO estoura', async () => {
    // FU-S3-RES1 — END-TO-END do FIX. O `aggregate` é injetado COMO o budget de cada ciclo
    // (budgetOverride no `loop.run`). Cada turno gasta 100 tokens (40+60); o teto AGREGADO é
    // 250. Antes do fix, cada ciclo somava num budget próprio e o agregado só "via" DEPOIS
    // ⇒ um ciclo inteiro podia estourar o teto antes do portão pré-ciclo perceber. Agora o
    // débito é DIRETO no contador único: o loop PARA assim que a soma cross-ciclo bate o teto.
    const { ports } = fakePorts();
    // cada ciclo: turn0 lê (progride, evita anti-loop-vazio), turn1+ seguem (nunca concluem)
    // ⇒ quem corta é o budget agregado, não conclusão/iterações.
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('read_file', { path: `f${turn}` }) : `segue (${Math.random()}).`,
    );
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    // teto agregado de 250 tokens; --max-iter alto p/ NÃO ser as iterações a cortar.
    await controller.cycle('--max-iter 50 --budget 250 "trabalhe sem parar"');
    const note = cycleNote(controller);
    const text = note?.lines.join(' ') ?? '';
    // parou por BUDGET (não por iterações/conclusão).
    expect(text).toMatch(/budget AGREGADO|tokens/i);
    // CORTE ATÔMICO: o total de tokens consumidos reportado NÃO ultrapassa o teto agregado
    // ALÉM de uma única chamada de modelo (tokens são pós-fato; o que o fix elimina é o
    // overshoot de um CICLO INTEIRO). Antes: podia chegar a centenas acima; agora ≤ teto+1·passo.
    const m = text.match(/([\d.]+)\s*tokens consumidos/i);
    expect(m).not.toBeNull();
    const consumed = m ? Number(m[1]) : Number.NaN;
    // ≤ teto + um único passo de 100 (o gate de tokens é pré-chamada, pós-fato): NUNCA
    // "teto + 1 ciclo inteiro". O corte cross-ciclo é atômico (próximo ciclo não inicia).
    expect(consumed).toBeLessThanOrEqual(250 + 100);
  });
});

describe('EST-0981 · GS-L4 — para AO CONCLUIR (detecção de término)', () => {
  it('quando o agente declara "tarefa concluída", o /cycle para antes do teto', async () => {
    const { ports } = fakePorts();
    let cycle = -1;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        if (key.endsWith(':0')) cycle++;
        // 2º ciclo declara conclusão na resposta final.
        const content = key.endsWith(':0')
          ? toolCall('read_file', { path: `f${cycle}` })
          : cycle >= 1
            ? 'tarefa concluída — nada mais a fazer.'
            : `ciclo ${cycle} ok.`;
        return {
          request_id: 'r',
          content,
          finish_reason: 'stop',
          usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
        };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
    });
    await controller.cycle('--max-iter 50 "faça o trabalho até terminar"');
    const note = cycleNote(controller);
    expect(note?.lines.join(' ')).toMatch(/conclu/i);
    // parou MUITO antes do teto de 50 (2 ciclos).
    expect(note?.lines.join(' ')).toMatch(/2 ciclo/);
  });
});

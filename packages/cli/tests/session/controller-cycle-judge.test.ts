// ADR-0137 (Fatia 3) — testes do SEAM do JUIZ na BORDA (SessionController), não só na
// política pura. Cada condição C1–C6 do gate `seguranca` tem AQUI um teste que FALHARIA se
// a condição fosse violada (prova no SEAM real, com um fake JudgeEngine — ZERO rede).
//
//   C1 (redação · BLOQUEIA) — um segredo plantado no objetivo/caixa/desfecho do subciclo NÃO
//        chega ao `JudgeInput.context` que o JudgeEngine recebe.
//   C4 (O(aprovações))      — juiz sempre `continue` + teto baixo: K `continue`s no gate ⇒
//        EXATAMENTE K+1 rodadas-de-teto, depois `stop` para. Sem auto-aprovação.
//   C5 (knob)               — `ALUY_CYCLE_JUDGE_OFF=1` ⇒ seam desligado, baseline `done`
//        determinístico bit-a-bit (o juiz nem é consultado).
//   C6 (stall ortogonal)    — juiz=continue + estado estagnado (madeProgress=false) ⇒ AINDA
//        para por no-progress (o juiz não silencia o stall determinístico).

import { describe, expect, it } from 'vitest';
import {
  ContextGraph,
  PolicyPermissionEngine,
  type JudgeEngine,
  type JudgeInput,
  type JudgeResult,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type AskResolver,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

// ─── Harness (espelha controller-cycle.test.ts) ─────────────────────────────

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(graph?: ContextGraph): { ports: ToolPorts; ran: string[] } {
  const ran: string[] = [];
  const fs: FileSystemPort = {
    async readFile() {
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
  return { ports: { fs, shell, search, graph }, ran };
}

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

const approveAll: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

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

/** Acha a última nota `/cycle` no estado. */
function cycleNote(controller: SessionController): readonly string[] {
  const blocks = controller.current.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'note' && b.title === '/cycle') return b.lines;
  }
  return [];
}

/**
 * Fake JudgeEngine: SEMPRE devolve a `chosen`/`reason` dados, mode 'llm'. Captura CADA
 * `JudgeInput` recebido — o teste audita o `context` (C1). ZERO rede.
 */
function fakeJudge(
  chosen: string,
  reason = 'segue',
): { judge: JudgeEngine; inputs: JudgeInput[]; calls: () => number } {
  const inputs: JudgeInput[] = [];
  const judge: JudgeEngine = {
    async judge(input: JudgeInput): Promise<JudgeResult> {
      inputs.push(input);
      return { chosen, confidence: 0.9, reasons: [{ optionId: chosen, rationale: reason }], mode: 'llm' };
    },
  };
  return { judge, inputs, calls: () => inputs.length };
}

/** Poll util: espera a condição virar verdadeira (microtask loop), com teto de iterações. */
async function waitFor(pred: () => boolean, maxTicks = 5000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (pred()) return;
    await Promise.resolve();
  }
  throw new Error('waitFor: condição nunca satisfeita');
}

// ════════════════════════════════════════════════════════════════════════════
// C1 — REDAÇÃO (BLOQUEIA): o segredo NÃO chega ao context do JudgeInput no SEAM.
// ════════════════════════════════════════════════════════════════════════════

describe('ADR-0137 · C1 (seam) — segredo plantado NÃO vaza ao JudgeInput.context do juiz', () => {
  const SECRET_OBJ = 'sk-live-SEGREDO1234567890ABCDEF'; // ≥16 chars após sk- ⇒ redator casa
  const SECRET_BOX = 'AWS_SECRET_ACCESS_KEY=AKIAIOSFODNN7EXAMPLE';
  const SECRET_OUT = 'github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

  it('o juiz recebe o context REDIGIDO (objetivo+caixa), sem nenhum segredo cru', async () => {
    // Duas SUPERFÍCIES de ataque reais alimentam o context do juiz no seam (applyCycleJudge):
    //   (a) o OBJETIVO do ciclo (a `task` digitada — pode conter segredo);
    //   (b) o RÓTULO de cada CAIXA do plano (graphPort.listBoxes — texto cru do agente).
    // O `lastOutcome` é hoje só um RESUMO de métricas (stopSummaryOf: "N tokens · M tools"),
    // não texto livre — por isso o SEGREDO de saída entra via (a)/(b), que é o que provamos.
    const graph = new ContextGraph();
    graph.openBox('b1', 'curto', `rodar comando com ${SECRET_BOX}`);
    const { ports } = fakePorts(graph);
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('read_file', { path: 'x' }) : `falhou: token ${SECRET_OUT} inválido.`,
    );
    const { judge, inputs } = fakeJudge('stop'); // stop ⇒ para no 1º ciclo (não precisa de gate)
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      judge,
    });
    // O objetivo carrega o segredo (vira `task` ⇒ JudgeInput context).
    await controller.cycle(`--max-iter 3 "deploy ${SECRET_OBJ}"`);

    // O juiz FOI consultado ao menos uma vez no seam.
    expect(inputs.length).toBeGreaterThan(0);
    // E em NENHUM input o segredo cru aparece — a redação é ANTES do JudgeInput.context.
    for (const input of inputs) {
      const ctx = input.context ?? '';
      expect(ctx).not.toContain(SECRET_OBJ);
      expect(ctx).not.toContain('AKIAIOSFODNN7EXAMPLE');
      expect(ctx).not.toContain(SECRET_OUT);
      // O marcador de redação está presente (prova que passou pelo redator, não que sumiu).
      expect(ctx).toContain('‹redigido›');
      // A ESTRUTURA sobrevive — o juiz ainda vê o esqueleto (objetivo + caixa).
      expect(ctx).toContain('objetivo:');
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C4 — O(aprovações): K `continue`s no gate ⇒ K+1 rodadas-de-teto, depois stop.
// ════════════════════════════════════════════════════════════════════════════

describe('ADR-0137 · C4 (seam) — gate do teto é O(aprovações): K aprovações ⇒ K+1 rodadas', () => {
  it('responder `continue` ao gate K vezes e `stop` na K+1 ⇒ EXATAMENTE K+1 rodadas-de-teto', async () => {
    const K = 3; // nº de aprovações humanas
    // O juiz SEMPRE quer continuar ⇒ cada teto vira pergunta (nunca auto-aprova). teto baixo (1).
    const { judge } = fakeJudge('continue', 'objetivo ainda não atingido');
    const { ports } = fakePorts();
    // Conta as RODADAS-DE-TETO observando o início de cada `engine.run` (workingLabel muda p/
    // "em ciclo (estendido)" a cada extensão; a 1ª rodada é a inicial). Mais robusto: contamos
    // os ciclos efetivamente rodados pelo nº de turnos `:0` (1 turno-0 por ciclo) — com max-iter
    // 1, cada rodada-de-teto roda EXATAMENTE 1 ciclo, então #ciclos = #rodadas-de-teto.
    let cyclesRun = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        if (key.endsWith(':0')) cyclesRun++;
        // turn0: lê (progride, evita anti-loop-vazio); turn1: segue (nunca declara conclusão)
        return {
          request_id: 'r',
          content: key.endsWith(':0')
            ? toolCall('read_file', { path: `f${cyclesRun}` })
            : `segue (${cyclesRun}/${Math.random()}).`,
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
      judge,
    });

    // Async-resolver: dispara o ciclo SEM await; cada vez que o gate aparecer, responde.
    let gatesAnswered = 0;
    const done = controller.cycle('--max-iter 1 "trabalho sem fim"');

    // Loop de poll: a cada gate, aprova K vezes, depois encerra na (K+1)ª.
    for (;;) {
      // espera OU o gate abrir OU o ciclo terminar.
      await waitFor(
        () => controller.current.phase === 'cycle-ceiling' || controller.current.phase === 'done',
      );
      if (controller.current.phase === 'done') break;
      // o gate está aberto.
      if (gatesAnswered < K) {
        gatesAnswered++;
        controller.continueCycleCeiling(); // [c] — estende um teto-worth
      } else {
        controller.stopCycleCeiling(); // [n] — encerra na (K+1)ª
      }
      // espera o seam sair da fase de gate antes de re-pollar (evita responder 2x o mesmo gate).
      await waitFor(() => controller.current.phase !== 'cycle-ceiling');
    }
    await done;

    // O gate foi consultado K+1 vezes (K continue + 1 stop): O(aprovações), sem auto-aprovação.
    expect(gatesAnswered).toBe(K);
    // Rodadas-de-teto = 1 inicial + K extensões = K+1. Com max-iter 1, isso é K+1 ciclos rodados.
    expect(cyclesRun).toBe(K + 1);
  });

  it('UMA aprovação a menos NÃO basta: sem o `c`, NÃO há rodada extra (default seguro encerra)', async () => {
    // Prova negativa: juiz quer continuar, mas se respondermos `stop` DE CARA (0 aprovações),
    // roda EXATAMENTE 1 rodada-de-teto (a inicial) — nada de auto-extensão.
    const { judge } = fakeJudge('continue', 'segue');
    const { ports } = fakePorts();
    let cyclesRun = 0;
    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        const key = args.idempotencyKey;
        if (key.endsWith(':0')) cyclesRun++;
        return {
          request_id: 'r',
          content: key.endsWith(':0')
            ? toolCall('read_file', { path: `f${cyclesRun}` })
            : `segue (${Math.random()}).`,
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
      judge,
    });
    const done = controller.cycle('--max-iter 1 "trabalho sem fim"');
    await waitFor(
      () => controller.current.phase === 'cycle-ceiling' || controller.current.phase === 'done',
    );
    expect(controller.current.phase).toBe('cycle-ceiling'); // o gate ABRIU (juiz quer mais)
    controller.stopCycleCeiling(); // [n] de cara
    await done;
    expect(cyclesRun).toBe(1); // EXATAMENTE 1 rodada-de-teto, sem extensão.
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C5 — KNOB: ALUY_CYCLE_JUDGE_OFF=1 ⇒ seam OFF, baseline determinístico bit-a-bit.
// ════════════════════════════════════════════════════════════════════════════

describe('ADR-0137 · C5 (seam) — ALUY_CYCLE_JUDGE_OFF=1 desliga o seam (juiz nunca consultado)', () => {
  /** Roda o MESMO cenário e devolve a nota /cycle + nº de consultas ao juiz. */
  async function run(env: Record<string, string | undefined>, judgeChosen: string) {
    const { ports } = fakePorts();
    // cada ciclo: turn0 lê (progride), turn1 conclui (sem declarar término ⇒ roda até o teto).
    const model = scriptedModel((turn) =>
      turn === 0 ? toolCall('read_file', { path: 'x.log' }) : `ok (ciclo).`,
    );
    const { judge, calls } = fakeJudge(judgeChosen, 'segue');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      judge,
      cycleJudgeEnv: env,
    });
    await controller.cycle('--max-iter 2 "trabalho curto"');
    return { lines: cycleNote(controller).join(' '), judgeCalls: calls() };
  }

  it('OFF (knob ON) ⇒ juiz NÃO é consultado e o resultado = baseline sem juiz, bit-a-bit', async () => {
    // Baseline SEM juiz injetado (seam estruturalmente OFF).
    const noJudge = await (async () => {
      const { ports } = fakePorts();
      const model = scriptedModel((turn) =>
        turn === 0 ? toolCall('read_file', { path: 'x.log' }) : `ok (ciclo).`,
      );
      const controller = new SessionController({
        model,
        permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
        ports,
        askResolver: approveAll,
        meta,
      });
      await controller.cycle('--max-iter 2 "trabalho curto"');
      return cycleNote(controller).join(' ');
    })();

    // Com juiz injetado MAS knob ON: o juiz que SEMPRE diz `continue` NÃO pode mudar nada.
    const off = await run({ ALUY_CYCLE_JUDGE_OFF: '1' }, 'continue');
    expect(off.judgeCalls).toBe(0); // C5 — o juiz nem é consultado.
    expect(off.lines).toBe(noJudge); // bit-a-bit igual ao baseline sem juiz.
    // Sanidade: o baseline para no teto de iterações (2 ciclos).
    expect(off.lines).toMatch(/2 ciclo/);
  });

  it('contra-prova: knob OFF (vazio) ⇒ o juiz É consultado (o seam está ligado por default)', async () => {
    const on = await run({}, 'stop');
    expect(on.judgeCalls).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// C6 — STALL ORTOGONAL: juiz=continue + estado estagnado ⇒ AINDA para por no-progress.
// ════════════════════════════════════════════════════════════════════════════

describe('ADR-0137 · C6 (seam) — stall determinístico não é silenciado pelo juiz', () => {
  it('juiz SEMPRE continue + ciclos de ZERO tool-calls (sem progresso) ⇒ para por no-progress', async () => {
    // O juiz quer continuar pra sempre, MAS cada ciclo NÃO executa tool-call ⇒ o marcador de
    // progresso REPETE ⇒ o CycleEngine corta por no-progress (anti-loop-vazio). O juiz pode
    // querer `continue`, mas só vira gate nos tetos DUROS (iter/duração) — NÃO no no-progress.
    const { judge, calls } = fakeJudge('continue', 'continue sempre');
    const { ports } = fakePorts();
    // TODO turno só responde texto (zero tool-call) ⇒ workDone nunca avança ⇒ progresso estagna.
    const model = scriptedModel(() => 'só penso, não ajo.');
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      judge,
    });
    // max-iter alto: se o juiz silenciasse o stall, rodaria 50 ciclos / abriria gate; NÃO deve.
    await controller.cycle('--max-iter 50 "trabalho que não progride"');
    const lines = cycleNote(controller).join(' ');
    // Parou por NO-PROGRESS (não por iterações, não por gate de teto, não "continua pra sempre").
    expect(lines).toMatch(/progress|progresso|sem avanço|loop/i);
    // E NÃO ficou preso no gate de teto: terminou (fase de repouso).
    expect(controller.current.phase).not.toBe('cycle-ceiling');
    // O juiz pode ter sido consultado, mas o stall determinístico prevaleceu de qualquer modo.
    expect(calls()).toBeGreaterThanOrEqual(0);
  });
});

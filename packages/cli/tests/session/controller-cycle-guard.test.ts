// EST-0981 · CLI-SEC-14 — GUARDA ANTI-COLISÃO de ciclos/turnos (anti gasto-dobrado).
// O furo (antes): DOIS `/cycle` (ou um `/cycle` + um `submit`) podiam rodar AO MESMO
// TEMPO — dois CycleEngine concorrentes, dois débitos de budget, blocos intercalados.
// A guarda (agora): com um ciclo ATIVO, `cycle()` e `submit()` PÚBLICOS RECUSAM com
// nota clara (não enfileiram em silêncio); os re-disparos INTERNOS do CycleEngine
// (runner → `loop.run` direto) seguem funcionando; a flag limpa SEMPRE no fim/abort/
// erro (`finally`) — `cycle()`/`submit()` voltam a funcionar.
//
// FRUGAL: tudo com modelo MOCK (nenhuma chamada real) — gate de promessa p/ segurar
// um ciclo VIVO deterministicamente enquanto a colisão é provocada.

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
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { queueAtRest } from '../../src/session/model.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): ToolPorts {
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

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

const approveAll: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

/**
 * Modelo roteirizado pelo turno (sufixo `:N` da idempotency-key) + GATE: enquanto
 * `release()` não roda, TODA chamada fica SEGURADA (o ciclo/turno fica VIVO,
 * deterministicamente). `keys` registra cada chamada — a prova de "quantos motores
 * rodaram" (cada CycleEngine gera um `cycleTag` próprio no prefixo da key).
 */
function gatedScriptedModel(script: (turn: number) => string): {
  model: ModelCaller;
  keys: string[];
  release: () => void;
} {
  const keys: string[] = [];
  let open = false;
  const waiters: Array<() => void> = [];
  const model: ModelCaller = {
    async call(args): Promise<ModelCallResult> {
      keys.push(args.idempotencyKey);
      if (!open) await new Promise<void>((r) => waiters.push(r));
      const key = args.idempotencyKey;
      const turn = Number(key.slice(key.lastIndexOf(':') + 1));
      return {
        request_id: 'r',
        content: script(Number.isFinite(turn) ? turn : 0),
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 40, tokens_out: 60 },
      };
    },
  };
  return {
    model,
    keys,
    release: () => {
      open = true;
      waiters.splice(0).forEach((w) => w());
    },
  };
}

/** Roteiro padrão de um ciclo: turn0 LÊ (progride — anti-loop-vazio), turn1+ conclui o turno sem declarar término. */
const cycleScript = (turn: number): string =>
  turn === 0 ? toolCall('read_file', { path: 'x' }) : 'seguindo em frente.';

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: condição não assentou no prazo');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Todas as notas `/cycle` no estado (na ordem). */
function cycleNotes(controller: SessionController): string[] {
  return controller.current.blocks
    .filter((b) => b.kind === 'note' && b.title === '/cycle')
    .map((b) => (b.kind === 'note' ? b.lines.join(' ') : ''));
}

/** O `cycleTag` (prefixo `cycle-<ts>`) de uma idempotency-key de ciclo. */
function tagOf(key: string): string {
  return key.slice(0, key.lastIndexOf('-'));
}

function build(script: (turn: number) => string = cycleScript) {
  const { model, keys, release } = gatedScriptedModel(script);
  // relógio injetado ESTRITAMENTE crescente ⇒ cada /cycle ganha um cycleTag DISTINTO
  // (a prova de unicidade de engine pelas keys não colide por timestamp igual).
  let t = 1_000_000;
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
    clock: () => ++t,
  });
  return { controller, keys, release };
}

describe('EST-0981 · CLI-SEC-14 — cycle() com ciclo ATIVO ⇒ RECUSA (não cria 2º engine)', () => {
  it('o 2º /cycle é recusado com nota, NENHUMA chamada nova ocorre e o 1º ciclo segue intacto', async () => {
    const { controller, keys, release } = build();

    // 1º /cycle fica VIVO (a 1ª chamada de modelo está segurada no gate).
    const p1 = controller.cycle('--max-iter 2 "tarefa longa"');
    await waitFor(() => keys.length === 1);
    expect(controller.current.cycleActive).toBe(true);

    // 2º /cycle COLIDE ⇒ recusa explícita com nota; nada roda.
    await controller.cycle('--max-iter 2 "segundo ciclo"');
    expect(cycleNotes(controller).some((n) => /ciclo ATIVO/i.test(n))).toBe(true);
    expect(keys.length).toBe(1); // NENHUM 2º engine disparou chamada
    // o 2º /cycle nem ecoa como fala `you` (foi recusado antes de iniciar).
    expect(
      controller.current.blocks.some((b) => b.kind === 'you' && b.text.includes('segundo ciclo')),
    ).toBe(false);

    // O 1º ciclo segue INTACTO até o teto: 2 ciclos × 2 turnos = 4 chamadas,
    // TODAS do MESMO engine (mesmo cycleTag no prefixo da key).
    release();
    await p1;
    expect(keys.length).toBe(4);
    expect(new Set(keys.map(tagOf)).size).toBe(1);
    expect(cycleNotes(controller).some((n) => /2 ciclo/.test(n))).toBe(true);
    // fim REAL ⇒ flag limpa.
    expect(controller.current.cycleActive).toBe(false);
  });
});

describe('EST-0981 · CLI-SEC-14 — submit() EXTERNO com ciclo ATIVO ⇒ recusa com nota', () => {
  it('o objetivo NÃO é enviado nem vira turno; após o fim do ciclo, submit volta a funcionar', async () => {
    const { controller, keys, release } = build();

    const p1 = controller.cycle('--max-iter 1 "tarefa"');
    await waitFor(() => keys.length === 1);

    // submit EXTERNO durante o ciclo ⇒ recusa: nota clara, sem turno, sem fala `you`.
    await controller.submit('objetivo intruso');
    expect(cycleNotes(controller).some((n) => /ciclo ATIVO.*não foi enviado/i.test(n))).toBe(true);
    expect(keys.length).toBe(1); // nenhum turno concorrente disparou
    expect(
      controller.current.blocks.some((b) => b.kind === 'you' && b.text === 'objetivo intruso'),
    ).toBe(false);

    // Os re-disparos INTERNOS do ciclo seguem funcionando (o runner não passa pela
    // guarda): o ciclo completa os 2 turnos dele.
    release();
    await p1;
    expect(keys.length).toBe(2);

    // Fim do ciclo ⇒ a guarda desarma: submit volta a funcionar (o turno RODA).
    await controller.submit('objetivo depois do ciclo');
    expect(
      controller.current.blocks.some(
        (b) => b.kind === 'you' && b.text === 'objetivo depois do ciclo',
      ),
    ).toBe(true);
    expect(keys.length).toBeGreaterThan(2);
  });
});

describe('EST-0981 · CLI-SEC-14 — turno NORMAL vivo + /cycle ⇒ recusa', () => {
  it('com um submit em andamento, /cycle recusa com "turno em andamento" e nada roda', async () => {
    const { controller, keys, release } = build();

    const pTurn = controller.submit('objetivo normal');
    await waitFor(() => keys.length === 1);

    await controller.cycle('--max-iter 1 "x"');
    expect(cycleNotes(controller).some((n) => /turno em andamento/i.test(n))).toBe(true);
    expect(keys.length).toBe(1); // nenhum engine de ciclo disparou
    expect(controller.current.cycleActive).not.toBe(true);

    // O turno termina e o /cycle volta a funcionar.
    release();
    await pTurn;
    const before = keys.length;
    await controller.cycle('--max-iter 1 "agora sim"');
    expect(keys.length).toBeGreaterThan(before);
    expect(cycleNotes(controller).some((n) => /1 ciclo/.test(n))).toBe(true);
  });
});

describe('EST-0981 · GS-L5 — esc/abort PARA o ciclo E limpa a flag (não regride o freio)', () => {
  it('interrupt() durante o ciclo ⇒ para limpo, cycleActive limpa, e um novo /cycle INICIA', async () => {
    const { controller, keys, release } = build();

    const p1 = controller.cycle('--max-iter 50 "trabalho longo"');
    await waitFor(() => keys.length === 1);
    expect(controller.current.cycleActive).toBe(true);

    controller.interrupt(); // o freio de sempre (esc / Ctrl+T → P convergem aqui)
    release();
    await p1;
    expect(cycleNotes(controller).some((n) => /parado por você|limpo/i.test(n))).toBe(true);
    expect(controller.current.cycleActive).toBe(false);

    // A guarda foi LIMPA no abort: um novo /cycle não é recusado — RODA.
    const before = keys.length;
    await controller.cycle('--max-iter 1 "nova tarefa"');
    expect(keys.length).toBeGreaterThan(before);
    expect(cycleNotes(controller).some((n) => /ciclo ATIVO/i.test(n))).toBe(false);
  });
});

describe('EST-0981 — ciclos em SEQUÊNCIA seguem funcionando (a guarda só barra o paralelo)', () => {
  it('dois /cycle um APÓS o outro rodam ambos (engines distintos, sem recusa)', async () => {
    const { controller, keys, release } = build();
    release(); // sem gate: cada ciclo roda direto

    await controller.cycle('--max-iter 1 "primeira"');
    await controller.cycle('--max-iter 1 "segunda"');

    expect(keys.length).toBe(4); // 2 ciclos × 2 turnos cada
    expect(new Set(keys.map(tagOf)).size).toBe(2); // um engine por /cycle, em sequência
    expect(cycleNotes(controller).some((n) => /ciclo ATIVO/i.test(n))).toBe(false);
  });
});

describe('EST-0981 — queueAtRest: a fila do type-ahead NÃO dispara no vão entre ciclos', () => {
  it('segura com ciclo ativo (mesmo em idle/done) e libera só no repouso REAL', () => {
    // o VÃO entre ciclos: a fase pode repousar um instante, mas o ciclo está ATIVO
    // ⇒ a fila fica SEGURADA (disparar ali = turno concorrente ao ciclo).
    expect(queueAtRest({ phase: 'done', cycleActive: true })).toBe(false);
    expect(queueAtRest({ phase: 'idle', cycleActive: true })).toBe(false);
    // fim REAL do ciclo (flag limpa) ⇒ a fila re-tenta.
    expect(queueAtRest({ phase: 'done', cycleActive: false })).toBe(true);
    expect(queueAtRest({ phase: 'idle', cycleActive: false })).toBe(true);
    // compat: sem o campo (estados antigos/sem ciclo) = sem ciclo.
    expect(queueAtRest({ phase: 'done' })).toBe(true);
    expect(queueAtRest({ phase: 'idle' })).toBe(true);
    // trabalho normal segue NÃO-repouso (regra original do type-ahead, intacta).
    expect(queueAtRest({ phase: 'streaming' })).toBe(false);
    expect(queueAtRest({ phase: 'thinking', cycleActive: true })).toBe(false);
    expect(queueAtRest({ phase: 'asking' })).toBe(false);
  });
});

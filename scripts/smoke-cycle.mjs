// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — SMOKE E2E manual de `/cycle`
// (autonomia REPETIDA), com a MESMA wiring de produção (buildSession), em modo
// `--unsafe --tier aluy-strata`. Prova as DUAS pontas do gate FORTE anti-runaway:
//
//   PARTE 1 — `/cycle` com TETO BAIXO (3 iterações) numa tarefa simples ⇒ roda os
//             ciclos e PARA NO TETO (não faz "só mais uma"). E mesmo em --unsafe,
//             o teto vale (GS-L3: --unsafe não relaxa o anti-runaway).
//   PARTE 2 — `/cycle` SEM TETO ⇒ RECUSA INICIAR (falha-fechada; nenhum ciclo roda).
//
// O broker é MOCKADO por sessão (sem rede/identity reais); o I/O é REAL e CONFINADO
// num workspace temporário; a credencial é um store fake. Cada CICLO tem uma sessão
// ÚNICA (keys de idempotência distintas entre ciclos — billing honesto, GS-L7).
//
// Rodar:  npm run build  &&  node scripts/smoke-cycle.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../packages/cli/dist/session/wiring.js';
import { linearize } from '../packages/cli/dist/session/linear.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name, input) {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function sseBody(...events) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

// ── broker mockado: roteia pela ITERAÇÃO DENTRO DO CICLO (sufixo `:N` da key).
// Cada ciclo: turn 0 = roda um `run_command` (efeito útil ⇒ PROGRESSO, evita o
// anti-loop-vazio); turn 1 = responde SEM declarar conclusão (não-done) ⇒ o /cycle
// continua até bater o TETO de iterações. (Em --unsafe o run_command é auto-aprovado.)
const seenKeys = [];
let reqN = 0;
function makeMockFetch() {
  return async (_url, init) => {
    reqN += 1;
    const headers = init?.headers ?? {};
    const idem =
      (typeof headers.get === 'function'
        ? headers.get('idempotency-key')
        : headers['idempotency-key']) ?? `unk:${reqN}`;
    seenKeys.push(idem);
    const turn = Number(idem.slice(idem.lastIndexOf(':') + 1));
    const content =
      turn === 0
        ? toolCall('run_command', { command: 'echo verificando o status do deploy' })
        : 'verifiquei o status — sem mudança desde a última checagem. seguindo.';
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: sseBody(
        { event: 'start', data: { request_id: `req-${reqN}`, session_id: idem } },
        ...content.split('').map((ch) => ({ event: 'delta', data: { content: ch } })),
        {
          event: 'usage',
          data: { request_id: `req-${reqN}`, tier: 'aluy-strata', tokens_in: 20, tokens_out: 40 },
        },
        { event: 'done', data: { finish_reason: 'stop' } },
      ),
      json: async () => ({}),
      text: async () => '',
    };
  };
}

const fakeStore = {
  async get() {
    return {
      kind: 'pat',
      pat: 'aluy_pat_smoke_token_nao_real',
      organization_id: 'org-smoke',
      scopes: ['assistant:session', 'llm:call'],
      v: 1,
    };
  },
  async set() {},
  async clear() {},
};

/** Projeta o estado da sessão na MESMA serialização da TUI/linear (o que o usuário vê). */
function renderBlocks(state) {
  return state.blocks
    .map((b) => linearize(b))
    .filter((s) => s !== '')
    .join('\n');
}

function cycleNoteLines(state) {
  for (let i = state.blocks.length - 1; i >= 0; i--) {
    const b = state.blocks[i];
    if (b && b.kind === 'note' && b.title === '/cycle') return b.lines;
  }
  return [];
}

function newSession() {
  const ws = mkdtempSync(join(tmpdir(), 'aluy-smoke-cycle-'));
  const built = buildSession({
    workspaceRoot: ws,
    store: fakeStore,
    brokerFetch: makeMockFetch(),
    mode: 'unsafe',
    tier: 'aluy-strata',
    env: {
      ALUY_BROKER_URL: 'https://broker.mock.local',
      ALUY_IDENTITY_URL: 'https://id.mock.local',
    },
  });
  return { built, ws };
}

async function part1_stopsAtCeiling() {
  console.log('\n══════════ PARTE 1 — /cycle com teto BAIXO (3) ⇒ PARA NO TETO ══════════');
  const before = reqN;
  const { built, ws } = newSession();
  console.log('▌ você  --unsafe --tier aluy-strata');
  console.log('  /cycle --max-iter 3 "cheque o status do deploy e me avise se mudar"\n');

  await built.controller.cycle('--max-iter 3 "cheque o status do deploy e me avise se mudar"');

  const final = built.controller.current;
  console.log('── projeção da TUI (blocos da sessão) ──');
  console.log(
    renderBlocks(final)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
  const lines = cycleNoteLines(final);
  rmSync(ws, { recursive: true, force: true });

  const note = lines.join(' ');
  const cyclesCalls = reqN - before; // 3 ciclos × 2 turnos = 6 chamadas ao broker
  const checks = [
    ['rodou os ciclos (chamou o broker)', cyclesCalls > 0],
    ['rodou EXATAMENTE 3 ciclos (2 turnos cada ⇒ 6 chamadas)', cyclesCalls === 6],
    ['parou no TETO de iterações (3 ciclos)', /3 ciclo/.test(note)],
    ['a parada é por TETO (anti-runaway), não erro', /iterações|fechado|teto/i.test(note)],
    ['fase final = done', final.phase === 'done'],
  ];
  report(checks, lines);
  return checks.every(([, ok]) => ok);
}

async function part2_refusesWithoutCeiling() {
  console.log('\n══════════ PARTE 2 — /cycle SEM TETO ⇒ RECUSA INICIAR ══════════════════');
  const before = reqN;
  const { built, ws } = newSession();
  console.log('▌ você  --unsafe --tier aluy-strata');
  console.log('  /cycle "rode para sempre"   (sem intervalo/--por/--max-iter)\n');

  await built.controller.cycle('"rode para sempre"');

  const final = built.controller.current;
  console.log('── projeção da TUI (blocos da sessão) ──');
  console.log(
    renderBlocks(final)
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );
  const lines = cycleNoteLines(final);
  rmSync(ws, { recursive: true, force: true });

  const note = lines.join(' ');
  const cyclesCalls = reqN - before;
  const checks = [
    ['NENHUM ciclo rodou (zero chamadas ao broker)', cyclesCalls === 0],
    ['recusou por falta de teto (nota honesta)', /sem teto|NÃO inicia/i.test(note)],
  ];
  report(checks, lines);
  return checks.every(([, ok]) => ok);
}

function report(checks, lines) {
  console.log('\n── nota de parada do /cycle ──');
  for (const l of lines) console.log('  • ' + l);
  console.log('\n── asserções ──');
  for (const [label, ok] of checks) console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

async function main() {
  const ok1 = await part1_stopsAtCeiling();
  const ok2 = await part2_refusesWithoutCeiling();
  const allOk = ok1 && ok2;
  console.log(
    `\n${allOk ? '✅ SMOKE /cycle OK' : '❌ SMOKE /cycle FALHOU'} — para-no-teto + recusa-sem-teto (CLI-SEC-14).`,
  );
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

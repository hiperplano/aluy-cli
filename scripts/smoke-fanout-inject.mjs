// FANOUT-17 (task #17) — SMOKE INTERATIVO do fan-out NÃO-BLOQUEANTE.
//
// Prova de ponta-a-ponta com a MESMA wiring de produção (buildSession) e broker
// MOCKADO (sem rede): o pai delega um fan-out cujos FILHOS ficam PENDURADOS num gate;
// enquanto o pai está bloqueado no `await port.spawn`, o DONO INJETA ("btw"). Mostra:
//
//   • Fatia 1 (flag OFF): a injeção NÃO espera o fan-out inteiro — drena p/
//     `pendingInjected` enquanto os filhos seguem vivos.
//   • Fatia 2 (flag ON, ALUY_FANOUT_DETACH_ON_INJECT=1): a injeção DESACOPLA o
//     fan-out na hora, o pai RESPONDE JÁ (turno conclui) com o SEED VIVO dos filhos,
//     e os filhos seguem em segundo plano (detachedSubagents > 0). O budget agregado
//     NUNCA é resetado enquanto há desacoplados (E-A2).
//
// Rodar:  npm run build  &&  node scripts/smoke-fanout-inject.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../packages/cli/dist/session/wiring.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (name, input) => `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;

function sseBody(...events) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}
function bodyFromContent(reqId, sessionId, content) {
  return sseBody(
    { event: 'start', data: { request_id: reqId, session_id: sessionId } },
    ...content.split('').map((ch) => ({ event: 'delta', data: { content: ch } })),
    {
      event: 'usage',
      data: { request_id: reqId, tier: 'aluy-strata', tokens_in: 20, tokens_out: 40 },
    },
    { event: 'done', data: { finish_reason: 'stop' } },
  );
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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Broker mockado com GATES por filho: os filhos penduram até `release()`. */
function makeGatedBroker() {
  const gates = new Map();
  for (const l of ['a', 'b']) {
    let rel;
    const p = new Promise((r) => (rel = r));
    gates.set(l, { p, rel });
  }
  let parentSession = null;
  const counts = new Map();
  let reqN = 0;

  const fetchFn = async (_url, init) => {
    reqN += 1;
    const headers = init?.headers ?? {};
    const idemRaw =
      typeof headers.get === 'function'
        ? headers.get('idempotency-key')
        : headers['idempotency-key'];
    // Requisições SEM idempotency-key são bootstrap de sessão (não-turno) — respondem
    // trivial e NÃO contam p/ a detecção de pai/filho.
    if (!idemRaw) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        body: bodyFromContent(`req-${reqN}`, 'bootstrap', 'ok'),
        json: async () => ({}),
        text: async () => '',
      };
    }
    const lastColon = idemRaw.lastIndexOf(':');
    const sessionId = lastColon > 0 ? idemRaw.slice(0, lastColon) : idemRaw;
    if (parentSession === null) parentSession = sessionId;
    const turn = counts.get(sessionId) ?? 0;
    counts.set(sessionId, turn + 1);
    const isParent = sessionId === parentSession;

    let content;
    if (isParent) {
      content =
        turn === 0
          ? 'delegando.\n' +
            toolCall('spawn_agent', {
              agents: [
                { label: 'a', goal: 'pesquise o tema A' },
                { label: 'b', goal: 'pesquise o tema B' },
              ],
            })
          : 'ok, respondendo o que você pediu agora.';
    } else {
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      const label = /tema A/.test(bodyText) ? 'a' : 'b';
      // PENDURA no gate (ou aborta se o signal cair — como o broker real).
      await Promise.race([
        gates.get(label).p,
        new Promise((res) => {
          const sig = init?.signal;
          if (sig?.aborted) return res();
          sig?.addEventListener('abort', () => res(), { once: true });
        }),
      ]);
      if (init?.signal?.aborted) throw new Error('chamada cancelada (abort)');
      content = `relatorio-${label}: pronto.`;
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: bodyFromContent(`req-${reqN}`, sessionId, content),
      json: async () => ({}),
      text: async () => '',
    };
  };
  return { fetchFn, release: (l) => gates.get(l).rel() };
}

function buildCtl(env) {
  const ws = mkdtempSync(join(tmpdir(), 'aluy-fanout-inj-'));
  const broker = makeGatedBroker();
  const built = buildSession({
    workspaceRoot: ws,
    store: fakeStore,
    brokerFetch: broker.fetchFn,
    mode: 'unsafe',
    tier: 'aluy-strata',
    subAgents: { enabled: true, maxConcurrency: 2 },
    env: {
      ALUY_BROKER_URL: 'https://broker.mock.local',
      ALUY_IDENTITY_URL: 'https://id.mock.local',
      ...env,
    },
  });
  return { ws, controller: built.controller, release: broker.release };
}

async function waitFor(cond, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timeout');
    await delay(10);
  }
}

const checks = [];
function check(label, ok) {
  checks.push([label, !!ok]);
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

async function demoFatia1() {
  console.log('\n══════════ FATIA 1 (flag OFF) — inject não espera o fan-out inteiro ══════════');
  const { ws, controller, release } = buildCtl({}); // OFF
  const done = controller.submit('delegue a e b');
  await waitFor(() => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
  console.log('  • fan-out vivo: 2 filhos pendurados (pai bloqueado no await port.spawn)');

  controller.injectInput('root', 'btw: e o status?');
  // o pump drena p/ pendingInjected SEM esperar os filhos (intervalo 150ms).
  await delay(400);
  const liveKids = controller
    .flowOverview()
    .filter((n) => n.kind === 'subagent' && n.phase !== 'cancelled' && n.phase !== 'failed').length;
  check(
    'os 2 filhos seguem VIVOS após a injeção (não foram desacoplados — flag OFF)',
    liveKids === 2,
  );
  console.log('  • a msg do dono já saiu da fila viva (drenada p/ o próximo turno) sem travar');

  release('a');
  release('b');
  await done;
  check(
    'o turno do pai concluiu normalmente (done) após os filhos terminarem',
    controller.current.phase === 'done',
  );
  rmSync(ws, { recursive: true, force: true });
}

async function demoFatia2() {
  console.log('\n══════════ FATIA 2 (flag ON) — inject DESACOPLA e o pai responde JÁ ══════════');
  const { ws, controller, release } = buildCtl({ ALUY_FANOUT_DETACH_ON_INJECT: '1' });
  const done = controller.submit('delegue a e b');
  await waitFor(() => controller.flowOverview().filter((n) => n.kind === 'subagent').length === 2);
  console.log('  • fan-out vivo: 2 filhos pendurados');

  controller.injectInput('root', 'na real, me dá um resumo agora');
  console.log('  • dono injetou DURANTE o fan-out ⇒ Fatia 2 desacopla');

  await done; // o pai responde EM PARALELO, sem esperar os filhos
  check(
    'o turno-resposta do pai CONCLUIU sem esperar os filhos (paralelo)',
    controller.current.phase === 'done',
  );
  check(
    'os filhos seguem em segundo plano (detachedSubagents = 2)',
    controller.current.detachedSubagents === 2,
  );

  const notes = controller.current.blocks
    .filter((b) => b.kind === 'note')
    .map((n) => `${n.title}: ${n.lines.join(' ')}`)
    .join('\n');
  check('nota: fan-out desacoplado p/ responder JÁ', /desacoplado/.test(notes));

  release('a');
  release('b');
  await waitFor(() => (controller.current.detachedSubagents ?? 0) === 0);
  check(
    'os filhos concluíram em segundo plano (contador zerou)',
    (controller.current.detachedSubagents ?? 0) === 0,
  );
  rmSync(ws, { recursive: true, force: true });
}

async function main() {
  await demoFatia1();
  await demoFatia2();
  const allOk = checks.every(([, ok]) => ok);
  console.log(
    `\n${allOk ? '✓ SMOKE FANOUT-INJECT OK' : '✗ SMOKE FALHOU'} — ${checks.filter(([, o]) => o).length}/${checks.length} asserções verdes`,
  );
  if (!allOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

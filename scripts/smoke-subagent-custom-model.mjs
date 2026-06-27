// EST-0962 (Custom · bug do sub-agente 422) — SMOKE E2E manual (SEM modelo real).
//
// Prova de ponta-a-ponta com a MESMA wiring de produção (buildSession): o pai em
// `tier:'custom'` + slug (escolhido via o MESMO caminho do `/model`: controller.setTier)
// DELEGA a um sub-agente, e o corpo do request do FILHO ao broker leva
// `tier:'custom'` + `model:<slug>` — exatamente o que faltava (gerava o 422
// "o modo Custom exige model"). HG-2: o corpo NUNCA carrega provider/api_key/base_url.
//
// O broker é MOCKADO (sem rede/identity reais) e CAPTURA o corpo HTTP cru de cada
// request; distinguimos o request do FILHO pela ROTA (o filho usa POST não-stream via
// BrokerModelCaller — `stream:false` no corpo; o pai usa `stream:true`).
//
// Rodar:  npm run build  &&  node scripts/smoke-subagent-custom-model.mjs

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../packages/cli/dist/session/wiring.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name, input) {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function sseStream(...events) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

const CUSTOM_SLUG = 'meta-llama/llama-3.3-70b-instruct';

// O objetivo do PAI aparece em TODO turno do pai (no histórico), NUNCA no filho: o
// filho roda um loop NOVO cujo objetivo é só o `goal` recortado pelo pai. É o
// discriminador robusto pai×filho — ambos vão pela MESMA rota HTTP (`stream:true`,
// pois `BrokerModelCaller.call` reusa `stream()`), então a rota não distingue.
const PARENT_OBJECTIVE = 'delegue uma subtarefa a um sub-agente';

// Captura o corpo CRU de cada request HTTP ao broker (o que de fato viaja na rede).
const childBodies = [];
let parentTurn = 0;

function makeMockFetch() {
  return async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : {};
    const text = (body.messages ?? []).map((m) => m.content).join('\n');
    // FILHO = request cujo histórico NÃO contém o objetivo do pai (loop próprio).
    const isChild = !text.includes(PARENT_OBJECTIVE);
    if (isChild) childBodies.push(body);

    // Resposta: filho conclui de imediato; pai delega no 1º turno (par) e fecha no ímpar.
    let content;
    if (isChild) {
      content = 'relatorio do filho concluido.';
    } else {
      const turn = parentTurn;
      parentTurn += 1;
      content =
        turn % 2 === 0
          ? toolCall('spawn_agent', {
              agents: [{ label: 'pesquisa', goal: 'pesquise o tema X' }],
            })
          : 'consolidei o resultado do filho. Objetivo concluido.';
    }
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: sseStream(
        { event: 'start', data: { request_id: 'r', session_id: `s-${Math.random()}` } },
        ...content.split('').map((ch) => ({ event: 'delta', data: { content: ch } })),
        { event: 'usage', data: { request_id: 'r', tier: 'custom', tokens_in: 5, tokens_out: 9 } },
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

async function main() {
  console.log('══════════ EST-0962 — sub-agente herda o Custom CORRENTE do pai ══════════\n');
  const ws = mkdtempSync(join(tmpdir(), 'aluy-smoke-custom-'));
  const built = buildSession({
    workspaceRoot: ws,
    store: fakeStore,
    brokerFetch: makeMockFetch(),
    mode: 'unsafe',
    subAgents: { enabled: true, maxConcurrency: 1 },
    env: {
      ALUY_BROKER_URL: 'https://broker.mock.local',
      ALUY_IDENTITY_URL: 'https://id.mock.local',
    },
  });

  // O usuário escolhe o modo Custom no `/model` (MESMO caminho: controller.setTier).
  console.log(`▌ /model custom ${CUSTOM_SLUG}`);
  built.controller.setTier('custom', CUSTOM_SLUG);
  console.log('▌ você  --unsafe  (tier corrente: custom)');
  console.log('  objetivo: delegue uma subtarefa a um sub-agente\n');

  await built.controller.submit('delegue uma subtarefa a um sub-agente');

  rmSync(ws, { recursive: true, force: true });

  // ── ASSERÇÕES ────────────────────────────────────────────────────────────────
  const checks = [];
  checks.push(['houve exatamente 1 request de FILHO', childBodies.length === 1]);
  const child = childBodies[0] ?? {};
  checks.push([`o corpo do filho leva tier:'custom'`, child.tier === 'custom']);
  checks.push([`o corpo do filho leva model:'${CUSTOM_SLUG}'`, child.model === CUSTOM_SLUG]);
  // HG-2: nenhuma credencial/identidade-de-provedor vaza no corpo do filho.
  checks.push([
    'HG-2: o corpo do filho NÃO carrega provider/api_key/base_url',
    child.provider === undefined && child.api_key === undefined && child.base_url === undefined,
  ]);

  console.log('── corpo do request do FILHO (capturado da "rede") ──');
  console.log('  ' + JSON.stringify({ tier: child.tier, model: child.model }));

  console.log('\n── prova do fix ──');
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) allOk = false;
  }
  if (!allOk) throw new Error('SMOKE FALHOU: o filho NÃO herdou o Custom corrente do pai.');

  console.log(
    '\n✓ SMOKE OK: o sub-agente herdou o `tier:custom` + `model:<slug>` CORRENTE do pai\n' +
      '  (a pista que o `/model` setou em runtime) — sem 422, com HG-2 preservado.',
  );
}

main().catch((err) => {
  console.error('\nSMOKE ERRO:', err);
  process.exit(1);
});

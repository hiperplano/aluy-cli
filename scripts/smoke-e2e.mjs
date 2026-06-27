// EST-0948 — SMOKE E2E manual: `aluy "objetivo"` → loop → tool sob ASK → resultado.
//
// Prova de ponta-a-ponta com a MESMA wiring de produção (buildSession), só que:
//   - o BROKER é mockado (StreamFetch injetado) — sem rede/identity reais;
//   - a CREDENCIAL é um store fake em memória (sem keychain do SO);
//   - o I/O é REAL e CONFINADO (NodeShellPort/NodeFileSystemPort) num workspace
//     temporário (cwd preso, timeout no exec, confinamento de path).
//
// O broker mockado responde, no 1º turno, um tool-call `run_command` (que a
// catraca PolicyPermissionEngine força a `ask`), e no 2º turno a resposta final.
// O TuiAskResolver de produção é dirigido por uma subscrição que APROVA — provando
// que a tool roda ATRÁS da catraca, com o efeito EXATO visível, e o resultado volta.
//
// Rodar:  npm run build  &&  node scripts/smoke-e2e.mjs

import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSession } from '../packages/cli/dist/session/wiring.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';

// ── broker mockado: 2 turnos (tool-call → final), via SSE ─────────────────────
function sseBody(...events) {
  const text = events.map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`).join('');
  return {
    async *[Symbol.asyncIterator]() {
      yield text;
    },
  };
}

let turn = 0;
const mockFetch = async () => {
  turn += 1;
  const content =
    turn === 1
      ? `vou criar o arquivo de prova e listar o diretório.\n${TOOL_OPEN}\n${JSON.stringify({
          name: 'run_command',
          input: { command: 'echo "prova aluy EST-0948" > prova.txt && ls -1' },
        })}\n${TOOL_CLOSE}`
      : 'pronto: criei prova.txt e listei o diretório. objetivo concluído.';
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    body: sseBody(
      { event: 'start', data: { request_id: `req-${turn}`, session_id: 'sess-smoke' } },
      ...content.split('').map((ch) => ({ event: 'delta', data: { content: ch } })),
      {
        event: 'usage',
        data: { request_id: `req-${turn}`, tier: 'aluy-flux', tokens_in: 50, tokens_out: 120 },
      },
      { event: 'done', data: { finish_reason: 'stop' } },
    ),
    json: async () => ({}),
    text: async () => '',
  };
};

// ── credencial fake em memória (sem keychain real) ────────────────────────────
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
  const ws = mkdtempSync(join(tmpdir(), 'aluy-smoke-'));
  writeFileSync(join(ws, 'README.md'), '# repo de prova do smoke\n');

  // WIRING DE PRODUÇÃO (buildSession) com broker mockado + store fake + ws temp.
  const built = buildSession({
    workspaceRoot: ws,
    store: fakeStore,
    brokerFetch: mockFetch,
    env: {
      ALUY_BROKER_URL: 'https://broker.mock.local',
      ALUY_IDENTITY_URL: 'https://id.mock.local',
    },
  });

  // Dirige o TuiAskResolver de produção: APROVA toda confirmação (imprimindo o
  // efeito EXATO que a catraca exigiu ANTES do efeito — CLI-SEC-9).
  built.askResolver.subscribe((pending) => {
    if (!pending) return;
    const req = pending.request;
    console.log('\n  ⚠ ask  (a catraca pediu confirmação ANTES do efeito)');
    console.log('    categoria:', req.category, '| sempre-ask:', req.alwaysAsk);
    console.log('    efeito EXATO:', JSON.stringify(req.effect.exact));
    console.log('    → APROVANDO (aprovar-uma-vez)\n');
    pending.resolve({ kind: 'approve-once' });
  });

  // Render mínimo (sem Ink): imprime os deltas e o resumo de blocos.
  console.log('▌ você');
  console.log('  objetivo: crie um arquivo de prova e liste o diretório\n');
  console.log('◇ aluy  (streaming token-a-token):');
  let lastAluyLen = 0;
  built.controller.subscribe((state) => {
    const aluy = [...state.blocks].reverse().find((b) => b.kind === 'aluy');
    if (aluy && aluy.text.length > lastAluyLen) {
      process.stdout.write(aluy.text.slice(lastAluyLen));
      lastAluyLen = aluy.text.length;
    }
  });

  await built.controller.submit('crie um arquivo de prova e liste o diretório');

  console.log('\n\n── blocos da sessão ──');
  for (const b of built.controller.current.blocks) {
    if (b.kind === 'tool')
      console.log(`  ⏺ ${b.verb} ${b.target.slice(0, 50)} — ${b.result} ${b.status}`);
    if (b.kind === 'deny') console.log(`  ✗ negado ${b.exact}`);
    if (b.kind === 'broker-error') console.log(`  ✗ broker: ${b.message}`);
  }
  console.log('  fase final:', built.controller.current.phase);
  console.log('  tokens:', built.controller.current.meta.tokens);

  // PROVA do efeito: o arquivo foi criado DENTRO do workspace confinado.
  console.log('\n── prova do efeito (arquivo no workspace confinado) ──');
  if (!existsSync(join(ws, 'prova.txt'))) {
    throw new Error('SMOKE FALHOU: prova.txt não foi criado (tool não rodou).');
  }
  const created = readFileSync(join(ws, 'prova.txt'), 'utf8').trim();
  console.log('  prova.txt =', JSON.stringify(created));
  if (created !== 'prova aluy EST-0948') {
    throw new Error('SMOKE FALHOU: conteúdo inesperado.');
  }

  rmSync(ws, { recursive: true, force: true });
  console.log('\n✓ SMOKE E2E OK: aluy "objetivo" → loop → tool sob ask (aprovado) → resultado.');
}

main().catch((err) => {
  console.error('\nSMOKE ERRO:', err);
  process.exit(1);
});

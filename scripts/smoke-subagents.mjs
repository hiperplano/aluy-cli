// EST-0969 · ADR-0057 — SMOKE E2E manual dos SUB-AGENTES LOCAIS PARALELOS.
//
// Prova de ponta-a-ponta com a MESMA wiring de produção (buildSession), em modo
// `--unsafe --tier aluy-strata`, num objetivo que dispara sub-agentes PARALELOS:
// "pesquise 3 linguagens em paralelo e compare". O broker é MOCKADO por sessão
// (sem rede/identity reais); o I/O é REAL e CONFINADO (NodeShellPort/FS) num
// workspace temporário; a credencial é um store fake em memória.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ EST-0969 (display) — O BUG DE UX + A PROVA DO FIX (antes/depois):          ║
// ║                                                                            ║
// ║ ANTES: os filhos paralelos compartilhavam o MESMO StreamingModelCaller do  ║
// ║   pai (com o sink ao vivo). Os N streams token-a-token dos filhos caíam    ║
// ║   TODOS no MESMO bloco vivo do pai ⇒ INTERLEAVE ilegível ("Usar Go?rust",  ║
// ║   "fGomt"). Este script RECONSTRÓI esse caminho (PARTE 1) p/ exibir o lixo. ║
// ║                                                                            ║
// ║ DEPOIS: a wiring de produção dá aos filhos um caller DEDICADO (sem o sink   ║
// ║   ao vivo) e a UI mostra um INDICADOR de sub-agentes (status por filho).   ║
// ║   O pai só streama o AGREGADO, legível. Este script renderiza a projeção   ║
// ║   REAL da TUI (linear/blocos) e prova que NÃO há embaralhado (PARTE 2).    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// Rodar:  npm run build  &&  node scripts/smoke-subagents.mjs

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

// ── relatórios "longos" por filho (prosa multi-token) — é o que, no caminho ANTIGO,
// interleavava token-a-token virando lixo. No caminho NOVO, isto volta ao pai como
// DADO consolidado e NÃO é despejado na região viva.
const CHILD_REPORTS = {
  rust: 'Rust e uma linguagem de sistemas com seguranca de memoria sem coletor de lixo, via ownership e borrow checker.',
  go: 'Go e uma linguagem compilada com goroutines e um runtime simples, focada em produtividade e concorrencia leve.',
  zig: 'Zig e uma linguagem de sistemas minimalista, sem alocacoes ocultas, com comptime e interop direto com C.',
};

// ── broker mockado, roteado por sessão ────────────────────────────────────────
const counts = new Map();
const seen = [];
let parentSession = null;

function scriptFor(sessionId, turn, labelHint) {
  if (parentSession === null) parentSession = sessionId;
  const isParent = sessionId === parentSession;
  if (isParent) {
    if (turn === 0) {
      return (
        'vou pesquisar 3 linguagens EM PARALELO usando sub-agentes.\n' +
        toolCall('spawn_agent', {
          agents: [
            { label: 'rust', goal: 'pesquise a linguagem Rust' },
            { label: 'go', goal: 'pesquise a linguagem Go' },
            { label: 'zig', goal: 'pesquise a linguagem Zig' },
          ],
        })
      );
    }
    return 'Comparei Rust, Go e Zig com base nos relatorios dos 3 sub-agentes. Objetivo concluido.';
  }
  // FILHO: devolve o relatorio LONGO da sua linguagem (roteado pelo goal).
  return CHILD_REPORTS[labelHint] ?? `relatorio da sessao ${sessionId.slice(0, 6)}.`;
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

let reqN = 0;
function makeMockFetch() {
  return async (_url, init) => {
    reqN += 1;
    const headers = init?.headers ?? {};
    const idem =
      (typeof headers.get === 'function'
        ? headers.get('idempotency-key')
        : headers['idempotency-key']) ?? `unk:${reqN}`;
    const lastColon = idem.lastIndexOf(':');
    const sessionId = lastColon > 0 ? idem.slice(0, lastColon) : idem;
    seen.push(sessionId);
    const turn = counts.get(sessionId) ?? 0;
    counts.set(sessionId, turn + 1);
    // descobre o label do filho pelo corpo da requisicao (o goal `pesquise … <Lang>`).
    let labelHint = '';
    try {
      const bodyText = typeof init?.body === 'string' ? init.body : '';
      if (/Rust/i.test(bodyText)) labelHint = 'rust';
      else if (/\bGo\b/i.test(bodyText)) labelHint = 'go';
      else if (/Zig/i.test(bodyText)) labelHint = 'zig';
    } catch {
      /* noop */
    }
    const content = scriptFor(sessionId, turn, labelHint);
    return {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: bodyFromContent(`req-${reqN}`, sessionId, content),
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

// ── PARTE 1 — RECONSTRÓI o caminho ANTIGO (bug): os filhos no MESMO sink ao vivo ──
// Não usamos a wiring real aqui — simulamos o que acontecia: 3 streams paralelos
// despejando token-a-token no MESMO buffer "vivo" do pai. É o lixo que o fix matou.
async function demoBefore() {
  console.log('\n══════════ ANTES (bug) — filhos no MESMO stream vivo do pai ══════════');
  let live = '';
  const reports = Object.values(CHILD_REPORTS);
  // 3 "filhos" emitindo char-a-char, intercalados (round-robin), como o caminho antigo.
  const cursors = reports.map(() => 0);
  let remaining = reports.length;
  while (remaining > 0) {
    for (let i = 0; i < reports.length; i++) {
      if (cursors[i] < reports[i].length) {
        // emite alguns chars deste filho, depois passa a vez (interleave real)
        const chunk = reports[i].slice(cursors[i], cursors[i] + 3);
        live += chunk;
        cursors[i] += 3;
        if (cursors[i] >= reports[i].length) remaining -= 1;
      }
    }
  }
  console.log('◇ aluy (região viva — 3 filhos interleavados):');
  console.log('  ' + live.slice(0, 180) + ' …');
  console.log('  ↑ ILEGÍVEL: os 3 relatórios picados e misturados no mesmo buffer.');
  return live;
}

// ── PARTE 2 — caminho NOVO (fix) — wiring REAL de produção ─────────────────────
async function demoAfter() {
  console.log('\n══════════ DEPOIS (fix) — wiring real de produção ════════════════════');
  const ws = mkdtempSync(join(tmpdir(), 'aluy-smoke-sub-'));
  const built = buildSession({
    workspaceRoot: ws,
    store: fakeStore,
    brokerFetch: makeMockFetch(),
    mode: 'unsafe',
    tier: 'aluy-strata',
    subAgents: { enabled: true, maxConcurrency: 3 },
    env: {
      ALUY_BROKER_URL: 'https://broker.mock.local',
      ALUY_IDENTITY_URL: 'https://id.mock.local',
    },
  });

  console.log('▌ você  --unsafe --tier aluy-strata');
  console.log('  objetivo: pesquise 3 linguagens em paralelo e compare\n');

  await built.controller.submit('pesquise 3 linguagens em paralelo e compare');

  const final = built.controller.current;
  const rendered = renderBlocks(final);
  console.log('── projeção da TUI (blocos da sessão, como o usuário vê) ──');
  console.log(
    rendered
      .split('\n')
      .map((l) => '  ' + l)
      .join('\n'),
  );

  rmSync(ws, { recursive: true, force: true });

  // ── ASSERÇÕES do fix ────────────────────────────────────────────────────────
  const distinct = new Set(seen);
  const sub = final.blocks.find((b) => b.kind === 'subagents');
  const aluyText = final.blocks
    .filter((b) => b.kind === 'aluy')
    .map((b) => b.text)
    .join('\n');

  const checks = [];
  checks.push(['4 sessões (1 pai + 3 filhos)', distinct.size === 4]);
  checks.push(['fase final = done', final.phase === 'done']);
  checks.push(['existe o INDICADOR de sub-agentes (status por filho)', !!sub]);
  checks.push([
    'os 3 filhos aparecem rotulados por origem e CONCLUÍDOS',
    !!sub &&
      ['rust', 'go', 'zig'].every((l) =>
        sub.children.some((c) => c.label === l && c.status === 'done'),
      ),
  ]);
  // o corpo CRU dos filhos NÃO vaza na região viva do pai (anti-interleave).
  checks.push([
    'os relatórios crus dos filhos NÃO vazaram nos blocos do pai (sem interleave)',
    !aluyText.includes(CHILD_REPORTS.rust) &&
      !aluyText.includes(CHILD_REPORTS.go) &&
      !aluyText.includes(CHILD_REPORTS.zig),
  ]);
  // o agregado do pai é LEGÍVEL (frase inteira, contínua).
  checks.push([
    'o agregado do PAI é legível (frase contínua)',
    aluyText.includes('Comparei Rust, Go e Zig'),
  ]);

  console.log('\n── prova do fix ──');
  let allOk = true;
  for (const [label, ok] of checks) {
    console.log(`  ${ok ? '✓' : '✗'} ${label}`);
    if (!ok) allOk = false;
  }
  if (!allOk) throw new Error('SMOKE FALHOU: uma ou mais asserções do fix não passaram.');
}

async function main() {
  await demoBefore();
  await demoAfter();
  console.log(
    '\n✓ SMOKE E2E OK: o display de sub-agentes paralelos é LEGÍVEL — status por filho,\n' +
      '  sem o stream interleavado; o agregado do pai sai limpo; o paralelismo (4 sessões) intacto.',
  );
}

main().catch((err) => {
  console.error('\nSMOKE ERRO:', err);
  process.exit(1);
});

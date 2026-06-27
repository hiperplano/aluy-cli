// EST-0983 — DRIVER de UMA sessão do smoke de terminal (processo SEPARADO).
//
// Roda o `runSession` REAL (wiring de produção, caminho NÃO-TTY: stdout piped — é o
// que o binário usa em script/CI) numa pasta COMPARTILHADA via env, p/ provar que a
// 2ª sessão (NOVO processo) relembra o que a 1ª gravou no disco. O broker é FAKE e
// ECOA a resposta certa se o fato chegou ao contexto da chamada (prova de recall sem
// LLM real); a credencial é um store fake (sem tocar o keychain do SO).
//
//   node smoke-memory-session.mjs write-project
//   node smoke-memory-session.mjs write-global
//   node smoke-memory-session.mjs ask    "qual o nome do meu projeto?"
//   node smoke-memory-session.mjs memory                 → roda `/memory`
import { runSession } from '../packages/cli/dist/session/run.js';
import { NodeWorkspace } from '../packages/cli/dist/io/workspace.js';
import { NodeMemoryStore } from '../packages/cli/dist/io/memory-store.js';
import { AgentMemory } from '../packages/cli-core/dist/agent/memory/memory.js';

const WS = process.env.ALUY_SMOKE_WS;
const BASE = process.env.ALUY_SMOKE_BASE;
const HOME = process.env.ALUY_SMOKE_HOME;
if (!WS || !BASE || !HOME) {
  console.error('faltam ALUY_SMOKE_WS / ALUY_SMOKE_BASE / ALUY_SMOKE_HOME');
  process.exit(2);
}
const mode = process.argv[2];
const goal = process.argv[3] ?? '';

const fakeStore = {
  async get() {
    return {
      kind: 'pat',
      pat: 'pat_smoke_nao_real',
      organization_id: 'org-smoke',
      scopes: ['chat'],
    };
  },
  async set() {},
  async clear() {},
};

// Broker FAKE: se o fato lembrado chegou no contexto, ECOA a resposta certa.
const fakeBroker = {
  async *stream(args) {
    const msgs = args?.request?.messages ?? [];
    const blob = msgs.map((m) => m.content).join('\n');
    // A pergunta do usuário é o último `goal`/`user` "puro" (sem envelope de memória).
    const question = goal.toLowerCase();
    let answer = 'não sei.';
    // Responde conforme a PERGUNTA, lendo o fato relembrado do contexto (recall).
    if (/projeto|nome/.test(question) && /Vega/.test(blob)) answer = 'Seu projeto se chama Vega.';
    else if (/sou eu|quem/.test(question) && /Tiago/.test(blob)) answer = 'Você é o Tiago.';
    else if (/Vega/.test(blob)) answer = 'Seu projeto se chama Vega.';
    else if (/Tiago/.test(blob)) answer = 'Você é o Tiago.';
    yield { type: 'start', request_id: 'r', session_id: 's' };
    yield { type: 'delta', content: answer };
    yield { type: 'done', finish_reason: 'stop' };
  },
};

const baseOpts = {
  env: { HOME, USERPROFILE: HOME, ALUY_BROKER_URL: 'http://127.0.0.1:1/unused' },
  workspaceRoot: WS,
  memoryBaseDir: BASE,
  journalBaseDir: `${HOME}/.aluy`,
  store: fakeStore,
  brokerClient: fakeBroker,
  mcpTools: [],
  unsafe: true,
  stdout: process.stdout, // piped (não-TTY) — caminho do binário em script/CI
};

async function writeFact(scope, text) {
  const ws = new NodeWorkspace({ root: WS });
  const store = new NodeMemoryStore({ workspace: ws, baseDir: BASE });
  const mem = new AgentMemory({ store });
  const r = await mem.remember(text, scope, 'usuario');
  const path = scope === 'projeto' ? store.paths.project : store.paths.global;
  console.log(`[write] ok=${r.ok} → ${path}`);
  process.exit(r.ok ? 0 : 1);
}

if (mode === 'write-project') await writeFact('projeto', 'o projeto se chama Vega e usa pnpm');
else if (mode === 'write-global') await writeFact('global', 'o usuário se chama Tiago');
else if (mode === 'ask') {
  await runSession({ ...baseOpts, goal });
  process.exit(0);
} else if (mode === 'memory') {
  await runSession({ ...baseOpts, goal: '/memory' });
  process.exit(0);
} else {
  console.error(`modo desconhecido: ${mode}`);
  process.exit(2);
}

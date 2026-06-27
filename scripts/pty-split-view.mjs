// EST-0990 — prova de RENDER sob PTY do MODO VIEW AVANÇADO (split CHAT | LOG, V2).
//
// Usa a MESMA wiring de produção (buildSession) + broker MOCKADO por sessão (o mesmo
// padrão do smoke-subagents) p/ rodar um objetivo que dispara 3 SUB-AGENTES paralelos.
// Ao fim do turno a `FlowTree` tem root + 3 filhos COM atividade (tokens/tempo/tool-
// calls) — então renderiza o App em SPLIT (initialSplitView:true) e deixa o Ink pintar:
// a coluna esquerda (CHAT, sufixo vivo) e a direita (LOG agrupado por agente, lendo a
// projeção REDIGIDA da FlowTree). Prova: lado-a-lado, sem sujeira/flicker, log agrupado.
//
// Rodar via PTY: `script -qec 'node scripts/pty-split-view.mjs' /tmp/cap` (aloca TTY).
// Sem TTY o Ink ainda renderiza (não-raw), suficiente p/ a captura do frame.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink';
import { buildSession } from '../packages/cli/dist/session/wiring.js';
import { ThemeProvider } from '../packages/cli/dist/ui/theme/context.js';
import { resolveTheme } from '../packages/cli/dist/ui/theme/theme.js';
import { App } from '../packages/cli/dist/session/App.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
const toolCall = (name, input) => `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;

const CHILD_REPORTS = {
  rust: 'Rust: seguranca de memoria sem GC via ownership/borrow checker.',
  go: 'Go: goroutines e runtime simples, concorrencia leve.',
  zig: 'Zig: minimalista, sem alocacoes ocultas, comptime, interop com C.',
};

const counts = new Map();
let parentSession = null;
function scriptFor(sessionId, turn, labelHint) {
  if (parentSession === null) parentSession = sessionId;
  if (sessionId === parentSession) {
    if (turn === 0) {
      return (
        'vou pesquisar 3 linguagens EM PARALELO.\n' +
        toolCall('spawn_agent', {
          agents: [
            { label: 'rust', goal: 'pesquise a linguagem Rust' },
            { label: 'go', goal: 'pesquise a linguagem Go' },
            { label: 'zig', goal: 'pesquise a linguagem Zig' },
          ],
        })
      );
    }
    return 'Comparei Rust, Go e Zig com base nos relatorios. Objetivo concluido.';
  }
  return CHILD_REPORTS[labelHint] ?? `relatorio da sessao ${sessionId.slice(0, 6)}.`;
}

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
    const turn = counts.get(sessionId) ?? 0;
    counts.set(sessionId, turn + 1);
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

const ws = mkdtempSync(join(tmpdir(), 'aluy-0990-pty-'));
const built = buildSession({
  workspaceRoot: ws,
  store: fakeStore,
  brokerFetch: makeMockFetch(),
  mode: 'unsafe',
  tier: 'aluy-strata',
  subAgents: { enabled: true, maxConcurrency: 3 },
  env: { ALUY_BROKER_URL: 'https://broker.mock.local', ALUY_IDENTITY_URL: 'https://id.mock.local' },
});

built.controller.dismissBoot();
// roda o turno: ao fim, a FlowTree tem root + 3 filhos com atividade (tokens/tempo).
await built.controller.submit('pesquise 3 linguagens em paralelo e compare');

// Largura forçada (o PTY do `script` nem sempre herda COLUMNS): mira o modo SIDE
// (≥100 col). `ALUY_PTY_COLS` ajusta p/ provar tabs (70) / desabilitado (50).
const cols = Number.parseInt(process.env.ALUY_PTY_COLS ?? '120', 10);
if (Number.isFinite(cols) && cols > 0) {
  Object.defineProperty(process.stdout, 'columns', { value: cols, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 40, configurable: true });
}

const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
const { unmount, waitUntilExit } = render(
  React.createElement(
    ThemeProvider,
    { theme },
    React.createElement(App, {
      controller: built.controller,
      animate: false,
      bootMs: 0,
      initialSplitView: true,
    }),
  ),
  { exitOnCtrlC: false },
);

setTimeout(() => {
  unmount();
  rmSync(ws, { recursive: true, force: true });
  process.exit(0);
}, 700);

await waitUntilExit().catch(() => {});

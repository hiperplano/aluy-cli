#!/usr/bin/env node
// ADR 0006 — mede, SEM enviar nada ao modelo, o request que o Concierge monta por mensagem:
// system prompt + schemas das 4 tools + digest + histórico. Tokens = chars/3.5 (estimativa).
//
// Uso (após `npm run build`): node scripts/medir-concierge.mjs [--tarefas 3] [--fatos 4] [--json]
import {
  CONCIERGE_TOOLS,
  TaskRegistry,
  buildConciergePrompt,
  buildDigest,
} from '@hiperplano/aluy-cli-core';

const args = process.argv.slice(2);
const val = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : d;
};
const CPT = 3.5;
const tok = (c) => Math.ceil(c / CPT);

const nTasks = val('--tarefas', 3);
const nFacts = val('--fatos', 4);
const facts = Array.from(
  { length: nFacts },
  (_, i) =>
    `preferência do dono número ${i + 1}: sempre delegue trabalho a tarefas e responda curto`,
);
const system = buildConciergePrompt({
  ownerFacts: facts,
  projectSummary: 'Monorepo TypeScript (npm workspaces): engine portátil + TUI Ink.'.repeat(8),
});

const reg = new TaskRegistry();
for (let i = 0; i < nTasks; i++) {
  reg.create({
    goal: `refatorar o módulo ${i} e atualizar os testes que dependem dele, conferindo a tipagem`,
    kind: i === 0 ? 'main' : 'detached',
    files: [`src/mod${i}.ts`],
  });
  reg.note(`t${i + 1}`, 'step');
}
reg.transition('t1', 'done', undefined, {
  summary: 'refatorei o módulo 0; 14 testes passam; tipagem ok',
});
const digest = buildDigest({
  tasks: reg.list(),
  events: reg.recentEvents(),
  engine: {
    subAgents: [],
    approvals: [{ taskId: 't2', summary: 'run_command: $ npm test' }],
    quotaPauses: [],
  },
  now: Date.now() + 90_000,
});
const history = Array.from({ length: 8 }, (_, i) =>
  i % 2 === 0
    ? 'mensagem do dono com uns vinte e poucos caracteres'
    : 'resposta curta do Concierge em uma ou duas linhas',
);
const toolsJson = JSON.stringify(CONCIERGE_TOOLS);
const userMsg = `<estado>\n${digest}\n</estado>\n\nMensagem do dono: como está a t2?`;

const parts = {
  system: system.length,
  tools: toolsJson.length,
  digest: userMsg.length,
  historico: history.join('').length,
};
const total = Object.values(parts).reduce((a, b) => a + b, 0);
const out = {
  tarefas: nTasks,
  fatos: nFacts,
  chars: parts,
  tokens: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, tok(v)])),
  totalTokens: tok(total),
  metaTokens: 3000,
  dentroDaMeta: tok(total) <= 3000,
};
if (args.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`Concierge — request por mensagem (estimativa chars/${CPT})`);
  for (const [k, v] of Object.entries(out.tokens))
    console.log(`  ${k.padEnd(10)} ${String(v).padStart(5)} tokens`);
  console.log(
    `  ${'TOTAL'.padEnd(10)} ${String(out.totalTokens).padStart(5)} tokens (meta ≤ ${out.metaTokens}) ${out.dentroDaMeta ? 'OK' : 'ACIMA'}`,
  );
}

#!/usr/bin/env node
// Mede, SEM enviar nada ao modelo, o tamanho do request que o Aluy montaria para a
// 1a mensagem de uma sessao (system prompt + schemas de tools + historico).
//
// Uso (apos `npm run build`):
//   node scripts/medir-prompt.mjs [--sem-mcp] [--tier custom] [--provider zai-coding]
//        [--model glm-5.3] [--msg "responda apenas: ok"] [--dump <arquivo.json>]
//        [--chars-por-token 3.5] [--calibrar <tokens reais do provider>] [--json]
//
// - Monta o MESMO conjunto de tools do controller (NATIVE + WEB + memoria + monitor +
//   rooms + session_command + spawn_agent/agents_*), e (sem --sem-mcp) conecta nos
//   servers de ~/.aluy/mcp.json via o `setupMcp` real (lanca os processos, como o boot).
// - Usa `buildMessages` real (o system prompt de verdade) e `toToolFunctionSchemas`
//   real (o campo `tools` de verdade).
// - Tokens: ESTIMATIVA chars/3.5 (nao ha tokenizer real como dependencia). Use
//   `--calibrar N` (tokens_in reais reportados pelo provider) para ver o fator.
// - `--dump` grava o corpo do request (messages + tools). Nao le nem imprime env/segredos.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d;
};
const CPT = Number(val('--chars-por-token', '3.5'));
const tokN = (chars) => Math.ceil(chars / CPT);

const core = await import('@hiperplano/aluy-cli-core');
const root = new URL('../packages/cli/dist/', import.meta.url);
const { buildSessionCommandsNote } = await import(new URL('slash/commands.js', root));
const { setupMcp } = await import(new URL('mcp/setup.js', root));

const cwd = mkdtempSync(join(tmpdir(), 'aluy-medir-'));
const tier = val('--tier', 'custom');
const runtime = { provider: val('--provider', 'zai-coding'), model: val('--model', 'glm-5.3') };
const msg = val('--msg', 'responda apenas: ok');

// ---- tools (espelha controller.ts ~1945) ----
const monitorTools = core.buildMonitorTools(new core.MonitorStore(), new core.EventQueue(), () =>
  new Date().toISOString(),
);
const roomTools = core.buildRoomTools({
  store: new core.MemoryRoomStore(),
  writerId: 'self',
  policyFor: () => ({ writers: [], maxHops: 10 }),
  now: () => 0,
  genMsgId: () => 'm',
});
const base = [
  ...core.NATIVE_TOOLS,
  ...core.WEB_TOOLS,
  core.rememberTool,
  core.recallTool,
  ...monitorTools,
  ...roomTools,
];
const extra = [
  core.sessionCommandTool,
  core.spawnAgentTool,
  core.agentsStatusTool,
  core.agentsStopTool,
  core.agentSendTool,
];

let mcpTools = [];
let mcpClose = async () => {};
if (!flag('--sem-mcp')) {
  const s = await setupMcp({ workspaceRoot: cwd });
  mcpTools = s.tools;
  mcpClose = () => s.close();
  for (const r of s.discovery.servers ?? [])
    if (!r.ok) console.error(`[aviso] server MCP "${r.server}" nao conectou`);
}
const tools = [...base, ...mcpTools, ...extra];

const note = buildSessionCommandsNote();
const history = [{ role: 'goal', text: msg }];
const build = (ts, t = tier, rt = runtime, roots = [cwd], sc = note) =>
  core.buildMessages(ts, history, undefined, roots, undefined, sc, t, rt);
const sys = (...a) => build(...a)[0].content;

const full = sys(tools);
const schemas = core.toToolFunctionSchemas(tools);
const schemasChars = JSON.stringify(schemas).length;

const skeleton = sys([]).length;
const out = {
  config: { tier, runtime, mensagem: msg, charsPorToken: CPT, nTools: tools.length },
  secoes: [],
};
const S = (secao, chars, estavel, nota = '') =>
  out.secoes.push({ secao, chars, tokens: tokN(chars), estavel, nota });

S('system: esqueleto (regras, mapa, MCP, cron, seguranca)', skeleton, 'sim');
S(
  'system: docs de tools em TEXTO (descricao+params)',
  full.length - skeleton,
  'sim',
  'duplica o campo tools',
);
S(
  '  dentro disso: few-shot tier fraco',
  full.length - sys(tools, '').length,
  'sim',
  `tier=${tier}`,
);
S('  dentro disso: runtime (provider/modelo)', full.length - sys(tools, tier, {}).length, 'sim');
S('  dentro disso: raizes autorizadas', full.length - sys(tools, tier, runtime, []).length, 'sim');
S(
  '  dentro disso: comandos de sessao',
  full.length - sys(tools, tier, runtime, [cwd], '').length,
  'sim',
);
S(
  'campo `tools` (JSON schemas nativos)',
  schemasChars,
  'sim',
  'enviado alem do texto se supports_tools',
);
S('mensagem do usuario', msg.length, 'n/a');

const grp = (t) => (t.name.startsWith('mcp__') ? 'mcp:' + t.name.split('__')[1] : 'nativas');
const groups = new Map();
for (const t of tools) groups.set(grp(t), [...(groups.get(grp(t)) ?? []), t]);
out.porGrupo = [...groups].map(([g, ts]) => ({
  grupo: g,
  tools: ts.length,
  tokensTexto: tokN(full.length - sys(tools.filter((t) => !ts.includes(t))).length),
  tokensSchema: tokN(JSON.stringify(core.toToolFunctionSchemas(ts)).length),
}));
out.porTool = tools
  .map((t) => ({
    nome: t.name,
    tokensSchema: tokN(JSON.stringify(core.toToolFunctionSchema(t)).length),
  }))
  .sort((a, b) => b.tokensSchema - a.tokensSchema);

const soma = full.length + schemasChars + msg.length;
out.total = {
  systemTokens: tokN(full.length),
  toolsFieldTokens: tokN(schemasChars),
  somaTokensEstimados: tokN(soma),
};
const cal = val('--calibrar');
if (cal) out.total.fatorCalibracao = Number(cal) / out.total.somaTokensEstimados;

const dump = val('--dump');
if (dump)
  writeFileSync(
    dump,
    JSON.stringify({ messages: build(tools), tools: schemas, tool_choice: 'auto' }, null, 1),
  );
await mcpClose();

if (flag('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`# tokens estimados (chars/${CPT})  tier=${tier}  tools=${tools.length}`);
  const pct = (n) => ((100 * n) / out.total.somaTokensEstimados).toFixed(1) + '%';
  for (const s of out.secoes)
    console.log(
      `${String(s.tokens).padStart(7)}  ${pct(s.tokens).padStart(6)}  ${s.secao}  ${s.nota}`,
    );
  console.log('\n# por grupo (texto no system | schema no campo tools)');
  for (const g of out.porGrupo)
    console.log(
      `${g.grupo.padEnd(28)} ${String(g.tools).padStart(3)} tools  texto=${g.tokensTexto}  schema=${g.tokensSchema}`,
    );
  console.log('\n# top 15 tools por schema');
  for (const t of out.porTool.slice(0, 15))
    console.log(`${String(t.tokensSchema).padStart(6)}  ${t.nome}`);
  console.log('\n# total', out.total);
}
process.exit(0);

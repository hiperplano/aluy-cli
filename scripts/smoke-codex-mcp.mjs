// EST-0979 (FU-S3-CODEX-TOML) — SMOKE REAL: um `~/.codex/config.toml` com um server MCP
// é DESCOBERTO pelo Aluy e suas tools entram no toolset ATRÁS da catraca.
//
// Prova de ponta-a-ponta com a wiring de produção (CodexMcpConfigStore real → parser
// TOML real → mergeMcpConfigs → setupMcp → StdioMcpTransport REAL lançando um server
// MCP de stdio de verdade → adapt → catraca):
//   1. Cria um `~/.codex/config.toml` REAL (em tmpdir) com `[mcp_servers.codexdemo]`
//      apontando p/ o fixture echo-env-server.mjs (server MCP de stdio de verdade).
//   2. `setupMcp({ loadCodexConfig: () => new CodexMcpConfigStore(...).load() })`.
//   3. Confirma que as tools do server do CODEX aparecem PREFIXADAS (`mcp__codexdemo__*`).
//   4. Confirma que cada tool passa pela catraca como EFEITO ⇒ `ask` (não relaxa).
//   5. CLI-SEC-7: chama a tool e confirma que o server NÃO viu `ALUY_TOKEN` do pai.
//
// Rodar:  npm run build  &&  node scripts/smoke-codex-mcp.mjs

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupMcp, CodexMcpConfigStore } from '../packages/cli/dist/mcp/index.js';
import { PolicyPermissionEngine } from '../packages/cli-core/dist/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(
  HERE,
  '..',
  'packages',
  'cli',
  'tests',
  'mcp',
  'fixtures',
  'echo-env-server.mjs',
);

function assert(cond, msg) {
  if (!cond) {
    console.error(`✗ SMOKE FALHOU: ${msg}`);
    process.exit(1);
  }
  console.log(`✓ ${msg}`);
}

const base = mkdtempSync(join(tmpdir(), 'aluy-smoke-codex-'));
const codexHome = join(base, '.codex');
mkdirSync(codexHome, { recursive: true });

// (1) `~/.codex/config.toml` REAL com um server MCP declarado em [mcp_servers] (TOML).
//     Inclui chaves FORA do nosso subconjunto (model/approval_policy) p/ provar que o
//     parser confinado as IGNORA sem quebrar. `process.execPath` lança o fixture .mjs.
const configToml = `# config global do Codex (simulado p/ o smoke)
model = "gpt-5"
approval_policy = "on-request"

[tui]
theme = "dark"

[mcp_servers.codexdemo]
command = ${JSON.stringify(process.execPath)}
args = [${JSON.stringify(SERVER)}]

[profiles.work]
model = "gpt-5-codex"
`;
writeFileSync(join(codexHome, 'config.toml'), configToml);

let setup;
try {
  // (2) Mesma wiring de produção: o store REAL lê o TOML REAL e devolve o McpConfig.
  //     parentEnv inclui ALUY_TOKEN p/ provar o CLI-SEC-7 (o server não deve vê-lo).
  const codexStore = new CodexMcpConfigStore({ baseDir: codexHome });
  const codexLoaded = codexStore.load();
  assert(codexLoaded.error === undefined, 'config.toml do Codex parseou sem erro');
  assert(
    codexLoaded.config.servers.length === 1 && codexLoaded.config.servers[0].name === 'codexdemo',
    'CodexMcpConfigStore descobriu o server "codexdemo" do config.toml (subconjunto [mcp_servers])',
  );

  setup = await setupMcp({
    workspaceRoot: base,
    parentEnv: { ...process.env, ALUY_TOKEN: 'svc_secret_smoke' },
    loadCodexConfig: () => codexStore.load(),
  });

  // (3) As tools do server do CODEX aparecem, PREFIXADAS pelo nome do server.
  const names = setup.tools.map((t) => t.name).sort();
  console.log(`   tools descobertas: ${names.join(', ')}`);
  assert(
    names.includes('mcp__codexdemo__whoami_env'),
    'tool do server do Codex aparece prefixada (mcp__codexdemo__whoami_env)',
  );
  assert(
    names.includes('mcp__codexdemo__echo_injection'),
    'demais tools do server do Codex também aparecem',
  );
  assert(
    setup.tools.every((t) => t.effect === 'mcp'),
    'toda tool MCP do Codex é classificada como efeito (mcp)',
  );

  // (4) Catraca: usar uma tool do Codex é EFEITO ⇒ `ask` (config do Codex NÃO relaxa).
  const engine = new PolicyPermissionEngine();
  const verdict = engine.decide({ name: 'mcp__codexdemo__whoami_env', input: {} });
  assert(
    verdict.decision === 'ask',
    'tool do Codex passa pela MESMA catraca como efeito ⇒ ask (não auto-pluga)',
  );

  // (5) CLI-SEC-7: chama a tool real; o server NÃO deve ter visto ALUY_TOKEN do pai.
  const tool = setup.tools.find((t) => t.name === 'mcp__codexdemo__whoami_env');
  const res = await tool.run({});
  assert(
    res.ok && res.observation.includes('(vazio)') && !res.observation.includes('svc_secret_smoke'),
    'CLI-SEC-7: o server do Codex NÃO viu ALUY_TOKEN (echo $ALUY_TOKEN ⇒ vazio)',
  );

  console.log('\n✓✓ SMOKE OK — server do ~/.codex/config.toml plugado e ATRÁS da catraca.');
} finally {
  await setup?.close();
  rmSync(base, { recursive: true, force: true });
}

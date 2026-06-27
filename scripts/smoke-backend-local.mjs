// ADR-0117 / EST-1113 — PROVA E2E do BACKEND LOCAL (BYO). Duas provas com socket REAL:
//
//  PROVA 1 (anti-SSRF · PROV-SEC-1, BINÁRIO REAL): roda o binário `aluy` com
//    `--backend local --local-base-url http://127.0.0.1:.../api/v1` e mostra que a
//    catraca anti-SSRF RECUSA o base_url interno ANTES de qualquer chamada — a defesa
//    NET-NEW do gate do `seguranca` funcionando no processo real.
//
//  PROVA 2 (happy-path, ESTRATÉGIA REAL sobre SOCKET REAL): monta o LocalModelClient
//    EXATAMENTE como o wiring de produção (buildLocalModelClient → adapter OpenAI →
//    SSE), com a credencial BYO da env, contra um provider stand-in HTTP local. O
//    anti-SSRF é satisfeito com um RESOLVER injetado que mapeia o host do mock p/ um
//    IP público (o MESMO contrato de porta que o wiring usa; em produção é o DNS real)
//    — provando que `--backend local` chama o provider DIRETO com a chave BYO e
//    devolve a resposta, ponta-a-ponta, sem broker.
//
//  Para a "saída real do Claude" do gate, o Tiago roda (mesma via, chave real):
//    OPENROUTER_API_KEY=sk-or-... node packages/cli/dist/bin/aluy.js \
//      --backend local --local-provider openrouter \
//      --local-model 'anthropic/claude-3.5-sonnet' -p "responda só: pong"
//    (ou ANTHROPIC_API_KEY + --local-provider anthropic --local-model claude-opus-4-8)
//
// Rodar:  npm run build  &&  node scripts/smoke-backend-local.mjs

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildLocalModelClient } from '../packages/cli/dist/model/local/factory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, '..', 'packages', 'cli', 'dist', 'bin', 'aluy.js');
const TMP_HOME = mkdtempSync(join(tmpdir(), 'aluy-e2e-home-'));

const REPLY = 'pong (backend local — provider direto, credencial BYO)';
const EXPECTED_KEY = 'sk-or-test-byo-key-12345'; // gitleaks:allow — chave SINTÉTICA do smoke (não é segredo real)

// ── provider stand-in: OpenAI-compat /chat/completions em SSE ──────────────────
let capturedAuth = null;
let capturedBody = null;
const server = createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.statusCode = 404;
    res.end('nope');
    return;
  }
  capturedAuth = req.headers['authorization'] ?? null;
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    capturedBody = JSON.parse(raw);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    for (const word of REPLY.split(' ')) {
      chunk({
        id: 'cmpl-x',
        model: capturedBody.model,
        choices: [{ delta: { content: word + ' ' } }],
      });
    }
    chunk({
      id: 'cmpl-x',
      model: capturedBody.model,
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 9 },
    });
    res.write('data: [DONE]\n\n');
    res.end();
  });
});

function listen() {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

// ── PROVA 1 — anti-SSRF no BINÁRIO REAL (loopback base_url ⇒ recusado) ─────────
function runBinaryAntiSsrf(port) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [
        BIN,
        '--backend',
        'local',
        '--local-provider',
        'openrouter',
        '--local-model',
        'anthropic/claude-3.5-sonnet',
        '--local-base-url',
        `http://127.0.0.1:${port}/api/v1`,
        '-p',
        'diga pong',
      ],
      {
        env: {
          ...process.env,
          HOME: TMP_HOME,
          OPENROUTER_API_KEY: EXPECTED_KEY,
          ALUY_TOKEN: '',
          NO_COLOR: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const fails = [];
const port = await listen();

// PROVA 1
const bin = await runBinaryAntiSsrf(port);
console.log('=== PROVA 1 — anti-SSRF (PROV-SEC-1) no binário real ===');
console.log(
  'comando: aluy --backend local --local-base-url http://127.0.0.1:' +
    port +
    '/api/v1 -p "diga pong"',
);
console.log('exit:', bin.code, '| stderr:', bin.err.trim().split('\n').slice(-1)[0]);
if (bin.code === 0)
  fails.push('PROVA 1: o binário NÃO recusou um base_url loopback (anti-SSRF furou!)');
if (!/anti-SSRF|interno|PROV-SEC-1|loopback/i.test(bin.err))
  fails.push('PROVA 1: recusa sem mencionar o motivo anti-SSRF');

// ── PROVA 2 — happy-path: estratégia real + socket real (anti-SSRF satisfeito) ──
// Resolver injetado: mapeia 127.0.0.1 (host do mock) p/ um IP público (8.8.8.8) só
// p/ a VALIDAÇÃO; o socket conecta no host real do base_url (o mock local). É o
// MESMO contrato `HostResolver` que o wiring usa — em produção é o DNS real.
const publicResolver = { resolve: async () => ['8.8.8.8'] };
const client = await buildLocalModelClient({
  provider: 'openrouter',
  model: 'anthropic/claude-3.5-sonnet',
  // hostname `localhost` (não IP-literal): a VALIDAÇÃO usa o resolver injetado
  // (→público); o SOCKET conecta via DNS real (localhost→127.0.0.1→mock). Espelha
  // produção, onde o host é público e o DNS real o resolve.
  baseUrl: `http://localhost:${port}/api/v1`,
  env: { OPENROUTER_API_KEY: EXPECTED_KEY },
  resolver: publicResolver,
});
const result = await client.call({
  request: { tier: 'aluy-flux', messages: [{ role: 'user', content: 'diga pong' }] },
  idempotencyKey: 'e2e-1',
});
server.close();

console.log('\n=== PROVA 2 — happy-path (LocalModelClient real → SSE real por socket) ===');
console.log('resposta REAL do provider via backend local:', JSON.stringify(result.content));
console.log('finish_reason:', result.finish_reason, '| usage:', JSON.stringify(result.usage));
console.log(
  'auth recebido pelo provider:',
  capturedAuth === `Bearer ${EXPECTED_KEY}` ? 'Bearer <BYO key OK>' : 'INESPERADO',
);
console.log('model enviado:', capturedBody?.model, '| stream:', capturedBody?.stream);

if (!result.content.includes('pong')) fails.push('PROVA 2: a resposta do provider não voltou');
if (result.finish_reason !== 'stop') fails.push('PROVA 2: finish_reason inesperado');
if (capturedAuth !== `Bearer ${EXPECTED_KEY}`)
  fails.push('PROVA 2: a credencial BYO não chegou no Authorization');
if (capturedBody?.model !== 'anthropic/claude-3.5-sonnet') fails.push('PROVA 2: model errado');
if (capturedBody?.stream !== true) fails.push('PROVA 2: stream não foi pedido');
if (result.usage?.tokens_in !== 11 || result.usage?.tokens_out !== 9)
  fails.push('PROVA 2: usage não normalizado');

if (fails.length > 0) {
  console.error('\n✗ FALHOU:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log(
  '\n✓ PROVA E2E OK — anti-SSRF recusa base_url interno (binário real) E o backend local chama o provider DIRETO com a credencial BYO e devolve a resposta (sem broker).',
);

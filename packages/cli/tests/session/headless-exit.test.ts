// EST-1007 (HANG) — REGRESSÃO ponta-a-ponta: `aluy -p` (e o posicional não-TTY) DEVE
// SAIR mesmo com um SERVER MCP stdio configurado/vivo. O #154 introduziu o `-p`; o hang
// só aparecia quando havia um server MCP em `~/.aluy/mcp.json` (na frota: `everything`/
// `playwright`): o boot lança o filho stdio, faz o handshake, e o filho fica VIVO —
// pinando o event-loop. O ramo não-TTY NÃO chamava `mcpSetup.close()` ⇒ o processo
// terminava o trabalho (objetivo respondido, resultado impresso) mas NUNCA encerrava.
//
// O teste do #154 NÃO pegou isto porque injetava `mcpTools:[]`, o que CURTO-CIRCUITA o
// `setupMcp` (zero spawn). Aqui rodamos o BINÁRIO REAL com:
//   • um SERVER MCP stdio REAL (fixture `mcp-stub-server.mjs`) em `~/.aluy/mcp.json`
//     (HOME tmp) — o filho que pinava o loop;
//   • um BROKER STUB HTTP (sem rede/sem modelo real) — `ALUY_BROKER_URL` → ele;
//   • `ALUY_TOKEN` semeando a credencial (sem keychain/login).
// e EXIGIMOS que o processo SAIA dentro do timeout (não seja morto). Sem o fix, o spawn
// não encerra e o teste FALHA por timeout (kill) — exatamente o bug do usuário.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'dist', 'bin', 'aluy.js');
const MCP_FIXTURE = join(HERE, '..', 'fixtures', 'mcp-stub-server.mjs');

// Teto generoso (spawn de filho MCP real + handshake). Se o processo NÃO encerrar
// dentro disto, é o HANG: matamos e o teste FALHA (não mascara).
// F66 — 20s era APERTADO sob a suíte CHEIA: com os workers paralelos do vitest a
// máquina fica sobre-inscrita, o boot+handshake do binário REAL passa de 20s e o
// killer interno disparava classificando um processo LENTO como HANG (falso
// positivo "processo PENDUROU"). 45s dá folga p/ contenção SEM perder a detecção
// de hang — um hang genuíno NUNCA encerra, logo é morto em qualquer teto finito.
const EXIT_TIMEOUT_MS = 45_000;

/** Resultado de uma execução do binário: como/quando saiu. */
interface RunResult {
  /** exit code (≠null = saiu sozinho) ou null se foi MORTO por timeout (= HANG). */
  code: number | null;
  /** true se tivemos de MATAR o processo (não encerrou) — a falha que queremos pegar. */
  killed: boolean;
  stdout: string;
  stderr: string;
}

/** Roda o binário e RESOLVE quando ele encerra — ou o mata após o timeout (hang). */
function runBinary(args: string[], env: NodeJS.ProcessEnv, stdin: string): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    // O runner de CI seta `FORCE_COLOR`, que VENCE `NO_COLOR` — removemos p/ a saída
    // ficar limpa/determinística (o `NO_COLOR` do env do teste então vale de fato).
    const childEnv = { ...process.env, ...env };
    delete childEnv.FORCE_COLOR;
    const child = spawn(process.execPath, [BIN, ...args], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL'); // o hang: o processo não encerrou sozinho.
    }, EXIT_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, stdout, stderr });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('binário aluy — EXIT em não-TTY com MCP vivo (EST-1007 HANG)', () => {
  let broker: Server;
  let brokerUrl: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeAll(async () => {
    // Broker STUB: responde `/v1/chat` em SSE (start/delta/usage/done) e qualquer
    // outra rota (tiers/quota/custom) com um 200 vazio. Sem rede/sem modelo real.
    broker = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if ((req.url ?? '').startsWith('/v1/chat')) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: start\ndata: {"id":"r"}\n\n');
          res.write('event: delta\ndata: {"content":"PRONTO"}\n\n');
          res.write('event: usage\ndata: {"input_tokens":"1","output_tokens":"1"}\n\n');
          res.write('event: done\ndata: {}\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"tiers":[],"models":[],"windows":[]}');
      });
    });
    await new Promise<void>((r) => broker.listen(0, '127.0.0.1', r));
    const addr = broker.address();
    if (addr === null || typeof addr === 'string') throw new Error('broker stub sem porta');
    brokerUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => broker.close(() => r()));
  });

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'hl-exit-home-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'hl-exit-ws-'));
    // `~/.aluy/mcp.json` com um SERVER stdio REAL (a fixture). É o filho que pinava o
    // event-loop e travava o `-p`/posicional antes do fix.
    mkdirSync(join(homeDir, '.aluy'), { recursive: true });
    writeFileSync(
      join(homeDir, '.aluy', 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_FIXTURE] },
        },
      }),
    );
  });

  afterEach(() => {
    for (const d of [homeDir, workspaceDir]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  const env = (): NodeJS.ProcessEnv => ({
    HOME: homeDir,
    USERPROFILE: homeDir,
    ALUY_BACKEND: 'broker', // este teste exercita o caminho headless via broker (stub abaixo).
    ALUY_MEM_OFF: '1', // mem0 é independente do maestro (kill-switch próprio)
    ALUY_MAESTRO_OFF: '1', // turbo OFF (mem0/headroom) → hermético no CI sem serviços
    ALUY_BROKER_URL: brokerUrl,
    // PAT SINTÉTICO com FORMATO válido (`pat_<32hex>_<secret>`): o fallback de env
    // do `getAccessToken` VALIDA o formato (`isPat`) — o antigo 'stub-token' reprovava
    // e o binário morria em "sem credencial" (a razão de estes testes terem sido
    // EXCLUÍDOS da CI — exclusão removida junto com este fix; ver ci.yml).
    ALUY_TOKEN: 'pat_0123456789abcdef0123456789abcdef_stub-secret', // semeia a credencial (sem keychain/login).
    NO_COLOR: '1',
    // Confina o cwd do agente no workspace tmp (sessões/journal no HOME tmp).
  });

  it(
    '`aluy -p "x"` com MCP vivo SAI (não pendura) e imprime SÓ o resultado',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const r = await runBinary(['-p', 'diga pronto', '--tier', 'aluy-flux'], env(), '');
      // O CORAÇÃO do teste: NÃO pode ter sido morto por timeout (= o hang do bug).
      expect(r.killed, `processo PENDUROU (hang) — stderr: ${r.stderr}`).toBe(false);
      expect(r.code).toBe(0);
      // Saída LIMPA: só o resultado do assistente, sem chrome rotulado.
      expect(r.stdout.trim()).toBe('PRONTO');
      expect(r.stdout).not.toMatch(/\[aluy\]|\[tool\]|\[você\]/);
    },
  );

  it(
    '`echo … | aluy -p` (stdin) com MCP vivo SAI',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const r = await runBinary(['-p', '--tier', 'aluy-flux'], env(), 'diga pronto via stdin');
      expect(r.killed, `processo PENDUROU (hang) — stderr: ${r.stderr}`).toBe(false);
      expect(r.code).toBe(0);
      expect(r.stdout.trim()).toBe('PRONTO');
    },
  );

  it(
    '`aluy "x"` posicional não-TTY com MCP vivo SAI (não regride o caminho que funcionava)',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const r = await runBinary(['diga pronto', '--tier', 'aluy-flux'], env(), '');
      expect(r.killed, `processo PENDUROU (hang) — stderr: ${r.stderr}`).toBe(false);
      expect(r.code).toBe(0);
      // O posicional MANTÉM o chrome rotulado (`[você]`/`[aluy]`) — não é o headless.
      expect(r.stdout).toMatch(/\[aluy\]/);
    },
  );
});

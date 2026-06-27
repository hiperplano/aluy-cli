// EST-1011 · ADR-0065 §11.2 (E-B3 / FU-VAU-11-bis) — PROVA DE SO REAL: o processo-
// server MCP roda DENTRO do sandbox de `bwrap`. Lança um server MCP de stdio de
// verdade (SDK oficial) ATRAVÉS do `BwrapSandboxLauncher` e afirma os invariantes do
// confinamento PARA O PROCESSO-SERVER:
//
//   • HANDSHAKE: `connect()` (initialize + listTools) e `callTool` completam ATRAVÉS
//     do sandbox — o JSON-RPC flui pelos fds 0/1/2 que passam intocados ao bwrap.
//   • (a) FS: o server confinado NÃO lê ~/.ssh / ~/.aws / ~/.aluy / $HOME (ENOENT),
//     MAS lê o arquivo do WORKSPACE (opera em arquivos do projeto).
//   • (d) NET-DENY default: o server SEM aprovação de rede NÃO conecta (socket falha).
//   • FLAG OFF (sem launcher) ⇒ caminho atual intocado (server cru, lê o segredo).
//   • Fail-mode D-SB-4: sem piso ⇒ degrade (dev) / refuse (prod) — NUNCA finge.
//
// HONESTIDADE (DoD): onde a máquina NÃO tem bwrap/userns, NÃO pulamos — provamos o
// FAIL-MODE (degrade/refuse), nunca fingimos confinamento. Cada teste roda algo.

import { describe, expect, it, beforeAll, afterAll, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { StdioMcpTransport } from '../../src/mcp/stdio-transport.js';
import { BwrapSandboxLauncher, detectSandboxCapability } from '../../src/sandbox/index.js';
import type { McpServerConfig } from '@hiperplano/aluy-cli-core';
import { floorAvailable } from '@hiperplano/aluy-cli-core';

const SERVER = fileURLToPath(new URL('./fixtures/sandbox-probe-server.mjs', import.meta.url));

const cap = detectSandboxCapability();
const FLOOR = floorAvailable(cap);

let base: string;
let ws: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-mcp-sb-it-'));
  ws = join(base, 'project');
  mkdirSync(ws, { recursive: true });
  // arquivo do workspace que o server DEVE ler (ele opera em arquivos do projeto).
  writeFileSync(join(ws, 'inside.txt'), 'workspace-visible');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function serverConfig(): McpServerConfig {
  return { name: 'probe', command: process.execPath, args: [SERVER], env: {} };
}

function launcher(env: 'dev' | 'prod' = 'dev', unsafeNoSandbox = false): BwrapSandboxLauncher {
  return new BwrapSandboxLauncher({ capability: cap, env, unsafeNoSandbox });
}

// ── Caminho CONFINADO (só roda com piso de SO real) ─────────────────────────────
describe.runIf(FLOOR)(
  'processo-server MCP confinado via bwrap (piso real)',
  () => {
    let transport: StdioMcpTransport | undefined;
    afterEach(async () => {
      await transport?.close();
      transport = undefined;
    });

    it('HANDSHAKE: initialize + listTools completam ATRAVÉS do sandbox', async () => {
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv: process.env,
        sandboxLauncher: launcher('dev'),
        workspaceRoots: [ws],
      });
      const tools = await transport.connect(serverConfig());
      const names = tools.map((t) => t.name).sort();
      // o handshake correu confinado: as tools do server foram descobertas.
      expect(names).toContain('read_path');
      expect(names).toContain('try_connect');
    });

    it('(a) FS: lê o arquivo do WORKSPACE através do sandbox (callTool flui confinado)', async () => {
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv: process.env,
        sandboxLauncher: launcher('dev'),
        workspaceRoots: [ws],
      });
      await transport.connect(serverConfig());
      const r = await transport.callTool('read_path', { path: join(ws, 'inside.txt') });
      expect(r.ok).toBe(true);
      expect(r.content).toBe('READ_OK:workspace-visible');
    });

    it('(a) FS: o server confinado NÃO lê ~/.ssh / ~/.aws / ~/.aluy / $HOME (ENOENT)', async () => {
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv: process.env,
        sandboxLauncher: launcher('dev'),
        workspaceRoots: [ws],
      });
      await transport.connect(serverConfig());
      const home = homedir();
      for (const secret of [
        join(home, '.ssh', 'id_rsa'),
        join(home, '.aws', 'credentials'),
        join(home, '.aluy', 'config.json'),
      ]) {
        const r = await transport.callTool('read_path', { path: secret });
        // o segredo é INALCANÇÁVEL por namespace de mount — ENOENT, não o conteúdo.
        expect(r.content.startsWith('READ_ERR:'), `${secret} ⇒ ${r.content}`).toBe(true);
        expect(r.content).not.toContain('READ_OK');
      }
    });

    it('(d) NET-DENY default: o server SEM aprovação de rede NÃO conecta', async () => {
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv: process.env,
        sandboxLauncher: launcher('dev'),
        workspaceRoots: [ws],
        // network NÃO declarado ⇒ default false (net-deny). NÃO damos --share-net.
      });
      await transport.connect(serverConfig());
      const r = await transport.callTool('try_connect', { host: '1.1.1.1', port: 80 });
      // socket inalcançável dentro do net-namespace isolado — NUNCA "CONNECTED".
      expect(r.content).not.toContain('CONNECTED');
      expect(r.content.startsWith('CONN_ERR:')).toBe(true);
    });

    it('CLI-SEC-7 (sob sandbox): o server NÃO vê ALUY_TOKEN', async () => {
      const parentEnv = { ...process.env, ALUY_TOKEN: 'svc_secret_xyz' } as NodeJS.ProcessEnv;
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv,
        sandboxLauncher: launcher('dev'),
        workspaceRoots: [ws],
      });
      await transport.connect(serverConfig());
      const r = await transport.callTool('whoami_env', { key: 'ALUY_TOKEN' });
      expect(r.content).toBe('(vazio)');
      expect(r.content).not.toContain('svc_secret_xyz');
    });
  },
  30_000,
);

// ── FLAG OFF: sem launcher ⇒ comportamento ATUAL intocado ────────────────────────
describe('FLAG OFF (sem sandboxLauncher) — caminho atual intocado', () => {
  let transport: StdioMcpTransport | undefined;
  afterEach(async () => {
    await transport?.close();
    transport = undefined;
  });

  it('o server roda CRU: lê um arquivo FORA do workspace (sem confinamento de SO)', async () => {
    // prova de contraste: sem o launcher, o server NÃO é confinado — ele alcança
    // paths fora do workspace (é justamente o que o sandbox fecha quando ligado).
    const outside = join(base, 'outside-secret.txt');
    writeFileSync(outside, 'leaked');
    transport = new StdioMcpTransport({ cwd: ws, parentEnv: process.env });
    await transport.connect(serverConfig());
    const r = await transport.callTool('read_path', { path: outside });
    expect(r.content).toBe('READ_OK:leaked'); // sem sandbox, o FS do host é alcançável.
  });
}, 30_000);

// ── Fail-mode D-SB-4: SEM piso ⇒ degrade (dev) / refuse (prod) — nunca finge ──────
describe.runIf(!FLOOR)(
  'fail-mode SEM piso de SO (D-SB-4) — nunca finge confinamento',
  () => {
    let transport: StdioMcpTransport | undefined;
    afterEach(async () => {
      await transport?.close();
      transport = undefined;
    });

    it('dev sem piso ⇒ DEGRADA (o server roda cru, com aviso) — não finge', async () => {
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv: process.env,
        sandboxLauncher: launcher('dev'),
        workspaceRoots: [ws],
      });
      // degrade: conecta o server CRU (sem bwrap). O handshake completa.
      const tools = await transport.connect(serverConfig());
      expect(tools.map((t) => t.name)).toContain('read_path');
    });

    it('prod sem piso e sem flag ⇒ RECUSA conectar (não roda nada)', async () => {
      transport = new StdioMcpTransport({
        cwd: ws,
        parentEnv: process.env,
        sandboxLauncher: launcher('prod'),
        workspaceRoots: [ws],
      });
      // refuse: o connect LANÇA (a descoberta trata fail-soft). NUNCA finge confinamento.
      await expect(transport.connect(serverConfig())).rejects.toThrow(/recus|sandbox|piso/i);
    });
  },
  30_000,
);

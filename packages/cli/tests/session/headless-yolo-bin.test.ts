// EST-1007 · ADR-0072 · AG-0008 — YOLO headless no BINÁRIO REAL (alinhamento Claude Code).
//
// Prova as duas pontas do DoD do dono (relax de gate, sinalizado ao `seguranca`), rodando
// o binário `aluy` de verdade (broker STUB HTTP, sem rede/modelo real, HOME tmp):
//   (1) `aluy -p "x" --yolo` NÃO-root, SEM `ALUY_YOLO_HEADLESS` ⇒ ENTRA em YOLO
//       (`yolo-entered` auditado no stderr) + roda a tarefa + EXIT 0 + zero MCP órfão
//       (não pendura, mesmo com server MCP stdio vivo) + BANNER de aviso no stderr.
//       (Antes do AG-0008 isto era RECUSADO sem o duplo opt-in.)
//   (2) `aluy -p "x" --yolo` como ROOT (uid 0 SIMULADO por preload, sem privilégio real)
//       ⇒ RECUSA com a mensagem de root + EXIT≠0 + NÃO monta sessão (não escreve nada).
//
// O uid 0 é simulado por um `--require` que faz `process.geteuid()` devolver 0 ANTES do
// binário rodar — fixture de teste, ZERO linha de produto (a guarda lê o `geteuid` REAL
// em produção).

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'dist', 'bin', 'aluy.js');
const MCP_FIXTURE = join(HERE, '..', 'fixtures', 'mcp-stub-server.mjs');
const FORCE_ROOT = join(HERE, '..', 'fixtures', 'force-root.cjs');

// F66 — 20s flakava sob a suíte cheia (workers paralelos sobre-inscrevem a
// máquina; o boot do binário REAL + re-exec do heap-limit passa de 20s e o killer
// interno marcava LENTIDÃO como HANG). 45s dá folga sem perder a detecção de hang
// (um hang nunca encerra → morto em qualquer teto). Ver F66 nos achados.
const EXIT_TIMEOUT_MS = 45_000;

interface RunResult {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}

/**
 * Roda o binário e RESOLVE quando ele encerra (ou o mata após o timeout = HANG).
 * `preloads` injeta `--require` ANTES do binário (p/ simular uid 0).
 */
function runBinary(
  args: string[],
  env: NodeJS.ProcessEnv,
  stdin: string,
  preloads: string[] = [],
): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.FORCE_COLOR; // FORCE_COLOR vence NO_COLOR no runner — removemos.
    const requireArgs = preloads.flatMap((p) => ['--require', p]);
    const child = spawn(process.execPath, [...requireArgs, BIN, ...args], {
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
      child.kill('SIGKILL');
    }, EXIT_TIMEOUT_MS);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, killed, stdout, stderr });
    });
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe('binário aluy — YOLO headless (EST-1007 · AG-0008)', () => {
  let broker: Server;
  let brokerUrl: string;
  let homeDir: string;
  let workspaceDir: string;

  beforeAll(async () => {
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
    homeDir = mkdtempSync(join(tmpdir(), 'yolo-bin-home-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'yolo-bin-ws-'));
    // server MCP stdio REAL (a fixture): o filho que pinava o loop — prova "zero órfão".
    mkdirSync(join(homeDir, '.aluy'), { recursive: true });
    writeFileSync(
      join(homeDir, '.aluy', 'mcp.json'),
      JSON.stringify({
        mcpServers: { stub: { command: process.execPath, args: [MCP_FIXTURE] } },
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
    ALUY_TOKEN: 'stub-token',
    NO_COLOR: '1',
    // NOTA: NÃO setamos ALUY_YOLO_HEADLESS — a prova é que o `--yolo` basta sozinho.
  });

  it(
    '`aluy -p "x" --yolo` NÃO-root, SEM ALUY_YOLO_HEADLESS ⇒ ENTRA em YOLO, roda, exit 0, sem hang/órfão',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const r = await runBinary(['-p', 'diga pronto', '--yolo', '--tier', 'aluy-flux'], env(), '');
      // não penurou (MCP fechado em toda saída) + saiu com sucesso.
      expect(r.killed, `processo PENDUROU (hang) — stderr: ${r.stderr}`).toBe(false);
      expect(r.code).toBe(0);
      // ENTROU em YOLO de fato — auditoria `yolo-entered` no LOG forense local
      // (`~/.aluy/audit.jsonl`), NÃO mais no stderr (que poluía o boot do usuário com JSON
      // cru a cada início). O stderr fica só com o BANNER.
      const audit = readFileSync(join(homeDir, '.aluy', 'audit.jsonl'), 'utf8');
      expect(audit).toMatch(/"kind":"yolo-entered"/);
      expect(audit).not.toMatch(/"kind":"yolo-refused"/);
      expect(r.stderr).not.toMatch(/"kind":"yolo-entered"/); // o JSON NÃO vaza no stderr
      // BANNER de aviso presente (não silencioso) no stderr.
      expect(r.stderr).toMatch(/MODO YOLO/);
      // EST-1007 (polish) — em HEADLESS o banner é AVISO PURO: NÃO traz a pergunta de
      // confirmação ("Continuar? [s/N]"). A flag `--yolo` já consentiu; não há prompt a
      // responder — o "[s/N]" ali só confundiria (parece esperar resposta que não vem).
      expect(r.stderr).not.toMatch(/Continuar\?|\[s\/N\]/);
      // o stdout fica LIMPO p/ script — só o resultado, sem o banner/auditoria.
      expect(r.stdout.trim()).toBe('PRONTO');
      expect(r.stdout).not.toMatch(/MODO YOLO|yolo-entered/);
    },
  );

  it(
    '`aluy -p "x" --yolo` como ROOT (uid 0 simulado) ⇒ RECUSA com mensagem de root + exit≠0 + sem sessão',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const sentinel = join(workspaceDir, 'should-not-exist.txt');
      const r = await runBinary(
        ['-p', `escreva pronto em ${sentinel}`, '--yolo', '--tier', 'aluy-flux'],
        env(),
        '',
        [FORCE_ROOT], // simula uid 0 ANTES do binário (sem privilégio real).
      );
      expect(r.killed, `processo PENDUROU — stderr: ${r.stderr}`).toBe(false);
      // RECUSA DURA: exit≠0 (não cai p/ normal, não roda nada).
      expect(r.code).not.toBe(0);
      // mensagem de root clara (espelha o Claude Code).
      expect(r.stderr).toMatch(/RECUSADO como ROOT|root/i);
      expect(r.stderr).toMatch(/usuário normal/i);
      // auditoria `yolo-refused` com motivo root — no LOG forense (`~/.aluy/audit.jsonl`).
      const auditR = readFileSync(join(homeDir, '.aluy', 'audit.jsonl'), 'utf8');
      expect(auditR).toMatch(/"kind":"yolo-refused"/);
      expect(auditR).toMatch(/"reason":"root"/);
      // NÃO montou sessão ⇒ NÃO escreveu nada (stdout limpo, sem "PRONTO").
      expect(r.stdout.trim()).toBe('');
      expect(existsSync(sentinel)).toBe(false);
    },
  );

  // EST-1015 — `--yolo` INTERATIVO (non-print) dispara o RE-EXEC do heap-limit (NODE_OPTIONS
  // sem `--max-old-space-size`). Antes, a guarda de YOLO (banner + auditoria) rodava no PAI
  // E no FILHO re-exec ⇒ banner 2× E `yolo-entered` auditado 2×. Agora o banner/auditoria do
  // ALLOW vivem APÓS o `ensureHeapLimit` ⇒ só o processo FINAL emite (1×). Sem objetivo e sem
  // TTY (stdin pipe), o binário sai limpo após o banner — não pendura nem precisa do modelo.
  it(
    '`aluy --yolo` interativo (re-exec do heap-limit) ⇒ banner + auditoria UMA vez (não duplica)',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const r = await runBinary(
        ['--yolo'],
        // NODE_OPTIONS='' FORÇA o re-exec (sem max-old-space herdado do runner); sentinela
        // limpa p/ o re-exec de fato ocorrer (e o filho então não re-exec de novo).
        { ...env(), NODE_OPTIONS: '', ALUY_HEAP_LIMIT_APPLIED: '' },
        '',
      );
      expect(r.killed, `processo PENDUROU — stderr: ${r.stderr}`).toBe(false);
      const banners = (r.stderr.match(/MODO YOLO/g) ?? []).length;
      expect(banners, `banner duplicado no stderr:\n${r.stderr}`).toBe(1);
      const audit = readFileSync(join(homeDir, '.aluy', 'audit.jsonl'), 'utf8');
      const entered = (audit.match(/"kind":"yolo-entered"/g) ?? []).length;
      expect(entered, `auditoria duplicada:\n${audit}`).toBe(1);
    },
  );
});

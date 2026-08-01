// ADR-0159 — SMOKE do BINÁRIO REAL: `aluy -p "... @foto.png" --image outra.png` produz
// um request `/v1/chat` cujo body carrega os anexos como `ContentPart` de imagem
// (shape `image_url` estilo OpenAI, `broker-client.ts#serializeContentParts`).
//
// Backend BROKER (não `local`): o override de `base_url` do backend LOCAL passa por
// anti-SSRF (PROV-SEC-1, `base-url.ts`) que BLOQUEIA loopback — não dá p/ apontar
// `--local-base-url` p/ um servidor fake em 127.0.0.1 sem enfraquecer uma trava de
// segurança real. O endpoint do BROKER não passa por essa validação (é o canal
// PRÓPRIO do CLI, configurado pelo dono — precedente: headless-yolo-bin.test.ts já
// usa exatamente este padrão). O `broker-client.ts` serializa `ContentPart[]` com o
// MESMO shape do adapter OpenAI-compat (ADR-0159 fase 1, já implementada e testada
// em unit) — então provar aqui prova o wire format ponta a ponta do binário real.

import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'dist', 'bin', 'aluy.js');

const EXIT_TIMEOUT_MS = 45_000;

// 1x1 PNG transparente REAL (assinatura completa + IHDR/IDAT/IEND válidos) — fixture
// bem conhecida, gerada em runtime (não versionada no repo — ADR-0159 não pede
// fixtures binárias comitadas; ver relatório da tarefa).
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_1X1 = Buffer.from(PNG_1X1_BASE64, 'base64');

interface RunResult {
  code: number | null;
  killed: boolean;
  stdout: string;
  stderr: string;
}

function runBinary(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<RunResult> {
  return new Promise<RunResult>((resolvePromise) => {
    const childEnv = { ...process.env, ...env };
    delete childEnv.FORCE_COLOR;
    const child = spawn(process.execPath, [BIN, ...args], {
      env: childEnv,
      cwd,
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
      resolvePromise({ code, killed, stdout, stderr });
    });
    child.stdin.end();
  });
}

interface ContentPartLike {
  readonly type: string;
  readonly text?: string;
  readonly image_url?: { readonly url: string };
}
interface ChatMessageLike {
  readonly role: string;
  readonly content: string | readonly ContentPartLike[];
}

describe('binário aluy — anexo de IMAGEM ponta a ponta (`@mention` + `--image`, ADR-0159)', () => {
  let broker: Server;
  let brokerUrl: string;
  let lastChatBody: string | undefined;
  let homeDir: string;
  let workspaceDir: string;

  beforeAll(async () => {
    broker = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if ((req.url ?? '').startsWith('/v1/chat')) {
          lastChatBody = body;
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: start\ndata: {"id":"r"}\n\n');
          res.write('event: delta\ndata: {"content":"OK"}\n\n');
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
    lastChatBody = undefined;
    homeDir = mkdtempSync(join(tmpdir(), 'img-attach-home-'));
    workspaceDir = mkdtempSync(join(tmpdir(), 'img-attach-ws-'));
    writeFileSync(join(workspaceDir, 'screenshot1.png'), PNG_1X1);
    writeFileSync(join(workspaceDir, 'screenshot2.png'), PNG_1X1);
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
    ALUY_BACKEND: 'broker',
    ALUY_MEM_OFF: '1',
    ALUY_MAESTRO_OFF: '1',
    ALUY_BROKER_URL: brokerUrl,
    ALUY_TOKEN: 'pat_0123456789abcdef0123456789abcdef_stub-secret',
    NO_COLOR: '1',
  });

  it(
    '`aluy -p "descreva @screenshot1.png" --image screenshot2.png` ⇒ exit 0, body /v1/chat traz 2 ContentPart de imagem (data URL base64, OpenAI-vision shape)',
    { timeout: EXIT_TIMEOUT_MS + 10_000 },
    async () => {
      const r = await runBinary(
        [
          '-p',
          'descreva @screenshot1.png',
          '--image',
          'screenshot2.png',
          '--tier',
          'aluy-flux',
        ],
        env(),
        workspaceDir,
      );
      expect(r.killed, `processo PENDUROU — stderr: ${r.stderr}`).toBe(false);
      expect(r.code, `stderr: ${r.stderr}`).toBe(0);
      expect(lastChatBody, 'nenhum request /v1/chat capturado').toBeDefined();

      const payload = JSON.parse(lastChatBody!) as { messages: readonly ChatMessageLike[] };
      const arrayContentMsgs = payload.messages.filter((m) => Array.isArray(m.content));
      // uma ChatMessage POR anexo (@mention no goal + --image) — mesma disciplina do
      // `buildMessages` (um `attachment_image` HistoryItem ⇒ uma ChatMessage).
      expect(arrayContentMsgs.length).toBeGreaterThanOrEqual(2);
      for (const m of arrayContentMsgs) expect(m.role).toBe('user');

      const allParts = arrayContentMsgs.flatMap((m) => m.content as readonly ContentPartLike[]);
      const imageParts = allParts.filter((p) => p.type === 'image_url');
      expect(imageParts.length).toBeGreaterThanOrEqual(2);
      for (const p of imageParts) {
        expect(p.image_url?.url).toMatch(/^data:image\/png;base64,/);
        const b64 = p.image_url!.url.split(',', 2)[1]!;
        expect(b64).toBe(PNG_1X1_BASE64);
      }
      // o rótulo textual (`Anexo: <path>`) acompanha cada imagem.
      const textParts = allParts.filter((p) => p.type === 'text');
      expect(textParts.some((p) => p.text?.includes('screenshot1.png'))).toBe(true);
      expect(textParts.some((p) => p.text?.includes('screenshot2.png'))).toBe(true);

      // stdout limpo (script-friendly) — o resultado do modelo, sem base64/chrome.
      expect(r.stdout.trim()).toBe('OK');
      expect(r.stdout).not.toContain(PNG_1X1_BASE64);
    },
  );
});

// ADR-0158 §11 (FASE 4 — attach) — attach-server.ts: socket UNIX real (tmpdir),
// permissão 0600, broadcast log/state/block, recepção de `say`, cleanup no `close`.

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAttachServer, type AttachServer } from '../../src/service/attach-server.js';
import { attachSocketPath } from '../../src/service/paths.js';
import { parseServiceAttachServerLine } from '@hiperplano/aluy-cli-core';

/** Espera até `cond()` virar `true` ou o timeout estourar (poll de 10ms). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface RawClient {
  readonly lines: unknown[];
  readonly send: (line: string) => void;
  readonly close: () => void;
}

function wrapAsRawClient(socket: ReturnType<typeof createConnection>): RawClient {
  socket.setEncoding('utf8');
  const lines: unknown[] = [];
  let buf = '';
  socket.on('data', (chunk: string) => {
    buf += chunk;
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const parsed = parseServiceAttachServerLine(raw);
      if (parsed !== undefined) lines.push(parsed);
      idx = buf.indexOf('\n');
    }
  });
  socket.on('error', () => {
    /* best-effort — os testes checam via `lines`/`clientCount`, não via exceção */
  });
  return {
    lines,
    send: (line) => socket.write(line),
    close: () => socket.end(),
  };
}

/** Conecta um cliente NET cru ao socket, RETENTANDO (ECONNREFUSED/ENOENT) até um
 * timeout — `existsSync` sozinho não prova que o `bind()`+`chmod` já terminaram
 * (o arquivo pode existir um instante antes do `listen` estar pronto p/ aceitar, ou
 * já existir de antes por outro motivo — ver o teste do socket órfão). Devolve as
 * linhas NDJSON recebidas já decodificadas pelo protocolo puro — espelha o que
 * `attach-client.ts` faz, mas SEM depender dele (teste do SERVIDOR isolado). */
async function connectRetrying(sockPath: string, timeoutMs = 2000): Promise<RawClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const socket = await new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
        const s = createConnection(sockPath);
        s.once('connect', () => resolve(s));
        s.once('error', reject);
      });
      return wrapAsRawClient(socket);
    } catch {
      if (Date.now() > deadline) throw new Error('connectRetrying: timeout');
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe('startAttachServer', () => {
  let serviceDir: string;
  let server: AttachServer | undefined;

  afterEach(() => {
    server?.close();
    if (serviceDir) rmSync(serviceDir, { recursive: true, force: true });
  });

  it('sobe o socket em `.state/attach.sock`, permissão 0600', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    server = startAttachServer(serviceDir, { onSay: () => {} }, () => {});
    const sockPath = attachSocketPath(serviceDir);
    // `existsSync` fica `true` já no `bind()` síncrono — ANTES do `chmod` (que só
    // roda no callback de 'listening'). Espera a conexão de VERDADE suceder: só
    // acontece depois do 'listening' completo, ou seja, depois do `chmod` também
    // (mesma ordem de código dentro do callback) — sincronização confiável.
    const client = await connectRetrying(sockPath);
    const mode = statSync(sockPath).mode & 0o777;
    expect(mode).toBe(0o600);
    client.close();
  });

  it('cliente conectado recebe broadcastLog/broadcastState/broadcastBlock', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    server = startAttachServer(serviceDir, { onSay: () => {} }, () => {});
    const client = await connectRetrying(attachSocketPath(serviceDir));
    await waitFor(() => server!.clientCount() > 0);

    server.broadcastLog('runner iniciado.');
    server.broadcastState('running-turn', 'atividade 1/3');
    server.broadcastBlock('you', 'oi');

    await waitFor(() => client.lines.length >= 3);
    expect(client.lines).toEqual([
      expect.objectContaining({ t: 'log', line: 'runner iniciado.' }),
      expect.objectContaining({ t: 'state', turnState: 'running-turn', detail: 'atividade 1/3' }),
      expect.objectContaining({ t: 'block', role: 'you', text: 'oi' }),
    ]);
    client.close();
  });

  it('cliente que conecta DEPOIS de um broadcastState recebe o ÚLTIMO estado imediatamente', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    server = startAttachServer(serviceDir, { onSay: () => {} }, () => {});
    server.broadcastState('sleeping', 'próximo turno amanhã 9h');
    // Nenhum cliente ainda — o evento acima só fica em `lastState`.

    const client = await connectRetrying(attachSocketPath(serviceDir));
    await waitFor(() => client.lines.length >= 1);
    expect(client.lines[0]).toEqual(
      expect.objectContaining({ t: 'state', turnState: 'sleeping', detail: 'próximo turno amanhã 9h' }),
    );
    client.close();
  });

  it('evento `say` do cliente chega ao hook `onSay`', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    const received: string[] = [];
    server = startAttachServer(serviceDir, { onSay: (t) => received.push(t) }, () => {});
    const client = await connectRetrying(attachSocketPath(serviceDir));
    await waitFor(() => server!.clientCount() > 0);
    client.send('{"t":"say","text":"aumenta pra 3 lotes"}\n');
    await waitFor(() => received.includes('aumenta pra 3 lotes'));
    expect(received).toEqual(['aumenta pra 3 lotes']);
    client.close();
  });

  it('linha hostil/malformada do cliente é ignorada (nunca derruba o servidor)', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    const received: string[] = [];
    server = startAttachServer(serviceDir, { onSay: (t) => received.push(t) }, () => {});
    const client = await connectRetrying(attachSocketPath(serviceDir));
    await waitFor(() => server!.clientCount() > 0);
    client.send('isto não é json\n{"t":"outracoisa"}\n{"t":"say","text":"depois disso ok"}\n');
    await waitFor(() => received.includes('depois disso ok'));
    expect(received).toEqual(['depois disso ok']);
    client.close();
  });

  it('close() derruba clientes conectados e remove o arquivo do socket', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    server = startAttachServer(serviceDir, { onSay: () => {} }, () => {});
    const sockPath = attachSocketPath(serviceDir);
    const client = await connectRetrying(sockPath);
    await waitFor(() => server!.clientCount() > 0);

    server.close();
    await waitFor(() => !existsSync(sockPath));
    expect(existsSync(sockPath)).toBe(false);
    client.close();
    server = undefined; // já fechado — o afterEach não precisa fechar de novo.
  });

  it('socket ÓRFÃO de um processo anterior (arquivo remanescente, sem listener) não impede o novo `listen`', async () => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-srv-'));
    const sockPath = attachSocketPath(serviceDir);
    // Simula um processo anterior que morreu sem teardown gracioso (kill -9): um
    // arquivo fica no lugar do socket, mas NINGUÉM escuta nele — `listen()` bateria
    // em EADDRINUSE se `startAttachServer` não o removesse primeiro.
    mkdirSync(join(serviceDir, '.state'), { recursive: true });
    writeFileSync(sockPath, '');
    expect(existsSync(sockPath)).toBe(true);

    server = startAttachServer(serviceDir, { onSay: () => {} }, () => {});
    const client = await connectRetrying(sockPath);
    await waitFor(() => server!.clientCount() > 0);
    client.close();
  });
});

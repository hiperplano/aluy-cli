// ADR-0158 §11 (FASE 4) — attach-client.ts: fecha sobreviventes de MUTAÇÃO (Stryker,
// pass 3) nos DOIS guards `if (closed) return;` (de `send`/`close`) que
// `attach-client.test.ts` (alheio — NÃO editado aqui) já prova "não lançam" pós-close,
// mas não prova que o guard de fato IMPEDE o efeito (o `try/catch` ao redor do
// `socket.write`/`socket.end` engoliria uma exceção de qualquer forma, então
// "não lançar" sozinho não mata o mutante `if (false) return`). Aqui: sockets REAIS
// (mesma disciplina do resto do módulo — nunca mocka `node:net`), mas com um SPY em
// cima dos métodos REAIS de `Socket.prototype` (chama through — não substitui
// comportamento) só para CONTAR chamadas, provando que o guard corta o efeito antes
// dele acontecer. Arquivo SEPARADO — só ESTENDE a cobertura.
import { describe, expect, it, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, Socket, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAttachSocket } from '../../src/service/attach-client.js';

describe('connectAttachSocket — guards `if (closed) return` de fato CORTAM o efeito (não só "não lançam")', () => {
  let base: string;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('send() pós-close(): NENHUM byte chega ao servidor (o guard corta ANTES do socket.write)', async () => {
    base = mkdtempSync(join(tmpdir(), 'attach-client-guard-'));
    const sockPath = join(base, 'attach.sock');
    const received: string[] = [];
    server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => received.push(chunk));
    });
    await new Promise<void>((resolve) => server?.listen(sockPath, resolve));

    const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
    await new Promise((r) => setTimeout(r, 30)); // dá tempo da conexão TCP/unix completar.

    conn.close();
    received.length = 0; // zera o que quer que tenha chegado até aqui (nada esperado).
    conn.send('não deveria chegar em lugar nenhum');
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([]);
  });

  it('close() chamado DUAS vezes: o segundo `socket.end()` REAL nunca é disparado (spy no protótipo, chama through)', async () => {
    base = mkdtempSync(join(tmpdir(), 'attach-client-guard2-'));
    const sockPath = join(base, 'attach.sock');
    server = createServer(() => {});
    await new Promise<void>((resolve) => server?.listen(sockPath, resolve));

    const endSpy = vi.spyOn(Socket.prototype, 'end');
    try {
      const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
      await new Promise((r) => setTimeout(r, 30));

      conn.close();
      const callsAfterFirstClose = endSpy.mock.calls.length;
      expect(callsAfterFirstClose).toBeGreaterThanOrEqual(1);

      conn.close(); // segunda chamada — o guard `if (closed) return` deve cortar ANTES do `.end()`.
      expect(endSpy.mock.calls.length).toBe(callsAfterFirstClose);
    } finally {
      endSpy.mockRestore();
    }
  });
});

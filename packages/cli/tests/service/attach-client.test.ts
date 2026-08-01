// ADR-0158 §11 (FASE 4 — attach) — attach-client.ts: o lado CLIENTE do socket de
// attach. Cobertura fechada em auditoria de cobertura (ver relatório): o módulo não
// tinha NENHUM teste dedicado — `commands/service.ts` (`runAttach`) sempre injeta um
// `attachConnect` FAKE nos próprios testes, então a implementação REAL de
// `connectAttachSocket` (conexão, parse/format de linha, os 3 formatos de
// `onClose`, o guard de "no máximo uma vez") nunca era exercitada. Os cenários
// abaixo usam sockets/erros REAIS (nunca mocka `node:net`) — mesma disciplina do
// `attach-server.test.ts`.
import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectAttachSocket, formatSocketErrorReason } from '../../src/service/attach-client.js';
import { parseServiceAttachClientLine } from '@hiperplano/aluy-cli-core';

/** Espera até `cond()` virar `true` ou o timeout estourar (poll de 10ms) — mesmo
 * helper usado em `attach-server.test.ts`. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('connectAttachSocket', () => {
  let base: string;
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = undefined;
    }
    if (base) rmSync(base, { recursive: true, force: true });
  });

  it('createConnection lança SÍNCRONO (porta/path inválido) ⇒ onClose com a mensagem de conexão, send/close do objeto devolvido são no-op seguros', () => {
    base = mkdtempSync(join(tmpdir(), 'attach-client-'));
    const onLines: string[] = [];
    const onCloseReasons: string[] = [];
    // '' como "path" faz `net.createConnection` interpretar como porta TCP vazia e
    // lançar SÍNCRONO (ERR_SOCKET_BAD_PORT) — exercita o `catch` do `createConnection`
    // (o outro ramo, "falha assíncrona", é coberto pelos testes de ENOENT abaixo).
    const conn = connectAttachSocket('', {
      onLine: (l) => onLines.push(l),
      onClose: (r) => onCloseReasons.push(r),
    });
    expect(onCloseReasons).toHaveLength(1);
    expect(onCloseReasons[0]).toContain('não foi possível conectar');
    expect(onLines).toEqual([]);
    // o objeto devolvido no ramo de erro síncrono é o par de no-ops — nunca lança.
    expect(() => conn.send('oi')).not.toThrow();
    expect(() => conn.close()).not.toThrow();
  });

  it('socket ausente (serviço não rodando) ⇒ ENOENT assíncrono, onClose "não está rodando", chamado no máximo uma vez', async () => {
    base = mkdtempSync(join(tmpdir(), 'attach-client-'));
    const missing = join(base, 'attach.sock');
    const onCloseReasons: string[] = [];
    connectAttachSocket(missing, {
      onLine: () => {
        throw new Error('não deveria receber linha nenhuma');
      },
      onClose: (r) => onCloseReasons.push(r),
    });
    await waitFor(() => onCloseReasons.length > 0);
    // o socket do Node costuma emitir 'error' E 'close' pra uma conexão que nunca
    // abriu — o guard `closed` do módulo tem que garantir só UMA chamada mesmo assim.
    await new Promise((r) => setTimeout(r, 50));
    expect(onCloseReasons).toHaveLength(1);
    expect(onCloseReasons[0]).toContain('não está rodando');
  });

  // A classificação de erro do SO p/ um path malformado (NUL embutido, etc.) varia
  // por plataforma/versão do Node (ENOENT numa, EINVAL noutra) — não é portátil
  // reproduzir um terceiro código via socket real sem mockar `node:net`. O ramo
  // `else` (qualquer código que NÃO seja ENOENT/ECONNREFUSED) é testado direto na
  // função PURA que decide a frase — mesma cobertura, sem depender do SO.
  it('formatSocketErrorReason: código ENOENT/ECONNREFUSED ⇒ "não está rodando"; qualquer outro ⇒ "conexão perdida"', () => {
    const enoent = Object.assign(new Error('enoent'), { code: 'ENOENT' });
    const econnrefused = Object.assign(new Error('econnrefused'), { code: 'ECONNREFUSED' });
    const outro = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    expect(formatSocketErrorReason(enoent)).toContain('não está rodando');
    expect(formatSocketErrorReason(econnrefused)).toContain('não está rodando');
    expect(formatSocketErrorReason(outro)).toContain('conexão perdida');
    expect(formatSocketErrorReason(outro)).not.toContain('não está rodando');
  });

  it('caminho feliz: linhas NDJSON válidas viram texto formatado, linha malformada é ignorada em silêncio, `send` manda `say` corretamente codificado', async () => {
    base = mkdtempSync(join(tmpdir(), 'attach-client-'));
    const sockPath = join(base, 'attach.sock');
    const received: string[] = [];
    server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('{"t":"log","line":"olá","atIso":"2026-08-01T00:00:00.000Z"}\n');
      socket.write('isto não é json\n'); // malformado — deve ser ignorada em silêncio
      socket.write(
        '{"t":"state","turnState":"awaiting-owner","detail":"pergunta pendente","atIso":"2026-08-01T00:00:00.000Z"}\n',
      );
      let buf = '';
      socket.on('data', (chunk: string) => {
        buf += chunk;
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          received.push(buf.slice(0, idx));
          buf = buf.slice(idx + 1);
          idx = buf.indexOf('\n');
        }
      });
    });
    await new Promise<void>((resolve) => server?.listen(sockPath, resolve));

    const onLines: string[] = [];
    const onCloseReasons: string[] = [];
    const conn = connectAttachSocket(sockPath, {
      onLine: (l) => onLines.push(l),
      onClose: (r) => onCloseReasons.push(r),
    });

    await waitFor(() => onLines.length >= 2);
    expect(onLines).toEqual([
      '· olá',
      '── estado: aguardando o dono — pergunta pendente ──',
    ]);

    conn.send('pode prosseguir');
    await waitFor(() => received.length >= 1);
    const sayEvent = parseServiceAttachClientLine(received[0]);
    expect(sayEvent).toEqual({ t: 'say', text: 'pode prosseguir' });

    // fechar do LADO DO CLIENTE (detach) NÃO chama onClose — o caller já sabe
    // (é ele quem decidiu detachar).
    conn.close();
    await new Promise((r) => setTimeout(r, 30));
    expect(onCloseReasons).toEqual([]);

    // `send`/`close` pós-close continuam no-op seguros.
    expect(() => conn.send('mais uma')).not.toThrow();
    expect(() => conn.close()).not.toThrow();
  });

  it('servidor fecha a conexão (serviço parou) ⇒ onClose "conexão encerrada pelo serviço"', async () => {
    base = mkdtempSync(join(tmpdir(), 'attach-client-'));
    const sockPath = join(base, 'attach.sock');
    server = createServer((socket) => {
      socket.end();
    });
    await new Promise<void>((resolve) => server?.listen(sockPath, resolve));

    const onCloseReasons: string[] = [];
    connectAttachSocket(sockPath, {
      onLine: () => {},
      onClose: (r) => onCloseReasons.push(r),
    });
    await waitFor(() => onCloseReasons.length > 0);
    expect(onCloseReasons).toHaveLength(1);
    expect(onCloseReasons[0]).toContain('conexão encerrada pelo serviço');
  });
});

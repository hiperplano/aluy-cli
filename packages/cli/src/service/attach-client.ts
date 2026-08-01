// ADR-0158 §11 (FASE 4 — attach) — o lado CLIENTE do socket: conecta ao
// `attach.sock` do serviço, recebe eventos NDJSON do servidor (`attach-server.ts`,
// rodando NO processo do runner) e formata cada um p/ uma linha de terminal
// (`formatServiceAttachEventForTerminal`, cli-core — PURO). Expõe `send(text)` p/
// mandar `say` de volta. A ORQUESTRAÇÃO do terminal interativo (readline, ESC/
// Ctrl-C ⇒ detach) fica em `commands/service.ts` (`runAttach`) — este módulo é só a
// ponte de protocolo sobre o socket, testável sem TTY.

import { createConnection, type Socket } from 'node:net';
import {
  encodeServiceAttachClientEvent,
  parseServiceAttachServerLine,
  formatServiceAttachEventForTerminal,
} from '@hiperplano/aluy-cli-core';

export interface AttachConnection {
  /** Manda `say` (a fala do dono digitada no attach) ao runner. No-op se já fechado. */
  readonly send: (text: string) => void;
  /** Fecha a conexão do LADO DO CLIENTE (detach) — NUNCA para o serviço. */
  readonly close: () => void;
}

/**
 * Mapeia o erro assíncrono do socket p/ a frase exibida (`onClose`). PURA — sem
 * I/O — testável direto com um erro sintético, sem depender de como o SO/versão
 * do Node classifica um path malformado (esse mapeamento varia entre plataformas
 * — ENOENT/ECONNREFUSED de verdade são fáceis de reproduzir via socket real; um
 * terceiro código arbitrário não é, portátil, sem mockar `node:net`).
 */
export function formatSocketErrorReason(err: NodeJS.ErrnoException): string {
  return err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
    ? 'o serviço não está rodando (ou o socket de attach ainda não subiu).'
    : `conexão perdida — ${String(err)}.`;
}

export interface AttachConnectHooks {
  /** Uma linha JÁ FORMATADA (`formatServiceAttachEventForTerminal`) por evento
   * válido recebido do servidor. Linha malformada ⇒ ignorada em silêncio (mesma
   * disciplina fail-safe do protocolo — nunca derruba o attach). */
  readonly onLine: (line: string) => void;
  /** A conexão terminou (servidor fechou, socket caiu, ou erro) — `reason` é uma
   * frase pronta p/ exibir. Chamado NO MÁXIMO uma vez. */
  readonly onClose: (reason: string) => void;
}

/**
 * Conecta ao `attach.sock` de um serviço. NUNCA lança — falha de conexão (serviço
 * parado, socket ausente/stale) chega via `onClose`, não via exceção (o caller
 * decide a mensagem de uso — "rode aluy service start" etc.).
 */
export function connectAttachSocket(sockPath: string, hooks: AttachConnectHooks): AttachConnection {
  let closed = false;
  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    hooks.onClose(reason);
  };

  let socket: Socket;
  try {
    socket = createConnection(sockPath);
  } catch (err) {
    // `createConnection` síncrono raramente lança (o erro normal vem via 'error'
    // assíncrono, tratado abaixo) — mas cobrimos os dois casos por segurança.
    finish(`não foi possível conectar (${String(err)}).`);
    return { send: () => {}, close: () => {} };
  }

  socket.setEncoding('utf8');
  let buf = '';
  socket.on('data', (chunk: Buffer | string) => {
    buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx = buf.indexOf('\n');
    while (idx !== -1) {
      const rawLine = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const event = parseServiceAttachServerLine(rawLine);
      if (event !== undefined) hooks.onLine(formatServiceAttachEventForTerminal(event));
      idx = buf.indexOf('\n');
    }
  });
  socket.on('error', (err: NodeJS.ErrnoException) => finish(formatSocketErrorReason(err)));
  socket.on('close', () => {
    finish('conexão encerrada pelo serviço (parou, ou o attach caiu).');
  });

  return {
    send: (text) => {
      if (closed) return;
      try {
        socket.write(encodeServiceAttachClientEvent({ t: 'say', text }));
      } catch {
        /* socket já morto entre o check e o write — o 'error'/'close' cobre */
      }
    },
    close: () => {
      if (closed) return;
      closed = true; // NÃO chama `onClose` — este é o DETACH do próprio dono, o
      // caller já sabe (é ele quem decidiu detachar) e imprime a mensagem dele.
      try {
        socket.end();
      } catch {
        /* best-effort */
      }
    },
  };
}

// ADR-0158 §11 (FASE 4 — "ENTRAR num serviço rodando") — o SOCKET local do attach,
// servido PELO PROCESSO DO RUNNER (§11: "conecta a TUI/shell ao processo do serviço"
// — aqui é o shell; o socket é o MESMO em ambos). UNIX socket em
// `<serviceDir>/.state/attach.sock`, permissão 0600 (só o dono), removido no
// teardown — NUNCA TCP (a autenticação é a posse da máquina/arquivo — §11 "aqui a
// autenticação é a posse da máquina/socket").
//
// Protocolo: NDJSON linha-a-linha, formatação PURA em `@hiperplano/aluy-cli-core`
// (`attach-protocol.ts`, ADR-0053 §8) — este módulo só faz o I/O (net.Server, fs) e
// aplica o protocolo já pronto.
//
// Segurança: qualquer cliente que abrir o socket (=qualquer processo do MESMO dono
// na MESMA máquina, dado o 0600) pode mandar `say` — é aceito e tratado como
// INSTRUÇÃO DO DONO (canal `user`, nunca `observation`), coerente com §11: "a fala
// dele entra como instrução (...) a autenticação é a posse da máquina/socket". Não
// há autenticação ADICIONAL dentro do protocolo — o arquivo É a autenticação.

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import {
  encodeServiceAttachServerEvent,
  parseServiceAttachClientLine,
  type ServiceAttachTurnState,
} from '@hiperplano/aluy-cli-core';
import { attachSocketPath, serviceStateDir } from './paths.js';

const SOCKET_MODE = 0o600;
const STATE_DIR_MODE = 0o700;

export interface AttachServerHooks {
  /** Disparado quando um cliente manda `say` (evento de entrada — §11 "o dono pode
   * DIGITAR"). O RUNNER decide o que fazer conforme a fase corrente (mid-turno/
   * dormindo/ask-espera) — este módulo não sabe de fases, só entrega o texto. */
  readonly onSay: (text: string) => void;
}

export interface AttachServer {
  /** Publica uma linha do `runner.log` p/ todo cliente conectado. */
  readonly broadcastLog: (line: string) => void;
  /** Publica uma transição de estado (§11 — "ver o que está acontecendo"). */
  readonly broadcastState: (turnState: ServiceAttachTurnState, detail?: string) => void;
  /** §11 — "os blocos da conversa do turno em andamento", melhor esforço. */
  readonly broadcastBlock: (role: string, text: string) => void;
  /** Nº de clientes conectados agora (best-effort, só p/ diagnóstico/teste). */
  readonly clientCount: () => number;
  /** Fecha todas as conexões, derruba o servidor e REMOVE o arquivo do socket. */
  readonly close: () => void;
}

/**
 * Sobe o servidor de attach p/ UM serviço. NUNCA lança — falha ao subir o socket
 * (ex.: `.state/` sem permissão) é logada e o runner SEGUE sem attach disponível
 * (attach é uma conveniência de observação/interação; não pode travar o turno do
 * serviço — mesma disciplina fail-open do `channel.ts`, FASE 3).
 */
export function startAttachServer(
  serviceDir: string,
  hooks: AttachServerHooks,
  log: (line: string) => void,
): AttachServer {
  const sockPath = attachSocketPath(serviceDir);
  const clients = new Set<Socket>();
  let lastState: { turnState: ServiceAttachTurnState; detail?: string } | undefined;

  const broadcastRaw = (line: string): void => {
    for (const c of clients) {
      try {
        c.write(line);
      } catch {
        /* cliente morto — o handler de 'close'/'error' já vai limpar o Set */
      }
    }
  };

  let server: Server | undefined;
  try {
    mkdirSync(serviceStateDir(serviceDir), { mode: STATE_DIR_MODE, recursive: true });
    // Socket ÓRFÃO de um runner anterior que morreu sem teardown gracioso (kill -9,
    // queda de energia) ⇒ o `listen` daria EADDRINUSE num arquivo morto. Remove
    // primeiro — o `pid.ts`/pidfile é quem já decide "está rodando de verdade" antes
    // de chegar aqui (`runServiceRunner` só é invocado por `service start`, que checa
    // o pidfile); um socket-file remanescente aqui é sempre lixo do processo anterior.
    if (existsSync(sockPath)) {
      try {
        unlinkSync(sockPath);
      } catch {
        /* best-effort */
      }
    }
    server = createServer((socket) => {
      clients.add(socket);
      socket.setEncoding('utf8');
      // Estado corrente IMEDIATO ao conectar — o attach não espera a PRÓXIMA
      // transição p/ saber "o que está acontecendo agora" (§11).
      if (lastState) {
        try {
          socket.write(
            encodeServiceAttachServerEvent({
              t: 'state',
              turnState: lastState.turnState,
              atIso: new Date().toISOString(),
              ...(lastState.detail !== undefined ? { detail: lastState.detail } : {}),
            }),
          );
        } catch {
          /* cliente já desconectou entre o accept e este write — ok, o 'close' cobre */
        }
      }
      // EST-0982 (mesmo padrão de `shell-port.ts`) — bufferiza o parcial e processa
      // linha-a-linha assim que cada `\n` chega (NDJSON — uma mensagem por linha).
      let buf = '';
      socket.on('data', (chunk: Buffer | string) => {
        buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        let idx = buf.indexOf('\n');
        while (idx !== -1) {
          const rawLine = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const event = parseServiceAttachClientLine(rawLine);
          if (event?.t === 'say') hooks.onSay(event.text);
          // linha malformada/tipo desconhecido ⇒ IGNORADA em silêncio (protocolo
          // puro já decide isso em `parseServiceAttachClientLine` — nunca lança).
          idx = buf.indexOf('\n');
        }
      });
      const cleanup = (): void => {
        clients.delete(socket);
      };
      socket.on('error', cleanup);
      socket.on('close', cleanup);
    });
    server.on('error', (err) => {
      log(`[attach] erro no socket (${sockPath}) — ${String(err)}.`);
    });
    server.listen(sockPath, () => {
      // 0600 — só o dono. Há uma janela mínima entre o `listen` e este `chmod` em
      // que o socket herda o umask do processo; aceitável (mesma disciplina de
      // "best-effort" do resto do módulo de serviço — o diretório `.state/` já é
      // 0700, então só o dono alcança o arquivo mesmo nessa janela).
      try {
        chmodSync(sockPath, SOCKET_MODE);
      } catch {
        /* best-effort */
      }
      log(`[attach] socket disponível em ${sockPath} — "aluy service attach" pode conectar.`);
    });
  } catch (err) {
    log(`[attach] falha ao subir o socket de attach — ${String(err)}. Serviço segue sem attach.`);
  }

  return {
    broadcastLog: (line) => {
      broadcastRaw(encodeServiceAttachServerEvent({ t: 'log', line, atIso: new Date().toISOString() }));
    },
    broadcastState: (turnState, detail) => {
      lastState = { turnState, ...(detail !== undefined ? { detail } : {}) };
      broadcastRaw(
        encodeServiceAttachServerEvent({
          t: 'state',
          turnState,
          atIso: new Date().toISOString(),
          ...(detail !== undefined ? { detail } : {}),
        }),
      );
    },
    broadcastBlock: (role, text) => {
      broadcastRaw(
        encodeServiceAttachServerEvent({ t: 'block', role, text, atIso: new Date().toISOString() }),
      );
    },
    clientCount: () => clients.size,
    close: () => {
      for (const c of clients) {
        try {
          c.end();
        } catch {
          /* best-effort */
        }
      }
      clients.clear();
      try {
        server?.close();
      } catch {
        /* best-effort */
      }
      try {
        if (existsSync(sockPath)) unlinkSync(sockPath);
      } catch {
        /* best-effort */
      }
    },
  };
}

// EST-1118 · ADR-0121 §4.1/§6.2 — FileRoomStore: transporte file do RoomStore.
//
// Cada sala = um arquivo JSONL append-only sob `<baseDir>/<código>.jsonl`.
// Dir `0700`, arquivos `0600`. Append atômico sob lock; seq monotônico por
// linha; eviction lazy HARD-DELETA os bytes (não só status).
//
// LOCUS: @hiperplano/aluy-cli (ADR-0053 §8 — porta vive no core, concreto `file` no CLI).
// Protocolo de sala INVARIANTE (ADR-0081): muda só ONDE o byte vive.
//
// PURO quanto relógio de SALA: o `now` vem via opts do createRoom.
// Lock de arquivo usa relógio real (Date.now) — é detalhe de implementação
// do transporte, não da sala.

import * as fsPromises from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRoom, isExpired, type Room, type RoomStore } from '@hiperplano/aluy-cli-core';

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/** Timeout para considerar um lock como stale (processo morto), em ms. */
const LOCK_STALE_MS = 30_000;

/** Poll interval ao tentar adquirir lock stale, em ms. */
const LOCK_RETRY_MS = 50;

/** Timeout máximo para adquirir lock, em ms. */
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Serialização do arquivo JSONL
// ---------------------------------------------------------------------------

/** Linha 1: metadata da sala. seq=1 por consistência (nº da linha). */
type RoomMetaLine = {
  seq: 1;
  type: 'room:meta';
  code: string;
  createdAt: number;
  ttlMs: number;
  revoked: boolean;
};

/** Linhas 2+: mensagens. seq ≥ 2, coincide com nº da linha. */
type MessageLine = {
  seq: number;
  type: 'msg';
  msg_id: string;
  from: string;
  to: string;
  kind: string;
  in_reply_to?: string;
  body: string;
  ts: number;
  /** F139 — profundidade `in_reply_to` carimbada (anti-loop robusto à eviction). */
  hop?: number;
};

type JsonlLine = RoomMetaLine | MessageLine;

function serializeRoomMeta(room: Room): string {
  const meta: RoomMetaLine = {
    seq: 1,
    type: 'room:meta',
    code: room.code,
    createdAt: room.createdAt,
    ttlMs: room.ttlMs,
    revoked: room.revoked,
  };
  return JSON.stringify(meta);
}

function serializeMessage(msg: Room['messages'][number], seq: number): string {
  const line: MessageLine = {
    seq,
    type: 'msg',
    msg_id: msg.msg_id,
    from: msg.from,
    to: msg.to,
    kind: msg.kind,
    body: msg.body,
    ts: msg.ts,
  };
  // exactOptionalPropertyTypes: só inclui se definido.
  if (msg.in_reply_to !== undefined) {
    line.in_reply_to = msg.in_reply_to;
  }
  // F139 — persiste o `hop` carimbado (anti-loop sobrevive ao restart/cross-CLI).
  if (msg.hop !== undefined) {
    line.hop = msg.hop;
  }
  return JSON.stringify(line);
}

/** Lê um arquivo JSONL e reconstrói a Room. */
async function readRoomFile(fp: string, code: string): Promise<Room> {
  const raw = await fsPromises.readFile(fp, 'utf-8');
  return deserializeRoom(code, raw);
}

function deserializeRoom(code: string, raw: string): Room {
  const lines = raw.split('\n').filter((l) => l.trim() !== '');
  if (lines.length === 0) {
    throw new Error(`Arquivo de sala "${code}" vazio.`);
  }

  const first = JSON.parse(lines[0]) as JsonlLine;
  if (first.type !== 'room:meta') {
    throw new Error(`Arquivo de sala "${code}" corrompido: linha 1 não é metadata.`);
  }

  const room: Room = {
    code: first.code,
    createdAt: first.createdAt,
    ttlMs: first.ttlMs,
    revoked: first.revoked,
    messages: [],
    nextSeq: 1, // EST-1120 — será recalculado abaixo
  };

  for (let i = 1; i < lines.length; i++) {
    // F94 — TOLERA a linha FINAL torta (append em voo): `get()` lê SEM lock, então um
    // leitor cross-process pode observar o arquivo no meio de um `appendFile` do writer
    // (linha final truncada). Como um append COMPLETO sempre termina em '\n', uma última
    // linha que não parseia ⇒ append em andamento/crash: DROPA (reaparece na próxima
    // leitura, sob lock do writer). Em linhas NÃO-finais, parse-fail = corrupção REAL ⇒ lança.
    let parsed: JsonlLine;
    try {
      parsed = JSON.parse(lines[i]) as JsonlLine;
    } catch (err) {
      if (i === lines.length - 1) break; // linha final torta: ignora (append em voo)
      throw err; // linha interna corrompida: erro honesto
    }
    if (parsed.type === 'msg') {
      const msg: Room['messages'][number] = {
        msg_id: parsed.msg_id,
        seq: parsed.seq, // EST-1120 — seq do JSONL vira campo do AgentMessage
        from: parsed.from,
        to: parsed.to,
        kind: parsed.kind as Room['messages'][number]['kind'],
        body: parsed.body,
        ts: parsed.ts,
      };
      if (parsed.in_reply_to !== undefined) {
        msg.in_reply_to = parsed.in_reply_to;
      }
      // F139 — restaura o `hop` carimbado (anti-loop robusto entre restarts/CLIs).
      if (parsed.hop !== undefined) {
        msg.hop = parsed.hop;
      }
      room.messages.push(msg);
    }
  }

  // EST-1120 — nextSeq = 1 + maior seq do feed (monotônico mesmo com cap)
  const maxMsgSeq = room.messages.reduce((max, m) => Math.max(max, m.seq), 0);
  room.nextSeq = Math.max(1, maxMsgSeq + 1);

  return room;
}

// ---------------------------------------------------------------------------
// Lock de arquivo
// ---------------------------------------------------------------------------

type LockState = { pid: number; createdAt: number };

function serializeLock(state: LockState): string {
  return JSON.stringify(state);
}

function isLockStale(state: LockState, now: number): boolean {
  if (now - state.createdAt > LOCK_STALE_MS) return true;
  try {
    process.kill(state.pid, 0);
    return false;
  } catch {
    return true; // ESRCH: processo não existe
  }
}

// ---------------------------------------------------------------------------
// FileRoomStore
// ---------------------------------------------------------------------------

export class FileRoomStore implements RoomStore {
  readonly maxRooms: number;
  /** Cap de bytes por .jsonl (anti-DoS, ADR-0121 §8.3). 0 = sem cap. */
  readonly maxBytes: number;
  private readonly baseDir: string;

  /**
   * @param maxRooms Número máximo de salas (default 16, ADR-0081 §9).
   * @param baseDir Diretório base (default `~/.aluy/rooms`). Injetável p/ teste.
   * @param maxBytes Tamanho máximo por arquivo .jsonl (default 1 MiB, ADR-0121 §8.3). 0 = sem cap.
   */
  constructor(maxRooms: number = 16, baseDir?: string, maxBytes?: number) {
    this.maxRooms = maxRooms;
    this.maxBytes = maxBytes ?? 1_048_576; // 1 MiB default (ADR-0121 §8.3)
    this.baseDir = baseDir ?? path.join(os.homedir(), '.aluy', 'rooms');
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private filePath(code: string): string {
    // Defesa contra path traversal: código NUNCA pode conter separadores
    // de caminho ou sequências de escape de diretório.
    if (code.includes('/') || code.includes('\\') || code.includes('..')) {
      throw new Error(`Código de sala inválido: "${code}"`);
    }
    return path.join(this.baseDir, `${code}.jsonl`);
  }

  private lockPath(code: string): string {
    return path.join(this.baseDir, `${code}.jsonl.lock`);
  }

  private async ensureDir(): Promise<void> {
    await fsPromises.mkdir(this.baseDir, { mode: 0o700, recursive: true });
  }

  /**
   * F135 — `true` se o arquivo termina em '\n' (último append COMPLETO) OU está vazio/
   * ausente. `false` ⇒ a última linha está TORTA (crash mid-append anterior): o caller
   * (`set`) deve REESCREVER em vez de `appendFile` (senão cola o lixo parcial com a nova
   * linha e perde a mensagem). Lê só o ÚLTIMO byte (O(1), sem carregar o arquivo).
   * Erro ao checar ⇒ `true` (fail-open: não força rewrite; um append que falharia
   * também falharia aqui).
   */
  private async fileEndsWithNewline(fp: string): Promise<boolean> {
    let fh: fsPromises.FileHandle | undefined;
    try {
      fh = await fsPromises.open(fp, 'r');
      const { size } = await fh.stat();
      if (size === 0) return true; // vazio ⇒ sem linha torta
      const buf = Buffer.alloc(1);
      await fh.read(buf, 0, 1, size - 1);
      return buf[0] === 0x0a; // '\n'
    } catch {
      return true; // não conseguiu checar ⇒ fail-open (não piora)
    } finally {
      await fh?.close();
    }
  }

  // -----------------------------------------------------------------------
  // Lock acquisition
  // -----------------------------------------------------------------------

  private async acquireLock(code: string): Promise<LockState> {
    const lockFile = this.lockPath(code);
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;

    while (true) {
      const now = Date.now();
      if (now >= deadline) {
        throw new Error(
          `Timeout ao adquirir lock para sala "${code}" ` + `(${LOCK_ACQUIRE_TIMEOUT_MS}ms).`,
        );
      }

      try {
        const state: LockState = { pid: process.pid, createdAt: now };
        await fsPromises.writeFile(lockFile, serializeLock(state), {
          flag: 'wx',
          mode: 0o600,
        });
        return state; // F95: devolve o token p/ o release checar posse.
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'EEXIST') throw err;

        // Lock existe — verificar se é stale.
        try {
          const raw = await fsPromises.readFile(lockFile, 'utf-8');
          const existing = JSON.parse(raw) as LockState;
          if (isLockStale(existing, now)) {
            await this.stealStaleLock(lockFile, now);
          }
        } catch {
          // Lock CORROMPIDO (não-parseável) — rouba/remove do mesmo jeito atômico.
          await this.stealStaleLock(lockFile, now);
        }
      }

      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }
  }

  /**
   * HUNT-ROOM (TOCTOU) — quebra um lock STALE/corrompido de forma ATÔMICA. O `unlink`
   * DIRETO era racy: dois processos podiam ler o MESMO lock stale e ambos `unlink`,
   * e o 2º unlink apagaria um lock FRESCO que um 3º acabara de criar via `wx` ⇒ dois
   * "donos" ⇒ escrita concorrente corrompendo a sala. Aqui RENOMEAMOS o lock p/ um nome
   * ÚNICO primeiro: `rename` é atômico — só UM processo consegue mover um dado arquivo
   * (os demais ⇒ ENOENT). O vencedor remove SÓ o arquivo RENOMEADO (nome próprio),
   * NUNCA o `lockFile` vivo. O perdedor não toca em nada e volta ao loop (tenta o `wx`,
   * que segue sendo a única catraca atômica de aquisição). NÃO garante que QUEM quebrou
   * adquire — só garante que ninguém apaga o lock de outro.
   */
  private async stealStaleLock(lockFile: string, now: number): Promise<void> {
    const stolen = `${lockFile}.steal.${process.pid}.${now}`;
    try {
      await fsPromises.rename(lockFile, stolen);
    } catch {
      return; // outro processo já roubou/removeu o stale — nada a fazer.
    }
    try {
      await fsPromises.unlink(stolen); // só o RENOMEADO (meu), nunca um lock vivo.
    } catch {
      // já foi (best-effort).
    }
  }

  /**
   * Libera o lock SÓ se ele ainda for o NOSSO (F95). Se a seção crítica estourou
   * `LOCK_STALE_MS` e outro processo roubou o lock stale e adquiriu o seu, um `unlink`
   * cego apagaria o lock VIVO desse novo dono ⇒ dois escritores. Lendo-e-checando o
   * token antes, o dono que estourou vê que o lock não é mais dele e NÃO o toca.
   */
  private async releaseLock(code: string, token: LockState): Promise<void> {
    const lockFile = this.lockPath(code);
    try {
      const raw = await fsPromises.readFile(lockFile, 'utf-8');
      const cur = JSON.parse(raw) as LockState;
      if (cur.pid !== token.pid || cur.createdAt !== token.createdAt) {
        return; // roubado stale por outro — não é mais nosso.
      }
    } catch {
      return; // sumiu / corrompido — nada a liberar.
    }
    try {
      await fsPromises.unlink(lockFile);
    } catch {
      // Já foi removido.
    }
  }

  // -----------------------------------------------------------------------
  // RoomStore — Criação
  // -----------------------------------------------------------------------

  async create(opts?: { ttlMs?: number; now?: number }): Promise<Room> {
    await this.ensureDir();

    // Evicta mortas antes de verificar cap.
    await this.evictDead(opts?.now);

    if (this.maxRooms > 0 && (await this.size()) >= this.maxRooms) {
      throw new Error(`limite de salas por sessão (${this.maxRooms}) atingido`);
    }

    const now = opts?.now ?? Date.now();
    // exactOptionalPropertyTypes: não passe `undefined` como valor de campo opcional.
    const createOpts: { ttlMs?: number; now?: number } = { now };
    if (opts?.ttlMs !== undefined) {
      createOpts.ttlMs = opts.ttlMs;
    }
    const room = createRoom(createOpts);

    const metaLine = serializeRoomMeta(room) + '\n';

    const token = await this.acquireLock(room.code);
    try {
      await fsPromises.writeFile(this.filePath(room.code), metaLine, {
        flag: 'wx',
        mode: 0o600,
      });
    } finally {
      await this.releaseLock(room.code, token);
    }

    return room;
  }

  // -----------------------------------------------------------------------
  // RoomStore — Consulta
  // -----------------------------------------------------------------------

  async get(code: string): Promise<Room | undefined> {
    try {
      return await readRoomFile(this.filePath(code), code);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return undefined;
      throw err;
    }
  }

  async list(): Promise<readonly Room[]> {
    await this.ensureDir();
    const entries = await fsPromises.readdir(this.baseDir, {
      withFileTypes: true,
    });
    const rooms: Room[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const code = entry.name.slice(0, -6);
      if (!/^[a-f0-9]{32}$/.test(code)) continue;
      try {
        rooms.push(await readRoomFile(path.join(this.baseDir, entry.name), code));
      } catch {
        // Arquivo corrompido ou sumiu — pula.
      }
    }
    return rooms;
  }

  async size(): Promise<number> {
    try {
      const entries = await fsPromises.readdir(this.baseDir, {
        withFileTypes: true,
      });
      let count = 0;
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          if (/^[a-f0-9]{32}$/.test(entry.name.slice(0, -6))) count++;
        }
      }
      return count;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return 0;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // RoomStore — Mutação (set = persistir Room após post/revoke)
  // -----------------------------------------------------------------------

  async set(code: string, room: Room): Promise<void> {
    if (room.code !== code) {
      throw new Error(
        `RoomStore.set: código divergente — esperado "${code}", ` + `recebido "${room.code}"`,
      );
    }

    const token = await this.acquireLock(code);
    try {
      // Lê estado atual do disco, se arquivo existe.
      let diskRoom: Room | undefined;
      try {
        diskRoom = await readRoomFile(this.filePath(code), code);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== 'ENOENT') throw err;
      }

      if (diskRoom === undefined) {
        // Sala não existe em disco — criar com metadata + todas as mensagens.
        const lines: string[] = [serializeRoomMeta(room)];
        for (let i = 0; i < room.messages.length; i++) {
          lines.push(serializeMessage(room.messages[i], i + 2));
        }
        await fsPromises.writeFile(this.filePath(code), lines.join('\n') + '\n', { mode: 0o600 });
        return;
      }

      // Sala existe — três cenários:
      // 1. Metadata mudou (revoked, ttlMs) → reescreve linha 1.
      // 2. Mensagens novas → append.
      // 3. Ambos.

      // TODO(EST-1120): dedupe msg_id sob concorrência

      const existingMsgIds = new Set(diskRoom.messages.map((m) => m.msg_id));
      const newMessages = room.messages.filter((m) => !existingMsgIds.has(m.msg_id));

      const metaChanged = diskRoom.revoked !== room.revoked || diskRoom.ttlMs !== room.ttlMs;

      // F135 (HUNT-ROOM) — se o arquivo NÃO termina em '\n', a ÚLTIMA linha está TORTA:
      // um writer ANTERIOR crashou mid-append (escreveu bytes parciais SEM o '\n' final).
      // `deserializeRoom` TOLERA isso na LEITURA (dropa a torta) — mas um `appendFile`
      // cego aqui COLARIA o lixo parcial com a nova linha (`…"fr{"seq":…}`), corrompendo-a:
      // ela vira uma linha que NÃO parseia E a nova mensagem se PERDE silenciosamente
      // (o `set` reportou sucesso!), ainda colidindo seq. Quando torto, REESCREVEMOS o
      // arquivo limpo (meta + `diskRoom.messages` — já parseado SEM a torta — + novas):
      // repara a linha torta e grava a nova ÍNTEGRA. Sob o lock o arquivo é quiescente,
      // então só uma torta PRÉ-existente (crash passado) dispara isto.
      const tornTail = !(await this.fileEndsWithNewline(this.filePath(code)));

      if (metaChanged || tornTail) {
        // Reescreve o arquivo inteiro sob lock.
        const allMessages = [...diskRoom.messages, ...newMessages];
        const lines: string[] = [serializeRoomMeta(room)];
        for (let i = 0; i < allMessages.length; i++) {
          lines.push(serializeMessage(allMessages[i], i + 2));
        }
        const content = lines.join('\n') + '\n';
        // Cap de tamanho (ADR-0121 §8.3): recusa rewrite se excede maxBytes.
        if (this.maxBytes > 0 && Buffer.byteLength(content, 'utf-8') > this.maxBytes) {
          throw new Error(
            `limite de tamanho da sala excedido (${this.maxBytes} bytes). ` +
              `Evicte salas expiradas ou reduza o volume de mensagens.`,
          );
        }
        await fsPromises.writeFile(this.filePath(code), content, { mode: 0o600 });
      } else if (newMessages.length > 0) {
        // Só append das mensagens novas.
        const currentLineCount = diskRoom.messages.length + 1; // +1 = metadata
        let toAppend = '';
        for (let i = 0; i < newMessages.length; i++) {
          const seq = currentLineCount + i + 1;
          toAppend += serializeMessage(newMessages[i], seq) + '\n';
        }
        // Cap de tamanho (ADR-0121 §8.3): recusa append se tamanho total excede maxBytes.
        if (this.maxBytes > 0) {
          const stat = await fsPromises.stat(this.filePath(code));
          if (stat.size + Buffer.byteLength(toAppend, 'utf-8') > this.maxBytes) {
            throw new Error(
              `limite de tamanho da sala excedido (${this.maxBytes} bytes). ` +
                `Evicte salas expiradas ou reduza o volume de mensagens.`,
            );
          }
        }
        await fsPromises.appendFile(this.filePath(code), toAppend);
      }
      // else: nada mudou — no-op.
    } finally {
      await this.releaseLock(code, token);
    }
  }

  // -----------------------------------------------------------------------
  // RoomStore — Remoção
  // -----------------------------------------------------------------------

  async remove(code: string): Promise<boolean> {
    try {
      await fsPromises.unlink(this.filePath(code));
      return true;
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return false;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Eviction (EST-ROOMS-5, ADR-0121 §8.3)
  // -----------------------------------------------------------------------

  /**
   * Evicta salas mortas (expiradas ou revogadas) — HARD-DELETA os bytes.
   *
   * Chamado ANTES de `create()` verificar o cap, para não ocuparem vagas.
   *
   * @param now Timestamp de referência (default Date.now()).
   * @returns Número de salas evictadas.
   */
  async evictDead(now?: number): Promise<number> {
    const ref = now ?? Date.now();
    let entries: Dirent[];
    try {
      entries = await fsPromises.readdir(this.baseDir, {
        withFileTypes: true,
      });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return 0;
      throw err;
    }

    let evicted = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const code = entry.name.slice(0, -6);
      if (!/^[a-f0-9]{32}$/.test(code)) continue;

      const fp = path.join(this.baseDir, entry.name);
      try {
        const room = await readRoomFile(fp, code);
        if (room.revoked || isExpired(room, ref)) {
          await fsPromises.unlink(fp);
          evicted += 1;
        }
      } catch {
        // Arquivo corrompido ou sumiu — remove.
        try {
          await fsPromises.unlink(fp);
          evicted += 1;
        } catch {
          // Já foi — ignora.
        }
      }
    }
    return evicted;
  }
}

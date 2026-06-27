// EST-0999 · ADR-0078 — SALA MULTI-AGENTE: INVARIANTE #2.
//
// Sala = feed append-only de mensagens entre agentes.
// Fase 1: READ-ONLY — agentes LEEM o feed (envelopado como DADO),
//         nunca escrevem. Write-por-agente é Fase 2.
//
// PORTÁVEL (ADR-0053 §8): nada de Ink/IO de terminal.

import { randomBytes } from 'node:crypto';
import { type AgentMessage, envelopeAsData } from './message.js';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/**
 * Sala multi-agente.
 *
 * - `code`: identificador de alta entropia (>= 128 bits, hex).
 * - `createdAt`: timestamp de criação (ms desde epoch).
 * - `ttlMs`: tempo de vida em ms (após o qual a sala expira).
 * - `messages`: feed append-only de mensagens.
 * - `revoked`: se `true`, a sala foi revogada (sobrepõe expiração).
 */
export type Room = {
  code: string;
  createdAt: number;
  ttlMs: number;
  messages: AgentMessage[];
  revoked: boolean;
  /** EST-1120 — próximo seq monotônico a atribuir (1-based). Incrementa a cada append. */
  nextSeq: number;
};

/**
 * EST-1011 (HUNT-RESOURCE — feed de sala SEM TETO de armazenamento) — quantas
 * mensagens o feed de UMA sala retém. O `readRoom`/`room_read`/`/rooms read` já
 * CAPAVAM a EXIBIÇÃO (50 mais recentes), mas o array `messages` em si crescia SEM
 * LIMITE: cada `postMessage`/`seedMessage` fazia `[...messages, msg]` para sempre.
 * Numa sessão multi-agente LONGA (writers conversando por horas), o feed acumula
 * milhares de mensagens em RAM, `readRoom` envelopa TODAS a cada leitura e o
 * `hopDepth` (mesh) constrói um `Map` sobre TODAS a cada escrita — O(n) por post,
 * O(n²) na sessão. É a classe "acumulador sem teto" (EST-1011): um cap na LEITURA
 * mascara o vazamento na ESCRITA. Cercamos na ORIGEM (append), mantendo a CAUDA
 * (as mensagens recentes — o que o threading/leitura usam). Anel bounded.
 */
export const MAX_ROOM_MESSAGES = 500;

/**
 * EST-1011 — acrescenta `msg` ao feed mantendo no máximo `MAX_ROOM_MESSAGES`
 * mensagens (descarta as mais ANTIGAS do início). PURO: devolve um novo array; não
 * muta o feed original (imutabilidade da Room). Abaixo do teto, é só `[...prev, msg]`.
 */
export function appendBounded(prev: readonly AgentMessage[], msg: AgentMessage): AgentMessage[] {
  const next = [...prev, msg];
  // Acima do teto, descarta a CABEÇA (mais antigas) e mantém a cauda recente. O
  // threading `in_reply_to` opera sobre a janela viva (pais muito antigos já saíram —
  // o `hopDepth` trata um pai inexistente como raiz da cadeia conhecida, sem pendurar).
  return next.length > MAX_ROOM_MESSAGES ? next.slice(next.length - MAX_ROOM_MESSAGES) : next;
}

// ---------------------------------------------------------------------------
// Fábrica
// ---------------------------------------------------------------------------

/**
 * Cria uma nova sala com código de alta entropia (16 bytes → 32 chars hex).
 *
 * @param opts.ttlMs  Tempo de vida em ms (default 3_600_000 = 1 hora).
 * @param opts.now    Timestamp para `createdAt` (default `Date.now()`).
 */
export function createRoom(opts?: { ttlMs?: number; now?: number }): Room {
  const code = randomBytes(16).toString('hex'); // 128 bits, 32 caracteres hex
  return {
    code,
    createdAt: opts?.now ?? Date.now(),
    ttlMs: opts?.ttlMs ?? 3_600_000,
    messages: [],
    revoked: false,
    nextSeq: 1, // EST-1120
  };
}

// ---------------------------------------------------------------------------
// Ciclo de vida
// ---------------------------------------------------------------------------

/**
 * Verifica se a sala expirou com base no TTL.
 *
 * @param room  A sala a verificar.
 * @param now   Timestamp de referência (default `Date.now()`).
 * @returns `true` se `now > createdAt + ttlMs`.
 */
export function isExpired(room: Room, now?: number): boolean {
  return (now ?? Date.now()) > room.createdAt + room.ttlMs;
}

/**
 * Revoga a sala, impedindo leituras futuras (sobrepõe expiração).
 *
 * @returns Uma nova sala com `revoked: true` (imutabilidade).
 */
export function revokeRoom(room: Room): Room {
  return { ...room, revoked: true };
}

// ---------------------------------------------------------------------------
// Leitura (READ-ONLY — Fase 1)
// ---------------------------------------------------------------------------

/**
 * Lê o feed da sala, retornando cada mensagem **envelopada como DADO
 * NÃO-CONFIÁVEL** (`<<<DADO_NAO_CONFIAVEL origem=...>>>`).
 *
 * Regras:
 * - Sala revogada → `{ ok: false, reason: "revoked", entries: [] }`.
 * - Sala expirada  → `{ ok: false, reason: "expired", entries: [] }`.
 * - Caso contrário → `{ ok: true, entries: [...] }`.
 *
 * READ-ONLY: o agente que lê **pondera** o conteúdo, nunca o obedece como
 * instrução. O envelope é a garantia (CLI-SEC-4).
 *
 * EST-1120: `sinceSeq` opcional — se informado, só retorna mensagens com
 * `seq > sinceSeq` (cursor do leitor, paginação). Sempre respeita o
 * `sinceSeq` ANTES do cap de exibição (READ_CAP) — o cursor é do leitor e a
 * Room é imutável; o leitor controla até onde já viu.
 *
 * @param room  A sala a ler.
 * @param now   Timestamp de referência (default `Date.now()`).
 * @param sinceSeq Se informado, só retorna mensagens com `seq > sinceSeq`.
 */
export function readRoom(
  room: Room,
  now?: number,
  sinceSeq?: number,
): { ok: boolean; reason?: string; entries: string[] } {
  if (room.revoked) {
    return { ok: false, reason: 'revoked', entries: [] };
  }
  if (isExpired(room, now)) {
    return { ok: false, reason: 'expired', entries: [] };
  }
  const candidates =
    sinceSeq !== undefined && sinceSeq >= 0
      ? room.messages.filter((m) => m.seq > sinceSeq)
      : room.messages;
  return {
    ok: true,
    entries: candidates.map(envelopeAsData),
  };
}

// ---------------------------------------------------------------------------
// Semeadura (uso interno do sistema — NÃO é API de agente)
// ---------------------------------------------------------------------------

/**
 * Semeia uma mensagem no feed da sala.
 *
 * ⚠️ **USO INTERNO DO SISTEMA APENAS.** Esta função existe para que o
 * *orquestrador* (não o agente) possa semear o feed com mensagens iniciais
 * ou de sistema. A escrita direta por agente na sala é **Fase 2** (ADR-0078).
 *
 * @returns Uma nova sala com a mensagem adicionada ao final do feed.
 */
export function seedMessage(room: Room, msg: AgentMessage): Room {
  // EST-1120 — atribui seq monotônico (nextSeq) e incrementa.
  // EST-1011 — append BOUNDED (cap de armazenamento, MAX_ROOM_MESSAGES): mesmo a
  // semeadura do sistema não faz o feed crescer sem teto numa sessão longa.
  const seq = room.nextSeq;
  return {
    ...room,
    nextSeq: seq + 1,
    messages: appendBounded(room.messages, { ...msg, seq }),
  };
}

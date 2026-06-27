// EST-ROOMS-1 · ADR-0081 §4, APR-0086 — RoomStore: holder mutável por código.
//
// A lib de salas (room.ts) trata Room como IMUTÁVEL — cada post/revoke devolve
// uma nova instância. O RoomStore guarda a instância CORRENTE de cada sala,
// indexada pelo código, com um teto (cap) anti-runaway (ADR-0081 §9).
//
// PORTÁVEL (ADR-0053 §8): nada de Ink/IO de terminal. PURO quanto a relógio:
// NUNCA chama Date.now() — o `now` vem via opts do createRoom, repassado ao
// createRoom da lib.
//
// EST-1091 · ADR-0121 §6.1 — PORTA ASSÍNCRONA: a interface RoomStore é async
// para que backends de I/O (file/loopback/broker) possam plugar depois. O
// MemoryRoomStore é o backend in-memory atual, envolto em Promises resolvidas.
// ZERO mudança de comportamento — é refactor de assinatura.

import { createRoom, isExpired, type Room } from './room.js';

// ---------------------------------------------------------------------------
// RoomStore — interface assíncrona (porta)
// ---------------------------------------------------------------------------

/**
 * Porta assíncrona de holder de salas multi-agente, indexadas por código.
 *
 * - Cria salas via `create()` (delega à lib `createRoom`).
 * - Mantém um teto (`maxRooms`) — acima dele, `create()` lança.
 * - `set()` substitui a instância de uma sala (após post/revoke na Room
 *   imutável), validando que o código coincide.
 * - `get()`, `remove()`, `list()`, `size()` para consulta/remoção.
 */
export interface RoomStore {
  readonly maxRooms: number;

  create(opts?: { ttlMs?: number; now?: number }): Promise<Room>;

  /**
   * Remove as salas MORTAS (revogadas ou com TTL expirado) — libera slots do cap. Idempotente.
   * @returns quantas foram evictadas.
   */
  evictDead(now?: number): Promise<number>;

  /**
   * Recupera uma sala pelo código.
   * @returns A sala ou `undefined` se não existir.
   */
  get(code: string): Promise<Room | undefined>;

  /**
   * Lista todas as salas armazenadas (cópia defensiva).
   */
  list(): Promise<readonly Room[]>;

  /**
   * Número de salas atualmente armazenadas.
   */
  size(): Promise<number>;

  /**
   * Substitui a instância de uma sala no store.
   *
   * Útil após `postMessage`/`revokeRoom` na Room imutável — o caller passa
   * a nova Room e o store a guarda no lugar da anterior.
   *
   * @throws Error se `room.code !== code`.
   */
  set(code: string, room: Room): Promise<void>;

  /**
   * Remove uma sala do store.
   * @returns `true` se a sala existia e foi removida.
   */
  remove(code: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// MemoryRoomStore — implementação in-memory (Map)
// ---------------------------------------------------------------------------

/**
 * Implementação in-memory do RoomStore.
 *
 * Envolve o Map em Promises resolvidas — a lógica é síncrona mas a assinatura
 * é async para satisfazer a interface RoomStore (porta assíncrona).
 */
export class MemoryRoomStore implements RoomStore {
  private readonly rooms = new Map<string, Room>();
  readonly maxRooms: number;

  /**
   * @param maxRooms  Número máximo de salas (default 16, ADR-0081 §9).
   *                  Passar 0 ou negativo desliga o teto (não recomendado).
   */
  constructor(maxRooms: number = 16) {
    this.maxRooms = maxRooms;
  }

  // -----------------------------------------------------------------------
  // Criação
  // -----------------------------------------------------------------------

  /**
   * Cria uma nova sala e a armazena.
   *
   * @throws Error se o número de salas já atingiu `maxRooms` (e maxRooms > 0).
   */
  async create(opts?: { ttlMs?: number; now?: number }): Promise<Room> {
    // EST-ROOMS-5 (FU do gate AG-0008) — antes de bater no teto, EVICTA as salas MORTAS
    // (TTL expirado ou revogadas). Sem isto, um cap fixo SEM reuso vira DoS auto-infligido
    // numa sessão longa: após N salas (mesmo todas expiradas) todo `create` lança e o
    // multi-agente `room:true` para de funcionar (classe "recurso sem teto", EST-1011). A
    // eviction usa o `now` do opts (pureza preservada — o store nunca chama Date.now).
    await this.evictDead(opts?.now);
    if (this.maxRooms > 0 && this.rooms.size >= this.maxRooms) {
      throw new Error(`limite de salas por sessão (${this.maxRooms}) atingido`);
    }
    const room = createRoom(opts);
    this.rooms.set(room.code, room);
    return room;
  }

  /**
   * Remove as salas MORTAS (revogadas ou com TTL expirado) — libera slots do cap. Idempotente.
   * @returns quantas foram evictadas.
   */
  async evictDead(now?: number): Promise<number> {
    let evicted = 0;
    for (const [code, room] of this.rooms) {
      if (room.revoked || isExpired(room, now)) {
        this.rooms.delete(code);
        evicted += 1;
      }
    }
    return evicted;
  }

  // -----------------------------------------------------------------------
  // Leitura
  // -----------------------------------------------------------------------

  /**
   * Recupera uma sala pelo código.
   * @returns A sala ou `undefined` se não existir.
   */
  async get(code: string): Promise<Room | undefined> {
    return this.rooms.get(code);
  }

  /**
   * Lista todas as salas armazenadas (cópia defensiva).
   */
  async list(): Promise<readonly Room[]> {
    return [...this.rooms.values()];
  }

  /**
   * Número de salas atualmente armazenadas.
   */
  async size(): Promise<number> {
    return this.rooms.size;
  }

  // -----------------------------------------------------------------------
  // Mutação (substituição da instância imutável)
  // -----------------------------------------------------------------------

  /**
   * Substitui a instância de uma sala no store.
   *
   * Útil após `postMessage`/`revokeRoom` na Room imutável — o caller passa
   * a nova Room e o store a guarda no lugar da anterior.
   *
   * @throws Error se `room.code !== code`.
   */
  async set(code: string, room: Room): Promise<void> {
    if (room.code !== code) {
      throw new Error(
        `RoomStore.set: código divergente — esperado "${code}", recebido "${room.code}"`,
      );
    }
    this.rooms.set(code, room);
  }

  // -----------------------------------------------------------------------
  // Remoção
  // -----------------------------------------------------------------------

  /**
   * Remove uma sala do store.
   * @returns `true` se a sala existia e foi removida.
   */
  async remove(code: string): Promise<boolean> {
    return this.rooms.delete(code);
  }
}

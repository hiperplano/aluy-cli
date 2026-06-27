// EST-ROOMS-1 · ADR-0081 §4, APR-0086 — Testes do RoomStore.
//
// Determinístico: usa `now` fixo nos creates.
// EST-1091: adaptado para a porta ASSÍNCRONA (MemoryRoomStore + await).

import { describe, it, expect } from 'vitest';
import { MemoryRoomStore, createRoom } from '../../../src/agent/rooms/index.js';
import type { Room } from '../../../src/agent/rooms/index.js';

const FIXED_NOW = 1_700_000_000_000;

describe('MemoryRoomStore (RoomStore porta assíncrona)', () => {
  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------
  it('create devolve uma Room com código + entra no store (get acha)', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: FIXED_NOW });

    expect(room).toBeDefined();
    expect(typeof room.code).toBe('string');
    expect(room.code.length).toBe(32); // 16 bytes → 32 hex chars
    expect(room.createdAt).toBe(FIXED_NOW);

    const stored = await store.get(room.code);
    expect(stored).toBeDefined();
    expect(stored!.code).toBe(room.code);
  });

  it('2 creates ⇒ size 2, list 2', async () => {
    const store = new MemoryRoomStore();
    const r1 = await store.create({ now: FIXED_NOW });
    const r2 = await store.create({ now: FIXED_NOW });

    expect(await store.size()).toBe(2);
    expect(await store.list()).toHaveLength(2);
    expect((await store.list()).map((r) => r.code)).toEqual(
      expect.arrayContaining([r1.code, r2.code]),
    );
  });

  // -----------------------------------------------------------------------
  // set
  // -----------------------------------------------------------------------
  it('set substitui a Room daquele código', async () => {
    const store = new MemoryRoomStore();
    const original = await store.create({ now: FIXED_NOW, ttlMs: 60_000 });

    // Simula um post/revoke na Room imutável: cria uma nova instância com
    // o MESMO código mas estado diferente.
    const updated: Room = { ...original, revoked: true };

    await store.set(original.code, updated);

    const stored = await store.get(original.code);
    expect(stored).toBeDefined();
    expect(stored!.revoked).toBe(true);
    // Garante que a instância mudou (referência diferente)
    expect(stored).not.toBe(original);
  });

  it('set com código divergente lança', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: FIXED_NOW });

    const other: Room = createRoom({ now: FIXED_NOW });

    await expect(store.set('codigo-diferente', room)).rejects.toThrow('código divergente');
    await expect(store.set(other.code, room)).rejects.toThrow('código divergente');
  });

  // -----------------------------------------------------------------------
  // remove
  // -----------------------------------------------------------------------
  it('remove tira a sala do store', async () => {
    const store = new MemoryRoomStore();
    const room = await store.create({ now: FIXED_NOW });

    expect(await store.get(room.code)).toBeDefined();
    const removed = await store.remove(room.code);
    expect(removed).toBe(true);
    expect(await store.get(room.code)).toBeUndefined();
    expect(await store.size()).toBe(0);
  });

  it('remove de código inexistente retorna false', async () => {
    const store = new MemoryRoomStore();
    expect(await store.remove('nao-existe')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // size / list
  // -----------------------------------------------------------------------
  it('size reflete quantidade correta após cria e remove', async () => {
    const store = new MemoryRoomStore();
    expect(await store.size()).toBe(0);

    const r1 = await store.create({ now: FIXED_NOW });
    expect(await store.size()).toBe(1);

    const r2 = await store.create({ now: FIXED_NOW });
    expect(await store.size()).toBe(2);

    await store.remove(r1.code);
    expect(await store.size()).toBe(1);

    await store.remove(r2.code);
    expect(await store.size()).toBe(0);
  });

  it('list retorna cópia (mutação externa não afeta store)', async () => {
    const store = new MemoryRoomStore();
    await store.create({ now: FIXED_NOW });

    const listBefore = await store.list();
    // Altera a cópia (não afeta o Map interno)
    (listBefore as Room[]).pop();
    expect(await store.size()).toBe(1); // inalterado
  });

  // -----------------------------------------------------------------------
  // Cap (maxRooms)
  // -----------------------------------------------------------------------
  it('cria até o maxRooms padrão (16) e o 17º lança', async () => {
    const store = new MemoryRoomStore(16);
    for (let i = 0; i < 16; i++) {
      await store.create({ now: FIXED_NOW });
    }
    expect(await store.size()).toBe(16);

    await expect(store.create({ now: FIXED_NOW })).rejects.toThrow(
      'limite de salas por sessão (16) atingido',
    );
  });

  it('maxRooms=1: um create ok, segundo lança', async () => {
    const store = new MemoryRoomStore(1);
    await store.create({ now: FIXED_NOW });
    await expect(store.create({ now: FIXED_NOW })).rejects.toThrow(
      'limite de salas por sessão (1) atingido',
    );
  });

  it('maxRooms=0 (desligado) permite criar muitas salas', async () => {
    const store = new MemoryRoomStore(0);
    for (let i = 0; i < 100; i++) {
      await store.create({ now: FIXED_NOW });
    }
    expect(await store.size()).toBe(100);
  });

  // -----------------------------------------------------------------------
  // Integração: set após createRoom direto
  // -----------------------------------------------------------------------
  it('set aceita Room vinda de createRoom da lib (mesmo código)', async () => {
    const store = new MemoryRoomStore();
    const room = createRoom({ now: FIXED_NOW });

    await store.set(room.code, room);
    expect(await store.get(room.code)).toBe(room);
  });
});

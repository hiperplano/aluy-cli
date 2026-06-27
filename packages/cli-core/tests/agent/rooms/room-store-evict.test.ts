// EST-ROOMS-5 (FU do gate AG-0008) — eviction de salas MORTAS no RoomStore: sem reuso, o
// cap fixo viraria DoS auto-infligido numa sessão longa (classe "recurso sem teto", EST-1011).
// EST-1091: adaptado para a porta ASSÍNCRONA (MemoryRoomStore + await).

import { describe, it, expect } from 'vitest';
import { MemoryRoomStore } from '../../../src/agent/rooms/index.js';

const T0 = 1_700_000_000_000;

describe('MemoryRoomStore — eviction de salas mortas (EST-ROOMS-5)', () => {
  it('create() acima do cap NÃO lança se há salas EXPIRADAS — elas são evictadas', async () => {
    const store = new MemoryRoomStore(3);
    // 3 salas com TTL curto, criadas em T0 (enchem o cap).
    for (let i = 0; i < 3; i++) await store.create({ now: T0, ttlMs: 100 });
    expect(await store.size()).toBe(3);
    // muito depois (todas expiradas): o 4º create NÃO lança — evicta as 3 mortas antes.
    const novo = await store.create({ now: T0 + 10_000, ttlMs: 100 });
    expect(novo).toBeDefined();
    expect(await store.size()).toBe(1); // só a nova sobrou
  });

  it('create() acima do cap com salas VIVAS ainda lança (cap real respeitado)', async () => {
    const store = new MemoryRoomStore(2);
    await store.create({ now: T0, ttlMs: 1_000_000 }); // viva
    await store.create({ now: T0, ttlMs: 1_000_000 }); // viva
    // todas vivas no mesmo instante ⇒ nada a evictar ⇒ o cap morde.
    await expect(store.create({ now: T0, ttlMs: 1_000_000 })).rejects.toThrow(/limite de salas/);
  });

  it('evictDead remove revogadas e expiradas, devolve a contagem', async () => {
    const store = new MemoryRoomStore(8);
    const viva = await store.create({ now: T0, ttlMs: 1_000_000 });
    const expira = await store.create({ now: T0, ttlMs: 100 });
    const revoga = await store.create({ now: T0, ttlMs: 1_000_000 });
    // revoga uma (set com a Room marcada revoked — espelha o fluxo real revokeRoom→set).
    await store.set(revoga.code, { ...revoga, revoked: true });
    const n = await store.evictDead(T0 + 10_000); // agora expira a de ttl curto + a revogada
    expect(n).toBe(2);
    expect(await store.size()).toBe(1);
    expect(await store.get(viva.code)).toBeDefined();
    expect(await store.get(expira.code)).toBeUndefined();
    expect(await store.get(revoga.code)).toBeUndefined();
  });
});

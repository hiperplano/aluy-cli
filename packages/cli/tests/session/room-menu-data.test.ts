// Leitor de salas do seletor `/rooms` (menuData.rooms) + o seletor em si (ler / observar).
import { describe, expect, it } from 'vitest';
import { MemoryRoomStore, postMessage } from '@hiperplano/aluy-cli-core';
import { roomsMenuData } from '../../src/session/rooms/room-menu-data.js';
import { menuStepFor, type MenuCtx } from '../../src/slash/menu-pickers.js';

describe('roomsMenuData', () => {
  it('lista as salas vivas com mensagens, atividade e participantes; some as revogadas', async () => {
    const store = new MemoryRoomStore();
    const a = await store.create();
    const b = await store.create();
    const r = postMessage(
      a,
      { writers: ['revisor'], maxHops: 4 },
      'revisor',
      {
        msg_id: 'm1',
        seq: 0,
        from: 'revisor',
        to: 'all',
        kind: 'inform',
        body: 'oi',
        ts: a.createdAt + 1_000,
      },
      a.createdAt + 1_000,
    );
    if (!r.ok) throw new Error('post falhou');
    await store.set(a.code, r.room);
    await store.set(b.code, { ...b, revoked: true });
    const rows = await roomsMenuData(store, () => a.createdAt + 61_000)();
    expect(rows).toEqual([{ id: a.code, label: a.code, hint: '1 msg · há 1m · revisor' }]);
  });

  it('sem salas ⇒ lista vazia', async () => {
    expect(await roomsMenuData(new MemoryRoomStore())()).toEqual([]);
  });
});

describe('/rooms com o leitor ligado', () => {
  const ctx = (rooms: MenuCtx['data']): MenuCtx => ({
    conversation: 'classic',
    conciergeAvailable: false,
    statusline: 'full',
    suggestionsOn: true,
    splitOn: false,
    data: rooms,
  });
  it('sem leitor cai no texto; com leitor oferece ler e observar', async () => {
    expect(menuStepFor('rooms', ctx(undefined))).toBeNull();
    const store = new MemoryRoomStore();
    const room = await store.create();
    const step = await menuStepFor('rooms', ctx({ rooms: roomsMenuData(store) }))!;
    const it = step.items.find((i) => i.id === room.code)!;
    if (it.outcome.kind !== 'next') throw new Error('esperava next');
    const acts = await it.outcome.step;
    expect(acts.items.map((i) => i.label)).toEqual(['ler', 'observar']);
    expect(acts.items.map((i) => (i.outcome.kind === 'run' ? i.outcome.args[0] : ''))).toEqual([
      `read ${room.code}`,
      `watch ${room.code}`,
    ]);
  });
});

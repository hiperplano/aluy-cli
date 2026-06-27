// HUNT-RESOURCE-CEILING (EST-1011 — classe "acumulador sem teto") — o feed de uma
// SALA crescia sem limite: a EXIBIÇÃO (readRoom/room_read/`/rooms read`) já capava em
// 50, mas o array `messages` em si fazia `[...messages, msg]` para SEMPRE. Numa sessão
// multi-agente LONGA isso é vazamento de RAM + O(n²) (hopDepth varre TODAS a cada post).
//
// Estes testes FALHAM sem o `appendBounded` (o feed cresceria ilimitado) e PASSAM com
// ele: o armazenamento é cercado em MAX_ROOM_MESSAGES, mantendo a CAUDA recente.

import { describe, it, expect } from 'vitest';
import { createRoom, MAX_ROOM_MESSAGES, seedMessage } from '../../../src/agent/rooms/room.js';
import { postMessage } from '../../../src/agent/rooms/mesh.js';
import type { MeshPolicy } from '../../../src/agent/rooms/mesh.js';
import type { AgentMessage } from '../../../src/agent/rooms/message.js';

const POLICY: MeshPolicy = { writers: ['a'], maxHops: 100000 };

function msg(i: number): AgentMessage {
  return { msg_id: `m${i}`, from: 'a', to: 'b', kind: 'inform', body: `corpo ${i}`, ts: i };
}

describe('HUNT-RESOURCE — feed de sala BOUNDED no armazenamento', () => {
  it('postMessage NÃO acumula sem teto: o feed para em MAX_ROOM_MESSAGES (sessão longa)', () => {
    let room = createRoom({ now: 0, ttlMs: Number.MAX_SAFE_INTEGER });
    // Sessão multi-agente longa: MUITAS mensagens além do teto (3× o cap).
    const total = MAX_ROOM_MESSAGES * 3 + 7;
    for (let i = 0; i < total; i++) {
      // Sem `in_reply_to` p/ não acionar hop-limit — o foco é o crescimento do feed.
      const r = postMessage(room, POLICY, 'a', msg(i), i + 1);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      room = r.room;
      // INVARIANTE: o feed NUNCA passa do teto — não cresce sem limite numa sessão longa.
      expect(room.messages.length).toBeLessThanOrEqual(MAX_ROOM_MESSAGES);
    }
    // Estabilizou EXATAMENTE no teto (não num número proporcional ao total enviado).
    expect(room.messages.length).toBe(MAX_ROOM_MESSAGES);
    // Manteve a CAUDA recente (a última enviada está lá; a primeira foi evictada).
    expect(room.messages[room.messages.length - 1]!.msg_id).toBe(`m${total - 1}`);
    expect(room.messages[0]!.msg_id).toBe(`m${total - MAX_ROOM_MESSAGES}`);
    expect(room.messages.some((m) => m.msg_id === 'm0')).toBe(false);
  });

  it('seedMessage (semeadura do sistema) também respeita o teto de armazenamento', () => {
    let room = createRoom({ now: 0, ttlMs: Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < MAX_ROOM_MESSAGES + 50; i++) {
      room = seedMessage(room, msg(i));
    }
    expect(room.messages.length).toBe(MAX_ROOM_MESSAGES);
    // A cauda recente sobrevive; a cabeça antiga foi descartada.
    expect(room.messages[room.messages.length - 1]!.msg_id).toBe(`m${MAX_ROOM_MESSAGES + 49}`);
    expect(room.messages.some((m) => m.msg_id === 'm0')).toBe(false);
  });

  it('abaixo do teto, NADA é descartado (cap só morde acima do limite)', () => {
    let room = createRoom({ now: 0, ttlMs: Number.MAX_SAFE_INTEGER });
    for (let i = 0; i < 10; i++) room = seedMessage(room, msg(i));
    expect(room.messages.length).toBe(10);
    expect(room.messages[0]!.msg_id).toBe('m0');
  });
});

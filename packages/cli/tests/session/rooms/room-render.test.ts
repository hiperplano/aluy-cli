// ADR-0126(B) — render PURO da visibilidade de salas. Testa formatação sem TUI/store.

import { describe, it, expect } from 'vitest';
import {
  relTime,
  participantsOf,
  formatRoomSummary,
  formatConversation,
  formatNewSince,
  maxSeq,
} from '../../../src/session/rooms/room-render.js';
import type { Room } from '@aluy/cli-core';

function msg(over: Partial<Room['messages'][number]> = {}): Room['messages'][number] {
  return {
    msg_id: 'm1',
    seq: 1,
    from: 'alpha',
    to: 'beta',
    kind: 'inform',
    body: 'oi',
    ts: 1_000,
    ...over,
  };
}

function room(over: Partial<Room> = {}): Room {
  return {
    code: 'abc123',
    createdAt: 0,
    ttlMs: 3_600_000,
    revoked: false,
    nextSeq: 1,
    messages: [],
    ...over,
  };
}

describe('relTime', () => {
  it('formata faixas: agora/s/m/h/d', () => {
    expect(relTime(0)).toBe('agora');
    expect(relTime(4_999)).toBe('agora');
    expect(relTime(12_000)).toBe('12s');
    expect(relTime(3 * 60_000)).toBe('3m');
    expect(relTime(2 * 3_600_000)).toBe('2h');
    expect(relTime(3 * 86_400_000)).toBe('3d');
  });
  it('entrada inválida ⇒ "—"', () => {
    expect(relTime(-1)).toBe('—');
    expect(relTime(NaN)).toBe('—');
  });
});

describe('participantsOf', () => {
  it('distintos por `from`, ordem de 1ª aparição', () => {
    const r = room({
      messages: [
        msg({ from: 'a' }),
        msg({ from: 'b' }),
        msg({ from: 'a' }), // repetido ⇒ não duplica
        msg({ from: 'c' }),
      ],
    });
    expect(participantsOf(r)).toEqual(['a', 'b', 'c']);
  });
  it('sala vazia ⇒ []', () => {
    expect(participantsOf(room())).toEqual([]);
  });
});

describe('formatRoomSummary', () => {
  it('código · msgs · última atividade · participantes', () => {
    const r = room({
      code: 'XY',
      messages: [msg({ from: 'rev', ts: 1_000 }), msg({ from: 'dev', ts: 5_000 })],
    });
    // now = 5_000 + 12_000 = 17_000 ⇒ "há 12s"
    expect(formatRoomSummary(r, 17_000)).toBe('XY · 2 msg · há 12s · rev, dev');
  });
  it('sala vazia ⇒ "sem atividade", sem participantes', () => {
    expect(formatRoomSummary(room({ code: 'Z' }), 99_999)).toBe('Z · 0 msg · sem atividade');
  });
  it('revogada ⇒ marca (revogada)', () => {
    const r = room({ code: 'R', revoked: true, messages: [msg({ ts: 1_000 })] });
    expect(formatRoomSummary(r, 1_000)).toContain('(revogada)');
  });
});

describe('formatConversation', () => {
  it('cabeçalho com participantes + linhas [seq] from → to [kind]: body', () => {
    const r = room({
      code: 'C',
      messages: [
        msg({ seq: 2, from: 'a', to: 'b', kind: 'ask', body: 'qual o status?' }),
        msg({ seq: 3, from: 'b', to: 'a', kind: 'result', body: 'pronto' }),
      ],
    });
    const { header, lines } = formatConversation(r, 50);
    expect(header).toBe('C · 2 msg · a, b');
    expect(lines).toEqual([
      '[seq 2] a → b [ask]: qual o status?',
      '[seq 3] b → a [result]: pronto',
    ]);
  });
  it('cap de tail: só as N últimas', () => {
    const many = Array.from({ length: 10 }, (_, i) => msg({ seq: i + 2, body: `linha ${i}` }));
    const { lines } = formatConversation(room({ messages: many }), 3);
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('linha 9');
  });
});

describe('formatNewSince + maxSeq', () => {
  it('só as mensagens com seq > sinceSeq', () => {
    const r = room({
      messages: [msg({ seq: 2, body: 'velha' }), msg({ seq: 3, body: 'nova' })],
    });
    expect(maxSeq(r)).toBe(3);
    expect(formatNewSince(r, 2)).toEqual(['[seq 3] alpha → beta [inform]: nova']);
    expect(formatNewSince(r, 3)).toEqual([]); // nada novo após o cursor
  });
  it('maxSeq de sala vazia ⇒ 0', () => {
    expect(maxSeq(room())).toBe(0);
  });
});

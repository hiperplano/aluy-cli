import { describe, it, expect } from 'vitest';
import { parseGetUpdates } from '../../src/connector/telegram-protocol.js';

const resp = (result: unknown[]) => ({ ok: true, result });

describe('parseGetUpdates (ADR-0134 §4 — parser puro, fail-safe)', () => {
  it('mensagem simples ⇒ TelegramUpdate + nextOffset = update_id+1', () => {
    const p = parseGetUpdates(
      resp([{ update_id: 42, message: { chat: { id: 100 }, from: { id: 100 }, text: 'oi' } }]),
      0,
    );
    expect(p.updates).toEqual([{ chatId: 100, fromId: 100, text: 'oi' }]);
    expect(p.nextOffset).toBe(43);
  });

  it('FORWARD ⇒ forwarded:true (vira DADO na malha)', () => {
    const p = parseGetUpdates(
      resp([
        { update_id: 1, message: { chat: { id: 5 }, from: { id: 5 }, text: 'x', forward_origin: {} } },
      ]),
      0,
    );
    expect(p.updates[0]).toMatchObject({ chatId: 5, text: 'x', forwarded: true });
  });

  it('REPLY-COM-QUOTE ⇒ quotedText (dado embutido)', () => {
    const p = parseGetUpdates(
      resp([
        { update_id: 1, message: { chat: { id: 5 }, from: { id: 5 }, text: 'q?', quote: { text: 'citado' } } },
      ]),
      0,
    );
    expect(p.updates[0]).toMatchObject({ text: 'q?', quotedText: 'citado' });
    expect(p.updates[0]?.forwarded).toBeUndefined();
  });

  it('fromId default = chatId quando from ausente', () => {
    const p = parseGetUpdates(resp([{ update_id: 1, message: { chat: { id: 7 }, text: 'a' } }]), 0);
    expect(p.updates[0]).toMatchObject({ chatId: 7, fromId: 7 });
  });

  it('ignora não-message (edited_message/channel_post) e itens sem chat', () => {
    const p = parseGetUpdates(
      resp([
        { update_id: 1, edited_message: { chat: { id: 1 }, text: 'edit' } },
        { update_id: 2, message: { from: { id: 9 }, text: 'sem chat' } },
        { update_id: 3, message: { chat: { id: 9 }, text: 'vale' } },
      ]),
      0,
    );
    expect(p.updates).toHaveLength(1);
    expect(p.updates[0]).toMatchObject({ chatId: 9, text: 'vale' });
    expect(p.nextOffset).toBe(4); // offset avança mesmo p/ os ignorados (não reprocessa)
  });

  it('resposta vazia/ok:false/lixo ⇒ [] e offset inalterado (fail-safe)', () => {
    expect(parseGetUpdates({ ok: true, result: [] }, 10)).toEqual({ updates: [], nextOffset: 10 });
    expect(parseGetUpdates({ ok: false }, 10)).toEqual({ updates: [], nextOffset: 10 });
    expect(parseGetUpdates(null, 10)).toEqual({ updates: [], nextOffset: 10 });
    expect(parseGetUpdates('lixo', 10)).toEqual({ updates: [], nextOffset: 10 });
  });

  it('texto ausente ⇒ string vazia (a malha descarta no classify)', () => {
    const p = parseGetUpdates(resp([{ update_id: 1, message: { chat: { id: 1 } } }]), 0);
    expect(p.updates[0]?.text).toBe('');
  });
});

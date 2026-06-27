import { describe, it, expect } from 'vitest';
import { parseGetUpdates } from '../../src/connector/telegram-protocol.js';

const resp = (result: unknown[]) => ({ ok: true, result });
/** message DM privada por default (v1). Sobrescreva `chat`/`from` p/ casos especiais. */
const dm = (over: Record<string, unknown> = {}) => ({
  chat: { id: 100, type: 'private' },
  from: { id: 100, is_bot: false },
  text: 'oi',
  ...over,
});

describe('parseGetUpdates (ADR-0134 §4 — parser puro, fail-safe)', () => {
  it('mensagem DM simples ⇒ TelegramUpdate + nextOffset = update_id+1', () => {
    const p = parseGetUpdates(resp([{ update_id: 42, message: dm() }]), 0);
    expect(p.updates).toEqual([{ chatId: 100, fromId: 100, text: 'oi' }]);
    expect(p.nextOffset).toBe(43);
  });

  it('FORWARD ⇒ forwarded:true (vira DADO na malha)', () => {
    const p = parseGetUpdates(
      resp([{ update_id: 1, message: dm({ chat: { id: 5, type: 'private' }, from: { id: 5 }, text: 'x', forward_origin: {} }) }]),
      0,
    );
    expect(p.updates[0]).toMatchObject({ chatId: 5, text: 'x', forwarded: true });
  });

  it('REPLY-COM-QUOTE ⇒ quotedText (dado embutido)', () => {
    const p = parseGetUpdates(
      resp([{ update_id: 1, message: dm({ text: 'q?', quote: { text: 'citado' } }) }]),
      0,
    );
    expect(p.updates[0]).toMatchObject({ text: 'q?', quotedText: 'citado' });
    expect(p.updates[0]?.forwarded).toBeUndefined();
  });

  it('R2/TC-6: from.is_bot ⇒ isBot:true (a malha descarta — anti-loop)', () => {
    const p = parseGetUpdates(
      resp([{ update_id: 1, message: dm({ from: { id: 100, is_bot: true } }) }]),
      0,
    );
    expect(p.updates[0]).toMatchObject({ isBot: true });
  });

  it('R4: chat NÃO-privado (grupo/canal) ⇒ IGNORADO (não autoriza terceiro do grupo)', () => {
    const p = parseGetUpdates(
      resp([
        { update_id: 1, message: { chat: { id: -500, type: 'group' }, from: { id: 999 }, text: 'oi grupo' } },
        { update_id: 2, message: { chat: { id: -1, type: 'supergroup' }, from: { id: 9 }, text: 'x' } },
        { update_id: 3, message: dm({ text: 'dm vale' }) },
      ]),
      0,
    );
    expect(p.updates).toHaveLength(1);
    expect(p.updates[0]).toMatchObject({ chatId: 100, text: 'dm vale' });
    expect(p.nextOffset).toBe(4); // offset avança p/ os ignorados (não reprocessa)
  });

  it('R4: chat sem `type` ⇒ tratado como NÃO-privado (ignorado, fail-closed)', () => {
    const p = parseGetUpdates(resp([{ update_id: 1, message: { chat: { id: 1 }, from: { id: 1 }, text: 'x' } }]), 0);
    expect(p.updates).toHaveLength(0);
  });

  it('fromId default = chatId quando from ausente', () => {
    const p = parseGetUpdates(resp([{ update_id: 1, message: { chat: { id: 7, type: 'private' }, text: 'a' } }]), 0);
    expect(p.updates[0]).toMatchObject({ chatId: 7, fromId: 7 });
  });

  it('ignora não-message (edited_message/channel_post)', () => {
    const p = parseGetUpdates(
      resp([
        { update_id: 1, edited_message: dm({ text: 'edit' }) },
        { update_id: 2, message: dm({ text: 'vale' }) },
      ]),
      0,
    );
    expect(p.updates).toHaveLength(1);
    expect(p.updates[0]).toMatchObject({ text: 'vale' });
    expect(p.nextOffset).toBe(3);
  });

  it('resposta vazia/ok:false/lixo ⇒ [] e offset inalterado (fail-safe)', () => {
    expect(parseGetUpdates({ ok: true, result: [] }, 10)).toEqual({ updates: [], nextOffset: 10 });
    expect(parseGetUpdates({ ok: false }, 10)).toEqual({ updates: [], nextOffset: 10 });
    expect(parseGetUpdates(null, 10)).toEqual({ updates: [], nextOffset: 10 });
    expect(parseGetUpdates('lixo', 10)).toEqual({ updates: [], nextOffset: 10 });
  });

  it('texto ausente ⇒ string vazia (a malha descarta no classify)', () => {
    const p = parseGetUpdates(resp([{ update_id: 1, message: { chat: { id: 1, type: 'private' } } }]), 0);
    expect(p.updates[0]?.text).toBe('');
  });
});

// O DESCARTE NO PARSE precisa dizer o motivo.
//
// Este era o ÚNICO trecho do caminho de ingresso sem voz — e o pior lugar possível para
// isso, porque o `maxId` avança ANTES dos filtros: um update descartado aqui sai da fila
// do Telegram do mesmo jeito. A mensagem do dono é consumida e some.
//
// O que isso custou (01/09): a ponte polizava (medido: duas conexões abertas com
// `api.telegram.org`), a fila do Telegram zerava a cada checagem — ou seja, as mensagens
// CHEGAVAM e eram consumidas — e o roteamento NUNCA era chamado. Não havia como saber
// onde elas morriam, porque este arquivo é código PURO do core, sem I/O e sem log.
//
// A solução respeita a pureza: o parser não loga, ele DEVOLVE o motivo. Quem tem log
// (o `TelegramClient`) escreve. Metadados apenas — o texto do usuário nunca vai a disco.

import { describe, expect, it } from 'vitest';
import { parseGetUpdates } from '../../src/connector/telegram-protocol.js';

function resposta(...mensagens: unknown[]): unknown {
  return {
    ok: true,
    result: mensagens.map((message, i) => ({ update_id: 100 + i, message })),
  };
}

const PRIVADA = {
  chat: { id: 42, type: 'private' },
  from: { id: 42, is_bot: false },
  text: 'ola',
};

describe('parseGetUpdates — o descarte explica a si mesmo', () => {
  it('mensagem privada normal passa e NÃO gera descarte', () => {
    const r = parseGetUpdates(resposta(PRIVADA), 0);
    expect(r.updates).toHaveLength(1);
    expect(r.descartados ?? []).toEqual([]);
  });

  it('chat de GRUPO ⇒ descartado com o motivo E o `chat.type` que veio', () => {
    const r = parseGetUpdates(
      resposta({ ...PRIVADA, chat: { id: -1001234, type: 'supergroup' } }),
      0,
    );
    expect(r.updates).toHaveLength(0);
    expect(r.descartados?.[0]?.motivo).toBe('nao-privado');
    expect(r.descartados?.[0]?.chatType, 'sem o tipo cru não dá p/ diagnosticar').toBe(
      'supergroup',
    );
    expect(r.descartados?.[0]?.chatId).toBe(-1001234);
  });

  it('update SEM `message` (edited/channel_post) ⇒ motivo próprio', () => {
    const r = parseGetUpdates({ ok: true, result: [{ update_id: 7, edited_message: PRIVADA }] }, 0);
    expect(r.updates).toHaveLength(0);
    expect(r.descartados?.[0]?.motivo).toBe('sem-message');
    expect(r.descartados?.[0]?.updateId).toBe(7);
  });

  it('mensagem sem `chat` ⇒ motivo próprio', () => {
    const r = parseGetUpdates(resposta({ from: { id: 1 }, text: 'x' }), 0);
    expect(r.descartados?.[0]?.motivo).toBe('sem-chat');
  });

  it('o OFFSET avança mesmo no descarte — é por isso que o silêncio era fatal', () => {
    // Este caso documenta a mecânica que fez a mensagem SUMIR: descartada aqui, ela já
    // foi confirmada no Telegram e não volta.
    const r = parseGetUpdates(resposta({ ...PRIVADA, chat: { id: -1, type: 'group' } }), 0);
    expect(r.updates).toHaveLength(0);
    expect(r.nextOffset, 'o update foi CONSUMIDO mesmo sendo descartado').toBe(101);
  });

  it('o texto do usuário NUNCA aparece no descarte (só metadados)', () => {
    const r = parseGetUpdates(
      resposta({ ...PRIVADA, text: 'SEGREDO-DO-DONO', chat: { id: -1, type: 'group' } }),
      0,
    );
    expect(JSON.stringify(r.descartados)).not.toContain('SEGREDO-DO-DONO');
  });

  it('vários updates: relata TODOS os descartes, não só o primeiro', () => {
    const r = parseGetUpdates(
      resposta({ ...PRIVADA, chat: { id: -1, type: 'group' } }, PRIVADA, {
        ...PRIVADA,
        chat: { id: -2, type: 'channel' },
      }),
      0,
    );
    expect(r.updates).toHaveLength(1);
    expect(r.descartados).toHaveLength(2);
  });
});

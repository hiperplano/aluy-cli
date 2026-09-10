// ACK VISUAL do ingresso — o "visto" que o dono pediu.
//
// Pedido dele em 01/09: "ele não deveria marcar a msg quando é lida". A Bot API NÃO tem
// "marcar como lida" para bots; o equivalente é `setMessageReaction` (verificado ao vivo
// contra o bot dele antes de implementar: FUNCIONA), que ancora o emoji NA mensagem —
// melhor que um visto genérico, porque diz QUAL mensagem foi vista.
//
// O que isso resolve, além do pedido: durante o dia inteiro uma mensagem descartada sumia
// sem NENHUM sinal, e ele só descobria lendo arquivo (quando havia arquivo). Com o ACK o
// retorno chega no celular — 👀 aceita, 🚫 descartada — sem depender de log nem de
// resposta do agente.
//
// Segurança: o alvo vem do INGRESSO (nunca de argumento do modelo) e o emoji é de conjunto
// FECHADO. Não há superfície de exfiltração — o modelo não escolhe destino nem símbolo.

import { describe, expect, it, vi } from 'vitest';
import { TelegramBridge } from '../../src/connector/telegram-bridge.js';

const META = { id: 'telegram', nome: 'Telegram' };

function monta(opts: { allow: string[]; ack?: ReturnType<typeof vi.fn> }) {
  const msgs: Record<string, unknown>[] = [];
  const bridge = new TelegramBridge({
    connectorFactory: () =>
      ({
        meta: META,
        async *incoming() {
          /* o teste chama `route` direto */
        },
        async send() {
          return true;
        },
      }) as never,
    allowlist: new Set(opts.allow),
    sink: { injectInstruction: vi.fn(), injectData: vi.fn() },
    redactor: { safeForLog: (t: string) => t },
    log: () => {},
    ...(opts.ack ? { ack: opts.ack } : {}),
  } as never);
  return { bridge, msgs };
}

function msgDe(over: Record<string, unknown> = {}) {
  return {
    content: 'ola',
    sender: '42',
    conversation: '42',
    provenance: { kind: 'author-direct' as const },
    messageId: 7,
    ...over,
  } as never;
}

describe('ACK do ingresso', () => {
  it('mensagem AUTORIZADA ⇒ 👀 na mensagem certa', () => {
    const ack = vi.fn();
    monta({ allow: ['42'], ack }).bridge.route(msgDe());
    expect(ack).toHaveBeenCalledWith(42, 7, '👀');
  });

  it('mensagem DESCARTADA ⇒ 🚫 — o caso que sumia calado', () => {
    const ack = vi.fn();
    // chat FORA da allowlist ⇒ a malha descarta
    monta({ allow: ['999'], ack }).bridge.route(msgDe());
    expect(ack).toHaveBeenCalledWith(42, 7, '🚫');
  });

  it('sem `messageId` NÃO reage (nem quebra) — conector que não fornece id', () => {
    const ack = vi.fn();
    monta({ allow: ['42'], ack }).bridge.route(msgDe({ messageId: undefined }));
    expect(ack).not.toHaveBeenCalled();
  });

  it('sem a porta `ack` o comportamento é o de hoje (zero regressão)', () => {
    expect(() => monta({ allow: ['42'] }).bridge.route(msgDe())).not.toThrow();
  });

  it('o alvo do ACK vem do INGRESSO, não de qualquer outro chat', () => {
    const ack = vi.fn();
    monta({ allow: ['555'], ack }).bridge.route(msgDe({ conversation: '555', sender: '555' }));
    expect(ack.mock.calls[0]?.[0], 'reage no chat que FALOU').toBe(555);
  });

  it('conversation não-numérica não vira NaN no alvo', () => {
    const ack = vi.fn();
    monta({ allow: ['abc'], ack }).bridge.route(msgDe({ conversation: 'abc', sender: 'abc' }));
    expect(ack, 'alvo inválido ⇒ melhor não reagir do que reagir errado').not.toHaveBeenCalled();
  });
});

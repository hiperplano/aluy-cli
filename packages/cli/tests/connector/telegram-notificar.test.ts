// `TelegramBridge.notificar` — o ENVIO DA SESSÃO (não do modelo) pelo canal.
//
// Existe para a PERGUNTA do agente quando o turno chegou pelo Telegram: a caixa abre no
// terminal, o dono está no celular, e sem este envio o loop fica parado esperando um
// teclado que ninguém vai tocar (dono, 02/09).
//
// É um caminho de EGRESSO novo, então precisa das mesmas travas do `telegram_send`: alvo
// TRAVADO (C3 — nunca um destino escolhido em outro lugar) e catraca ANTES do envio (C4).
// Sem estes testes, o conserto de UX teria aberto um furo no seam de segurança.

import { describe, expect, it } from 'vitest';
import { TelegramBridge } from '../../src/connector/telegram-bridge.js';
import {
  EgressRateLimiter,
  type Connector,
  type IncomingMessage,
  type OutgoingMessage,
} from '@hiperplano/aluy-cli-core';

function fakeConnector(msgs: IncomingMessage[], sends: OutgoingMessage[]): Connector {
  return {
    meta: { id: 'telegram', displayName: 'Telegram', authIsForgeable: false },
    async *incoming() {
      for (const m of msgs) yield m;
    },
    async send(reply: OutgoingMessage) {
      sends.push(reply);
    },
  };
}

function ownerMsg(text: string, chatId = 100): IncomingMessage {
  return {
    content: text,
    sender: String(chatId),
    conversation: String(chatId),
    provenance: { kind: 'author-direct' },
  };
}

const noopRedactor = { safeForLog: (s: string) => s };
const noopSink = { injectInstruction: () => undefined, injectData: () => undefined };

describe('notificar — o aviso da SESSÃO no canal', () => {
  it('envia ao alvo TRAVADO pelo ingresso (C3) — o destino não vem de fora', async () => {
    const sends: OutgoingMessage[] = [];
    const bridge = new TelegramBridge({
      connectorFactory: () => fakeConnector([ownerMsg('oi', 100)], sends),
      allowlist: new Set(['100']),
      sink: noopSink,
      redactor: noopRedactor,
    });
    await bridge.pump();
    expect(await bridge.notificar('❓ Qual banco?')).toBe(true);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.conversation).toBe('100');
    expect(sends[0]?.content).toBe('❓ Qual banco?');
  });

  it('SEM conversa travada não inventa destino — recusa e devolve `false`', async () => {
    const sends: OutgoingMessage[] = [];
    const bridge = new TelegramBridge({
      connectorFactory: () => fakeConnector([], sends),
      allowlist: new Set(['100']),
      sink: noopSink,
      redactor: noopRedactor,
    });
    expect(await bridge.notificar('❓ Qual banco?')).toBe(false);
    expect(sends).toHaveLength(0);
  });

  it('passa pela CATRACA do egresso (C4) — estouro NEGA, não enfileira', async () => {
    const sends: OutgoingMessage[] = [];
    const bridge = new TelegramBridge({
      connectorFactory: () => fakeConnector([ownerMsg('oi', 100)], sends),
      allowlist: new Set(['100']),
      sink: noopSink,
      redactor: noopRedactor,
      egressLimiter: new EgressRateLimiter(1, 60_000),
      now: () => 0,
    });
    await bridge.pump();
    expect(await bridge.notificar('primeira')).toBe(true);
    expect(await bridge.notificar('segunda')).toBe(false);
    expect(sends, 'a segunda NÃO pode ter saído').toHaveLength(1);
  });

  it('falha de envio devolve `false` e o texto do log passa pelo REDATOR (C1)', async () => {
    const vistos: string[] = [];
    const bridge = new TelegramBridge({
      connectorFactory: () => ({
        meta: { id: 'telegram', displayName: 'Telegram', authIsForgeable: false },
        async *incoming() {
          yield ownerMsg('oi', 100);
        },
        async send() {
          throw new Error('falhou em https://api.telegram.org/botSEGREDO/sendMessage');
        },
      }),
      allowlist: new Set(['100']),
      sink: noopSink,
      redactor: { safeForLog: (s: string) => s.replace('SEGREDO', '<token>') },
      log: (l) => vistos.push(l),
    });
    await bridge.pump();
    expect(await bridge.notificar('❓')).toBe(false);
    const log = vistos.join('\n');
    expect(log).toContain('<token>');
    expect(log, 'o token NUNCA pode aparecer no log').not.toContain('SEGREDO');
  });
});

// Conector Telegram (ADR-0134) — a impl concreta da porta `Connector` (ADR-0135 §1):
// junta o INGRESSO (long-poll → IncomingMessage) e o EGRESSO (send) por trás da porta
// portável. A malha consome ESTA porta (classifica o ingresso, trava o alvo do egresso,
// passa pela catraca). Aqui só a composição Telegram-específica sobre o `TelegramClient`.
//
// ⚠️ INERTE: ainda NÃO instanciado pelo boot. A ativação (`--telegram`) + o registro na
//    malha + a tool `telegram_send` gateada esperam a revisão `seguranca` (ADR-0134).

import {
  TELEGRAM_META,
  telegramUpdateToIncoming,
  type Connector,
  type ConnectorMeta,
  type IncomingMessage,
  type OutgoingMessage,
} from '@hiperplano/aluy-cli-core';
import { TelegramClient } from './telegram-client.js';

export interface TelegramConnectorOptions {
  /** Cancela o long-poll (encerra junto com a sessão). */
  readonly signal?: AbortSignal;
}

/** A porta `Connector` para o Telegram: `incoming()` (long-poll) + `send()` (sendMessage). */
export class TelegramConnector implements Connector {
  readonly meta: ConnectorMeta = TELEGRAM_META;

  constructor(
    private readonly client: TelegramClient,
    private readonly opts: TelegramConnectorOptions = {},
  ) {}

  /** INGRESSO — long-poll → `IncomingMessage` portável (a malha classifica/autoriza). */
  async *incoming(): AsyncIterable<IncomingMessage> {
    for await (const update of this.client.stream(this.opts.signal)) {
      yield telegramUpdateToIncoming(update);
    }
  }

  /**
   * EGRESSO — envia ao chat da conversa-alvo. O `OutgoingMessage.conversation` é o
   * `ConversationRef` (chat-id como string) que a MALHA travou no chat allowlistado da
   * conversa corrente — NUNCA um destino arbitrário do agente (TC-5, fecha exfiltração).
   */
  async send(reply: OutgoingMessage): Promise<void> {
    const chatId = Number(reply.conversation);
    if (!Number.isFinite(chatId)) return; // ref inválido ⇒ no-op (a malha não deveria gerar isto).
    await this.client.send(chatId, reply.content, this.opts.signal);
  }
}

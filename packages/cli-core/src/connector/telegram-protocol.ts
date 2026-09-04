// Conector Telegram (ADR-0154 §4) — PARSER do `getUpdates` (long-poll, NÃO webhook). PURO
// e FAIL-SAFE: traduz a resposta CRUA da Bot API → `TelegramUpdate[]` + o próximo offset.
// Qualquer campo ausente/inesperado ⇒ ignorado (nunca lança). O long-poll concreto (HTTP)
// vive no @hiperplano/aluy-cli; aqui só a tradução portável.
//
// v1: só `message` (texto). `edited_message`/`channel_post`/mídia ⇒ ignorados (cada um é
// vetor próprio — futuro). A detecção de FORWARD (mensagem inteira de terceiro = DADO) e de
// QUOTE (reply citando = dado embutido) é feita aqui e levada no `TelegramUpdate` p/ a malha.

import type { TelegramUpdate } from './telegram-ingress.js';

export interface ParsedUpdates {
  readonly updates: readonly TelegramUpdate[];
  /** Offset p/ o PRÓXIMO getUpdates (maior update_id + 1). Inalterado se nada chegou. */
  readonly nextOffset: number;
  /**
   * O que foi DESCARTADO e por quê. Vazio quando tudo passou.
   *
   * Sem isto o descarte é invisível: o `maxId` avança ANTES dos filtros, então o update
   * sai da fila do Telegram e some. Ver `DescarteDeUpdate`.
   */
  readonly descartados?: readonly DescarteDeUpdate[];
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/**
 * Traduz a resposta de `getUpdates` (`{ ok, result: [...] }`) p/ updates + próximo offset.
 * `currentOffset` é o offset que foi PEDIDO (p/ não regredir se a resposta vier vazia).
 */
/**
 * Por que um update cru foi DESCARTADO. Metadados apenas — nunca o texto do usuário.
 *
 * Existe porque o descarte aqui é TOTALMENTE mudo e, pior, o `maxId` avança ANTES dos
 * filtros: o update sai da fila do Telegram e some sem uma linha de log. Em 01/09 o dono
 * passou horas mandando mensagem enquanto a ponte polizava, a fila zerava e o roteamento
 * NUNCA era chamado — a mensagem morria exatamente aqui, no único trecho do caminho que
 * não tinha como falar (é código PURO do core, sem I/O). Devolver o motivo deixa o
 * chamador (que TEM log) contar o que aconteceu.
 */
export interface DescarteDeUpdate {
  readonly updateId: number | undefined;
  /** `sem-message` · `sem-chat` · `nao-privado` — a razão exata do `continue`. */
  readonly motivo: 'sem-message' | 'sem-chat' | 'nao-privado';
  /** `chat.type` como veio (só p/ o caso `nao-privado`). */
  readonly chatType?: string;
  /** `chat.id`, quando havia. Útil p/ casar com a allowlist do dono. */
  readonly chatId?: number;
}

export function parseGetUpdates(raw: unknown, currentOffset: number): ParsedUpdates {
  const root = obj(raw);
  if (!root || root.ok !== true || !Array.isArray(root.result)) {
    // SEM `descartados`: aqui a RESPOSTA inteira é inválida (não é `ok`, não é lista),
    // não há update individual descartado a explicar. O campo é opcional de propósito
    // — a forma deste retorno é comparada por igualdade num teste existente.
    return { updates: [], nextOffset: currentOffset };
  }
  const updates: TelegramUpdate[] = [];
  const descartados: DescarteDeUpdate[] = [];
  let maxId = currentOffset - 1;
  for (const item of root.result) {
    const u = obj(item);
    if (!u) continue;
    const updateId = num(u.update_id);
    if (updateId !== undefined && updateId > maxId) maxId = updateId;
    // v1: só `message` (ignora edited_message/channel_post/etc.).
    const m = obj(u.message);
    if (!m) {
      descartados.push({ updateId, motivo: 'sem-message' });
      continue;
    }
    const chat = obj(m.chat);
    const chatId = num(chat?.id);
    if (chatId === undefined) {
      // sem chat ⇒ não dá p/ allowlist nem responder.
      descartados.push({ updateId, motivo: 'sem-chat' });
      continue;
    }
    // R4 (gate seguranca) — v1 = DM 1:1: só chat PRIVADO. Grupo/canal ⇒ IGNORA (lá o chat-id
    // é coletivo e `chatId != fromId`, então autorizar por chat-id abriria instrução a
    // terceiros do grupo). Garante chatId == fromId. `type` ausente ⇒ trata como não-privado.
    if (chat?.type !== 'private') {
      descartados.push({
        updateId,
        motivo: 'nao-privado',
        chatId,
        ...(typeof chat?.type === 'string' ? { chatType: chat.type } : {}),
      });
      continue;
    }
    const from = obj(m.from);
    const fromId = num(from?.id) ?? chatId;
    const isBot = from?.is_bot === true; // R2/TC-6 — remetente-bot ⇒ a malha descarta.
    const text = typeof m.text === 'string' ? m.text : '';
    // FORWARD (msg inteira de terceiro): qualquer marcador de forward da Bot API.
    const forwarded =
      m.forward_origin !== undefined ||
      m.forward_from !== undefined ||
      m.forward_from_chat !== undefined ||
      m.forward_sender_name !== undefined ||
      m.forward_date !== undefined;
    // REPLY-COM-QUOTE (dono cita um trecho): `quote.text`.
    const quotedText = (() => {
      const q = obj(m.quote)?.text;
      return typeof q === 'string' && q.trim() !== '' ? q : undefined;
    })();
    const messageId = num(m.message_id);
    updates.push({
      chatId,
      fromId,
      text,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(forwarded ? { forwarded: true } : {}),
      ...(quotedText !== undefined ? { quotedText } : {}),
      ...(isBot ? { isBot: true } : {}),
    });
  }
  // O campo SÓ aparece quando há algo a relatar: sem isto, a forma do retorno mudaria
  // em todo caso normal, e um teste existente compara o objeto por igualdade.
  return {
    updates,
    nextOffset: maxId + 1,
    ...(descartados.length > 0 ? { descartados } : {}),
  };
}

// Conector Telegram (ADR-0134 §4) — PARSER do `getUpdates` (long-poll, NÃO webhook). PURO
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
export function parseGetUpdates(raw: unknown, currentOffset: number): ParsedUpdates {
  const root = obj(raw);
  if (!root || root.ok !== true || !Array.isArray(root.result)) {
    return { updates: [], nextOffset: currentOffset };
  }
  const updates: TelegramUpdate[] = [];
  let maxId = currentOffset - 1;
  for (const item of root.result) {
    const u = obj(item);
    if (!u) continue;
    const updateId = num(u.update_id);
    if (updateId !== undefined && updateId > maxId) maxId = updateId;
    // v1: só `message` (ignora edited_message/channel_post/etc.).
    const m = obj(u.message);
    if (!m) continue;
    const chatId = num(obj(m.chat)?.id);
    if (chatId === undefined) continue; // sem chat ⇒ não dá p/ allowlist nem responder.
    const fromId = num(obj(m.from)?.id) ?? chatId;
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
    updates.push({
      chatId,
      fromId,
      text,
      ...(forwarded ? { forwarded: true } : {}),
      ...(quotedText !== undefined ? { quotedText } : {}),
    });
  }
  return { updates, nextOffset: maxId + 1 };
}

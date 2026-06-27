// Conector Telegram (ADR-0134) — ADAPTADOR de ingresso: mapeia um update do Telegram p/
// a `IncomingMessage` portável e DELEGA a classificação à MALHA genérica (mesh.ts). A
// lógica de segurança (allowlist, dono=instrução, forward=dado, default fechado) vive
// UMA vez na malha (ADR-0135: "herdada, não reimplementada"). Aqui mora só o ESPECÍFICO
// do Telegram: o formato do chat-id/from-id e a leitura do forward/quote.
//
// PURO (sem rede/I/O): recebe um update já parseado + a allowlist e devolve a decisão. O
// long-poll, o keychain e o egresso vivem no @hiperplano/aluy-cli.
//
// ⚠️ INERTE: ainda NÃO ligado a `--telegram`/boot — espera o resto da bridge + a revisão
//    de segurança que o ADR-0134 exige.

import { classifyConnectorIngress, type ConnectorIngress } from './mesh.js';
import type { IncomingMessage, Provenance, ConnectorMeta, ConversationRef } from './types.js';

/** Metadados do conector Telegram. `authIsForgeable:false` — o from-id é assinado pelo servidor. */
export const TELEGRAM_META: ConnectorMeta = {
  id: 'telegram',
  displayName: 'Telegram',
  authIsForgeable: false,
};

/** Um update do Telegram já reduzido ao que importa p/ a decisão de ingresso. */
export interface TelegramUpdate {
  /** `chat.id` — o chat de onde veio (em DM 1:1, == fromId). É a chave da allowlist. */
  readonly chatId: number;
  /** `from.id` — quem enviou. */
  readonly fromId: number;
  /** O texto da mensagem. */
  readonly text: string;
  /**
   * A mensagem INTEIRA é um FORWARD de terceiro (`forward_origin`/`forward_from`): o
   * `text` não foi escrito pelo dono ⇒ a mensagem toda é DADO (`third-party-relayed`).
   */
  readonly forwarded?: boolean;
  /**
   * O dono ESCREVEU `text` e CITOU (reply-with-quote) este trecho de terceiro: o comando
   * do dono é instrução; só o `quotedText` é DADO embutido. (Distinto de `forwarded`.)
   */
  readonly quotedText?: string;
  /** `from.is_bot` — remetente é bot ⇒ a malha DESCARTA (anti-loop TC-6, R2). */
  readonly isBot?: boolean;
}

/** A decisão (alias da decisão da malha — instrução × dado × descarte). */
export type IngressDecision = ConnectorIngress;

/**
 * Mapeia um `TelegramUpdate` p/ a `IncomingMessage` portável (proveniência inclusa). PURO.
 * SINGLE-SOURCE da tradução: usado pelo `classifyTelegramIngress` E pela impl `Connector`
 * (incoming()), p/ não divergirem.
 *
 * FORWARD (msg inteira de terceiro) ⇒ `third-party-relayed` (a malha trata como DADO).
 * REPLY-COM-QUOTE (dono escreve + cita) ⇒ `author-direct` + o quote vira DADO embutido.
 */
export function telegramUpdateToIncoming(update: TelegramUpdate): IncomingMessage {
  let provenance: Provenance;
  if (update.forwarded === true) {
    provenance = { kind: 'third-party-relayed' };
  } else {
    const embedded = (update.quotedText ?? '').trim();
    provenance = embedded
      ? { kind: 'author-direct', embeddedThirdParty: embedded }
      : { kind: 'author-direct' };
  }
  return {
    content: update.text,
    sender: String(update.fromId),
    conversation: String(update.chatId),
    provenance,
    ...(update.isBot === true ? { senderIsBot: true } : {}),
  };
}

/** O `ConversationRef` (opaco) de um chat-id do Telegram. Inverso do `Number(ref)` no send. */
export function telegramConversationRef(chatId: number): ConversationRef {
  return String(chatId);
}

/**
 * Classifica um update do Telegram contra a allowlist do dono (ADR-0134 §1/§2 via malha
 * ADR-0135). PURO. Default FECHADO. Mapeia o update p/ `IncomingMessage` e delega.
 */
export function classifyTelegramIngress(
  update: TelegramUpdate,
  allowlist: ReadonlySet<number>,
): ConnectorIngress {
  // A allowlist do Telegram é por chat-id (numérica); a malha trabalha com ids opacos (string).
  const allow = new Set<string>(Array.from(allowlist, (n) => String(n)));
  return classifyConnectorIngress(telegramUpdateToIncoming(update), allow, TELEGRAM_META);
}

/** Allowlist a partir de uma lista de chat-ids (DADO de config; ignora inválidos). */
export function parseAllowlist(ids: readonly unknown[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const id of ids) {
    if (typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id)) out.add(id);
  }
  return out;
}

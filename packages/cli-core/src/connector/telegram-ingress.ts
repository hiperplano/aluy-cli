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
import type { IncomingMessage, Provenance, ConnectorMeta } from './types.js';

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
  /** O texto da mensagem (o que o dono digitou). */
  readonly text: string;
  /** Presença = a mensagem CONTÉM conteúdo encaminhado de terceiro (forward). */
  readonly forwarded?: boolean;
  /** Texto citado/encaminhado de terceiro (tratado como DADO, não instrução). */
  readonly quotedText?: string;
}

/** A decisão (alias da decisão da malha — instrução × dado × descarte). */
export type IngressDecision = ConnectorIngress;

/**
 * Classifica um update do Telegram contra a allowlist do dono (ADR-0134 §1/§2 via malha
 * ADR-0135). PURO. Default FECHADO. Mapeia o update p/ `IncomingMessage` e delega.
 */
export function classifyTelegramIngress(
  update: TelegramUpdate,
  allowlist: ReadonlySet<number>,
): ConnectorIngress {
  const embedded = update.forwarded === true ? (update.quotedText ?? '').trim() : '';
  const provenance: Provenance = embedded
    ? { kind: 'author-direct', embeddedThirdParty: embedded }
    : { kind: 'author-direct' };
  const msg: IncomingMessage = {
    content: update.text,
    sender: String(update.fromId),
    conversation: String(update.chatId),
    provenance,
  };
  // A allowlist do Telegram é por chat-id (numérica); a malha trabalha com ids opacos (string).
  const allow = new Set<string>(Array.from(allowlist, (n) => String(n)));
  return classifyConnectorIngress(msg, allow, TELEGRAM_META);
}

/** Allowlist a partir de uma lista de chat-ids (DADO de config; ignora inválidos). */
export function parseAllowlist(ids: readonly unknown[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const id of ids) {
    if (typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id)) out.add(id);
  }
  return out;
}

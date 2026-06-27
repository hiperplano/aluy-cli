// Conector Telegram (ADR-0134, sob o padrão de conectores ADR-0135) — FILTRO DE
// INGRESSO. É o CORAÇÃO de segurança da bridge: decide se uma mensagem que CHEGA do
// Telegram vira INSTRUÇÃO do dono, DADO (forward de terceiro), ou é DESCARTADA antes
// de tocar o modelo. PURO (sem rede/I/O): recebe um update já parseado + a allowlist e
// devolve a decisão. O long-poll, o keychain e o egress vivem no @hiperplano/aluy-cli.
//
// Invariantes (ADR-0134 §1/§2 — gate FORTE do `seguranca`, ainda PENDENTE de revisão):
//   • allowlist VAZIA  ⇒ descarta tudo (default FECHADO — nada entra sem autorização).
//   • chat-id FORA da allowlist ⇒ DESCARTA antes do modelo (nem instrução, nem dado).
//   • chat-id NA allowlist ⇒ é o DONO autenticado (o Telegram entrega o from/chat-id
//     real, não-forjável sem o token) ⇒ a mensagem é INSTRUÇÃO confiável (igual ao CLI).
//   • conteúdo ENCAMINHADO/CITADO de terceiro DENTRO da msg do dono ⇒ DADO não-confiável
//     (não foi o dono que escreveu) — sub-envelopado, separado do comando do dono.
//
// ⚠️ Código INERTE: ainda NÃO está ligado a `--telegram` nem ao boot. Só a lógica pura,
//    testável, é introduzida aqui. A ativação espera o resto da bridge + a revisão de
//    segurança que o ADR-0134 exige.

/** Um update do Telegram já reduzido ao que importa p/ a decisão de ingresso. */
export interface TelegramUpdate {
  /** `chat.id` — o chat de onde veio (em DM 1:1, == fromId). */
  readonly chatId: number;
  /** `from.id` — quem enviou. */
  readonly fromId: number;
  /** O texto da mensagem (já o que o dono digitou). */
  readonly text: string;
  /** Presença = a mensagem CONTÉM conteúdo encaminhado de terceiro (forward). */
  readonly forwarded?: boolean;
  /** Texto citado/encaminhado de terceiro (tratado como DADO, não instrução). */
  readonly quotedText?: string;
}

/** A decisão do filtro de ingresso. */
export type IngressDecision =
  | {
      readonly kind: 'instruction';
      /** O comando DIRETO do dono — entra como instrução confiável. */
      readonly text: string;
      /** Conteúdo de terceiro (forward/quote) — DADO não-confiável, sub-envelopado. */
      readonly forwardedData?: string;
    }
  | {
      readonly kind: 'discard';
      /** Por que foi descartado (só p/ log local; nunca toca o modelo). */
      readonly reason: string;
    };

/**
 * Classifica um update do Telegram contra a allowlist do dono (ADR-0134 §1/§2).
 * PURO, sem efeito. Default FECHADO: allowlist vazia ⇒ tudo descartado.
 */
export function classifyTelegramIngress(
  update: TelegramUpdate,
  allowlist: ReadonlySet<number>,
): IngressDecision {
  // Default fechado: sem ninguém autorizado, NADA entra (nem vira dado).
  if (allowlist.size === 0) {
    return { kind: 'discard', reason: 'allowlist vazia (default fechado)' };
  }
  // Autorização por chat-id: o de fora é DESCARTADO antes de tocar o contexto.
  if (!allowlist.has(update.chatId)) {
    return { kind: 'discard', reason: `chat-id ${update.chatId} não-allowlistado` };
  }
  // Texto vazio (sticker/foto/etc. sem legenda) ⇒ nada a injetar.
  const text = update.text.trim();
  if (text === '') {
    return { kind: 'discard', reason: 'mensagem sem texto' };
  }
  // Dono autenticado ⇒ INSTRUÇÃO. Forward/quote de terceiro ⇒ DADO sub-envelopado.
  const forwardedData =
    update.forwarded === true ? (update.quotedText ?? '').trim() || undefined : undefined;
  return forwardedData !== undefined
    ? { kind: 'instruction', text, forwardedData }
    : { kind: 'instruction', text };
}

/** Allowlist a partir de uma lista de chat-ids (DADO de config; ignora inválidos). */
export function parseAllowlist(ids: readonly unknown[]): ReadonlySet<number> {
  const out = new Set<number>();
  for (const id of ids) {
    if (typeof id === 'number' && Number.isFinite(id) && Number.isInteger(id)) out.add(id);
  }
  return out;
}

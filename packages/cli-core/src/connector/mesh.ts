// Malha de conectores (ADR-0135 §2) — a FRONTEIRA DE CONFIANÇA genérica, herdada por TODO
// conector (TC-1/TC-2). É o SINGLE-SOURCE da decisão instrução×dado×descarte: o conector
// só descreve proveniência/identidade; AQUI se decide. PURO (sem I/O).
//
// Invariantes (gate FORTE do `seguranca`, ainda PENDENTE de revisão):
//   • TC-2 allowlist VAZIA ⇒ descarta tudo (default FECHADO).
//   • TC-2 sender/conversa FORA da allowlist ⇒ DESCARTA antes do modelo (nem dado).
//   • TC-1 `authIsForgeable` ⇒ TODO o ingresso vira DADO (degradação segura), nunca instrução.
//   • TC-1 proveniência `third-party-relayed` ⇒ DADO (a msg inteira é repasse de terceiro).
//   • TC-1 dono allowlistado + `author-direct` ⇒ INSTRUÇÃO confiável (igual ao CLI);
//     trecho de terceiro embutido (`embeddedThirdParty`) ⇒ DADO sub-envelopado.

import type { IncomingMessage, ConversationRef, ConnectorMeta } from './types.js';

/** A decisão da malha sobre uma mensagem que chegou. */
export type ConnectorIngress =
  | {
      /** Comando direto do dono autenticado — entra no canal de entrada do usuário. */
      readonly kind: 'instruction';
      readonly text: string;
      /** Trecho de terceiro embutido (forward/quote) — DADO não-confiável, separado. */
      readonly forwardedData?: string;
    }
  | {
      /** Conteúdo NÃO-confiável (auth forjável OU repasse de terceiro) — envelopado como dado. */
      readonly kind: 'data';
      readonly text: string;
    }
  | {
      /** Filtrado antes de tocar o modelo (só log local; não conta budget). */
      readonly kind: 'discard';
      readonly reason: string;
    };

/**
 * Classifica uma `IncomingMessage` contra a allowlist do dono + a proveniência + a
 * forjabilidade do transporte (ADR-0135 §2, TC-1/TC-2). PURO. Default FECHADO.
 *
 * A allowlist é "por id-do-canal": casa pelo `conversation` (em DM 1:1 == sender). Ids
 * opacos (string) — o conector define o formato (chat-id, user-id, e-mail…).
 */
export function classifyConnectorIngress(
  msg: IncomingMessage,
  allowlist: ReadonlySet<ConversationRef>,
  meta: ConnectorMeta,
): ConnectorIngress {
  // TC-2 — default fechado: sem ninguém autorizado, NADA entra.
  if (allowlist.size === 0) {
    return { kind: 'discard', reason: 'allowlist vazia (default fechado)' };
  }
  // TC-2 — autorização por id-do-canal (conversa); fora ⇒ DESCARTA antes do modelo.
  if (!allowlist.has(msg.conversation)) {
    return { kind: 'discard', reason: `canal ${msg.conversation} não-allowlistado` };
  }
  const text = msg.content.trim();
  if (text === '') {
    return { kind: 'discard', reason: 'mensagem sem conteúdo' };
  }
  // TC-1 — transporte forjável ⇒ degradação segura: tudo vira DADO, nunca instrução.
  if (meta.authIsForgeable) {
    return { kind: 'data', text };
  }
  // TC-1 — repasse de terceiro (msg inteira) ⇒ DADO.
  if (msg.provenance.kind === 'third-party-relayed') {
    return { kind: 'data', text };
  }
  // TC-1 — dono autenticado + autor-direto ⇒ INSTRUÇÃO; embutido de terceiro ⇒ DADO.
  const embedded = msg.provenance.embeddedThirdParty?.trim();
  return embedded
    ? { kind: 'instruction', text, forwardedData: embedded }
    : { kind: 'instruction', text };
}

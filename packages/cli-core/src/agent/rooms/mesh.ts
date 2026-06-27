// EST-0999 · ADR-0078 — SALAS MULTI-AGENTE, FASE 2: WRITE / MESH.
//
// A Fase 1 (read-only) deixa o agente LER o feed (sempre envelopado como DADO). A
// Fase 2 deixa um agente ESCREVER na sala — o canal por onde um agente "fala" com
// outro (mesh). É a superfície de MAIOR risco (propagação de injeção), então é
// gateada por TRÊS travas, todas provadas no teste:
//
//   1. INVARIANTE #1 PRESERVADO (laundering multi-ator): o que um agente ESCREVE
//      entra no leitor como DADO, NUNCA instrução. Garantido POR CONSTRUÇÃO — o
//      `readRoom` (Fase 1) envelopa TODA mensagem com `envelopeAsData`, sem olhar
//      QUEM escreveu. Logo a escrita-por-agente não abre buraco no envelope.
//      (O efeito derivado de uma mensagem lida ainda passa pela catraca `decide()`
//       do RECEPTOR — confused-deputy fechado: ler/escrever NÃO transfere grant.)
//   2. AUTHZ de escritor (AC-SEC): só IDs em `policy.writers` escrevem. Leitor ⊊
//      escritor (ler não dá direito de escrever).
//   3. ANTI-LOOP (AC-SEC-7): uma cadeia de respostas (`in_reply_to`) não pode passar
//      de `policy.maxHops` — corta o mesh-storm A→B→A→… por construção.
//
// PORTÁVEL (ADR-0053 §8): puro, sem Ink/IO de terminal.

import type { AgentMessage } from './message.js';
import { type Room, isExpired, appendBounded } from './room.js';

/** Política de escrita/mesh de uma sala (Fase 2). DADO, não código. */
export interface MeshPolicy {
  /** IDs de agente AUTORIZADOS a escrever. Leitor ⊊ escritor (ler não escreve). */
  readonly writers: readonly string[];
  /** Teto de saltos da cadeia `in_reply_to` (anti-loop A→B→A). */
  readonly maxHops: number;
}

/** Resultado de uma tentativa de escrita-por-agente. */
export type PostResult =
  | { readonly ok: true; readonly room: Room }
  | {
      readonly ok: false;
      readonly reason: 'revoked' | 'expired' | 'unauthorized' | 'hop-limit';
    };

/**
 * Profundidade da cadeia `in_reply_to` de uma mensagem (0 = raiz, sem pai). Percorre
 * pais até a raiz OU até um teto duro (anti-ciclo no próprio cômputo — uma cadeia
 * adulterada com ciclo não pendura). NÃO confia no payload pra terminar.
 */
function hopDepth(messages: readonly AgentMessage[], inReplyTo: string | undefined): number {
  if (inReplyTo === undefined) return 0;
  const byId = new Map(messages.map((m) => [m.msg_id, m]));
  let depth = 0;
  let cursor: string | undefined = inReplyTo;
  const seen = new Set<string>();
  // Teto de iteração = nº de mensagens (uma cadeia honesta não excede isso); um
  // ciclo (id já visto) também para. Defesa-em-profundidade contra feed adulterado.
  while (cursor !== undefined && depth <= messages.length && !seen.has(cursor)) {
    seen.add(cursor);
    const parent = byId.get(cursor);
    if (parent === undefined) break; // pai inexistente: trata como raiz da cadeia conhecida
    depth += 1;
    cursor = parent.in_reply_to;
  }
  return depth;
}

/**
 * F139 — Profundidade da MENSAGEM NOVA que responde a `inReplyTo`. Prefere o `hop`
 * CARIMBADO do pai IMEDIATO (`pai.hop + 1`): O(1) e ROBUSTO à eviction dos ANCESTRAIS
 * do pai (cada msg lembra a própria profundidade; o pai imediato é recente ⇒ está na
 * janela bounded). Sem isso, o `hopDepth` (walk) SUBCONTA quando a raiz da cadeia sai
 * da janela (`MAX_ROOM_MESSAGES`) ⇒ o anti-loop era derrotável numa sala movimentada.
 * FALLBACK p/ o walk quando o pai não está na janela OU é LEGADO (sem `hop` carimbado —
 * feeds persistidos antes deste fix): mesma semântica de antes, sem regressão.
 */
function newMessageHop(messages: readonly AgentMessage[], inReplyTo: string | undefined): number {
  if (inReplyTo === undefined) return 0;
  const parent = messages.find((m) => m.msg_id === inReplyTo);
  if (parent !== undefined && parent.hop !== undefined) {
    return parent.hop + 1; // carimbado: robusto à eviction de ancestrais.
  }
  return hopDepth(messages, inReplyTo); // legado / pai fora da janela: walk (best-effort).
}

/**
 * Um agente ESCREVE uma mensagem na sala (Fase 2). Valida, na ordem:
 *   revogada → expirada → escritor autorizado → dentro do teto de saltos.
 * Qualquer falha NÃO muta a sala (imutável). Sucesso → nova sala com a msg ao fim.
 *
 * ⚠️ A mensagem escrita será lida via `readRoom`, ou seja, ENVELOPADA como DADO. Um
 * agente NUNCA injeta instrução pela sala — só deposita dado a ser PONDERADO.
 */
export function postMessage(
  room: Room,
  policy: MeshPolicy,
  writerId: string,
  msg: AgentMessage,
  now?: number,
): PostResult {
  if (room.revoked) return { ok: false, reason: 'revoked' };
  if (isExpired(room, now)) return { ok: false, reason: 'expired' };
  if (!policy.writers.includes(writerId)) return { ok: false, reason: 'unauthorized' };

  // F139 — profundidade da MENSAGEM NOVA via `hop` CARIMBADO do pai imediato (O(1),
  // robusto à eviction de ancestrais; fallback walk p/ legado). Raiz (sem `in_reply_to`)
  // = 0. Carimbada na fronteira abaixo (NÃO confia em `hop` que o caller pôs — como `from`).
  const hops = newMessageHop(room.messages, msg.in_reply_to);
  if (hops > policy.maxHops) return { ok: false, reason: 'hop-limit' };

  // BINDING DE ORIGEM (AC-SEC / CLI-SEC-9): a fronteira de authz CARIMBA o `from` com o
  // `writerId` AUTORIZADO — NÃO confia no `from` que o caller pôs no `msg`. Sem isto,
  // um escritor autorizado poderia depositar uma mensagem com `from` FORJADO (origem de
  // OUTRO agente), e o `envelopeAsData` a exibiria com esse `origem=` falso (impersonation
  // de proveniência no feed). A identidade autorizada É a origem — fonte única de verdade.
  // F139 — idem p/ `hop`: a fronteira CARIMBA a profundidade computada (não a do caller).
  const bound: AgentMessage = { ...msg, from: writerId, hop: hops };

  // EST-1120 — atribui seq monotônico (nextSeq) e incrementa.
  const seq = room.nextSeq;

  // EST-1011 (HUNT-RESOURCE) — append BOUNDED: o feed da sala não cresce sem teto numa
  // sessão multi-agente longa (a EXIBIÇÃO já era capada; a ARMAZENAGEM não era). Mantém
  // a cauda recente (MAX_ROOM_MESSAGES) — o threading `in_reply_to` opera na janela viva.
  return {
    ok: true,
    room: {
      ...room,
      nextSeq: seq + 1,
      messages: appendBounded(room.messages, { ...bound, seq }),
    },
  };
}

/** Exposto p/ teste do anti-loop (profundidade de cadeia). */
export const __hopDepthForTest = hopDepth;

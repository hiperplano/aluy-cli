// EST-0999 · ADR-0078 — SALAS MULTI-AGENTE: INVARIANTE #1.
//
// Mensagem entre agentes = DADO, nunca instrução.
// O envelope `<<<DADO_NAO_CONFIAVEL origem=...>>>` garante que o agente B
// *pondera* o conteúdo, nunca o obedece como comando/system.
//
// PORTÁVEL (ADR-0053 §8): nada de Ink/IO de terminal.

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

/** Categorias semânticas da mensagem entre agentes. */
export type AgentMessageKind = 'ask' | 'inform' | 'result' | 'ack';

/**
 * Mensagem bruta trocada entre dois agentes numa sala.
 *
 * - `msg_id`: identificador único da mensagem (UUID ou similar).
 * - `from`: agente remetente (rótulo de origem, CLI-SEC-9).
 * - `to`: agente destinatário.
 * - `kind`: semântica pretendida (ask=pergunta, inform=dado, result=resposta,
 *   ack=confirmação de recebimento).
 * - `in_reply_to`: opcional — `msg_id` da mensagem original (reply-threading).
 * - `body`: conteúdo textual da mensagem.
 * - `ts`: timestamp (ms desde epoch, ex.: `Date.now()`).
 */
export type AgentMessage = {
  msg_id: string;
  /** EST-1120 — seq monotônico por sala (1-based), atribuído no append. */
  seq: number;
  from: string;
  to: string;
  kind: AgentMessageKind;
  in_reply_to?: string;
  body: string;
  ts: number;
  /**
   * F139 — PROFUNDIDADE da cadeia `in_reply_to` CARIMBADA pela fronteira de authz
   * (`postMessage`) no momento do post: `hop = hop(pai imediato) + 1`, raiz = 0. Por
   * que carimbar em vez de RE-ANDAR a cadeia a cada checagem: o feed é BOUNDED
   * (`MAX_ROOM_MESSAGES`) — ancestrais antigos são evictados, e um walk pára em "pai
   * inexistente" e SUBCONTA ⇒ o anti-loop (maxHops) era DERROTÁVEL numa sala movimentada
   * (cadeia ilimitada após a raiz sair da janela). Lendo o `hop` do pai IMEDIATO (que é
   * recente ⇒ está na janela), a profundidade sobrevive à eviction dos ancestrais e é
   * O(1). Carimbado pela fronteira (NÃO confia no valor que o caller pôs — como o `from`).
   * Opcional p/ compat com feeds legados (mensagens sem `hop` caem no walk de fallback).
   */
  hop?: number;
};

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/**
 * Envelopa o `body` da mensagem como **DADO NÃO-CONFIÁVEL**, rotulando a
 * origem (campo `from`) no marcador de abertura.
 *
 * O resultado usa os marcadores canónicos `<<<DADO_NAO_CONFIAVEL` e
 * `<<<FIM_DADO>>>` (CLI-SEC-4). Quando o agente destinatário recebe este
 * texto, ele entra como *dado a ponderar*, nunca como instrução/system.
 *
 * Exemplo de saída:
 * ```
 * <<<DADO_NAO_CONFIAVEL origem=agente-alpha>>>
 *   Conteúdo perigoso aqui, mas envelopado.
 * <<<FIM_DADO>>>
 * ```
 *
 * DEFESA DE BORDA (CLI-SEC-4, envelope-breakout): o `body` é DADO de outro agente
 * e pode CONTER os próprios marcadores do envelope numa tentativa de FECHAR a cerca
 * cedo e injetar instrução "fora" dela. Por isso TODA ocorrência dos marcadores de
 * fechamento (o `<<<FIM_DADO>>>` desta camada E o `DADO_NAO_CONFIAVEL>>>` canónico
 * da camada externa do loop) é NEUTRALIZADA no corpo antes de envelopar. Espelha o
 * `wrapUntrusted` de `context.ts` — uma injeção não consegue romper a cerca.
 */
const CLOSE_MARKER = '<<<FIM_DADO>>>';
const OUTER_CLOSE_MARKER = 'DADO_NAO_CONFIAVEL>>>';

/** Neutraliza os marcadores de FECHO (desta camada E da externa) num texto. PURO. */
function neutralizeCloseMarkers(s: string): string {
  return s
    .split(CLOSE_MARKER)
    .join('<<<FIM_DADO_neutralizado>>>')
    .split(OUTER_CLOSE_MARKER)
    .join('DADO_NAO_CONFIAVEL_neutralizado>>>');
}

export function envelopeAsData(msg: AgentMessage): string {
  const sanitized = neutralizeCloseMarkers(msg.body);
  // DEFESA-EM-PROFUNDIDADE no `from`: o rótulo de origem entra na LINHA DE ABERTURA.
  // Um `from` com `\n` ou um marcador de fecho (`<<<FIM_DADO>>>`) FECHARIA a cerca
  // cedo e injetaria instrução FORA dela — o mesmo breakout que o `body` já defende.
  // Hoje o `writerId` é allowlistado (mesh.ts), MAS a fronteira de segurança NÃO deve
  // depender disso p/ a marca-safety: neutralizamos os marcadores E colapsamos quebras
  // de linha (a origem é um rótulo single-line por contrato).
  const safeFrom = neutralizeCloseMarkers(msg.from)
    .replace(/[\r\n]+/g, ' ')
    .trim();
  const lines = sanitized.split('\n');
  const indented = lines.map((l) => (l.trim() === '' ? '' : `  ${l}`)).join('\n');
  return [`<<<DADO_NAO_CONFIAVEL origem=${safeFrom}>>>`, indented, '<<<FIM_DADO>>>'].join('\n');
}

// ---------------------------------------------------------------------------
// Guarda
// ---------------------------------------------------------------------------

/**
 * Retorna `true` se o texto está devidamente envelopado como DADO NÃO-CONFIÁVEL
 * (começa com `<<<DADO_NAO_CONFIAVEL`).
 *
 * Use como guarda de sanidade — nunca eleve ao prompt algo que passe por esta
 * verificação sem envelopamento.
 */
export function isInstructionFree(enveloped: string): boolean {
  return enveloped.startsWith('<<<DADO_NAO_CONFIAVEL');
}

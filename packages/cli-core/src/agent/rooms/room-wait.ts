// EST-ROOMS-WAIT · ADR-0081 — ESPERA produtor-consumidor no `room_read`.
//
// MOTIVAÇÃO (dogfood REAL): 3 sub-agentes numa sala — 2 PRODUTORES postam, 1
// COORDENADOR lê e resume. O coordenador LEU ANTES dos produtores postarem
// (corrida produtor-consumidor): `room_read` é um SNAPSHOT do agora, então o
// coordenador viu uma sala vazia e "resumiu o nada". A forma canônica é em 2
// FASES (produtores terminam → consumidor lê); quando o leitor PRECISA correr em
// paralelo, `room_read` ganha um modo de ESPERA por writers nomeados.
//
// ESTE MÓDULO é a LÓGICA PURA da espera (testável SEM timers reais): quem já
// postou, quando parar, e a NOTA de degradação honesta quando a espera expira. Os
// timers/await ficam no fininho do tool (`room-tools.ts`) — aqui não há relógio.
//
// SEGURANÇA (gate AG-0008): read-only (não cria caminho de escrita). O ANTI-DoS é
// DURO: `clampWaitTimeout` aplica um TETO de produto (`MAX_ROOM_WAIT_MS`) — pedir
// mais é CLAMPADO, ausente vira um default sensato. NUNCA espera infinita. O
// envelope DADO permanece no `room-tools.ts` (este módulo não envelopa nada — só
// inspeciona `from` para decidir). FAIL-MODE LOUD: `buildWaitNote` produz um aviso
// EXPLÍCITO dos writers que NÃO postaram — proibido devolver vazio-silencioso que
// pareça "nada novo".
//
// PORTÁVEL (ADR-0053 §8): nada de Ink/IO de terminal; nada de Date.now.

import type { AgentMessage } from './message.js';

// ---------------------------------------------------------------------------
// Anti-DoS (teto DURO) — ADR-0081 §9, classe EST-1011 ("espera sem teto")
// ---------------------------------------------------------------------------

/**
 * TETO DURO da espera de `room_read` (ms). Pedir `timeout_ms` acima disto é
 * CLAMPADO para cá — um agente comprometido (ou um loop) NUNCA prende o leitor
 * por mais que isto. 60s é generoso para um produtor terminar uma subtarefa e
 * curto o bastante para não travar a sessão.
 */
export const MAX_ROOM_WAIT_MS = 60_000;

/**
 * Espera DEFAULT quando `timeout_ms` é ausente/inválido. Sensato para o padrão
 * agregador (produtor curto) sem prender demais.
 */
export const DEFAULT_ROOM_WAIT_MS = 15_000;

/**
 * Intervalo de POLLING do store em-memória (ms). O tool relê a sala a cada tick
 * até a condição ser satisfeita OU o teto estourar. Pequeno o bastante para
 * reagir rápido a um post, grande o bastante para não girar a CPU.
 */
export const ROOM_WAIT_POLL_MS = 150;

/**
 * Normaliza o `timeout_ms` pedido para a janela PERMITIDA `(0, MAX_ROOM_WAIT_MS]`:
 *  - ausente / não-finito / ≤ 0 ⇒ `DEFAULT_ROOM_WAIT_MS` (não interpreta "0" como
 *    "espera infinita" — anti-DoS DURO);
 *  - acima do teto ⇒ CLAMPADO em `MAX_ROOM_WAIT_MS`;
 *  - caso contrário ⇒ o próprio valor (arredondado p/ inteiro de ms).
 *
 * PURO. É a ÚNICA porta de entrada do timeout — o tool nunca usa o valor cru.
 */
export function clampWaitTimeout(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_ROOM_WAIT_MS;
  }
  return Math.min(Math.round(requested), MAX_ROOM_WAIT_MS);
}

// ---------------------------------------------------------------------------
// Decisão da espera (quem postou / quando parar) — PURO
// ---------------------------------------------------------------------------

/**
 * Resultado da AVALIAÇÃO de uma rodada de espera contra um snapshot do feed.
 *  - `satisfied`: `true` quando TODOS os `waitFor` têm ≥1 mensagem na sala.
 *  - `missing`: os labels de `waitFor` que AINDA não postaram (vazio ⇔ satisfied).
 *
 * Note: `satisfied === (missing.length === 0)` — por construção.
 */
export interface WaitEvaluation {
  readonly satisfied: boolean;
  readonly missing: readonly string[];
}

/** Normaliza/dedup a lista de writers pedida (trim, descarta vazios, ordem preservada). */
export function normalizeWaitFor(waitFor: readonly string[] | undefined): string[] {
  if (waitFor === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of waitFor) {
    const label = String(raw ?? '').trim();
    if (label === '' || seen.has(label)) continue;
    seen.add(label);
    out.push(label);
  }
  return out;
}

/**
 * Avalia o feed contra os writers esperados. Um writer "já postou" quando há ≥1
 * mensagem cujo `from` é EXATAMENTE o label (match exato — o `from` é o rótulo de
 * origem da mesh, CLI-SEC-9; não fazemos casefold/substring para não confundir
 * `bob` com `bob2`). PURO: só lê o snapshot, não muta nada, sem relógio.
 *
 * Critério "≥1 msg daquele writer na sala" (não "desde o instante da chamada"):
 * no padrão agregador o que importa é que o produtor TENHA contribuído — uma
 * mensagem pré-existente daquele writer JÁ satisfaz o consumidor (não há razão
 * para esperar uma SEGUNDA). Isto também é robusto à perda da cabeça do feed pelo
 * cap de armazenamento (MAX_ROOM_MESSAGES): se a contribuição saiu da janela, a
 * espera não pendura à toa — degrada para a nota loud no teto.
 */
export function evaluateWait(
  messages: readonly AgentMessage[],
  waitFor: readonly string[],
): WaitEvaluation {
  if (waitFor.length === 0) {
    return { satisfied: true, missing: [] };
  }
  const posted = new Set<string>();
  for (const m of messages) {
    posted.add(m.from);
  }
  const missing = waitFor.filter((w) => !posted.has(w));
  return { satisfied: missing.length === 0, missing };
}

// ---------------------------------------------------------------------------
// FAIL-MODE LOUD — degradação honesta (ADR-0081; classe EST-1016 "parcial≠completo")
// ---------------------------------------------------------------------------

/**
 * Constrói a NOTA de espera EXPIRADA — o aviso LOUD que vai à observação quando o
 * teto estoura com writers faltando. O leitor SABE que o resultado é INCOMPLETO:
 * jamais devolvemos vazio/parcial silencioso que pareça "nada novo".
 *
 * @param missing  Os writers que NÃO postaram até o teto (não-vazio aqui).
 * @returns Linha de aviso pronta para prefixar a observação.
 */
export function buildWaitTimeoutNote(missing: readonly string[]): string {
  // Defensivo: chamadores só invocam com missing não-vazio, mas não mentimos se
  // alguém passar vazio (sem aviso falso de incompletude).
  if (missing.length === 0) return '';
  return `⚠ espera expirou — writers que NÃO postaram: [${missing.join(', ')}]`;
}

/**
 * Constrói a NOTA de espera ATENDIDA (todos os writers nomeados postaram). É um
 * aviso POSITIVO e curto — confirma ao leitor que a condição foi satisfeita (vs
 * um snapshot cego). Não é obrigatório, mas torna o caminho feliz auto-explicado.
 *
 * @param waited  Os writers que o leitor esperou (não-vazio).
 */
export function buildWaitSatisfiedNote(waited: readonly string[]): string {
  if (waited.length === 0) return '';
  return `✓ todos os writers esperados postaram: [${waited.join(', ')}]`;
}

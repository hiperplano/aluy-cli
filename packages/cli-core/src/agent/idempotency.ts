// EST-0944 — Idempotency-Key: a key NASCE NO LOOP (correção do revisor do
// EST-0943, registrada aqui por decisão do orquestrador/specs).
//
// PORQUÊ AQUI E NÃO NO CLIENTE: o loop é o dono da noção de "uma chamada LÓGICA
// de modelo". Uma chamada lógica = uma iteração do loop (um turno modelo). Se a
// REDE falhar e o loop precisar repetir essa MESMA chamada lógica, ele reusa a
// MESMA key — e o broker DEDUPLICA o billing (não cobra 2× a mesma chamada).
// Isto é o coração da tese reseller: cobrança honesta, sem dupla-contagem por
// retry de transporte. Se a key nascesse no cliente HTTP, um retry geraria key
// nova e o broker cobraria de novo — exatamente o bug que esta decisão evita.
//
// CONTRATO: a key é ESTÁVEL por (sessão, índice de iteração) e ÚNICA entre
// chamadas lógicas distintas. Um retry da MESMA iteração ⇒ MESMA key (passamos a
// mesma `iteration`). A próxima iteração ⇒ key diferente (avança o índice).

/**
 * Gera a Idempotency-Key de uma chamada lógica de modelo. Determinística:
 * `<sessionId>:<iteration>`. O `sessionId` é o id estável da sessão agêntica
 * (gerado no início do objetivo); `iteration` é o índice 0-based da chamada
 * lógica. Mesma (sessão, iteração) ⇒ mesma key (reuso em retry); iteração
 * seguinte ⇒ key nova (chamada lógica distinta = novo billing legítimo).
 */
export function idempotencyKeyFor(sessionId: string, iteration: number): string {
  return `${sessionId}:${iteration}`;
}

/**
 * Gera um id de sessão agêntica. Usa `crypto.randomUUID` quando disponível
 * (Node ≥ 16.7 / browsers modernos — portável, sem `node:crypto`); senão, um
 * fallback de tempo+aleatório (suficiente p/ unicidade local da sessão).
 */
export function newSessionId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

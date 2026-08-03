// ADR-0158 §5 pt.4 (emenda) — RUNNER (fase 2): `activity-timeout:` do `service.md`
// (ex.: "45m", "2h", "sem-teto") vira o TETO anti-runaway POR ATIVIDADE que
// `resolveActivityTimeout` (runner.ts) usa no lugar do default `MAX_ACTIVITY_MS`.
// Achado em dogfooding: o dono quer o fundo rodando 24/7, sem corte de 30min por
// atividade — `sem-teto` é a saída EXPLÍCITA (nunca um número gigante simulando
// infinito, evitando o mesmo overflow de 32-bit do `setTimeout` já corrigido
// alhures pro sleep entre ciclos).
//
// PORTÁVEL (ADR-0053 §8): parser de string puro (sem `node:*`, sem I/O).

import { parseDuration } from '../cycle/cycle-parse.js';

/**
 * Parseia o `activity-timeout:` cru do `service.md` num teto de ms, `'unlimited'`,
 * ou `undefined`. `undefined` (campo ausente OU malformado) ⇒ o CALLER cai no
 * default `MAX_ACTIVITY_MS` — mesma tolerância semântica de `parseServiceBudget`
 * (RES-MD-3 já validou a FORMA estrutural no parser do manifesto; aqui é
 * semântica, nunca lança). `"sem-teto"` (case-insensitive) ⇒ `'unlimited'` —
 * literal, nunca um número gigante simulando infinito. Reusa `parseDuration`
 * (`5m`/`30s`/`1h`/`90`) — mesma gramática de duração do `/cycle`.
 */
export function parseServiceActivityTimeout(
  raw: string | undefined,
): number | 'unlimited' | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === 'sem-teto') return 'unlimited';
  return parseDuration(trimmed);
}

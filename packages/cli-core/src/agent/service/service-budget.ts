// ADR-0158 §5/§8.3 — RUNNER (fase 2): `budget:` do `service.md` (ex.: "200k/turno")
// precisa virar um INTEIRO de tokens p/ passar pelo caminho JÁ EXISTENTE de teto de
// sessão (`resolveMaxTokens`/`limits.ts`, `--max-tokens`). Este módulo faz SÓ essa
// conversão — puro, sem I/O — o CLAMP anti-runaway (CLI-SEC-8) continua sendo
// `resolveMaxTokens`, que este parser não duplica nem contorna.
//
// PORTÁVEL (ADR-0053 §8): parser de string puro.

/**
 * Parseia o `budget:` cru do `service.md` (ex.: `"200k/turno"`, `"1.5m"`, `"50000"`)
 * num INTEIRO de tokens. Aceita sufixo `k`/`m` (case-insensitive) e ignora qualquer
 * texto após o número/sufixo (o `/turno` do exemplo do ADR §1 é só rótulo). `undefined`
 * quando o valor não tem cara de número (RES-MD-3 do manifesto já validou a FORMA
 * estrutural; aqui é semântica — o runner cai no default do `resolveMaxTokens` quando
 * `undefined`, nunca lança). PURO.
 */
export function parseServiceBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([km]?)/i.exec(raw);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const suffix = (m[2] ?? '').toLowerCase();
  const mult = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : 1;
  const tokens = Math.round(n * mult);
  return tokens > 0 ? tokens : undefined;
}

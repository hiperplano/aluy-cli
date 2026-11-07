// ADR-0158 §3/§5 — RUNNER (fase 2): `until: "HH:MM"` é REGRA DURA ("fim de
// expediente não é sugestão") — o runner ENCERRA o turno no horário, por CÓDIGO,
// nunca por prosa (§3: "regra dura NUNCA é prompt"). Este módulo só faz a CONTA pura
// (que Date é "hoje às HH:MM" relativo a um `now` injetado, e quanto falta) — o
// ENFORCEMENT (matar o processo do turno) é I/O e mora no runner concreto (`cli`).
//
// PORTÁVEL (ADR-0053 §8): cálculo puro de data/hora local da máquina (mesmo limite
// honesto de `cron-next.ts`: sem timezone dedicado, sem calendário de feriados).

/** `undefined` quando `hhmm` não casa `HH:MM` (RES-MD-3 do parser já valida a forma;
 * aqui é defesa extra — nunca lança). */
export function parseHHMM(hhmm: string): { readonly hour: number; readonly minute: number } | undefined {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return undefined;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return undefined;
  return { hour, minute };
}

/**
 * A data-hora de "hoje (relativo a `now`) às `hhmm`". Se `hhmm` já passou hoje, é a
 * data-hora PASSADA de hoje mesmo (o caller decide o que fazer — `msUntilDeadline`
 * abaixo já devolve negativo nesse caso, sinal de "já venceu"). `undefined` ⇒ `hhmm`
 * malformado. PURO.
 */
export function todayAt(now: Date, hhmm: string): Date | undefined {
  const parsed = parseHHMM(hhmm);
  if (!parsed) return undefined;
  const d = new Date(now.getTime());
  d.setHours(parsed.hour, parsed.minute, 0, 0);
  return d;
}

/**
 * Milissegundos até o `until: HH:MM` de hoje, a partir de `now`. NEGATIVO (ou zero)
 * ⇒ o expediente já terminou (o runner não deve nem abrir o turno / deve encerrá-lo
 * JÁ). `undefined` ⇒ sem `until` declarado (sem teto de expediente) OU malformado.
 * PURO.
 */
export function msUntilDeadline(now: Date, until: string | undefined): number | undefined {
  if (until === undefined) return undefined;
  const deadline = todayAt(now, until);
  if (!deadline) return undefined;
  return deadline.getTime() - now.getTime();
}

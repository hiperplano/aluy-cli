// ADR-0158 §5 — RUNNER (fase 2): "dorme até o `schedule`" exige CALCULAR o próximo
// disparo de uma expressão cron de 5 campos. O repo já tem `validateCronExpr`
// (`packages/cli/src/commands/cron.ts`) mas ela só VALIDA faixa — o `aluy cron`
// existente NUNCA precisou calcular "quando" porque delega ao cron do PRÓPRIO SO
// (crontab). O runner de serviço NÃO tem um cron do SO por trás (é um processo só
// seu, §5 — "nenhum processo entre turnos" foi REJEITADO) — por isso precisa da
// PRÓPRIA conta. Fronteira ADR-0053 §8: isto é cálculo puro (sem I/O, sem Date.now()
// implícito — `from` é injetado) e por isso mora aqui, testado, não no `cli`.
//
// Gramática aceita — a MESMA de `validateCronExpr` (minuto hora dia-do-mês mês
// dia-da-semana): `*`, valor, lista `a,b,c`, intervalo `a-b`, passo `/N` (sozinho ou
// após `*`/intervalo), e nomes de mês/dia-da-semana (jan..dec, sun..sat). Dia-do-mês
// E dia-da-semana AMBOS restritos (≠ `*`) ⇒ semântica OR do cron POSIX clássico
// (bate se qualquer um dos dois casar) — não AND.
//
// LIMITE HONESTO (§Consequências do ADR: "timezone/DST/feriado são pântanos
// conhecidos — a v1 declara o que NÃO trata"): calcula em HORÁRIO LOCAL da máquina
// (o mesmo `Date` do processo), sem calendário de feriados. Uma expressão que nunca
// pode casar (ex.: "0 0 30 2 *", 30 de fevereiro) devolve `undefined` após varrer um
// teto de 2 anos — fail-safe, nunca trava o runner num loop infinito.

/** Um campo cron já expandido num conjunto de valores aceitos. `undefined` = campo inválido. */
function expandField(
  raw: string,
  min: number,
  max: number,
  names?: readonly string[],
): Set<number> | undefined {
  const out = new Set<number>();
  const parseOne = (tok: string): number | undefined => {
    const named = names?.indexOf(tok.toLowerCase());
    if (named !== undefined && named >= 0) return min === 0 ? named : named + 1;
    return /^\d+$/.test(tok) ? Number(tok) : undefined;
  };
  for (const part of raw.split(',')) {
    if (part === '') return undefined;
    const [rangeOrStar, stepRaw] = part.split('/');
    if (rangeOrStar === undefined) return undefined;
    let step = 1;
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return undefined;
      step = Number(stepRaw);
      if (step < 1) return undefined;
    }
    let lo: number;
    let hi: number;
    if (rangeOrStar === '*') {
      lo = min;
      hi = max;
    } else {
      const bounds = rangeOrStar.split('-');
      if (bounds.length > 2) return undefined;
      const a = parseOne(bounds[0]!);
      if (a === undefined) return undefined;
      if (bounds.length === 1) {
        lo = a;
        hi = a;
      } else {
        const b = parseOne(bounds[1]!);
        if (b === undefined) return undefined;
        lo = a;
        hi = b;
      }
    }
    if (lo < min || hi > max || lo > hi) return undefined;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Teto de varredura: 2 anos em minutos — fail-safe contra expressão que nunca casa. */
const SEARCH_LIMIT_MINUTES = 2 * 366 * 24 * 60;

/**
 * Calcula o PRÓXIMO disparo (estritamente APÓS `from`, no minuto) de uma expressão
 * cron de 5 campos. `undefined` ⇒ expressão inválida (forma errada/campo fora da
 * faixa) OU nenhum disparo dentro do teto de 2 anos (fail-safe). PURO/determinístico
 * para um dado `from` — nunca lê o relógio sozinha.
 */
export function nextCronFire(expr: string, from: Date): Date | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return undefined;
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];

  const minutes = expandField(minF, 0, 59);
  const hours = expandField(hourF, 0, 23);
  const doms = expandField(domF, 1, 31);
  const months = expandField(monF, 1, 12, MONTH_NAMES);
  const dowsRaw = expandField(dowF, 0, 7, DOW_NAMES);
  if (!minutes || !hours || !doms || !months || !dowsRaw) return undefined;

  // dow `7` ≡ domingo (mesmo que `0`) — normaliza no conjunto.
  const dows = new Set<number>([...dowsRaw].map((d) => (d === 7 ? 0 : d)));
  const domRestricted = domF !== '*';
  const dowRestricted = dowF !== '*';

  // Começa no PRÓXIMO minuto cheio após `from` (nunca devolve o próprio `from`,
  // mesmo que ele já case — "próximo disparo" é estritamente futuro).
  let t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t = new Date(t.getTime() + 60_000);

  for (let i = 0; i < SEARCH_LIMIT_MINUTES; i++) {
    const minute = t.getMinutes();
    const hour = t.getHours();
    const dayOfMonth = t.getDate();
    const month = t.getMonth() + 1;
    const dayOfWeek = t.getDay();

    if (minutes.has(minute) && hours.has(hour) && months.has(month)) {
      const domOk = doms.has(dayOfMonth);
      const dowOk = dows.has(dayOfWeek);
      const dayOk = domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
      if (dayOk) return t;
    }
    t = new Date(t.getTime() + 60_000);
  }
  return undefined;
}

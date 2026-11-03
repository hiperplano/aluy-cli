// VERBOS DE ESPERA — o rótulo genérico (`pensando`, `lembrando`…) vira um gerúndio brincalhão
// em PT-BR (`Garimpando…`, `Matutando…`), sorteado UMA vez por PASSO (cada chamada de modelo /
// fase de preparo), nunca por frame nem por segundo.
//
// SÓ os rótulos genéricos de "ocupado" são trocados. Os funcionais/honestos (aguardando
// decisão, pausa por cota, compactando, conferindo o trabalho, tentando de novo…) seguem como
// estão: o usuário precisa ENTENDER o que está acontecendo.
//
// A lista mora no catálogo i18n (`working.verbs`, separada por `|`) — outro idioma só
// sobrescreve a chave; sem ela cai no pt-BR. PURO e com RNG injetável/semeável (testes estáveis).

/** Rótulos genéricos de ocupado que podem virar verbo (os de `workingLabel` do controller). */
export const ROTULOS_GENERICOS: ReadonlySet<string> = new Set([
  'pensando',
  'lembrando',
  'preparando',
  'maestro avaliando',
]);

/** `ALUY_SPINNER_VERBS=plain` volta aos rótulos planos (`pensando…`). Default: `playful`. */
export function verbosSimples(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ALUY_SPINNER_VERBS ?? '').trim().toLowerCase();
  return v === 'plain' || v === 'off' || v === '0' || v === 'false';
}

/** RNG determinístico (mulberry32) — `seed` fixa a sequência. */
export function criarRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed do processo: `ALUY_SPINNER_VERBS_SEED` (testes/repro) ou o relógio. */
export function seedPadrao(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number.parseInt(env.ALUY_SPINNER_VERBS_SEED ?? '', 10);
  return Number.isFinite(s) ? s : Date.now();
}

/** Quebra a string do catálogo (`a|b|c`) em verbos. */
export function parseVerbos(catalogo: string): readonly string[] {
  return catalogo
    .split('|')
    .map((v) => v.trim())
    .filter((v) => v !== '');
}

/** Sorteia um verbo diferente do `anterior` (se houver mais de um). */
export function sortearVerbo(
  verbos: readonly string[],
  rng: () => number,
  anterior?: string,
): string | undefined {
  if (verbos.length === 0) return undefined;
  if (verbos.length === 1) return verbos[0];
  for (let i = 0; i < 8; i++) {
    const v = verbos[Math.floor(rng() * verbos.length)]!;
    if (v !== anterior) return v;
  }
  return verbos.find((v) => v !== anterior) ?? verbos[0];
}

/** Segundos do turno: `12s`, e `1m 05s` a partir de 60s. PURO. */
export function formatSegundos(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (total < 60) return `${String(total)}s`;
  return `${String(Math.floor(total / 60))}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Contagem compacta pt-BR sem unidade: `850`, `1,2k`, `33k`. `<= 0`/inválido ⇒ undefined. */
export function formatContagemPtBr(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 1000) return String(Math.round(n));
  const k = n / 1000;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace('.', ',')}M`;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '').replace('.', ',') : String(Math.round(k))}k`;
}

/** Tokens compactos em pt-BR: `850 tokens`, `1,2k tokens`, `33k tokens`. `<= 0` ⇒ undefined. */
export function formatTokensPtBr(n: number): string | undefined {
  const c = formatContagemPtBr(n);
  return c === undefined ? undefined : `${c} tokens`;
}

/**
 * O parêntese dim depois do verbo: `(pensando · ↑ 21k ↓ 394 tokens · 9s)`.
 *   ↑ = tokens ENVIADOS na requisição do passo (estimativa `~` até o uso real chegar);
 *   ↓ = tokens GERADOS no turno. Antes do 1º delta só há ↑; depois, ambos.
 * Cabe em `larguraMax` colunas ou perde segmentos: PRIMEIRO o ↑, depois o ↓, depois a fase; os
 * segundos são o último a sair. `fase` ausente (rótulo funcional já diz a fase) ⇒ omitida.
 */
export function detalheDeEspera(args: {
  readonly fase?: string | undefined;
  /** Tokens gerados (↓) no turno. */
  readonly tokens?: number | undefined;
  /** Tokens enviados (↑) na requisição do passo; `estimado` ⇒ prefixo `~`. */
  readonly entrada?: { readonly tokens: number; readonly estimado: boolean } | undefined;
  readonly ms: number;
  readonly larguraMax?: number | undefined;
}): string {
  const secs = formatSegundos(args.ms);
  const saida = args.tokens !== undefined ? formatContagemPtBr(args.tokens) : undefined;
  const ent = args.entrada !== undefined ? formatContagemPtBr(args.entrada.tokens) : undefined;
  const up =
    ent !== undefined ? `↑ ${args.entrada?.estimado === true ? '~' : ''}${ent}` : undefined;
  const down = saida !== undefined ? `↓ ${saida}` : undefined;
  const io = (a?: string, b?: string): string | undefined => {
    const t = [a, b].filter((x): x is string => x !== undefined).join(' ');
    return t === '' ? undefined : `${t} tokens`;
  };
  const alvo = (...p: (string | undefined)[]): string[] =>
    p.filter((x): x is string => x !== undefined);
  const candidatos: string[][] = [
    alvo(args.fase, io(up, down), secs),
    alvo(args.fase, io(undefined, down), secs),
    alvo(args.fase, secs),
    [secs],
  ];
  const max = args.larguraMax ?? Number.POSITIVE_INFINITY;
  for (const c of candidatos) {
    const txt = `(${c.join(' · ')})`;
    if (txt.length <= max) return txt;
  }
  return `(${secs})`;
}

/**
 * O rótulo exibido na linha de trabalho: o verbo do passo (fonte única no estado do controller)
 * quando o `workingLabel` é genérico; senão o próprio rótulo (funcional).
 */
export function rotuloExibido(args: {
  readonly label: string | undefined;
  readonly verbo: string | undefined;
}): string | undefined {
  const { label } = args;
  if (label === undefined) return undefined;
  if (args.verbo === undefined || !ROTULOS_GENERICOS.has(label)) return label;
  return args.verbo;
}

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

/** `ALUY_VERBOS=simples` volta aos rótulos planos (`pensando…`). Default: verbos. */
export function verbosSimples(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.ALUY_VERBOS ?? '').trim().toLowerCase();
  return v === 'simples' || v === 'off' || v === '0' || v === 'false';
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

/** Seed do processo: `ALUY_VERBOS_SEED` (testes/repro) ou o relógio. */
export function seedPadrao(env: NodeJS.ProcessEnv = process.env): number {
  const s = Number.parseInt(env.ALUY_VERBOS_SEED ?? '', 10);
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

/** Tokens compactos em pt-BR: `850 tokens`, `1,2k tokens`, `33k tokens`. `<= 0` ⇒ undefined. */
export function formatTokensPtBr(n: number): string | undefined {
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (n < 1000) return `${String(Math.round(n))} tokens`;
  const k = n / 1000;
  const txt = k < 10 ? k.toFixed(1).replace(/\.0$/, '').replace('.', ',') : String(Math.round(k));
  return n < 1_000_000
    ? `${txt}k tokens`
    : `${(n / 1_000_000).toFixed(1).replace('.', ',')}M tokens`;
}

/**
 * O parêntese dim depois do verbo: `(pensando · 1,2k tokens · 12s)`. Cabe em `larguraMax`
 * colunas ou perde segmentos pela direita de prioridade: PRIMEIRO os tokens, depois a fase;
 * os segundos são o último a sair. `fase` ausente (rótulo funcional já diz a fase) ⇒ omitida.
 */
export function detalheDeEspera(args: {
  readonly fase?: string | undefined;
  readonly tokens?: number | undefined;
  readonly ms: number;
  readonly larguraMax?: number | undefined;
}): string {
  const secs = formatSegundos(args.ms);
  const tok = args.tokens !== undefined ? formatTokensPtBr(args.tokens) : undefined;
  const candidatos: string[][] = [
    [args.fase, tok, secs].filter((x): x is string => x !== undefined),
    [args.fase, secs].filter((x): x is string => x !== undefined),
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
 * O estado do sorteio de UMA sessão da UI: guarda o verbo do passo corrente. `passo` é a
 * identidade do passo (o `workingSince`, que o controller zera a cada chamada de modelo).
 */
export class SeletorDeVerbo {
  private passo: number | undefined;
  private verbo: string | undefined;
  private readonly rng: () => number;
  constructor(seed: number = seedPadrao()) {
    this.rng = criarRng(seed);
  }
  /** O verbo do passo (estável enquanto `passo` não muda). */
  para(passo: number | undefined, verbos: readonly string[]): string | undefined {
    if (this.verbo === undefined || this.passo !== passo) {
      this.verbo = sortearVerbo(verbos, this.rng, this.verbo);
      this.passo = passo;
    }
    return this.verbo;
  }
}

/**
 * O rótulo exibido: verbo sorteado quando o `workingLabel` é genérico; senão o próprio rótulo
 * (funcional). Capitalizado como o catálogo o escreve.
 */
export function rotuloExibido(args: {
  readonly label: string | undefined;
  readonly passo: number | undefined;
  readonly verbos: readonly string[];
  readonly seletor: SeletorDeVerbo;
  readonly simples: boolean;
}): string | undefined {
  const { label } = args;
  if (label === undefined) return undefined;
  if (args.simples || !ROTULOS_GENERICOS.has(label)) return label;
  return args.seletor.para(args.passo, args.verbos) ?? label;
}

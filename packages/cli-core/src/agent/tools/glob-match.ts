// EST-0944 — matcher de GLOB→matcher de CAMINHO, PURO e ANTI-ReDoS (sem dependência).
//
// O tool nativo `glob` acha ARQUIVOS por padrão (`**/*.ts`, `src/**/test_*.py`). A
// LÓGICA de I/O (enumerar arquivos confinados, respeitar `.gitignore`, tetos) mora na
// PORTA concreta (@hiperplano/aluy-cli, Node). AQUI fica só a parte PORTÁVEL e determinística: a
// COMPILAÇÃO do padrão glob num MATCHER de caminhos RELATIVOS. Sem `node:*`, sem dep —
// testável sem filesystem nem modelo (cli-core não faz I/O cru, CLI-SEC-7).
//
// ┌─ SINTAXE SUPORTADA (subconjunto SEGURO, estilo Claude Code / gitignore-ish) ──┐
// │  *         casa zero+ chars, MAS NÃO cruza `/` (um segmento de caminho).        │
// │  **        casa zero+ SEGMENTOS inteiros (cruza `/`, qualquer profundidade).    │
// │            `**/x` casa `x` na raiz também (o `/` após `**` é opcional).          │
// │  ?         casa exatamente 1 char que NÃO seja `/`.                              │
// │  [abc] [a-z] [!abc]   classe de chars (um char, nunca `/`); `!`/`^` = negação.   │
// │  {a,b,c}   alternância (uma das opções); pode aninhar literais simples.          │
// │  \x        escape: o próximo char é LITERAL (ex.: `\*` casa um `*` de verdade).  │
// │  qualquer outro char é LITERAL (incl. `.` — NÃO é metacaractere aqui).           │
// └──────────────────────────────────────────────────────────────────────────────┘
//
// ┌─ ANTI-ReDoS (o padrão vem do MODELO = entrada NÃO-confiável, CLI-SEC-4) ───────┐
// │ O `**` NÃO vira regex (a tradução regex de `**/` — `(?:[^/]*(?:/|$))*` — é um   │
// │ quantificador ANINHADO, fonte clássica de backtracking catastrófico). Em vez    │
// │ disso, o padrão é PARTIDO em SEGMENTOS (`/`) e casado por um algoritmo de duas   │
// │ pontas O(n·m) (estilo wildcard-matching), onde só `**` "salta" segmentos — SEM   │
// │ backtracking exponencial. DENTRO de cada segmento, `*`/`?`/`[...]`/literais      │
// │ viram um regex ANCORADO simples (`[^/]*`, `[^/]`, classe) — linear, sem grupo    │
// │ quantificado sobre alternância. Tetos defensivos: comprimento e nº de segmentos. │
// └──────────────────────────────────────────────────────────────────────────────┘

/** Erro de padrão glob inválido (sintaxe) — vira erro VISÍVEL no tool (não silêncio). */
export class GlobSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GlobSyntaxError';
  }
}

/** Teto de comprimento do padrão (anti-abuso; um glob legítimo é curto). */
export const MAX_GLOB_PATTERN_CHARS = 1_024;
/** Teto de aninhamento de `{...}` (anti-explosão combinatória da expansão). */
const MAX_BRACE_DEPTH = 5;
/**
 * Teto do nº TOTAL de alternativas que a expansão `{...}` pode gerar (anti-explosão
 * combinatória). O `MAX_BRACE_DEPTH` limita só o ANINHAMENTO; grupos SEQUENCIAIS
 * (`{a..}{b..}{c..}`) multiplicam o produto cartesiano dentro do orçamento de chars —
 * 5 grupos de 40 opções num padrão de ~400 chars geram 40^5 = 102M strings, travando
 * o event-loop por dezenas de segundos e estourando a memória. O padrão vem do MODELO
 * (entrada NÃO-confiável, CLI-SEC-4), então capamos o RESULTADO, não só a forma.
 */
export const MAX_GLOB_ALTERNATIVES = 1_024;

/** Escapa um char LITERAL p/ dentro de um RegExp (fora de classe `[...]`). */
function escapeLiteral(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Escapa um char p/ dentro de uma classe `[...]` de regex. Escapa SÓ `\` e `]` (que
 * encerrariam/quebrariam a classe). NÃO escapa `-` nem `^`: em glob eles têm o MESMO
 * papel que em regex (range `a-z`; `^` no início = negação, já tratada à parte) — então
 * passam direto e a classe se comporta como o usuário espera (`[a-z]`, `[!0-9]`).
 */
function escapeInClass(ch: string): string {
  return ch === '\\' || ch === ']' ? `\\${ch}` : ch;
}

/**
 * Compila UM segmento glob (SEM `/`, SEM `**`, já com `{}` expandido) num RegExp
 * ANCORADO que casa o segmento INTEIRO. Os coringas NÃO cruzam `/` por construção
 * (`[^/]`). PURO. Lança `GlobSyntaxError` em classe `[...]` não fechada ou escape `\`
 * pendente. A tradução é 1-para-1/linear (anti-ReDoS) — sem quantificador aninhado.
 */
function compileSegment(seg: string): RegExp {
  let re = '';
  let i = 0;
  const n = seg.length;
  while (i < n) {
    const ch = seg[i]!;
    if (ch === '\\') {
      const next = seg[i + 1];
      if (next === undefined) {
        throw new GlobSyntaxError('escape "\\" no fim do segmento (sem char para escapar).');
      }
      re += escapeLiteral(next);
      i += 2;
      continue;
    }
    if (ch === '*') {
      re += '[^/]*'; // `*` (e `**` dentro de um segmento, ex.: `a**b`) — não cruza `/`
      i += 1;
      // colapsa runs de `*` (vários `*` seguidos = um `[^/]*`, evita `[^/]*[^/]*`).
      while (seg[i] === '*') i += 1;
      continue;
    }
    if (ch === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      let body = '';
      let negate = false;
      if (seg[j] === '!' || seg[j] === '^') {
        negate = true;
        j += 1;
      }
      if (seg[j] === ']') {
        body += '\\]';
        j += 1;
      }
      let closed = false;
      while (j < n) {
        const c = seg[j]!;
        if (c === ']') {
          closed = true;
          break;
        }
        if (c === '\\') {
          const nx = seg[j + 1];
          if (nx === undefined) {
            throw new GlobSyntaxError('escape "\\" não terminado dentro de "[...]".');
          }
          body += escapeInClass(nx);
          j += 2;
          continue;
        }
        body += escapeInClass(c);
        j += 1;
      }
      if (!closed) {
        throw new GlobSyntaxError(`classe de chars "[" não fechada (falta "]") em "${seg}".`);
      }
      re += negate ? `[^/${body}]` : `[${body}]`;
      i = j + 1;
      continue;
    }
    re += escapeLiteral(ch);
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

/**
 * Um TOKEN do padrão compilado por segmentos: ou o coringa `**` (salta zero+ segmentos),
 * ou um RegExp que casa UM segmento literal/coringa-de-segmento.
 */
type SegToken = { readonly star2: true } | { readonly star2: false; readonly re: RegExp };

/** Compila a lista de tokens de segmento de UM padrão (sem `{}`). PURO. */
function compileSegments(pattern: string): SegToken[] {
  const rawSegs = pattern.split('/');
  const tokens: SegToken[] = [];
  for (const seg of rawSegs) {
    if (seg === '**') {
      // `**` puro = salta segmentos. Colapsa `**` consecutivos (`a/**/**/b` = `a/**/b`).
      if (tokens.length > 0 && tokens[tokens.length - 1]!.star2) continue;
      tokens.push({ star2: true });
    } else {
      tokens.push({ star2: false, re: compileSegment(seg) });
    }
  }
  return tokens;
}

/**
 * Casa a lista de segmentos do CAMINHO contra os tokens, com `**` saltando zero+
 * segmentos. Algoritmo de DUAS PONTAS O(n·m) (estilo wildcard match) — SEM recursão
 * exponencial nem backtracking catastrófico (anti-ReDoS). PURO.
 */
function matchSegments(tokens: readonly SegToken[], parts: readonly string[]): boolean {
  let ti = 0; // índice no padrão
  let pi = 0; // índice no caminho
  let starTi = -1; // último `**` visto (p/ backtrack controlado, O(1) por posição)
  let starPi = 0; // posição no caminho quando vimos o `**`
  while (pi < parts.length) {
    const tok = tokens[ti];
    if (tok && !tok.star2 && tok.re.test(parts[pi]!)) {
      ti += 1;
      pi += 1;
    } else if (tok && tok.star2) {
      // `**` casa zero segmentos por ora; lembra a posição p/ "esticar" depois.
      starTi = ti;
      starPi = pi;
      ti += 1;
    } else if (starTi !== -1) {
      // não casou: estica o último `**` p/ engolir mais um segmento. Avança SÓ no
      // caminho — cada segmento do caminho é consumido no máx. uma vez por `**` ⇒ O(n·m).
      ti = starTi + 1;
      starPi += 1;
      pi = starPi;
    } else {
      return false; // sem `**` p/ esticar e o segmento não casou ⇒ falha.
    }
  }
  // Consome `**` restantes (que podem casar zero segmentos) no fim do padrão.
  while (ti < tokens.length && tokens[ti]!.star2) ti += 1;
  return ti === tokens.length;
}

/**
 * Expande as alternâncias `{a,b,c}` de um padrão glob em uma LISTA de padrões sem `{}`.
 * Suporta aninhamento simples e múltiplos grupos (produto cartesiano). PURO. Lança
 * `GlobSyntaxError` em `{` não fechado ou aninhamento além do teto (anti-explosão).
 */
export function expandBraces(pattern: string, depth = 0): string[] {
  if (depth > MAX_BRACE_DEPTH) {
    throw new GlobSyntaxError(`aninhamento de "{...}" excede o teto (${MAX_BRACE_DEPTH}).`);
  }
  const open = findUnescaped(pattern, '{', 0);
  if (open === -1) return [pattern];

  const close = matchingBrace(pattern, open);
  if (close === -1) {
    throw new GlobSyntaxError(`"{" sem "}" correspondente em "${pattern}".`);
  }
  const head = pattern.slice(0, open);
  const inner = pattern.slice(open + 1, close);
  const tail = pattern.slice(close + 1);

  const options = splitTopLevel(inner);
  const out: string[] = [];
  for (const opt of options) {
    for (const expandedRest of expandBraces(`${head}${opt}${tail}`, depth + 1)) {
      // Anti-explosão combinatória: grupos sequenciais multiplicam o produto dentro
      // do orçamento de chars (o `MAX_BRACE_DEPTH` só freia o aninhamento). Corta ANTES
      // de materializar mais — falha VISÍVEL em vez de pendurar o event-loop / OOM.
      if (out.length >= MAX_GLOB_ALTERNATIVES) {
        throw new GlobSyntaxError(
          `expansão de "{...}" gera alternativas demais (> ${MAX_GLOB_ALTERNATIVES}).`,
        );
      }
      out.push(expandedRest);
    }
  }
  return out;
}

/** Índice da 1ª ocorrência NÃO-escapada de `ch` em `s` a partir de `from` (ou -1). */
function findUnescaped(s: string, ch: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === ch) return i;
  }
  return -1;
}

/** Índice do `}` que casa o `{` na posição `open` (respeita aninhamento/escape). */
function matchingBrace(s: string, open: number): number {
  let level = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '\\') {
      i += 1;
      continue;
    }
    if (s[i] === '{') level += 1;
    else if (s[i] === '}') {
      level -= 1;
      if (level === 0) return i;
    }
  }
  return -1;
}

/** Divide `inner` pelas vírgulas de NÍVEL 0 (fora de `{}` aninhado, não-escapadas). */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let level = 0;
  let cur = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]!;
    if (c === '\\') {
      cur += c + (inner[i + 1] ?? '');
      i += 1;
      continue;
    }
    if (c === '{') level += 1;
    else if (c === '}') level -= 1;
    if (c === ',' && level === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * Compila um padrão glob (com `{}`/`**`/`*`/`?`/`[...]`) num MATCHER de caminhos
 * RELATIVOS (POSIX `/`). Devolve um predicado PURO `(relPath) => boolean`. Lança
 * `GlobSyntaxError` em padrão vazio, longo demais ou sintaticamente inválido.
 *
 * Os caminhos testados são SEMPRE relativos à raiz, com separador `/` (o locus concreto
 * normaliza antes). O match é por SEGMENTOS, ancorado início↔fim: o padrão casa o
 * caminho INTEIRO (estilo glob de path), não um pedaço. Anti-ReDoS por construção
 * (algoritmo de duas pontas no `**`, regex por-segmento sem quantificador aninhado).
 */
export function compileGlob(pattern: string): (relPath: string) => boolean {
  if (pattern === '') {
    throw new GlobSyntaxError('padrão vazio.');
  }
  if (pattern.length > MAX_GLOB_PATTERN_CHARS) {
    throw new GlobSyntaxError(
      `padrão longo demais (${pattern.length} > ${MAX_GLOB_PATTERN_CHARS} chars).`,
    );
  }
  // Expande `{}` em alternativas; cada uma vira uma lista de tokens de segmento. O match
  // é a UNIÃO (OR): o caminho casa se ALGUMA alternativa casa (testa N matchers lineares).
  const alternatives = expandBraces(pattern).map((alt) => compileSegments(alt));
  return (relPath: string): boolean => {
    // Normaliza separador (defesa: o concreto já passa POSIX, mas não confiamos).
    const norm = relPath.split('\\').join('/');
    // Caminho vazio = nenhum segmento; trata como `['']` p/ um padrão poder casá-lo.
    const parts = norm === '' ? [''] : norm.split('/');
    return alternatives.some((tokens) => matchSegments(tokens, parts));
  };
}

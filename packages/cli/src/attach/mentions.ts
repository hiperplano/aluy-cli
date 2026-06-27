// EST-0957 · fallback NÃO-TTY — `@path` LITERAL no texto do objetivo.
//
// O picker `@arquivo` é interação de TTY (digitar `@` abre um menu navegável). Em
// NÃO-TTY/linear (saída piped/CI), não há menu — mas o DoD pede um fallback: um
// token `@caminho` ESCRITO no texto do objetivo é resolvido LITERALMENTE como
// anexo (mesma trava de confinamento/path-deny via AttachReader). Decisão: o `@`
// só vira menção se for um TOKEN de caminho plausível (não um `@` solto, não um
// e-mail `user@host`, não um `@scope/pkg` de npm no meio de uma frase qualquer —
// exigimos que pareça um caminho: tem `/` OU uma extensão de arquivo).
//
// BUG-0019 — caminhos COM ESPAÇO: `@"a b.md"`, `@'a b.md'` (aspas) ou `@a\ b.md`
// (barra-espaço escapado). O path é des-escapado/sem-aspas antes de ir ao reader; o
// intervalo removido do goal cobre o token inteiro (aspas/escapes inclusos).
//
// Determinístico, sem I/O — a RESOLUÇÃO concreta (ler/confinar) é do AttachReader.

/** Uma menção `@path` extraída do texto, com o intervalo p/ removê-la do goal. */
export interface AtMention {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

// `@` seguido de um token de caminho. Precedido por início-de-string ou whitespace
// (não casa um `@` colado a uma palavra, ex.: `email@host` não dispara porque o `@`
// não está no começo nem após espaço). TRÊS formas de token (BUG-0019), nesta ordem
// de precedência:
//   1. `@"caminho com espaços"`  — aspas DUPLAS: captura tudo até a próxima `"`.
//   2. `@'caminho com espaços'`  — aspas SIMPLES: captura tudo até a próxima `'`.
//   3. `@caminho\ escapado`      — token cru: LETRAS UNICODE/dígitos/`._-/` MAIS `\ `
//      (barra seguida de espaço) p/ embutir espaços sem aspas.
// As aspas exigem FECHAMENTO (`[^"]+"`): uma aspa não-fechada NÃO casa nessa
// alternativa e DEGRADA p/ a forma crua (não engole o resto da linha). O token cru
// nunca casa espaço NÚ — só `\ ` — então `@a b` para em `@a`, preservando o legado.
//
// EST-1015 (fix PT-BR) — o token cru usava `[\w./-]` (ASCII-only): `@coração.md`,
// `@configuração.json`, `@José.pdf` PARAVAM no acento (`@cora`/`@Jos`) ⇒ não eram
// reconhecidos como menção. Agora `\p{L}` (letra Unicode) + `\p{N}` (número) + `._-/`
// (flag `u`) casa o nome de arquivo acentuado INTEIRO. Email (`user@host`) segue
// rejeitado (o `@` não está no início nem após espaço); aspas/`\ ` intactos.
const MENTION_RE = /(?:^|\s)(@(?:"([^"]+)"|'([^']+)'|((?:[\p{L}\p{N}._/-]|\\ )+)))/gu;

/**
 * Des-escapa/remove as aspas de um token capturado, devolvendo o caminho REAL a
 * passar ao AttachReader. Para o token cru, `\ ` (barra-espaço) vira um espaço; as
 * formas com aspas chegam já sem delimitador (o grupo de captura é o miolo).
 */
function unescapePath(raw: string): string {
  return raw.replace(/\\ /g, ' ');
}

/** `true` se o caminho (JÁ des-escapado) PARECE um arquivo (tem `/` ou extensão). */
function looksLikePath(token: string): boolean {
  if (token.includes('/')) return true;
  return /\.[A-Za-z0-9]+$/.test(token);
}

// EST-1015 — PONTUAÇÃO de FIM-DE-FRASE colada ao token CRU. O char-class do token
// inclui `.` (p/ extensões e `..`), então um ponto final colado é GREEDY-engolido:
// `@config.ts.` capturava `config.ts.` ⇒ `looksLikePath` falha (não termina em
// `.<ext>`) e a menção SOME; `@src/app.ts.` ia ao reader como `src/app.ts.` (path
// ERRADO, arquivo inexistente). Um nome de arquivo real NUNCA termina em `.` nu —
// o ponto final é terminador de frase, não parte do caminho. Apara os `.` à direita
// (e devolve QUANTOS foram aparados, p/ encurtar a faixa: o `.` continua no goal como
// pontuação). NÃO toca `@../x` nem `@./x` (esses `.` não estão à DIREITA). Só o token
// cru — formas com aspas (`@"a."`) são explícitas e ficam intactas.
function trimTrailingDots(token: string): { token: string; trimmed: number } {
  const stripped = token.replace(/\.+$/, '');
  return { token: stripped, trimmed: token.length - stripped.length };
}

/**
 * Extrai as menções `@path` plausíveis do texto. Ignora `@` solto e tokens que não
 * parecem caminho (`@todo`, `@user`). Os intervalos cobrem o `@...` (sem o espaço
 * separador) p/ o caller poder REMOVÊ-LOS do objetivo, deixando só a intenção.
 */
export function parseAtMentions(text: string): readonly AtMention[] {
  const out: AtMention[] = [];
  for (const m of text.matchAll(MENTION_RE)) {
    const whole = m[1]!; // `@"a b"` | `@'a b'` | `@a\ b` — inclui aspas/escapes.
    // Só UM dos três grupos casa: aspas-duplas | aspas-simples | token cru.
    const raw = m[4]; // o token CRU (sem aspas), se foi essa alternativa.
    const inner = m[2] ?? m[3] ?? raw!; // o miolo, ainda escapado.
    // Só o token CRU sofre aparo de ponto-final colado (as formas com aspas são
    // explícitas). `trimmed` = quantos `.` saíram, p/ encurtar a faixa removida.
    const { token: trimmedInner, trimmed } =
      raw !== undefined ? trimTrailingDots(inner) : { token: inner, trimmed: 0 };
    const path = unescapePath(trimmedInner); // caminho REAL p/ o AttachReader.
    if (!looksLikePath(path)) continue;
    // A faixa cobre o `@...` INTEIRO (aspas/escapes inclusos) MENOS a pontuação de
    // fim-de-frase aparada, p/ o stripMentions tirar a menção e DEIXAR o ponto final.
    const start = (m.index ?? 0) + m[0].indexOf(whole);
    out.push({ path, start, end: start + whole.length - trimmed });
  }
  return out;
}

/** Remove os intervalos das menções do texto, normalizando espaços. */
export function stripMentions(text: string, mentions: readonly AtMention[]): string {
  if (mentions.length === 0) return text;
  // Remove de trás p/ frente p/ não invalidar os índices.
  let out = text;
  for (const mention of [...mentions].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, mention.start) + out.slice(mention.end);
  }
  return out.replace(/\s{2,}/g, ' ').trim();
}

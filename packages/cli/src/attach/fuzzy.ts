// EST-0957 · CA-1 — FUZZY MATCH dos arquivos do workspace p/ o picker `@`.
//
// Mesma MECÂNICA do <SlashMenu> (filtro incremental), mas sobre CAMINHOS — então
// fuzzy de subsequência (não só prefixo/substring): `@auth/sess` deve casar
// `packages/cli/src/auth/session.ts`. Determinístico, sem I/O — testável isolado.
//
// Ranking (melhor → pior), p/ o item mais provável ficar no topo (selecionável com
// um Enter):
//   1) match de SUBSTRING contígua (mais forte) antes de subsequência esparsa;
//   2) match no BASENAME (nome do arquivo) antes de no diretório;
//   3) menor "espalhamento" (caracteres mais juntos) antes de mais esparso;
//   4) caminho mais curto; por fim ordem alfabética (estável).

/** Um item filtrado: o caminho + a pontuação + os índices que casaram (highlight). */
export interface FuzzyHit {
  readonly path: string;
  readonly score: number;
  /** Índices (no `path`) dos caracteres que casaram a query — p/ realçar. */
  readonly matched: readonly number[];
}

/**
 * Casa `query` em `text` como SUBSEQUÊNCIA case-insensitive. Devolve os índices
 * casados e um score (maior = melhor) ou `null` se não casa. Bônus p/ contiguidade
 * e p/ casar no basename. Query vazia ⇒ casa tudo (score neutro, sem índices).
 */
export function fuzzyScore(
  query: string,
  text: string,
): { score: number; matched: number[] } | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (q === '') return { score: 0, matched: [] };

  const matched: number[] = [];
  let ti = 0;
  let score = 0;
  let prevIdx = -1;
  // Posição do início do basename (após a última `/`) p/ o bônus de basename.
  const baseStart = text.lastIndexOf('/') + 1;

  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!;
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    matched.push(found);
    // Contiguidade: caractere logo após o anterior vale mais (substring forte).
    if (prevIdx >= 0 && found === prevIdx + 1) score += 5;
    else score += 1;
    // Bônus se casa dentro do basename (o que o usuário costuma mirar).
    if (found >= baseStart) score += 2;
    // Bônus de borda: início de segmento (após `/`/`-`/`_`/`.`) é "âncora".
    const before = found > 0 ? text[found - 1] : '/';
    if (before === '/' || before === '-' || before === '_' || before === '.') score += 3;
    prevIdx = found;
    ti = found + 1;
  }
  // Penaliza espalhamento (span maior = pior) e caminho longo (leve).
  const span = (matched[matched.length - 1] ?? 0) - (matched[0] ?? 0);
  score -= span * 0.1;
  score -= text.length * 0.01;
  return { score, matched };
}

/**
 * Filtra+ordena os caminhos do índice pela `query` fuzzy. Query vazia ⇒ devolve
 * todos na ordem do índice (já ordenado alfabeticamente pelo FileIndexPort), sem
 * highlight. Caso contrário, só os que casam, do melhor score ao pior.
 */
export function filterFuzzy(query: string, paths: readonly string[]): readonly FuzzyHit[] {
  const q = query.trim();
  if (q === '') return paths.map((p) => ({ path: p, score: 0, matched: [] }));
  const hits: FuzzyHit[] = [];
  for (const path of paths) {
    const r = fuzzyScore(q, path);
    if (r) hits.push({ path, score: r.score, matched: r.matched });
  }
  hits.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return hits;
}

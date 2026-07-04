// EST-0965 (anti-flicker, WRAP) — contagem de linhas VISUAIS (não linhas-fonte).
//
// O furo que sobrou da EST-0965: TODO o orçamento da região viva (live-budget.ts +
// o windowTail do <AluyBlock>) contava linhas-FONTE (1 por `\n`). Mas uma linha
// mais larga que `columns` QUEBRA (wrap) em VÁRIAS linhas VISUAIS no terminal — o
// Ink (e qualquer emulador) re-flui no `columns` da janela. Output real de agente
// (JSON de e-commerce, paths longos, logs, stack traces) tem linhas LONGAS. Então a
// altura REAL renderizada da região viva passava do orçado ⇒ estourava `rows` ⇒ o
// Ink fazia `clearTerminal + redesenha tudo` ⇒ piscava. O #59 documentou isso como
// risco inerente ("a SAFETY_MARGIN absorve casos leves") — mas em build real não é
// leve. A correção é CONTAR LINHAS VISUAIS em todo o cálculo de altura.
//
// PURO (sem React/Ink): testável sem TUI.

/**
 * Largura de EXIBIÇÃO de uma string numa célula de terminal monoespaçado, em
 * COLUNAS. É uma aproximação deliberadamente conservadora p/ o orçamento de altura
 * (não um layout pixel-perfect):
 *
 *   • sequências CSI (`\x1b[...`, cor/estilo ANSI) → 0 (ver FIX abaixo);
 *   • caracteres de controle (C0, exceto já tratados fora) → 0;
 *   • largura-DUPLA (CJK, Hangul, kana, ideogramas, e a maioria dos emoji no plano
 *     astral) → 2 colunas;
 *   • zero-width (combinantes, ZWJ, variation selectors) → 0;
 *   • o resto → 1 coluna.
 *
 * Não cobre TODO o Unicode (não há tabela wcwidth embarcada), mas cobre as faixas
 * que mais aparecem e que, se contadas como 1, SUBESTIMARIAM a largura e furariam o
 * orçamento (CJK/emoji ocupam 2 células). Itera por CODE POINT, então um emoji
 * astral conta UMA vez (e como 2 colunas), não como 2 unidades UTF-16.
 *
 * FIX (achado do dono — duplicação/fantasma no SCROLL de sessão grande) — ANTES esta
 * função NÃO filtrava sequências CSI: só o byte `\x1b` tinha largura 0 (é C0), mas os
 * bytes SEGUINTES da sequência (`[`, dígitos, `;`, a letra final `m`/…) são ASCII
 * IMPRIMÍVEL "normal" p/ este scanner ⇒ cada um contava 1 coluna. Um `\x1b[31m`
 * (cor vermelha, 5 bytes) inflava em +4 colunas de LIXO invisível — texto de tool/
 * bang com saída COLORIDA (comum: `ls --color`, diffs, test runners) tinha a largura
 * SUPERESTIMADA, e `visualLines`/`windowTailVisual` (que usam `displayWidth`) mediam
 * MAIS linhas visuais do que o terminal realmente pinta. Isso diverge da medição
 * "espelho" real (`wrappedLineCount`, que usa `wrap-ansi` — ciente de CSI) usada por
 * `measureConversaBlock`/`markdownLines`: a MESMA sequência de escape, medida por
 * `displayWidth` (superestima) vs. medida pelo render de fato (ignora), é a fonte
 * concreta do drift medida≠render que só aparece em conteúdo ANTIGO/colorido — ou
 * seja, ao ROLAR (pgup/pgdn) pro histórico de uma sessão grande. Agora pulamos a
 * sequência CSI inteira (mesmo padrão de `frameEndCursor`/`chunkIsFrameContent` em
 * `synchronized-output.ts`) ANTES de medir largura — ela nunca conta coluna.
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '\x1b' && text[i + 1] === '[') {
      // CSI: `\x1b[` + parâmetros (`[0-9;?]*`) + bytes intermediários (` -/`) + 1
      // byte final (`@-~`). LARGURA ZERO no terminal (não imprime; move cursor ou
      // pinta cor) ⇒ pula a sequência inteira SEM contar coluna alguma.
      let j = i + 2;
      while (j < text.length && text[j]! >= '0' && text[j]! <= '?') j += 1;
      while (j < text.length && text[j]! >= ' ' && text[j]! <= '/') j += 1;
      i = j; // o `for` ainda soma +1 ⇒ próxima iteração começa APÓS o byte final.
      continue;
    }
    const cp = text.codePointAt(i)!;
    if (cp > 0xffff) i += 1; // par surrogate: pula a unidade baixa (já contabilizada).
    width += charWidth(cp);
  }
  return width;
}

/** Largura (0/1/2) de UM code point. Conservador (ver `displayWidth`). */
function charWidth(cp: number): number {
  // C0/C1 e DEL — sem largura visível (tab tratado à parte por quem chama, se quiser).
  if (cp === 0) return 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;

  // Zero-width: combinantes, ZWJ/ZWNJ, joiners, variation selectors, BOM.
  if (isZeroWidth(cp)) return 0;

  // Largura-dupla (wide): CJK & cia + emoji astral. Conservador.
  if (isWide(cp)) return 2;

  return 1;
}

/** Code points de largura ZERO (combinantes / joiners / seletores). */
function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) || // combining diacritical marks
    (cp >= 0x1ab0 && cp <= 0x1aff) || // combining diacritical marks extended
    (cp >= 0x1dc0 && cp <= 0x1dff) || // combining diacritical marks supplement
    (cp >= 0x20d0 && cp <= 0x20ff) || // combining marks for symbols
    (cp >= 0xfe00 && cp <= 0xfe0f) || // variation selectors
    (cp >= 0xfe20 && cp <= 0xfe2f) || // combining half marks
    cp === 0x200b || // zero-width space
    cp === 0x200c || // ZWNJ
    cp === 0x200d || // ZWJ
    cp === 0xfeff // BOM / zero-width no-break space
  );
}

/** Code points de largura DUPLA (wide) — faixas conservadoras + emoji astral. */
function isWide(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … Kangxi
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, CJK symbols …
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji & pictographs (astral)
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+ (astral ideographs)
  );
}

/**
 * Nº de linhas VISUAIS que `text` ocupa quando renderizado numa largura de `columns`
 * colunas (o terminal re-flui no `columns` da janela). Para CADA linha-fonte (split
 * por `\n`): `ceil(max(1, displayWidth(linha)) / columns)` — uma linha-fonte VAZIA
 * ainda ocupa 1 linha visual; uma linha de 200 chars em columns=80 ocupa 3. Soma de
 * todas as linhas-fonte. PURO.
 *
 * `columns <= 0` (ou ausente) ⇒ sem wrap conhecido: cai p/ a contagem de linhas-FONTE
 * (1 por `\n`), o comportamento antigo (degradação graciosa, nunca quebra).
 */
export function visualLines(text: string, columns: number): number {
  const sourceLines = text.split('\n');
  if (!columns || columns <= 0) return sourceLines.length;
  let total = 0;
  for (const line of sourceLines) {
    const w = displayWidth(line);
    total += Math.max(1, Math.ceil(w / columns));
  }
  return total;
}

/**
 * GAP-FIX (sessão renomeada) — INDENT REAL (colunas) do texto do composer inline.
 * O input não começa na coluna 0: há o prompt `› ` (2 cols) e, em sessão RENOMEADA
 * (`/rename`), a tag `● <nome> ` ANTES dele (EST-0972) — e o Ink guarda as linhas
 * seguintes na MESMA banda de colunas do texto. Medir o wrap com `columns - 2` fixo
 * SUBESTIMA a altura visual quando há tag (um nome de ~20 chars come ~23 colunas):
 * o frame passa de `rows`, o Ink cai no `clearTerminal` (que não reseta o
 * `previousLineCount`) e o GAP entre o transcript e o composer CRESCE a cada tecla.
 * Esta é a ÚNICA fonte do indent — App (orçamento `composerVisualLines`) e
 * <Composer> (janela `effCols`) usam a MESMA conta p/ nunca divergirem. PURO.
 */
export function composerIndentCols(sessionLabel?: string): number {
  const label = (sessionLabel ?? '').trim();
  // prompt `›` + espaço = 2; tag `● <nome> ` = glifo(1) + espaço(1) + nome + espaço(1).
  return 2 + (label === '' ? 0 : displayWidth(label) + 3);
}

/**
 * JANELA DE CAUDA por linhas VISUAIS (com WRAP). Devolve o SUFIXO de linhas-fonte de
 * `text` cuja altura visual (em `columns` colunas) cabe em `maxLines` linhas visuais,
 * e `hidden` = quantas linhas-FONTE ficaram acima (o que o marcador `…N acima`
 * mostra). É o coração do anti-flicker de WRAP, COMPARTILHADO por <AluyBlock> (prévia
 * de fala), <ToolLine> e <BangBlock> (saída ao vivo) — todos janelavam por linhas-
 * fonte, o que subestimava a altura real quando as linhas eram largas.
 *
 *   • `maxLines` ausente/≤0 ⇒ texto inteiro, `hidden: 0` (sem teto).
 *   • cabe inteiro (medido VISUALMENTE) ⇒ texto inteiro, `hidden: 0`.
 *   • `columns ≤ 0` (largura desconhecida) ⇒ janela por linhas-FONTE (degradação
 *     graciosa — nunca pior que o comportamento antigo).
 *   • a ÚLTIMA linha-fonte é SEMPRE incluída (garante progresso). Mas se essa linha
 *     SOZINHA já estoura o teto VISUAL (uma única linha GIGANTE sem `\n` — minified
 *     JS, JSON numa linha só, log de MB), ela é CORTADA na CAUDA p/ caber em `maxLines`
 *     linhas visuais, com um `…` no início marcando o corte (ver FIX abaixo).
 *
 * PURO.
 */
export function windowTailVisual(
  text: string,
  maxLines: number | undefined,
  columns: number,
): { text: string; hidden: number } {
  if (!maxLines || maxLines <= 0) return { text, hidden: 0 };
  const lines = text.split('\n');
  if (visualLines(text, columns) <= maxLines) return { text, hidden: 0 };
  let used = 0;
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const h = visualLines(lines[i]!, columns);
    // A última (i === lines.length-1) entra sempre; depois, só se ainda couber.
    if (i < lines.length - 1 && used + h > maxLines) break;
    used += h;
    start = i;
  }
  // FIX (HUNT-RENDER, linha única gigante): a 1ª linha-fonte mantida (`lines[start]`)
  // é a mais alta da janela; se ela SOZINHA passa do teto VISUAL — uma só linha sem
  // `\n` mais larga que `maxLines × columns` (minified JS/JSON/log de MB) — ela seria
  // PINTADA INTEIRA. O orçamento da região viva (live-budget) só reservou `maxLines+1`,
  // mas o Ink re-flui a linha gigante em CENTENAS/MILHARES de linhas visuais a cada
  // frame ⇒ estoura `rows` (full-frame clear/redraw = flicker) e inunda o render. Aqui
  // CORTAMOS essa linha na CAUDA (mantém o conteúdo mais NOVO, à direita) p/ caber em
  // `maxLines` visuais. Só com `columns>0` (largura conhecida); senão degrada (antigo).
  if (start < lines.length && columns > 0) {
    const headLine = lines[start]!;
    if (visualLines(headLine, columns) > maxLines) {
      lines[start] = clampLineToVisualTail(headLine, maxLines, columns);
    }
  }
  if (start <= 0) {
    // Sem linhas-fonte ACIMA, mas a linha pode ter sido cortada na largura ⇒ devolve
    // o (possivelmente) cortado, hidden 0 (o corte é largura, não linhas-fonte).
    return { text: lines.join('\n'), hidden: 0 };
  }
  return { text: lines.slice(start).join('\n'), hidden: start };
}

/**
 * FIX (HUNT-RENDER) — corta UMA linha-fonte (sem `\n`) p/ sua CAUDA caber em `maxLines`
 * linhas VISUAIS quando renderizada em `columns` colunas. Mantém os caracteres FINAIS
 * (conteúdo mais novo de um stream) e põe `…` (1 col) no início marcando o corte. O
 * orçamento de colunas da cauda é `maxLines × columns − 1` (o `…` ocupa 1 col).
 *
 * Itera por CODE POINT de trás p/ frente (não parte surrogate; CJK/emoji = 2 cols).
 * `maxLines`/`columns` ≤ 0 ⇒ devolve a linha intacta (degradação graciosa). PURO.
 */
function clampLineToVisualTail(line: string, maxLines: number, columns: number): string {
  if (maxLines <= 0 || columns <= 0) return line;
  // Reserva 1 col p/ o `…`; o resto é o orçamento de largura da cauda mantida.
  const budget = maxLines * columns - 1;
  if (budget <= 0) return '…';
  const chars = Array.from(line); // por code point (não parte par surrogate)
  let used = 0;
  let keptFrom = chars.length;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = displayWidth(chars[i]!);
    if (used + w > budget) break;
    used += w;
    keptFrom = i;
  }
  return '…' + chars.slice(keptFrom).join('');
}

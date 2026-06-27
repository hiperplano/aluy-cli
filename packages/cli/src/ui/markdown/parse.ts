// EST · acabamento TUI — PARSER de markdown da fala do agente. PURO (string →
// AST), sem React/ANSI/I/O — 100% testável. Subconjunto deliberado (o que o
// assistente realmente emite): títulos `#`, citações `>`, listas `-`/`1.`,
// cercas ```lang, e inline **negrito** / *itálico* / `código` / [texto](url).
//
// Filosofia anti-peso: NÃO trazemos `marked` (parser HTML-completo) p/ um alvo
// terminal — emojis de spec e HTML cru não fazem sentido na TUI e custariam
// superfície/risco. Um tokenizer enxuto cobre o caso real e mantém o mapeamento
// DS→estilo 100% sob nosso controle.
//
// EST-0965 — TABELAS GFM: o agente usa tabela o tempo TODO (listagens, comparações)
// e antes saíam como texto cru (`| Tipo | Nome | --- |`) que quebrava feio. Agora o
// tokenizer reconhece o bloco de tabela GFM (linha de header + separador
// `|---|:--:|--:|` + N linhas de corpo) e o <TableBlock> renderiza ALINHADO,
// cabendo no terminal. O render mora aqui no markdown/ (não em `marked`): controle
// total do DS→estilo e do orçamento de altura (linhas visuais, anti-flicker).
//
// STREAMING: o parse roda sobre o TEXTO ACUMULADO do turno a cada frame (não
// token-a-token). Uma cerca ``` ABERTA mas ainda não fechada (stream no meio de
// um bloco de código) é tratada como bloco de código em aberto — realça o que já
// veio, sem "vazar" markdown inline pra dentro do código (CA: não quebra o stream).

export interface InlineBold {
  readonly kind: 'bold';
  readonly text: string;
}
export interface InlineItalic {
  readonly kind: 'italic';
  readonly text: string;
}
export interface InlineCode {
  readonly kind: 'code';
  readonly text: string;
}
export interface InlineLink {
  readonly kind: 'link';
  readonly text: string;
  readonly url: string;
}
export interface InlinePlain {
  readonly kind: 'plain';
  readonly text: string;
}
export type Inline = InlineBold | InlineItalic | InlineCode | InlineLink | InlinePlain;

export interface ParagraphBlock {
  readonly kind: 'paragraph';
  readonly spans: readonly Inline[];
}
export interface HeadingBlock {
  readonly kind: 'heading';
  readonly level: number; // 1..6
  readonly spans: readonly Inline[];
}
export interface QuoteBlock {
  readonly kind: 'quote';
  readonly spans: readonly Inline[];
}
export interface ListItemBlock {
  readonly kind: 'list-item';
  readonly ordered: boolean;
  readonly marker: string; // `-` ou `1.` (preservado p/ ordenadas)
  readonly indent: number; // nível de aninhamento (espaços/2)
  readonly spans: readonly Inline[];
}
export interface CodeBlockBlock {
  readonly kind: 'code';
  readonly lang: string | undefined;
  readonly code: string;
  readonly closed: boolean; // false = cerca ainda aberta (stream no meio)
}
/** Alinhamento de coluna de tabela (GFM `:---`, `:--:`, `--:`, ou `---`=left). */
export type TableAlign = 'left' | 'center' | 'right';
export interface TableBlockNode {
  readonly kind: 'table';
  readonly header: readonly string[]; // células do cabeçalho (texto cru, c/ inline)
  readonly align: readonly TableAlign[]; // alinhamento por coluna (mesmo nº de colunas)
  readonly rows: readonly (readonly string[])[]; // linhas de corpo (texto cru por célula)
}
export type MdBlock =
  | ParagraphBlock
  | HeadingBlock
  | QuoteBlock
  | ListItemBlock
  | CodeBlockBlock
  | TableBlockNode;

// ── INLINE ───────────────────────────────────────────────────────────────────

// EST-1015 (fix ênfase intraword) — o `_`/`__` (underscore) NÃO pode ser ênfase NO MEIO
// de uma palavra (regra do CommonMark): `some_variable_name`/`get_user_by_id` (snake_case
// comum em prosa técnica do modelo) viravam "…_variable_…" em ITÁLICO espúrio. O fix exige
// BORDA: o `_`/`__` de abertura não pode ser precedido — nem o de fechamento seguido — por
// letra/número/`_` (lookbehind/lookahead `(?<![\p{L}\p{N}_])`…`(?![\p{L}\p{N}_])`, flag `u`).
// O `*`/`**` (asterisco) PERMANECE permitindo intraword (`2*3*4` → `*3*`), pois o CommonMark
// permite ênfase com `*` dentro de palavra. Underscore dentro de `` `código` ``/link é
// preservado (essas alternativas casam ANTES). Sem o `g`: `exec` casa sempre do início.
const INLINE_RE =
  // 1: `code`  2: [text](url) text=3 url=4  5: ***bold-italic***/___…___  6: **bold**/__bold__
  // 7: *italic*/_italic_. O grupo 5 (TRIPLO) vem ANTES do 6/7: sem ele, `***x***` casava o
  // `**x**` INTERNO (a regex de bold é `[^*]+`, não aceita `*`), deixando os `*` EXTERNOS como
  // texto solto na tela (`*𝐱*`). Não há tipo bold+itálico ⇒ renderiza como BOLD (consome limpo).
  /(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*\*[^*]+\*\*\*|(?<![\p{L}\p{N}_])___[^_]+___(?![\p{L}\p{N}_]))|(\*\*[^*]+\*\*|(?<![\p{L}\p{N}_])__[^_]+__(?![\p{L}\p{N}_]))|(\*[^*\n]+\*|(?<![\p{L}\p{N}_])_[^_\n]+_(?![\p{L}\p{N}_]))/u;

/** Tokeniza uma linha de texto em spans inline (negrito/itálico/código/link/plano). */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  while (rest.length > 0) {
    const m = INLINE_RE.exec(rest);
    if (!m || m.index === undefined) {
      out.push({ kind: 'plain', text: rest });
      break;
    }
    if (m.index > 0) out.push({ kind: 'plain', text: rest.slice(0, m.index) });
    const tok = m[0];
    if (m[1]) {
      out.push({ kind: 'code', text: tok.slice(1, -1) });
    } else if (m[2]) {
      out.push({ kind: 'link', text: m[3] ?? '', url: m[4] ?? '' });
    } else if (m[5]) {
      // ***x*** / ___x___ — triplo (bold+itálico). Sem tipo combinado ⇒ BOLD (consome os 3
      // delimitadores de cada lado: `tok.slice(3, -3)`), em vez de deixar os `*` externos soltos.
      out.push({ kind: 'bold', text: tok.slice(3, -3) });
    } else if (m[6]) {
      out.push({ kind: 'bold', text: tok.slice(2, -2) });
    } else if (m[7]) {
      out.push({ kind: 'italic', text: tok.slice(1, -1) });
    }
    rest = rest.slice(m.index + tok.length);
  }
  // coalesce planos adjacentes (saída enxuta)
  return out.reduce<Inline[]>((acc, s) => {
    const last = acc[acc.length - 1];
    if (s.kind === 'plain' && last && last.kind === 'plain') {
      acc[acc.length - 1] = { kind: 'plain', text: last.text + s.text };
    } else acc.push(s);
    return acc;
  }, []);
}

// ── BLOCK ──────────────────────────────────────────────────────────────────--

const FENCE_RE = /^(\s*)```(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const ULIST_RE = /^(\s*)([-*+])\s+(.*)$/;
const OLIST_RE = /^(\s*)(\d+)[.)]\s+(.*)$/;

// ── TABELA (GFM) ─────────────────────────────────────────────────────────────
// Tolerante: pipes com/sem espaço, com/sem pipe nas bordas. Uma "linha de tabela"
// é qualquer linha que CONTENHA um pipe (a desambiguação real vem do SEPARADOR —
// só vira tabela se a 2ª linha for `|---|:--:|--:|`). Uma célula de separador é
// `:?-+:?` (um ou mais `-`, com `:` opcional nas pontas p/ alinhamento).
const SEP_CELL_RE = /^:?-+:?$/;

/**
 * Divide uma linha de tabela em células (texto cru, trim). Tolerante a borda: tira
 * UM pipe de cada ponta se houver, depois quebra nos pipes internos. `\|` escapado
 * NÃO divide (vira `|` literal na célula). Sem pipe nenhum ⇒ uma única célula.
 */
function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Quebra nos pipes NÃO escapados; restaura `\|` → `|` em cada célula.
  const cells = s.split(/(?<!\\)\|/);
  return cells.map((c) => c.replace(/\\\|/g, '|').trim());
}

/** A linha contém ao menos um pipe NÃO escapado? (candidata a linha de tabela). */
function looksLikeTableRow(line: string): boolean {
  return /(?<!\\)\|/.test(line);
}

/**
 * Tenta ler a linha-SEPARADORA (`|---|:--:|--:|`). Devolve o alinhamento por coluna
 * ou `null` se não casar (ⓘ toda célula precisa ser `:?-+:?`, e ≥1 célula). É o
 * GATE que distingue tabela de texto solto com pipe — e o que dá o streaming-safe:
 * enquanto o separador não chegou (stream token-a-token), NÃO vira tabela.
 */
function parseSeparator(line: string): TableAlign[] | null {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const align: TableAlign[] = [];
  for (const c of cells) {
    if (!SEP_CELL_RE.test(c)) return null;
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : 'left');
  }
  return align;
}

/**
 * Parseia o texto markdown acumulado num array de blocos. Linhas em branco
 * separam parágrafos. Cercas ``` ligam/desligam o modo código (capturando lang).
 * Uma cerca aberta sem par é emitida como `code` com `closed:false`.
 */
export function parseMarkdown(input: string): MdBlock[] {
  const lines = input.split('\n');
  const blocks: MdBlock[] = [];
  let para: Inline[] | null = null;

  const flushPara = (): void => {
    if (para && para.length > 0) blocks.push({ kind: 'paragraph', spans: para });
    para = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const lang = (fence[2] ?? '').trim() || undefined;
      const codeLines: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const cl = lines[j] ?? '';
        if (/^\s*```\s*$/.test(cl)) {
          closed = true;
          break;
        }
        codeLines.push(cl);
      }
      blocks.push({ kind: 'code', lang, code: codeLines.join('\n'), closed });
      i = closed ? j : lines.length; // consome até a cerca de fecho (ou fim)
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      continue;
    }

    // TABELA (GFM): linha-header com pipe + PRÓXIMA linha é o separador `|---|`.
    // O separador é o GATE — sem ele, a linha cai como parágrafo (texto cru).
    // Isso é o que dá o streaming-safe: uma tabela chegando token-a-token (header
    // sem separador ainda) NÃO renderiza quebrada; só vira tabela quando o
    // separador chega. Linha header SEM pipe nas bordas (`a | b`) também casa.
    if (looksLikeTableRow(line)) {
      const sep = i + 1 < lines.length ? parseSeparator(lines[i + 1] ?? '') : null;
      if (sep) {
        flushPara();
        const header = splitTableRow(line);
        // nº de colunas = o do header; normaliza o alinhamento p/ esse tamanho.
        const cols = header.length;
        const align: TableAlign[] = [];
        for (let c = 0; c < cols; c++) align.push(sep[c] ?? 'left');
        // corpo: linhas seguintes que ainda contenham pipe / sejam de tabela.
        const rows: string[][] = [];
        let j = i + 2;
        for (; j < lines.length; j++) {
          const bl = lines[j] ?? '';
          if (bl.trim() === '' || !looksLikeTableRow(bl)) break;
          const cells = splitTableRow(bl);
          // normaliza p/ o nº de colunas do header (faltando ⇒ vazio; sobrando ⇒ corta).
          const norm: string[] = [];
          for (let c = 0; c < cols; c++) norm.push(cells[c] ?? '');
          rows.push(norm);
        }
        blocks.push({ kind: 'table', header, align, rows });
        i = j - 1; // consome header + separador + corpo (o for incrementa).
        continue;
      }
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushPara();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length,
        spans: parseInline(heading[2] ?? ''),
      });
      continue;
    }

    const ul = ULIST_RE.exec(line);
    if (ul) {
      flushPara();
      blocks.push({
        kind: 'list-item',
        ordered: false,
        marker: '-',
        indent: Math.floor((ul[1] ?? '').length / 2),
        spans: parseInline(ul[3] ?? ''),
      });
      continue;
    }

    const ol = OLIST_RE.exec(line);
    if (ol) {
      flushPara();
      blocks.push({
        kind: 'list-item',
        ordered: true,
        marker: `${ol[2]}.`,
        indent: Math.floor((ol[1] ?? '').length / 2),
        spans: parseInline(ol[3] ?? ''),
      });
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      flushPara();
      blocks.push({ kind: 'quote', spans: parseInline(quote[1] ?? '') });
      continue;
    }

    // parágrafo: acumula linhas contíguas (junta com espaço, estilo markdown).
    const spans = parseInline(line);
    para = para ? [...para, { kind: 'plain', text: ' ' }, ...spans] : spans;
  }
  flushPara();
  return blocks;
}

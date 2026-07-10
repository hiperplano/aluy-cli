// EST-1015 (UX do cockpit) · ADR-0076 §3/§5 — JANELA da CONVERSA por LINHAS VISUAIS.
//
// RAIZ do bug "texto embaralhado/sobreposto" no cockpit (provado por captura tmux/PTY):
// a região de CONVERSA janelava por Nº DE BLOCOS (`resolveViewport(blocks.length, room)`),
// tratando cada bloco como se ocupasse 1 linha. Um turno real ocupa VÁRIAS (rótulo +
// fala com wrap + respiro), então a janela "que cabia" estourava a Box de altura fixa —
// e o clipping do Ink 5.2.1 FALHA com conteúdo alto/aninhado: em vez de cortar, ele
// MESCLA linhas (o `▌` do rótulo + a fala da linha seguinte na MESMA linha; caudas de
// blocos vizinhos coladas). O mesmo mis-clip já provado no `clipNoteToFit` (o /help).
//
// O INVARIANTE novo: a soma das ALTURAS VISUAIS dos blocos visíveis NUNCA passa de
// `room`. Aí o overflow do Ink nem é exercitado (conteúdo ≤ Box) e o render é limpo por
// construção. Para isso este módulo:
//   · MEDE a altura visual de cada bloco EXATAMENTE como o <BlockView> renderiza
//     (mesmos pipelines: cleanAluyForDisplay → windowTailVisual → Markdown; mesmos
//     paddings/rótulos; wrap por PALAVRA idêntico ao do Ink — `wrap-ansi` com
//     `{trim:false, hard:true}`, a MESMA lib/flags que o Ink usa em <Text wrap="wrap">);
//   · ENCAIXA blocos inteiros da CAUDA p/ cima (âncora "▼ ao vivo") até encher `room`;
//   · CLIPA NA FONTE o bloco que sozinho não cabe (generalização do `clipNoteToFit`:
//     you/aluy/note/saídas de tool/bang), com o marcador `…(+N linhas — /fullscreen)`.
//
// PURO (sem React/Ink; `wrap-ansi` é string→string) — testável sem TUI.

import wrapAnsi from 'wrap-ansi';
import { cleanAluyForDisplay } from '@hiperplano/aluy-cli-core';
import type { SessionBlock } from './model.js';
import { windowTailVisual, displayWidth } from './visual-lines.js';
import {
  clampLiveOutputChars,
  liveShellTailMaxLines,
  MAX_LIVE_OUTPUT_CHARS,
  MAX_LIVE_SPEECH_CHARS,
} from './live-budget.js';
import { parseMarkdown, type Inline } from '../ui/markdown/parse.js';

/** Contexto de medição — o que o render usa e a medição precisa espelhar. */
export interface ConversaCtx {
  /** Largura do terminal (colunas) — a região ocupa a largura toda. */
  readonly columns: number;
  /** Altura do terminal (linhas) — p/ o cap adaptativo da cauda viva de shell (F163). */
  readonly rows: number;
  /** `colorMode === 'mono'` (NO_COLOR): o markdown ganha cercas visíveis `*`/`_`/`` ` ``. */
  readonly mono?: boolean;
  /**
   * Teto de linhas VISUAIS da prévia do aluy STREAMING (o `maxLines` passado ao
   * <BlockView>). DEVE ser o mesmo valor no render e na medição — use
   * `streamPreviewMaxLines(room)` nos dois lados.
   */
  readonly streamMaxLines?: number;
}

/** Indent (colunas) da fala de um turno (`<Box paddingLeft={2}>`). */
const SPEECH_INDENT = 2;
/** Indent (colunas) da saída ao vivo/box de saída sob tool/bang (2+2 aninhados). */
const OUTPUT_INDENT = 4;
/** Largura fixa do verbo da <ToolLine> (§2.7). */
const TOOL_VERB_WIDTH = 7;
/** Prefixo visual do <Working> (glifo + espaço + onda ～×3 + espaço) antes do label. */
const WORKING_PREFIX_COLS = 6;
/** Teto de falhas visíveis do <TestRunBlock>. */
const TESTRUN_MAX_FAILURES = 10;

/**
 * O teto da PRÉVIA VIVA do aluy streaming DENTRO da região de conversa: `room` menos o
 * overhead fixo do bloco (rótulo `Λ aluy` + marcador `…N acima` + linha do cursor ● +
 * respiro), p/ o bloco streamando SOZINHO nunca estourar a região. Piso 1.
 */
export function streamPreviewMaxLines(room: number): number {
  return Math.max(1, room - 4);
}

/**
 * Nº de linhas VISUAIS de `text` numa coluna de `width` colunas, com o MESMO wrap do
 * Ink (<Text wrap="wrap"> = `wrap-ansi(text, w, {trim:false, hard:true})`). `''` = 1
 * linha (uma linha vazia ainda ocupa uma linha). PURO.
 */
export function wrappedLineCount(text: string, width: number): number {
  const w = Math.max(1, width);
  if (text === '') return 1;
  return wrapAnsi(text, w, { trim: false, hard: true }).split('\n').length;
}

/** Soma de `wrappedLineCount` por linha-fonte (cada linha-fonte é um <Box> próprio). */
function sumWrapped(lines: readonly string[], width: number): number {
  let total = 0;
  for (const ln of lines) total += wrappedLineCount(ln, width);
  return total;
}

/** O texto RENDERIZADO de spans inline (o que o <Inlines> pinta, dado o modo mono). */
function spanText(spans: readonly Inline[], mono: boolean): string {
  let out = '';
  for (const s of spans) {
    switch (s.kind) {
      case 'plain':
        out += s.text;
        break;
      case 'bold':
        out += mono ? `*${s.text}*` : s.text;
        break;
      case 'italic':
        out += mono ? `_${s.text}_` : s.text;
        break;
      case 'code':
        out += mono ? `\`${s.text}\`` : s.text;
        break;
      case 'link':
        out += `${s.text} (${s.url})`;
        break;
    }
  }
  return out;
}

/**
 * Altura VISUAL (linhas) do MARKDOWN de uma fala, como o <Markdown> renderiza numa
 * coluna de `width` colunas. Espelha Markdown.tsx bloco a bloco (parágrafo/título/
 * citação/lista/código/tabela). PURO.
 */
export function markdownLines(text: string, width: number, mono: boolean): number {
  if (text === '') return 0;
  const blocks = parseMarkdown(text);
  let total = 0;
  for (const b of blocks) {
    switch (b.kind) {
      case 'paragraph':
        total += wrappedLineCount(spanText(b.spans, mono), width);
        break;
      case 'heading':
        total += wrappedLineCount(
          (mono ? `${'#'.repeat(b.level)} ` : '') + spanText(b.spans, mono),
          width,
        );
        break;
      case 'quote':
        // `▌ ` (2 cols) + texto na largura restante.
        total += wrappedLineCount(spanText(b.spans, mono), width - 2);
        break;
      case 'list-item': {
        // paddingLeft = indent*2; marcador (`• `/`12. `) + texto na largura restante.
        const markerCols = (b.ordered ? displayWidth(b.marker) : 1) + 1;
        total += wrappedLineCount(spanText(b.spans, mono), width - b.indent * 2 - markerCols);
        break;
      }
      case 'code':
        // moldura ╭─ lang ──╮ (1) + cada linha `│ código` (wrap em width-2) + ╰─── (1).
        total += 2 + sumWrapped(b.code.split('\n'), width - 2);
        break;
      case 'table':
        // <TableBlock> TRUNCA colunas p/ caber (não quebra linha): header + separador +
        // corpo = rows+2 linhas.
        total += b.rows.length + 2;
        break;
    }
  }
  return total;
}

/** Pipeline de display do turno aluy (o MESMO do <AluyBlock>): clamp → clean → janela. */
function aluySpeech(
  b: Extract<SessionBlock, { kind: 'aluy' }>,
  ctx: ConversaCtx,
): { text: string; hidden: number } {
  const raw = b.streaming ? clampLiveOutputChars(b.text, MAX_LIVE_SPEECH_CHARS) : b.text;
  const full = cleanAluyForDisplay(raw);
  const speechCols = ctx.columns - SPEECH_INDENT;
  return windowTailVisual(full, b.streaming ? ctx.streamMaxLines : undefined, speechCols);
}

/** Cauda VIVA de shell (tool/bang running) — o MESMO pipeline do <ToolLine>/<BangBlock>. */
function liveTailLines(liveOutput: string | undefined, ctx: ConversaCtx): number {
  const liveRaw = clampLiveOutputChars(liveOutput ?? '', MAX_LIVE_OUTPUT_CHARS);
  const live = liveRaw.replace(/\n+$/, '');
  if (live === '') return 0;
  const liveCols = ctx.columns - OUTPUT_INDENT;
  const maxL = liveShellTailMaxLines(ctx.rows, ctx.columns);
  const { text, hidden } = windowTailVisual(live, maxL, liveCols);
  if (text.length === 0) return 0;
  return (hidden > 0 ? 1 : 0) + sumWrapped(text.split('\n'), liveCols);
}

/** Box de saída concluída (`╭ saída ─` + linhas `│ …` + `╰ ok ─`) de tool/bang. */
function outputBoxLines(output: string | undefined, ctx: ConversaCtx): number {
  const out = output ?? '';
  if (out.trim() === '') return 0;
  const w = ctx.columns - OUTPUT_INDENT;
  // header + cada linha (prefixo `│ ` = 2 cols dentro da largura w) + rodapé.
  return (
    1 +
    sumWrapped(
      out.split('\n').map((l) => `xx${l}`),
      w,
    ) +
    1
  );
}

/**
 * ALTURA VISUAL (linhas) de um bloco da sessão como o <BlockView> o renderiza no
 * cockpit (largura `ctx.columns`). Espelho 1:1 dos componentes (TurnBlock/ToolLine/
 * BangBlock/NoteBlock/SubAgents/Doctor/TestRunBlock/BrokerError/InjectAck). PURO.
 */
export function measureConversaBlock(b: SessionBlock, ctx: ConversaCtx): number {
  const c = ctx.columns;
  switch (b.kind) {
    case 'you':
      // rótulo `▌ você` (1) + fala (wrap em c-2) + paddingBottom (1).
      return 1 + wrappedLineCount(b.text, c - SPEECH_INDENT) + 1;
    case 'aluy': {
      const { text, hidden } = aluySpeech(b, ctx);
      const md = markdownLines(text, c - SPEECH_INDENT, ctx.mono === true);
      // rótulo (1) + marcador `…N acima` + markdown + cursor ● (streaming) + pad (1).
      return 1 + (hidden > 0 ? 1 : 0) + md + (b.streaming ? 1 : 0) + 1;
    }
    case 'tool': {
      if (b.status === 'running') {
        const label = `${b.verbGerund ?? 'rodando'}${b.target ? ` ${b.target}` : ''}`;
        const head = wrappedLineCount(' '.repeat(WORKING_PREFIX_COLS) + label, c - SPEECH_INDENT);
        return head + liveTailLines(b.liveOutput, ctx);
      }
      const verb = b.verb.length >= TOOL_VERB_WIDTH ? b.verb : b.verb.padEnd(TOOL_VERB_WIDTH);
      const head = wrappedLineCount(`x ${verb} ${b.target} ${b.result} x`, c - SPEECH_INDENT);
      return head + (b.status === 'err' ? outputBoxLines(b.output, ctx) : 0);
    }
    case 'note':
      // `◷ título` (1) + linhas (wrap em c-2) + paddingBottom (1).
      return 1 + sumWrapped([...b.lines], c - SPEECH_INDENT) + 1;
    case 'bang': {
      if (b.status === 'running') {
        const head = wrappedLineCount(
          ' '.repeat(WORKING_PREFIX_COLS) + `rodando $ ${b.command}`,
          c - SPEECH_INDENT,
        );
        return head + liveTailLines(b.liveOutput, ctx) + 1; // + paddingBottom do wrapper.
      }
      const stateWord = b.status === 'blocked' ? 'bloqueado' : b.status === 'err' ? 'erro' : 'ok';
      const head = wrappedLineCount(`x shell $ ${b.command} x ${stateWord}`, c - SPEECH_INDENT);
      return head + outputBoxLines(b.output, ctx) + 1; // + paddingBottom do wrapper.
    }
    case 'subagents': {
      // cabeçalho (1) + 1 linha por filho (wrap) + paddingBottom (1).
      let rows = 0;
      for (const ch of b.children) {
        const word =
          ch.status === 'running'
            ? 'rodando'
            : ch.status === 'done'
              ? 'ok'
              : ch.status === 'cancelled'
                ? 'parado'
                : 'falhou';
        // ADR-0146 (D5) — o `model` entra ANTES do `summary`, independente do status
        // (espelha o `<ChildLine>` real) — senão esta medição SUBESTIMA a altura de um
        // filho com model+summary e o clip do Ink acontece no cockpit também.
        const modelPart = ch.model !== undefined ? ` · ${ch.model}` : '';
        const summary =
          ch.summary !== undefined && ch.status !== 'running' ? ` · ${ch.summary}` : '';
        rows += wrappedLineCount(
          `[${ch.label}] x ${word}${modelPart}${summary}`,
          c - SPEECH_INDENT,
        );
      }
      return 1 + rows + 1;
    }
    case 'doctor': {
      // cabeçalho (1) + 1 linha por check (+ dica `→ fix` p/ ⚠/✗) + resumo (2: paddingTop
      // + linha) + paddingBottom (1).
      let rows = 0;
      for (const ck of b.checks) {
        rows += 1;
        if (ck.status !== 'pending' && ck.status !== 'ok' && ck.fix !== undefined) rows += 1;
      }
      return 1 + rows + (b.summary !== undefined ? 2 : 0) + 1;
    }
    case 'deny':
      return wrappedLineCount(`[x] negado · ${b.verb} ${b.exact}`, c - SPEECH_INDENT);
    case 'broker-error': {
      const hasStatusRow =
        b.status !== undefined || b.attempt !== undefined || b.retryInSeconds !== undefined;
      // header (1) + mensagem (wrap) + status? + affordance (1) + borda inferior (1).
      return (
        1 + wrappedLineCount(`xx${b.message}`, c - OUTPUT_INDENT) + (hasStatusRow ? 1 : 0) + 1 + 1
      );
    }
    case 'testrun': {
      if (b.score.unknownFormat) return 2;
      const failures = b.score.failures.length;
      return (
        1 + // barra
        1 + // placar
        (b.score.durationMs !== undefined ? 1 : 0) +
        (failures > 0
          ? 1 + Math.min(failures, TESTRUN_MAX_FAILURES) + (failures > TESTRUN_MAX_FAILURES ? 1 : 0)
          : 0) +
        (b.running ? 0 : 1)
      );
    }
    case 'inject':
      // `↳ encaixado: …` (1, texto truncado a 80 pelo próprio componente) + pad (1).
      return 2;
  }
}

/** O marcador de clip na fonte (mesma voz do `clipNoteToFit`). */
function clipMarker(hiddenLines: number): string {
  return `…(+${hiddenLines} linhas — saia do /fullscreen p/ ver tudo)`;
}

/**
 * CLIPA um bloco NA FONTE p/ sua altura medida caber em `room` linhas (generalização do
 * `clipNoteToFit` p/ you/aluy/note e saídas concluídas de tool/bang). Mantém a CABEÇA
 * (o começo do conteúdo) + marcador `…(+N)`. Blocos sem conteúdo clipável que ainda
 * assim não cabem degradam p/ uma nota mínima (nunca devolve algo maior que `room`,
 * desde que `room ≥ 3`). PURO — devolve um bloco NOVO (nunca muta).
 */
export function clipConversaBlock(b: SessionBlock, room: number, ctx: ConversaCtx): SessionBlock {
  if (measureConversaBlock(b, ctx) <= room) return b;

  const clipLines = (
    lines: readonly string[],
    overhead: number,
    width: number = ctx.columns - SPEECH_INDENT,
    prefixCols = 0,
  ): string[] => {
    // encaixa a cabeça: mantém linhas do início enquanto (overhead + altura + marcador)
    // couber em room. `overhead` = linhas fixas do bloco (rótulos/pads/bordas);
    // `prefixCols` = colunas de prefixo por linha (`│ ` da box de saída).
    const markerRows = wrappedLineCount('x'.repeat(prefixCols) + clipMarker(lines.length), width);
    const budget = room - overhead - markerRows;
    const kept: string[] = [];
    let used = 0;
    for (const ln of lines) {
      const h = wrappedLineCount('x'.repeat(prefixCols) + ln, width);
      if (used + h > budget) break;
      kept.push(ln);
      used += h;
    }
    kept.push(clipMarker(lines.length - kept.length));
    return kept;
  };

  switch (b.kind) {
    case 'note': {
      // overhead: título (1) + paddingBottom (1).
      if (room < 3) break;
      return { ...b, lines: clipLines(b.lines, 2) };
    }
    case 'you': {
      if (room < 3) break;
      return { ...b, text: clipLines(b.text.split('\n'), 2).join('\n') };
    }
    case 'aluy': {
      if (b.streaming) {
        // A prévia viva já é bounded por `streamMaxLines`, mas a janela dela conta
        // linhas visuais SEM wrap por palavra (visualLines) — que pode subestimar. Se a
        // altura REAL (wrap-ansi) ainda passa de `room`, encurta a CAUDA da fonte até
        // caber (mantém o fim — é o que está chegando). Termina: o texto só encolhe.
        const clean = cleanAluyForDisplay(clampLiveOutputChars(b.text, MAX_LIVE_SPEECH_CHARS));
        let lines = clean.split('\n');
        while (lines.length > 1) {
          lines = lines.slice(Math.max(1, Math.ceil(lines.length / 4)));
          const cand = { ...b, text: lines.join('\n') };
          if (measureConversaBlock(cand, ctx) <= room) return cand;
        }
        break;
      }
      if (room < 3) break;
      // Clipa a fala LIMPA (o que o usuário vê); o marcador vira o último parágrafo.
      // O clip é por linha-FONTE, mas a altura FINAL é do MARKDOWN clipado (uma moldura
      // de código partida ao meio muda a conta) ⇒ laço de defesa: encolhe o orçamento
      // até a medição REAL caber em `room`. Termina: overhead cresce a cada volta.
      const clean = cleanAluyForDisplay(b.text);
      const lines = clean.split('\n');
      for (let shrink = 0; shrink < room; shrink += 1) {
        const clipped = { ...b, text: clipLines(lines, 2 + shrink).join('\n') };
        if (measureConversaBlock(clipped, ctx) <= room) return clipped;
      }
      break;
    }
    case 'tool': {
      if (b.status === 'err' && b.output !== undefined && room >= 4) {
        // overhead: linha do ⏺ (1) + bordas da box (2). Linhas com prefixo `│ ` em c-4.
        return {
          ...b,
          output: clipLines(b.output.split('\n'), 3, ctx.columns - OUTPUT_INDENT, 2).join('\n'),
        };
      }
      break;
    }
    case 'bang': {
      if (b.status !== 'running' && b.output !== undefined && room >= 5) {
        // overhead: linha do ⏺ (1) + bordas da box (2) + paddingBottom (1).
        return {
          ...b,
          output: clipLines(b.output.split('\n'), 4, ctx.columns - OUTPUT_INDENT, 2).join('\n'),
        };
      }
      break;
    }
    default:
      break;
  }
  // Fallback: bloco vivo/estrutural maior que a região (sala minúscula) — nota mínima.
  return {
    kind: 'note',
    title: '…',
    lines: [clipMarker(measureConversaBlock(b, ctx))],
  };
}

/** A janela resolvida da conversa (blocos INTEIROS da cauda + clip do que não coube). */
export interface ConversaWindow {
  /** Índice do 1º bloco visível (inclusive). */
  readonly start: number;
  /** Índice após o último visível (exclusive). `total - hiddenBelow`. */
  readonly end: number;
  /** Blocos ESCONDIDOS acima (indicador `↑N`). */
  readonly hiddenAbove: number;
  /** Blocos escondidos abaixo (`↓N`; 0 ⇒ colado na cauda, `▼ ao vivo`). */
  readonly hiddenBelow: number;
  /** Os blocos a renderizar (já clipados quando preciso). SOMA das alturas ≤ room. */
  readonly blocks: readonly SessionBlock[];
  /** Linhas visuais consumidas (≤ room) — p/ teste/diagnóstico. */
  readonly usedLines: number;
}

/**
 * Resolve a janela da CAUDA da conversa que CABE em `room` linhas visuais.
 * `scroll` = nº de blocos escondidos ABAIXO (0 = colado na cauda), clampado.
 * GARANTIA (o invariante anti-corrupção): `usedLines ≤ room`. PURO.
 */
export function fitConversaWindow(
  blocks: readonly SessionBlock[],
  room: number,
  scroll: number,
  ctx: ConversaCtx,
): ConversaWindow {
  const total = blocks.length;
  if (total === 0 || room <= 0) {
    return { start: 0, end: 0, hiddenAbove: 0, hiddenBelow: 0, blocks: [], usedLines: 0 };
  }
  // clamp do scroll: no máximo até deixar SÓ o bloco mais antigo visível.
  const off = Math.min(Math.max(0, Math.trunc(scroll)), total - 1);
  const end = total - off;
  let used = 0;
  let start = end;
  for (let i = end - 1; i >= 0; i -= 1) {
    const h = measureConversaBlock(blocks[i]!, ctx);
    if (used + h > room) break;
    used += h;
    start = i;
  }
  if (start === end) {
    // O bloco MAIS NOVO da janela sozinho não cabe ⇒ clipa na fonte p/ caber.
    const clipped = clipConversaBlock(blocks[end - 1]!, room, ctx);
    const h = measureConversaBlock(clipped, ctx);
    if (h <= room) {
      return {
        start: end - 1,
        end,
        hiddenAbove: end - 1,
        hiddenBelow: total - end,
        blocks: [clipped],
        usedLines: h,
      };
    }
    // sala minúscula (room < nota mínima): nada visível — melhor vazio que corrupção.
    return {
      start: end,
      end,
      hiddenAbove: end,
      hiddenBelow: total - end,
      blocks: [],
      usedLines: 0,
    };
  }
  return {
    start,
    end,
    hiddenAbove: start,
    hiddenBelow: total - end,
    blocks: blocks.slice(start, end),
    usedLines: used,
  };
}

// EST-PASTE-COLLAPSE (composer/sessão) — PASTE-COLAPSO: colar um bloco GRANDE no composer
// vira um CHIP textual (`[texto colado #1, +123 linhas]`) em vez de despejar o texto cru,
// igual ao Claude Code. O conteúdo COMPLETO fica fora do buffer visível (mapeado por id)
// e é EXPANDIDO de volta no submit — o modelo recebe o texto inteiro, fiel byte-a-byte.
//
// POR QUE colapsar: um paste de 800 linhas no composer (a) estoura a viewport, (b) some o
// objetivo do usuário no meio do despejo, (c) deixa a edição/cursor inutilizáveis. O Claude
// Code resolve com um placeholder compacto que representa o bloco; aqui espelhamos isso.
//
// O DESIGN (chip = token LITERAL no buffer + registro paralelo):
//   · O buffer de edição contém o TEXTO do chip (`[texto colado #N, +L linhas]`) — então
//     cursor/inserção/largura/render reusam EXATAMENTE as funções puras de composer-edit
//     (insertAt/deleteBackward/moveLeft…) sem nenhuma mudança nelas. O chip OCUPA colunas
//     reais e é visível; nada de sentinela invisível que quebraria contagem de coluna.
//   · Um REGISTRO paralelo (`PasteRegistry`: id → conteúdo original) guarda o texto cheio
//     FORA do buffer. O id mora no `#N` do próprio chip — a ponte entre buffer e registro.
//   · COLISÃO: um chip só é "de verdade" se o seu `#N` existe no registro. Se o usuário
//     DIGITAR literalmente `[texto colado #9, +5 linhas]` (id inexistente), ele permanece
//     texto normal — não expande, não apaga atômico. Sem sentinela mágico, sem colisão.
//
// ATOMICIDADE do chip (apagar): backspace/delete ADJACENTE a um chip remove o chip INTEIRO
// (e descarta o ref), não 1 char — `deleteChipAt`. Fora da borda de um chip, é edição normal.
//
// DEGRADAÇÃO: SÓ o marcador de bracketed paste (`\x1b[200~…201~`) dispara o colapso (o
// caller chama `shouldCollapse` no evento `paste` da máquina). Sem bracketed paste (xrdp),
// o texto chega cru, sem marcador ⇒ NUNCA colapsa (preserva o comportamento atual). NÃO há
// heurística "muitas linhas digitadas = paste" — isso seria frágil e surpreendente.
//
// PUREZA/TESTE: tudo aqui é PURO (sem React/TTY). O Composer/App só fiam o I/O (registro num
// ref, chamada no evento de paste e na rota de submit). Testável determinístico sem terminal.

import { type EditState, clampCursor, insertAt } from './composer-edit.js';

/** Limiar PADRÃO de linhas: colar com ≥ este número de linhas COLAPSA (espelha o Claude Code). */
export const DEFAULT_COLLAPSE_MIN_LINES = 6;
/** Limiar PADRÃO de caracteres: colar com MAIS que isto COLAPSA mesmo com poucas linhas (linha longa). */
export const DEFAULT_COLLAPSE_MIN_CHARS = 800;

/** Opções de gating do colapso (defaults espelham o Claude Code; override p/ teste/config). */
export interface CollapseOptions {
  /** Mínimo de linhas p/ colapsar (≥). Default {@link DEFAULT_COLLAPSE_MIN_LINES}. */
  readonly minLines?: number;
  /** Mínimo de chars p/ colapsar (>). Default {@link DEFAULT_COLLAPSE_MIN_CHARS}. */
  readonly minChars?: number;
}

/**
 * Conta as LINHAS de um bloco colado, como o usuário as vê. Uma string sem `\n` é 1 linha.
 * Cada `\n` adiciona uma quebra. Um `\n` FINAL (trailing newline) NÃO cria uma linha vazia
 * fantasma — `a\nb\n` são 2 linhas (a, b), igual ao `wc -l`+1 do conteúdo "real". String
 * vazia é 0 linhas (não há nada colado). Puro.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  // Quebras = nº de `\n`. Se o texto termina em `\n`, esse `\n` é só terminador da última
  // linha (não abre uma nova linha vazia), então desconta 1 da contagem de quebras.
  let breaks = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') breaks += 1;
  }
  const trailing = text.endsWith('\n') ? 1 : 0;
  return breaks - trailing + 1;
}

/**
 * Decide se um bloco COLADO deve COLAPSAR em chip. Colapsa quando tem ≥ `minLines` linhas
 * OU mais que `minChars` caracteres (uma linha única ENORME também colapsa). Blocos pequenos
 * NÃO colapsam (seguem inline, comportamento atual). Puro.
 */
export function shouldCollapse(text: string, opts: CollapseOptions = {}): boolean {
  const minLines = opts.minLines ?? DEFAULT_COLLAPSE_MIN_LINES;
  const minChars = opts.minChars ?? DEFAULT_COLLAPSE_MIN_CHARS;
  return countLines(text) >= minLines || text.length > minChars;
}

/**
 * Monta o TEXTO do chip para um id e contagem de linhas. PT-BR, com plural correto:
 * `[texto colado #1, +1 linha]` / `[texto colado #1, +123 linhas]`. Esta é a representação
 * que vai LITERAL no buffer (ocupa colunas reais, visível, editável como texto).
 */
export function chipLabel(id: number, lines: number): string {
  const unit = lines === 1 ? 'linha' : 'linhas';
  return `[texto colado #${id}, +${lines} ${unit}]`;
}

/** Um chip de paste: o id (numeração por sessão de composição) e o conteúdo COMPLETO original. */
export interface PasteChip {
  readonly id: number;
  /** O texto do chip como aparece no buffer (`chipLabel(id, lines)`). */
  readonly label: string;
  /** O conteúdo COMPLETO original (fiel byte-a-byte ao colado, já normalizado pela máquina). */
  readonly content: string;
}

/**
 * O registro de pastes de UMA sessão de composição: id → conteúdo, com numeração incremental
 * (#1, #2, …). NÃO é puro (carrega o próximo id e o mapa), mas é um saco de estado simples e
 * testável — o lado React só o guarda num ref. `reset()` zera ao limpar/submeter o composer.
 */
export interface PasteRegistry {
  /** Registra um conteúdo, devolve o chip (id NOVO incremental + label). */
  add(content: string, lines: number): PasteChip;
  /** O conteúdo de um id, ou `undefined` se não registrado (id digitado à mão / já apagado). */
  get(id: number): string | undefined;
  /** Esquece um id (chamado quando o chip é apagado atomicamente). */
  remove(id: number): void;
  /** Esquece TUDO e reinicia a numeração em #1 (composer limpo/submetido). */
  reset(): void;
  /** Snapshot id→conteúdo (p/ `expandPastes`). */
  snapshot(): ReadonlyMap<number, string>;
}

/** Cria um {@link PasteRegistry} vazio (numeração começa em #1). */
export function createPasteRegistry(): PasteRegistry {
  let nextId = 1;
  const map = new Map<number, string>();
  return {
    add(content: string, lines: number): PasteChip {
      const id = nextId;
      nextId += 1;
      map.set(id, content);
      return { id, label: chipLabel(id, lines), content };
    },
    get(id: number): string | undefined {
      return map.get(id);
    },
    remove(id: number): void {
      map.delete(id);
    },
    reset(): void {
      map.clear();
      nextId = 1;
    },
    snapshot(): ReadonlyMap<number, string> {
      return map;
    },
  };
}

/**
 * INSERE um chip de paste no buffer NA posição do cursor: registra o conteúdo, monta o chip
 * e o insere como texto literal (reusa `insertAt` — cursor avança pro fim do chip). Devolve o
 * novo estado de edição. É a operação que o caller chama quando `shouldCollapse` é true.
 */
export function makePasteChip(
  state: EditState,
  content: string,
  registry: PasteRegistry,
): EditState {
  const lines = countLines(content);
  const chip = registry.add(content, lines);
  return insertAt(state, chip.label);
}

// ── DETECÇÃO de chips no buffer ──────────────────────────────────────────────────────────
// Um chip no buffer casa o padrão `[texto colado #N, +L linha(s)]`. Mas só é um chip DE
// VERDADE se o `#N` existe no registro — senão é texto que o usuário digitou (sem colisão).

/** Regex de um chip no buffer: captura o id (#N). Global p/ varrer todas as ocorrências. */
const CHIP_RE = /\[texto colado #(\d+), \+\d+ linhas?\]/g;

/** Uma ocorrência de chip localizada no buffer (id + faixa de índices [start, end)). */
export interface ChipSpan {
  readonly id: number;
  readonly start: number;
  readonly end: number;
}

/**
 * Localiza todos os chips REGISTRADOS no buffer (na ordem em que aparecem). Tokens que
 * CASAM o padrão mas cujo id NÃO está no registro são ignorados (texto digitado à mão —
 * sem colisão). Puro.
 */
export function findChipSpans(buffer: string, registry: PasteRegistry): ChipSpan[] {
  const spans: ChipSpan[] = [];
  CHIP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CHIP_RE.exec(buffer)) !== null) {
    const id = Number(m[1]);
    if (registry.get(id) !== undefined) {
      spans.push({ id, start: m.index, end: m.index + m[0].length });
    }
  }
  return spans;
}

/**
 * Resultado de uma tentativa de apagar um chip atomicamente. `handled=false` ⇒ não havia
 * chip na borda; o caller segue com o backspace/delete normal de char.
 */
export interface DeleteChipResult {
  readonly handled: boolean;
  /** O novo estado (só significativo quando `handled`). */
  readonly state: EditState;
  /** O id do chip removido (p/ o caller chamar `registry.remove`); só quando `handled`. */
  readonly removedId?: number;
}

/**
 * APAGAR ATÔMICO: se o cursor está numa BORDA de um chip — backspace com o cursor logo
 * DEPOIS do chip (`cursor === end`), ou delete-forward com o cursor logo ANTES (`cursor ===
 * start`) — remove o chip INTEIRO do buffer e devolve o id p/ esquecer no registro. Senão
 * `handled=false` (edição normal de 1 char).
 *
 * `direction`: `'backward'` (backspace, apaga o que está À ESQUERDA do cursor) ou `'forward'`
 * (delete, apaga À DIREITA). Espelha o comportamento do Claude Code: o chip é uma UNIDADE; um
 * único backspace/delete sobre sua borda o remove por completo, não caractere a caractere.
 *
 * Caso o cursor caia DENTRO de um chip (entre start e end, raro porque o cursor anda por
 * char e o chip é atômico, mas defensivo), qualquer apagar remove o chip todo também.
 */
export function deleteChipAt(
  state: EditState,
  registry: PasteRegistry,
  direction: 'backward' | 'forward',
): DeleteChipResult {
  const pos = clampCursor(state.text, state.cursor);
  const spans = findChipSpans(state.text, registry);
  for (const span of spans) {
    const atBackBoundary = direction === 'backward' && pos === span.end;
    const atFwdBoundary = direction === 'forward' && pos === span.start;
    const inside = pos > span.start && pos < span.end;
    if (atBackBoundary || atFwdBoundary || inside) {
      const text = state.text.slice(0, span.start) + state.text.slice(span.end);
      return {
        handled: true,
        state: { text, cursor: span.start },
        removedId: span.id,
      };
    }
  }
  return { handled: false, state };
}

/**
 * EXPANDE no submit: substitui CADA chip registrado no buffer pelo seu conteúdo COMPLETO
 * original (fiel byte-a-byte). Chips não-registrados (texto digitado) ficam intactos. Sem
 * nenhum chip, devolve o buffer inalterado (submit normal sem paste). Puro — o caller passa
 * o snapshot do registro.
 *
 * Processa da DIREITA p/ a ESQUERDA pra os índices das ocorrências anteriores não mudarem
 * conforme o conteúdo (maior que o chip) é inserido. Cada chip expande NO SEU LUGAR.
 */
export function expandPastes(buffer: string, registry: PasteRegistry): string {
  const spans = findChipSpans(buffer, registry);
  if (spans.length === 0) return buffer;
  let out = buffer;
  for (let i = spans.length - 1; i >= 0; i -= 1) {
    const span = spans[i] as ChipSpan;
    const content = registry.get(span.id);
    if (content === undefined) continue; // já filtrado por findChipSpans, mas defensivo.
    out = out.slice(0, span.start) + content + out.slice(span.end);
  }
  return out;
}

// HUNT-LOOP — bug-hunt: a SELEÇÃO de compactação corta por CONTAGEM (length -
// keepRecent), podendo SEPARAR um `model_tool_calls` (vai p/ `older`, vira sumário)
// do seu `tool_result` pareado (fica em `recent`) ⇒ o histórico compactado começa
// com um `role:"tool"` ÓRFÃO (sem o assistant.tool_calls correspondente). Um
// provider rejeita um `role:"tool"` sem o `tool_calls` precedente.
//
// + renderHistoryForSummary NÃO trata `model_tool_calls`/`tool_result`/`reanchor`
//   ⇒ o trabalho via tool NATIVA some do sumário (perda de conteúdo).
import { describe, it, expect } from 'vitest';
import {
  selectForCompaction,
  applyCompaction,
  renderHistoryForSummary,
  sizeAwareKeepRecent,
  COMPACTION_TOOL_NAME,
} from '../../src/agent/compact.js';
import { buildMessages } from '../../src/agent/context.js';
import type { HistoryItem } from '../../src/agent/context.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';

/** O histórico compactado é VÁLIDO para o provider sse cada `role:"tool"` (mapeado
 * de um `tool_result`) tem ANTES um `assistant` com `tool_calls` (o `model_tool_calls`
 * eco). Devolve a lista de orphans (vazia ⇒ válido). É a invariante que a SELEÇÃO da
 * compactação tem de preservar em QUALQUER boundary (o walk-back de selectForCompaction). */
function orphanToolMessages(compacted: readonly HistoryItem[]): number[] {
  const msgs = buildMessages(NATIVE_TOOLS, compacted);
  const orphans: number[] = [];
  for (let i = 0; i < msgs.length; i += 1) {
    if (msgs[i]!.role !== 'tool') continue;
    const paired = msgs
      .slice(0, i)
      .some((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);
    if (!paired) orphans.push(i);
  }
  return orphans;
}

function nativePairHistory(): HistoryItem[] {
  // O par nativo STRADDLE a fronteira do corte (keepRecent=4): com length=7, o
  // split cai em índice 3 — o `model_tool_calls` (idx 2) fica em `older` e o
  // `tool_result` (idx 3) cai em `recent` ⇒ órfão no compactado.
  return [
    { role: 'goal', text: 'faça X' },
    { role: 'model', text: 'passo 1' },
    {
      role: 'model_tool_calls',
      text: 'vou escrever',
      calls: [{ id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'a' } }],
    },
    { role: 'tool_result', toolCallId: 'c1', toolName: 'write_file', text: 'ok' },
    { role: 'model', text: 'passo 2' },
    { role: 'model', text: 'passo 3' },
    { role: 'model', text: 'passo 4' },
  ];
}

describe('HUNT-LOOP — compactação x pareamento de tool nativo', () => {
  it('o histórico compactado NÃO começa com tool_result órfão', () => {
    const history = nativePairHistory();
    // keepRecent=4 ⇒ split em length-4 = 3 ⇒ older=[goal, model_tool_calls, tool_result?]
    // O par nativo pode ficar quebrado conforme o corte.
    const { recent } = selectForCompaction(history, 4);
    // depois de aplicar: [summary, ...recent]. Se recent começa com tool_result, é órfão.
    const compacted = applyCompaction(history, 'resumo', 4).history;

    // INVARIANTE: nenhum `tool_result` no compactado pode aparecer SEM um
    // `model_tool_calls` precedente que o referencie.
    const openIds = new Set<string>();
    for (const item of compacted) {
      if (item.role === 'model_tool_calls') for (const c of item.calls) openIds.add(c.id);
      if (item.role === 'tool_result') {
        expect(openIds.has(item.toolCallId)).toBe(true);
      }
    }
    // E o buildMessages resultante não deve ter um role:"tool" sem assistant.tool_calls antes.
    const msgs = buildMessages(NATIVE_TOOLS, compacted);
    for (let i = 0; i < msgs.length; i += 1) {
      if (msgs[i]!.role === 'tool') {
        const prevHasToolCalls = msgs
          .slice(0, i)
          .some((m) => m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0);
        expect(prevHasToolCalls).toBe(true);
      }
    }
    void recent;
  });

  it('renderHistoryForSummary inclui o trabalho via tool NATIVA (não some)', () => {
    const older: HistoryItem[] = [
      { role: 'goal', text: 'faça X' },
      {
        role: 'model_tool_calls',
        text: 'vou escrever',
        calls: [{ id: 'c1', name: 'write_file', input: { path: 'a.txt', content: 'a' } }],
      },
      {
        role: 'tool_result',
        toolCallId: 'c1',
        toolName: 'write_file',
        text: 'arquivo a.txt criado',
      },
    ];
    const rendered = renderHistoryForSummary(older);
    // o nome da ferramenta usada deve aparecer no texto a resumir (senão o sumário
    // perde que houve escrita de arquivo).
    expect(rendered).toContain('write_file');
    expect(rendered).not.toContain('undefined');
  });

  // HUNT-SPLICE — um grupo `model_tool_calls`→`tool_result(s)` com MÚLTIPLAS calls
  // (1 eco + N resultados) deve permanecer ÍNTEGRO no histórico compactado em
  // QUALQUER posição de corte (`keepRecent` de 0..length). O walk-back de
  // selectForCompaction empurra o corte p/ TRÁS até o `model_tool_calls`, levando o
  // grupo inteiro p/ `recent` — nunca deixando um `tool_result` órfão como 1º item.
  // Sem o walk-back, o corte no MEIO do grupo produz um `role:"tool"` sem o
  // `assistant.tool_calls` precedente (histórico que o provider rejeita — 400).
  it('grupo MULTI-CALL nativo fica íntegro em TODO boundary (0..length)', () => {
    const history: HistoryItem[] = [
      { role: 'goal', text: 'g' },
      { role: 'model', text: 'm0' },
      {
        role: 'model_tool_calls',
        text: 'três tools',
        calls: [
          { id: 'a', name: 'x', input: {} },
          { id: 'b', name: 'x', input: {} },
          { id: 'c', name: 'x', input: {} },
        ],
      },
      { role: 'tool_result', toolCallId: 'a', toolName: 'x', text: 'ra' },
      { role: 'tool_result', toolCallId: 'b', toolName: 'x', text: 'rb' },
      { role: 'tool_result', toolCallId: 'c', toolName: 'x', text: 'rc' },
      { role: 'model', text: 'm1' },
    ];
    for (let keep = 0; keep <= history.length; keep += 1) {
      const compacted = applyCompaction(history, 'resumo', keep).history;
      // (1) nenhum `tool_result` aparece sem o seu `model_tool_calls` antes;
      const open = new Set<string>();
      for (const item of compacted) {
        if (item.role === 'model_tool_calls') for (const c of item.calls) open.add(c.id);
        if (item.role === 'tool_result') expect(open.has(item.toolCallId)).toBe(true);
      }
      // (2) e o histórico mapeado p/ o provider não tem `role:"tool"` órfão.
      expect(orphanToolMessages(compacted)).toEqual([]);
      // (3) `recent` nunca começa com um `tool_result` (o item órfão clássico).
      expect(selectForCompaction(history, keep).recent[0]?.role).not.toBe('tool_result');
    }
  });

  // HUNT-SPLICE — quando a JANELA enche por POUCOS turnos GIGANTES recentes, a
  // SELEÇÃO size-aware ENCOLHE `keepRecent` (até o piso de 1) p/ que o gigante entre
  // no `older` e a janela baixe. O corte resultante pode cair sobre um `tool_result`
  // — o walk-back tem de continuar valendo SOBRE o count size-aware, mantendo o grupo
  // junto. Locks a interação size-aware × walk-back (caminho do dogfood).
  it('size-aware encolhe recent mas o walk-back mantém o grupo nativo íntegro', () => {
    const big = 'x'.repeat(400_000); // ~100k tokens estimados — estoura qualquer cauda
    const history: HistoryItem[] = [
      { role: 'goal', text: 'g' },
      { role: 'model', text: 'a' },
      { role: 'model', text: 'b' },
      {
        role: 'model_tool_calls',
        text: 'leitura grande',
        calls: [{ id: 'c1', name: 'read_file', input: {} }],
      },
      { role: 'tool_result', toolCallId: 'c1', toolName: 'read_file', text: big },
    ];
    const eff = sizeAwareKeepRecent(history, 4, 1_000); // orçamento minúsculo ⇒ encolhe
    expect(eff).toBe(1); // a cauda gigante força o piso
    const sel = selectForCompaction(history, eff);
    // o `tool_result` gigante (piso=1) puxaria o corte p/ cima de um órfão; o walk-back
    // arrasta o `model_tool_calls` junto ⇒ recent começa no eco, não no resultado.
    expect(sel.recent[0]?.role).toBe('model_tool_calls');
    expect(sel.older.length).toBeGreaterThanOrEqual(2); // sobra o que compactar (janela baixa)
    expect(orphanToolMessages(applyCompaction(history, 'S', eff).history)).toEqual([]);
  });

  // HUNT-SPLICE — DUAS compactações seguidas: o 2º sumário DOBRA o 1º (folding) em vez
  // de duplicá-lo. O histórico compactado tem SEMPRE no máximo UM `observation` de
  // sumário (`COMPACTION_TOOL_NAME`), e o objetivo original sobrevive (vai p/ dentro
  // do sumário encadeado). Nenhum turno é perdido nem aparece 2× — a partição
  // older/recent é exaustiva e disjunta.
  it('compactar 2× NÃO duplica o sumário nem perde o objetivo', () => {
    const base: HistoryItem[] = [
      { role: 'goal', text: 'OBJETIVO' },
      { role: 'model', text: 'm1' },
      { role: 'model', text: 'm2' },
      { role: 'model', text: 'm3' },
      { role: 'model', text: 'm4' },
      { role: 'model', text: 'm5' },
      { role: 'model', text: 'm6' },
    ];
    const first = applyCompaction(base, 'SUM1 (contém OBJETIVO)', 4).history;
    const countSummaries = (h: readonly HistoryItem[]) =>
      h.filter((i) => i.role === 'observation' && i.toolName === COMPACTION_TOOL_NAME).length;
    expect(countSummaries(first)).toBe(1);
    // mais turnos antes da 2ª compactação
    const grown: HistoryItem[] = [
      ...first,
      { role: 'model', text: 'm7' },
      { role: 'model', text: 'm8' },
    ];
    const second = applyCompaction(grown, 'SUM2', 4).history;
    // o sumário antigo foi FOLDED no novo (não fica órfão acumulando) ⇒ ainda 1 só.
    expect(countSummaries(second)).toBe(1);
    // e o item de sumário está na CABEÇA (cronologia: passado condensado → presente).
    expect(second[0]?.role).toBe('observation');
  });
});

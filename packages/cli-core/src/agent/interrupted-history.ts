// HISTÓRICO DO TURNO INTERROMPIDO — o que sobra de um turno cancelado (ESC/Ctrl-C) volta a ser
// contexto da conversa, em vez de sumir (visto pelo dono em 16/09: "o que vc fez" → "nada
// ainda", logo depois de ter pedido três agentes). PURO; sem I/O.
import type { HistoryItem } from './context.js';

/** Texto do resultado sintético de uma tool-call que o ESC deixou sem resposta. */
export const INTERRUPTED_TOOL_RESULT =
  'não executada ou sem resultado: o turno foi interrompido pelo usuário (ESC) antes de a ferramenta responder.';

/**
 * Deixa um histórico PARCIAL válido para o provider. A API compatível com a da OpenAI recusa
 * um `assistant` com `tool_calls` que não seja seguido por um `role:"tool"` para CADA id — e um
 * turno cortado no meio de um lote termina exatamente assim. Cada call sem resultado ganha um
 * `tool_result` sintético, inserido no fim do grupo de resultados daquele turno (antes de
 * qualquer outro item). Não muta a entrada; histórico já pareado volta igual.
 */
export function closeInterruptedHistory(history: readonly HistoryItem[]): HistoryItem[] {
  const out: HistoryItem[] = [];
  for (let i = 0; i < history.length; i++) {
    const item = history[i]!;
    out.push(item);
    if (item.role !== 'model_tool_calls') continue;
    const answered = new Set<string>();
    while (i + 1 < history.length && history[i + 1]!.role === 'tool_result') {
      const r = history[++i] as Extract<HistoryItem, { role: 'tool_result' }>;
      answered.add(r.toolCallId);
      out.push(r);
    }
    for (const call of item.calls) {
      if (answered.has(call.id)) continue;
      out.push({
        role: 'tool_result',
        toolCallId: call.id,
        toolName: call.name,
        text: INTERRUPTED_TOOL_RESULT,
      });
    }
  }
  return out;
}

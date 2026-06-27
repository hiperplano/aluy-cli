// EST-ASK · ADR-0080 (APR-0085) — SIDE-QUERY do `/ask`: uma pergunta PARALELA READ-ONLY
// respondida SEM tocar o loop/histórico principal.
//
// Mecânica (ADR-0080 §4): recebe um SNAPSHOT IMUTÁVEL do histórico (a CÓPIA já foi tirada
// pelo chamador — `structuredClone` no controller), monta um histórico PRÓPRIO
// `[...snapshot, pergunta]` e faz UMA chamada ao modelo com TOOLS VAZIAS (`buildMessages([])`
// + um caller SEM nativeTools anexadas) ⇒ read-only por construção: a resposta só pode ser
// TEXTO, zero efeito, a catraca nem é tocada.
//
// INVARIANTES (ADR-0080 §11):
//  - §11.1 NÃO-REENTRÂNCIA: a resposta NUNCA volta ao histórico do loop principal — este
//    módulo só LÊ o snapshot e DEVOLVE texto; quem chama renderiza num ASIDE e NÃO faz push
//    no `messages[]` vivo. Aqui garantimos o lado do módulo: o snapshot recebido NÃO é mutado.
//  - §11.3 read-only em profundidade: `buildMessages([])` (sem tools no system) + o caller
//    sem tools. (O `tool_choice:'none'` é cinto extra na camada do caller, fora deste módulo.)

import type { ChatMessage, ModelCallResult } from '../model/types.js';
import { buildMessages, type HistoryItem } from './context.js';
import type { FlowSummary } from './flow-tree.js';

/** O mínimo que a side-query precisa de um caller (o `BrokerModelCaller` o satisfaz). */
export interface SideQueryCaller {
  call(args: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ModelCallResult>;
}

export interface SideQueryArgs {
  /** Cópia IMUTÁVEL do histórico (o chamador faz `structuredClone`). NÃO é mutado aqui. */
  readonly snapshot: readonly HistoryItem[];
  /** A pergunta do usuário. */
  readonly question: string;
  /** Caller SEM tools anexadas (read-only). */
  readonly caller: SideQueryCaller;
  /** Chave de idempotência da chamada (única por `/ask`). */
  readonly idempotencyKey: string;
  /** Aborta a side-query (Esc / cancel) sem tocar o loop principal. */
  readonly signal?: AbortSignal;
  /**
   * EST-1015 (fix) — RESUMO do estado AO VIVO do trabalho em andamento (agente principal +
   * sub-agentes/loop da FlowTree do turno ATUAL). O snapshot é o histórico do último turno
   * CONCLUÍDO — não enxerga o que roda AGORA; sem isto, "como está?" durante sub-agentes era
   * respondido com "não sei o que está acontecendo". Quando presente, é injetado no contexto
   * ANTES da pergunta. Use `summarizeLiveFlows` p/ produzi-lo a partir do `overview()`.
   */
  readonly liveState?: string;
}

/** Formata `tokens` compacto p/ o resumo (12400 → "12.4k", 950 → "950"). */
function compactTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
}

/** Mapeia a fase de um fluxo p/ um rótulo curto em PT-BR (para o resumo do /ask). */
const PHASE_PT: Readonly<Record<string, string>> = {
  thinking: 'pensando',
  tool: 'executando ferramenta',
  asking: 'aguardando confirmação',
  done: 'concluído',
  cancelled: 'cancelado',
  failed: 'falhou',
};

/**
 * EST-1015 (fix do /ask cego) — resume a ÁRVORE DE FLUXOS VIVA (o `overview()` da FlowTree)
 * num texto curto p/ a side-query do `/ask` poder responder "como está?" SOBRE o que roda
 * AGORA. PURO/testável. Lista o agente PRINCIPAL (raiz) e os sub-agentes/loops com fase +
 * contabilidade (iterações, tools, tokens, duração). `now` é o relógio (p/ a duração viva).
 * Vazio/só-raiz-ociosa ⇒ string vazia (o caller omite a injeção).
 */
export function summarizeLiveFlows(overview: readonly FlowSummary[], now: number): string {
  if (overview.length === 0) return '';
  const dur = (a: FlowSummary['accounting']): string => {
    const ms = (a.endedAt ?? now) - a.startedAt;
    const s = Math.max(0, Math.round(ms / 1000));
    return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  };
  const line = (f: FlowSummary): string => {
    const a = f.accounting;
    const phase = PHASE_PT[f.phase] ?? f.phase;
    return `fase ${phase} · ${a.iterations} iter, ${a.toolCalls} tools, ${compactTokens(a.tokens)} tokens, ${dur(a)}`;
  };
  const root = overview.find((f) => f.kind === 'root');
  const children = overview.filter((f) => f.kind !== 'root');
  const lines: string[] = [
    'Estado AO VIVO do trabalho em andamento AGORA (canal lateral, para você responder sobre o progresso):',
  ];
  if (root) lines.push(`- Agente principal (${root.label}): ${line(root)}.`);
  if (children.length > 0) {
    const live = children.filter(
      (c) => c.phase !== 'done' && c.phase !== 'cancelled' && c.phase !== 'failed',
    ).length;
    lines.push(`- Sub-agentes (${children.length}, ${live} vivo(s)):`);
    for (const c of children) lines.push(`  • ${c.label} [${c.kind}] — ${line(c)}.`);
  } else {
    lines.push('- Sem sub-agentes ativos (só o agente principal).');
  }
  return lines.join('\n');
}

/** O enquadramento que diz ao modelo: pergunta paralela, sem tools, conciso. */
function framePergunta(question: string): string {
  return (
    'Pergunta PARALELA do usuário sobre o trabalho em andamento (canal lateral). ' +
    'Responda em TEXTO, conciso e direto, com base no contexto acima. ' +
    'Você NÃO tem ferramentas disponíveis nesta resposta — apenas responda.\n\n' +
    `Pergunta: ${question}`
  );
}

/**
 * Executa a side-query e devolve a resposta em texto. PURA quanto a EFEITO (sem tools) e
 * quanto ao snapshot (não o muta — o `askHistory` é um array NOVO via spread).
 */
export async function runSideQuery(args: SideQueryArgs): Promise<{ answer: string }> {
  // Array NOVO — o snapshot recebido permanece intocado (invariante de não-mutação).
  // O `liveState` (estado AO VIVO dos sub-agentes/loop) entra ANTES da pergunta, p/ a
  // resposta poder falar do que roda AGORA (o snapshot só tem o último turno concluído).
  const liveItems: readonly HistoryItem[] =
    args.liveState !== undefined && args.liveState.trim() !== ''
      ? [{ role: 'user_inject', origin: 'estado ao vivo', text: args.liveState }]
      : [];
  const askHistory: readonly HistoryItem[] = [
    ...args.snapshot,
    ...liveItems,
    { role: 'user_inject', origin: 'pergunta paralela', text: framePergunta(args.question) },
  ];
  // `buildMessages([])` = SEM tools no system prompt → o modelo não tem o que chamar.
  const messages = buildMessages([], askHistory);
  const result = await args.caller.call({
    messages,
    idempotencyKey: args.idempotencyKey,
    ...(args.signal !== undefined ? { signal: args.signal } : {}),
  });
  return { answer: result.content };
}

// EST-ASK · ADR-0080 — runSideQuery: pergunta paralela read-only.
//  - a resposta é o `content` do modelo;
//  - o caller recebe a pergunta (no histórico montado);
//  - INVARIANTE §11.1 (lado do módulo): o snapshot recebido NÃO é mutado.

import { describe, expect, it } from 'vitest';
import {
  runSideQuery,
  summarizeLiveFlows,
  type SideQueryCaller,
} from '../../src/agent/side-query.js';
import type { HistoryItem } from '../../src/agent/context.js';
import type { ChatMessage, ModelCallResult } from '../../src/model/types.js';
import type { FlowSummary } from '../../src/agent/flow-tree.js';

/** Constrói um FlowSummary mínimo p/ os testes do resumo do /ask. */
function summary(
  partial: Partial<FlowSummary> & Pick<FlowSummary, 'id' | 'kind' | 'label' | 'phase'>,
): FlowSummary {
  return {
    accounting: { tokens: 0, toolCalls: 0, iterations: 0, startedAt: 0, durationMs: 0 },
    ...partial,
  };
}

function fakeCaller(content: string): {
  caller: SideQueryCaller;
  seen: { messages?: readonly ChatMessage[] };
} {
  const seen: { messages?: readonly ChatMessage[] } = {};
  return {
    seen,
    caller: {
      async call(args): Promise<ModelCallResult> {
        seen.messages = args.messages;
        return { request_id: 'r1', content, finish_reason: 'stop' };
      },
    },
  };
}

const SNAPSHOT: readonly HistoryItem[] = [
  { role: 'goal', text: 'rode os testes' },
  { role: 'observation', toolName: 'run_command', text: 'npm test → 3 falhas' },
];

describe('runSideQuery — pergunta paralela read-only (ADR-0080)', () => {
  it('devolve o content do modelo como resposta', async () => {
    const { caller } = fakeCaller('Você está em 3 falhas de teste.');
    const { answer } = await runSideQuery({
      snapshot: SNAPSHOT,
      question: 'quantas falhas?',
      caller,
      idempotencyKey: 'ask-1',
    });
    expect(answer).toBe('Você está em 3 falhas de teste.');
  });

  it('o caller recebe a PERGUNTA no histórico montado (com o snapshot)', async () => {
    const { caller, seen } = fakeCaller('ok');
    await runSideQuery({
      snapshot: SNAPSHOT,
      question: 'qual o erro?',
      caller,
      idempotencyKey: 'ask-2',
    });
    const blob = (seen.messages ?? []).map((m) => m.content).join('\n');
    expect(blob).toContain('qual o erro?'); // a pergunta chegou
    expect(blob).toContain('rode os testes'); // o snapshot também (contexto)
  });

  it('EST-1015: o liveState (estado dos sub-agentes) entra no contexto ANTES da pergunta', async () => {
    const { caller, seen } = fakeCaller('Tem 2 sub-agentes; o revisor ainda roda.');
    const overview: readonly FlowSummary[] = [
      summary({ id: 'root', kind: 'root', label: 'aluy', phase: 'thinking' }),
      summary({
        id: 'root/revisor',
        kind: 'subagent',
        label: 'revisor',
        phase: 'tool',
        accounting: { tokens: 3100, toolCalls: 1, iterations: 2, startedAt: 0, durationMs: 12000 },
      }),
    ];
    const liveState = summarizeLiveFlows(overview, 12000);
    await runSideQuery({
      snapshot: SNAPSHOT,
      question: 'como está?',
      caller,
      idempotencyKey: 'ask-live',
      liveState,
    });
    const blob = (seen.messages ?? []).map((m) => m.content).join('\n');
    expect(blob).toContain('Estado AO VIVO'); // o estado vivo chegou ao contexto
    expect(blob).toContain('revisor'); // o sub-agente aparece
    expect(blob).toContain('como está?'); // e a pergunta também
  });

  it('INVARIANTE: NÃO muta o snapshot recebido (não-reentrância, lado do módulo)', async () => {
    const original: readonly HistoryItem[] = [
      { role: 'goal', text: 'tarefa' },
      { role: 'model', text: 'pensando' },
    ];
    const before = JSON.stringify(original);
    const { caller } = fakeCaller('resposta');
    await runSideQuery({ snapshot: original, question: 'oi?', caller, idempotencyKey: 'ask-3' });
    expect(JSON.stringify(original)).toBe(before); // intacto
    expect(original).toHaveLength(2); // nada foi acrescentado ao snapshot
  });
});

describe('summarizeLiveFlows — resumo da árvore VIVA p/ o /ask (EST-1015)', () => {
  it('lista o agente principal + sub-agentes com fase e contabilidade', () => {
    const overview: readonly FlowSummary[] = [
      summary({
        id: 'root',
        kind: 'root',
        label: 'aluy',
        phase: 'thinking',
        accounting: { tokens: 12400, toolCalls: 3, iterations: 5, startedAt: 0, durationMs: 45000 },
      }),
      summary({
        id: 'root/revisor',
        kind: 'subagent',
        label: 'revisor',
        phase: 'tool',
        accounting: { tokens: 3100, toolCalls: 1, iterations: 2, startedAt: 1000, durationMs: 0 },
      }),
      summary({
        id: 'root/tester',
        kind: 'subagent',
        label: 'tester',
        phase: 'done',
        accounting: { tokens: 8000, toolCalls: 5, iterations: 4, startedAt: 0, durationMs: 0 },
      }),
    ];
    const out = summarizeLiveFlows(overview, 45000);
    expect(out).toContain('Agente principal (aluy)');
    expect(out).toContain('pensando'); // fase traduzida
    expect(out).toContain('12k tokens'); // tokens compactos (≥10k sem decimal)
    expect(out).toContain('3.1k tokens'); // <10k com 1 decimal (revisor)
    expect(out).toContain('Sub-agentes (2, 1 vivo(s))'); // 2 filhos, 1 vivo (tester=done)
    expect(out).toContain('revisor [subagent]');
    expect(out).toContain('executando ferramenta'); // fase 'tool'
    expect(out).toContain('tester [subagent]');
  });

  it('sem sub-agentes ⇒ diz que só o principal está ativo', () => {
    const overview: readonly FlowSummary[] = [
      summary({ id: 'root', kind: 'root', label: 'aluy', phase: 'thinking' }),
    ];
    const out = summarizeLiveFlows(overview, 0);
    expect(out).toContain('Sem sub-agentes ativos');
  });

  it('overview vazio ⇒ string vazia (caller omite a injeção)', () => {
    expect(summarizeLiveFlows([], 0)).toBe('');
  });
});

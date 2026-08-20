// PISO NA MEDIÇÃO — a rc.137 pôs `effectiveCols` na FALA, na saída viva e no CLIP, e
// deixou a MEDIÇÃO de fora: `measureConversaBlock` usava `ctx.columns` CRU, subtraído em
// dez pontos do switch.
//
// Por que importa: com `columns` degenerado (0/negativo/NaN — a janela real que existe na
// troca de modo e no resize, antes de o próximo layout assentar) a medição e o clip
// DISCORDAVAM. Medido num bloco `subagents` de 4 filhos: a medição dava 6 com `NaN` e 82
// com `0` — para a mesma tela impossível. No fullscreen a altura medida é o número que
// decide encolher ou não; discordar dela é layout que não fecha.
import { describe, expect, it } from 'vitest';
import { measureConversaBlock } from '../../src/session/cockpit-conversa.js';
import type { SessionBlock } from '../../src/session/model.js';

const ctx = (columns: number) => ({ columns, rows: 45, streamMaxLines: 10 }) as never;
const subagents = (n: number): SessionBlock =>
  ({
    kind: 'subagents',
    children: Array.from({ length: n }, (_, i) => ({ label: `agente-${i}`, status: 'running' })),
  }) as SessionBlock;
const fala: SessionBlock = { kind: 'you', text: 'uma pergunta qualquer' };

describe('measureConversaBlock — largura degenerada não produz medida absurda', () => {
  it('largura normal mede o esperado (não-regressão)', () => {
    expect(measureConversaBlock(subagents(4), ctx(170))).toBe(6);
    expect(measureConversaBlock(subagents(4), ctx(80))).toBe(6);
  });

  it('A ORIGEM — NaN deixa de mentir: passa a medir como largura mínima, não como larga', () => {
    // ANTES: `NaN` devolvia 6 (o mesmo de uma tela de 170 colunas), porque a subtração
    // com NaN escapava pelos clamps de baixo. Agora cai no piso, igual a 0 e a negativo.
    const comNaN = measureConversaBlock(subagents(4), ctx(Number.NaN));
    const comZero = measureConversaBlock(subagents(4), ctx(0));
    expect(comNaN).toBe(comZero);
  });

  it('0, negativo e NaN medem TODOS igual — o degenerado tem uma resposta só', () => {
    const alturas = [0, -5, Number.NaN, Number.POSITIVE_INFINITY].map((c) =>
      measureConversaBlock(fala, ctx(c)),
    );
    expect(new Set(alturas).size).toBe(1);
  });

  it('nunca devolve 0, negativo ou NaN (o cockpit soma isso para fechar o layout)', () => {
    for (const c of [0, -5, Number.NaN, 1, 2, 170]) {
      const h = measureConversaBlock(subagents(3), ctx(c));
      expect(Number.isFinite(h)).toBe(true);
      expect(h).toBeGreaterThan(0);
    }
  });
});

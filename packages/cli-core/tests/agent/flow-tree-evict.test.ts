// EST-1011 (Bug 5 do bug-hunt — `FlowTree` cresce sem teto) — EVICT de nós FILHOS
// TERMINAIS acima de um teto, com a contabilidade PRESERVADA num agregado.
//
// Antes: `cancel()`/`finish()` só MARCAVAM o nó terminal; NADA removia de `byId`/
// `children` ⇒ sessão longa / `/loop` / muitos sub-agentes acumulava nós para sempre.
// Agora: acima de `maxTerminalNodes`, os terminais mais ANTIGOS (por `endedAt`) saem
// da árvore — mas seus tokens/tool-calls/iterações entram no agregado (`totalAccounting`)
// para que o TOTAL da sessão não regrida. Os nós VIVOS nunca são coletados; a raiz nunca.

import { describe, expect, it } from 'vitest';
import { FlowTree } from '../../src/index.js';

/** Relógio determinístico crescente — `endedAt` ordena o evict por recência. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

describe('EST-1011 · FlowTree — evict de nós terminais (anti-crescimento)', () => {
  it('mantém só `maxTerminalNodes` terminais + a raiz; conta os nós VIVOS', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now, maxTerminalNodes: 3 });
    // Cria e FECHA 20 sub-agentes (todos terminais), cada um num instante distinto.
    for (let i = 0; i < 20; i++) {
      const c = tree.ensureChild(`agent-${i}`);
      clock.advance(10);
      c.finish('final');
    }
    // Sobrou: raiz + os 3 terminais mais recentes (não os 20).
    const overview = tree.overview();
    expect(overview).toHaveLength(1 + 3);
    expect(overview[0]!.label).toBe('aluy'); // raiz primeiro, nunca evictada.
    // nodeCount = raiz + 3 = 4 (NÃO 21). O vazamento parou.
    expect(tree.nodeCount).toBe(4);
    expect(tree.evictedCount).toBe(17);
  });

  it('evicta os MAIS ANTIGOS (por endedAt) — a cauda recente fica navegável', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now, maxTerminalNodes: 2 });
    for (let i = 0; i < 5; i++) {
      const c = tree.ensureChild(`a${i}`);
      clock.advance(10);
      c.finish('final');
    }
    const labels = tree
      .overview()
      .filter((n) => n.kind === 'subagent')
      .map((n) => n.label);
    // Os 2 mais recentes (a3, a4) sobrevivem; a0..a2 saíram (mais antigos).
    expect(labels).toEqual(['a3', 'a4']);
    expect(tree.node('root/a0')).toBeUndefined();
    expect(tree.node('root/a4')).toBeDefined();
  });

  it('CONTABILIDADE preservada — `totalAccounting` soma o que foi evictado', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now, maxTerminalNodes: 2 });
    let expectTokens = 0;
    let expectTools = 0;
    let expectIters = 0;
    for (let i = 0; i < 10; i++) {
      const c = tree.ensureChild(`a${i}`);
      c.setUsage({ tokens: 100 * (i + 1), toolCalls: i + 1, iterations: 1 });
      expectTokens += 100 * (i + 1);
      expectTools += i + 1;
      expectIters += 1;
      clock.advance(5);
      c.finish('final');
    }
    // Embora só 2 nós sobrem na árvore, o total NÃO perde o custo dos 8 evictados.
    const total = tree.totalAccounting();
    expect(total.tokens).toBe(expectTokens);
    expect(total.toolCalls).toBe(expectTools);
    expect(total.iterations).toBe(expectIters);
    // E a árvore de fato encolheu (raiz + 2 terminais).
    expect(tree.nodeCount).toBe(3);
  });

  it('NUNCA evicta nós VIVOS — um sub-agente pendurado segue visível', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now, maxTerminalNodes: 1 });
    tree.ensureChild('hung'); // nunca .finish() ⇒ vivo
    for (let i = 0; i < 10; i++) {
      const c = tree.ensureChild(`done-${i}`);
      clock.advance(5);
      c.finish('final');
    }
    // O vivo está lá; os terminais foram cercados ao teto (1).
    expect(tree.node('root/hung')).toBeDefined();
    expect(tree.node('root/hung')!.isTerminal()).toBe(false);
    const liveLabels = tree.liveChildren().map((c) => c.label);
    expect(liveLabels).toContain('hung');
    // raiz + hung(vivo) + 1 terminal recente.
    expect(tree.nodeCount).toBe(3);
  });

  it('default (sem opção) não evicta sob uso normal — não regride EST-0982', () => {
    const tree = new FlowTree(); // teto default (32)
    for (let i = 0; i < 5; i++) tree.ensureChild(`x${i}`).finish('final');
    // 5 << 32 ⇒ nada some; a árvore EST-0982 funciona igual.
    expect(tree.overview().filter((n) => n.kind === 'subagent')).toHaveLength(5);
    expect(tree.evictedCount).toBe(0);
  });

  it('re-`ensureChild` do MESMO label após evict cria um nó NOVO (não ressuscita o velho)', () => {
    const clock = fakeClock();
    const tree = new FlowTree({ clock: clock.now, maxTerminalNodes: 1 });
    const first = tree.ensureChild('reuse');
    first.setUsage({ tokens: 50, toolCalls: 1, iterations: 1 });
    clock.advance(5);
    first.finish('final');
    // Enche o teto p/ forçar o evict do `reuse`.
    for (let i = 0; i < 5; i++) {
      const c = tree.ensureChild(`pad-${i}`);
      clock.advance(5);
      c.finish('final');
    }
    expect(tree.node('root/reuse')).toBeUndefined(); // evictado.
    // Um novo sub-agente com o mesmo label nasce LIMPO (não o terminal antigo).
    const second = tree.ensureChild('reuse');
    expect(second.isTerminal()).toBe(false);
    expect(second.accounting().tokens).toBe(0);
    // O custo do `reuse` ANTIGO segue contado no total (não se perde no evict).
    expect(tree.totalAccounting().tokens).toBeGreaterThanOrEqual(50);
  });
});

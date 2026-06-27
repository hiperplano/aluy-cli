// EST-1125 — Testes unitários do esqueleto do grafo de caixas de contexto.
// Cobre: CA-GRAFO-1 (modelo caixa/horizonte/containment/dependência),
// CA-GRAFO-ISOLAMENTO (CA-MA6), CA-GRAFO-DINAMICO (Q-MA9 híbrido),
// CA-GRAFO-TETO (~200 + eviction heurística), CA-GRAFO-FRONTEIRA (sem I/O).

import { describe, expect, it } from 'vitest';
import {
  ContextGraph,
  DEFAULT_MAX_BOXES,
  type BoxSnapshot,
} from '../src/agent/maestro/context-box-graph.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

let clockSeq = 0;
function fakeClock(step = 1): () => number {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
}

function makeId(label: string): string {
  clockSeq += 1;
  return ContextGraph.boxId(label, clockSeq * 1000);
}

function assertBox(
  box: BoxSnapshot | null,
  overrides: Partial<BoxSnapshot> & { id: string },
): void {
  if (!box) throw new Error(`expected box ${overrides.id} to exist`);
  expect(box.id).toBe(overrides.id);
  if (overrides.horizon !== undefined) expect(box.horizon).toBe(overrides.horizon);
  if (overrides.label !== undefined) expect(box.label).toBe(overrides.label);
  if (overrides.parentId !== undefined) expect(box.parentId).toBe(overrides.parentId);
  if (overrides.pinned !== undefined) expect(box.pinned).toBe(overrides.pinned);
  if (overrides.closed !== undefined) expect(box.closed).toBe(overrides.closed);
  if (overrides.children !== undefined)
    expect(new Set(box.children)).toEqual(new Set(overrides.children));
  if (overrides.dependencies !== undefined)
    expect(new Set(box.dependencies)).toEqual(new Set(overrides.dependencies));
}

// ── CA-GRAFO-1 — modelo: caixa/horizonte/containment/dependência ───────────

describe('CA-GRAFO-1 — modelo ContextBox · horizonte · containment · dependência', () => {
  it('abre uma caixa com horizonte longo', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const id = 'projeto-01';
    const r = g.openBox(id, 'longo', 'Projeto principal');
    expect(r.created).toBe(true);
    assertBox(r.box, { id, horizon: 'longo', label: 'Projeto principal', parentId: null });
    expect(r.box.createdAt).toBeGreaterThan(0);
    expect(r.box.lastAccessedAt).toBeGreaterThan(0);
    expect(r.box.accessCount).toBe(0); // openBox não conta como access
  });

  it('abertura é idempotente: mesmo ID retorna created:false', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const id = 'tarefa-01';
    const r1 = g.openBox(id, 'curto', 'Tarefa rápida');
    expect(r1.created).toBe(true);
    const r2 = g.openBox(id, 'curto', 'Tarefa rápida');
    expect(r2.created).toBe(false);
    expect(r2.box.id).toBe(id);
  });

  it('containment: pai contém filha (longo ⊃ médio ⊃ curto)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const paiId = 'longo-pai';
    const filhaId = 'curto-filha';

    g.openBox(paiId, 'longo', 'Pai');
    g.openBox(filhaId, 'curto', 'Filha', paiId);

    const pai = g.getBox(paiId);
    const filha = g.getBox(filhaId);

    assertBox(pai, { id: paiId, children: [filhaId] });
    assertBox(filha, { id: filhaId, parentId: paiId });
  });

  it('dependência entre caixas (subatividade depende de outra)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const aId = 'caixa-a';
    const bId = 'caixa-b';

    g.openBox(aId, 'médio', 'A');
    g.openBox(bId, 'médio', 'B');
    const ok = g.addDependency(bId, aId); // B depende de A

    expect(ok).toBe(true);
    expect(g.getDependencies(bId)).toEqual([aId]);
  });

  it('dependência sem self-loop', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('x', 'médio', 'X');
    expect(g.addDependency('x', 'x')).toBe(false);
  });

  it('dependência rejeitada se uma das caixas não existe', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('a', 'médio', 'A');
    expect(g.addDependency('a', 'fantasma')).toBe(false);
    expect(g.addDependency('fantasma', 'a')).toBe(false);
  });

  it('listBoxes ordena por lastAccessedAt (default)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('a', 'médio', 'A');
    g.openBox('b', 'médio', 'B');
    g.openBox('c', 'médio', 'C');

    // Acessa propositalmente para alterar lastAccessedAt.
    g.getBox('a');
    g.getBox('c');
    g.getBox('c');

    const list = g.listBoxes('lastAccessedAt');
    expect(list[0]!.id).toBe('c'); // mais recente
  });

  it('listBoxes ordena por createdAt', () => {
    const clock = fakeClock();
    const g = new ContextGraph({ clock });
    g.openBox('first', 'médio', 'Primeira');
    g.openBox('second', 'médio', 'Segunda');

    const list = g.listBoxes('createdAt');
    expect(list[0]!.id).toBe('first');
    expect(list[1]!.id).toBe('second');
  });

  it('listBoxes ordena por accessCount', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('a', 'médio', 'A');
    g.openBox('b', 'médio', 'B');
    g.getBox('b');
    g.getBox('b');
    g.getBox('a');

    const list = g.listBoxes('accessCount');
    expect(list[0]!.id).toBe('b'); // accessCount = 2 (getBox toca)
  });
});

// ── CA-GRAFO-ISOLAMENTO — isolamento por caixa (CA-MA6) ───────────────────

describe('CA-GRAFO-ISOLAMENTO — CA-MA6 (contexto não contamina)', () => {
  it('contexto de subatividade curta NÃO contamina a caixa-longa pai', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const paiId = 'trabalho-longo';
    const filhaId = 'sub-curta';

    g.openBox(paiId, 'longo', 'Trabalho longo');
    g.openBox(filhaId, 'curto', 'Subatividade curta', paiId);

    g.addContext(paiId, 'contexto do trabalho longo');
    g.addContext(filhaId, 'contexto da subatividade curta');

    const ctxPai = g.getContext(paiId);
    const ctxFilha = g.getContext(filhaId);

    expect(ctxPai).toHaveLength(1);
    expect(ctxPai[0]!.text).toBe('contexto do trabalho longo');
    expect(ctxFilha).toHaveLength(1);
    expect(ctxFilha[0]!.text).toBe('contexto da subatividade curta');
  });

  it('getContextChain sobe a cadeia de containment (pai → avô)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const avoId = 'avo';
    const paiId = 'pai';
    const filhaId = 'filha';

    g.openBox(avoId, 'longo', 'Avô');
    g.openBox(paiId, 'médio', 'Pai', avoId);
    g.openBox(filhaId, 'curto', 'Filha', paiId);

    g.addContext(avoId, 'contexto-avô');
    g.addContext(paiId, 'contexto-pai');
    g.addContext(filhaId, 'contexto-filha');

    const chain = g.getContextChain(filhaId);
    expect(chain).toHaveLength(3);
    expect(chain[0]!.boxId).toBe(filhaId);
    expect(chain[0]!.entries[0]!.text).toBe('contexto-filha');
    expect(chain[1]!.boxId).toBe(paiId);
    expect(chain[1]!.entries[0]!.text).toBe('contexto-pai');
    expect(chain[2]!.boxId).toBe(avoId);
    expect(chain[2]!.entries[0]!.text).toBe('contexto-avô');
  });

  it('contexto de caixas-irmãs NÃO aparece no getContextChain', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const paiId = 'pai';
    g.openBox(paiId, 'longo', 'Pai');
    g.openBox('irma-1', 'curto', 'Irmã 1', paiId);
    g.openBox('irma-2', 'curto', 'Irmã 2', paiId);

    g.addContext('irma-1', 'contexto da irmã 1');
    g.addContext('irma-2', 'contexto da irmã 2');

    // getContextChain da irmã-2 só vê o pai e ela mesma.
    const chain = g.getContextChain('irma-2');
    const ids = chain.map((c) => c.boxId);
    expect(ids).toContain('irma-2');
    expect(ids).toContain(paiId);
    expect(ids).not.toContain('irma-1');
  });

  it('getContextChain para caixa inexistente retorna vazio', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.getContextChain('fantasma')).toEqual([]);
  });

  it('getContextChain quebra se ancestrais não existirem (órfão)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    // parentId aponta para algo inexistente.
    g.openBox('filha-orfa', 'curto', 'Filha órfã', 'pai-fantasma');
    const chain = g.getContextChain('filha-orfa');
    // Deve retornar só a própria caixa, parando no órfão.
    expect(chain).toHaveLength(1);
    expect(chain[0]!.boxId).toBe('filha-orfa');
  });
});

// ── CA-GRAFO-DINAMICO — abertura/fechamento dinâmico (Q-MA9) ─────────────

describe('CA-GRAFO-DINAMICO — Q-MA9 híbrido (abrir/fechar dinâmico)', () => {
  it('abre caixas em todos os horizontes', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    const r1 = g.openBox('l', 'longo', 'Longo');
    const r2 = g.openBox('m', 'médio', 'Médio');
    const r3 = g.openBox('c', 'curto', 'Curto');
    expect(r1.box.horizon).toBe('longo');
    expect(r2.box.horizon).toBe('médio');
    expect(r3.box.horizon).toBe('curto');
  });

  it('fecha caixa na conclusão', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('tarefa', 'curto', 'Tarefa');
    const closed = g.closeBox('tarefa');
    expect(closed).not.toBeNull();
    expect(closed!.closed).toBe(true);
    expect(g.isClosed('tarefa')).toBe(true);
  });

  it('closeBox retorna null para caixa inexistente', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.closeBox('fantasma')).toBeNull();
  });

  it('getBox retorna null para caixa inexistente', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.getBox('fantasma')).toBeNull();
  });

  it('addContext retorna null para caixa inexistente', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.addContext('fantasma', 'texto')).toBeNull();
  });

  it('size reflete o número de caixas vivas', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.size).toBe(0);
    g.openBox('a', 'médio', 'A');
    g.openBox('b', 'médio', 'B');
    expect(g.size).toBe(2);
  });

  it('touch (via getBox) atualiza lastAccessedAt e accessCount', () => {
    const clock = fakeClock();
    const g = new ContextGraph({ clock });
    g.openBox('x', 'médio', 'X');
    const before = g.getBox('x')!;
    const after = g.getBox('x')!;
    expect(after.accessCount).toBeGreaterThan(before.accessCount);
  });
});

// ── CA-GRAFO-TETO — ~200 + eviction heurística (CA-MA7 liga, sem persistência) ──

describe('CA-GRAFO-TETO — eviction por horizonte/recência/frequência/pin (sem judge-LLM)', () => {
  it('DEFAULT_MAX_BOXES é 200', () => {
    expect(DEFAULT_MAX_BOXES).toBe(200);
  });

  it('NUNCA evicta caixa-longa', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('longa', 'longo', 'Caixa longa');
    g.openBox('curta-1', 'curto', 'Curta 1');
    // Força a criação de uma 3ª caixa → dispara eviction.
    g.openBox('curta-2', 'curto', 'Curta 2');

    // A caixa longa DEVE continuar.
    expect(g.getBox('longa')).not.toBeNull();
    // Uma das curtas foi evictada.
    const curta1 = g.getBox('curta-1');
    const curta2 = g.getBox('curta-2');
    expect(curta1 === null || curta2 === null).toBe(true);
  });

  it('NUNCA evicta caixa pinada', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('pinned', 'curto', 'Pinada');
    g.pinBox('pinned');
    g.openBox('normal', 'curto', 'Normal');
    g.openBox('nova', 'curto', 'Nova');

    // A pinada DEVE continuar.
    expect(g.getBox('pinned')).not.toBeNull();
  });

  it('evicta caixa curto antes de médio', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('media', 'médio', 'Média');
    g.openBox('curta', 'curto', 'Curta');
    g.openBox('nova', 'médio', 'Nova');

    // A caixa curta deve ter sido evictada, a média preservada.
    expect(g.getBox('curta')).toBeNull();
    expect(g.getBox('media')).not.toBeNull();
    expect(g.getBox('nova')).not.toBeNull();
  });

  it('prefere evictar caixas fechadas', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('aberta', 'curto', 'Aberta');
    g.openBox('fechada', 'curto', 'Fechada');
    g.closeBox('fechada');
    g.openBox('nova', 'curto', 'Nova');

    // A fechada deve ter sido evictada primeiro.
    expect(g.getBox('fechada')).toBeNull();
    expect(g.getBox('aberta')).not.toBeNull();
    expect(g.getBox('nova')).not.toBeNull();
  });

  it('evicta pela menos recente (recência) como desempate', () => {
    const clock = fakeClock();
    const g = new ContextGraph({ maxBoxes: 3, clock });
    g.openBox('recente', 'curto', 'Recente');
    g.openBox('antiga', 'curto', 'Antiga');
    g.openBox('media', 'curto', 'Média');

    // Acessa 'recente' e 'media' para torná-las mais recentes.
    g.getBox('recente');
    g.getBox('media');

    // Força eviction.
    g.openBox('nova', 'curto', 'Nova');

    // A 'antiga' (menos recente) deve ter sido evictada.
    expect(g.getBox('antiga')).toBeNull();
    expect(g.getBox('recente')).not.toBeNull();
    expect(g.getBox('media')).not.toBeNull();
  });

  it('forceEvict respeita invariante: NUNCA evicta longo', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('longa', 'longo', 'Longa');
    expect(g.forceEvict('longa')).toBeNull();
    expect(g.getBox('longa')).not.toBeNull();
  });

  it('forceEvict respeita invariante: NUNCA evicta pinada', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('pin', 'curto', 'Pinada');
    g.pinBox('pin');
    expect(g.forceEvict('pin')).toBeNull();
    expect(g.getBox('pin')).not.toBeNull();
  });

  it('forceEvict remove caixa elegível normalmente', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('x', 'curto', 'X');
    const s = g.forceEvict('x');
    expect(s).not.toBeNull();
    expect(s!.id).toBe('x');
    expect(g.getBox('x')).toBeNull();
  });

  it('F86 — removeBox remove INCONDICIONALMENTE (até longo/pinada, onde forceEvict recusa)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('longa', 'longo', 'Longa');
    g.openBox('pin', 'curto', 'Pinada');
    g.pinBox('pin');
    // forceEvict recusa ambas; removeBox remove.
    expect(g.forceEvict('longa')).toBeNull();
    expect(g.removeBox('longa')!.id).toBe('longa');
    expect(g.getBox('longa')).toBeNull();
    expect(g.removeBox('pin')!.id).toBe('pin');
    expect(g.getBox('pin')).toBeNull();
  });

  it('F86 — removeBox de id inexistente ⇒ null (idempotente)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.removeBox('fantasma')).toBeNull();
  });

  it('F86 — removeBox limpa a referência no pai (filho some da lista do pai)', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('pai', 'longo', 'Pai');
    g.openBox('filho', 'curto', 'Filho', 'pai');
    g.removeBox('filho');
    expect(g.getBox('filho')).toBeNull();
    // o pai não retém o filho removido (sem referência órfã).
    expect(g.getBox('pai')!.children).not.toContain('filho');
  });

  it('evictOne retorna null se nenhuma caixa for elegível (só longo/pinada)', () => {
    const g = new ContextGraph({ maxBoxes: 1, clock: fakeClock() });
    g.openBox('longa', 'longo', 'Longa');
    g.pinBox('longa'); // garante inelegível (longo já bastaria)
    expect(g.evictOne()).toBeNull(); // nada elegível ⇒ null
  });

  // F133 (HUNT-GRAFO) — REGRESSÃO: o teto anti-runaway NÃO pode ser derrotável.
  // Antes, quando todas as caixas eram inelegíveis (longo/pinadas), `openBox`
  // criava a nova MESMO ASSIM ⇒ `size` ultrapassava `maxBoxes` e o grafo crescia
  // sem limite (EST-1011). Agora `openBox` RECUSA (null) e o teto segura.
  it('F133 — no TETO sem vítima elegível (todas longo), openBox RECUSA (null) e size não passa do teto', () => {
    const g = new ContextGraph({ maxBoxes: 3, clock: fakeClock() });
    for (let i = 0; i < 3; i++) g.openBox(`b${i}`, 'longo', `box ${i}`);
    expect(g.size).toBe(3);
    const refused = g.openBox('overflow', 'longo', 'overflow');
    expect(refused).toBeNull(); // recusada
    expect(g.getBox('overflow')).toBeNull(); // não foi criada
    expect(g.size).toBe(3); // TETO respeitado (antes virava 4)
    // martela mais — segue recusando, sem vazar (antes crescia sem limite).
    for (let i = 0; i < 10; i++) g.openBox(`x${i}`, 'longo', `x ${i}`);
    expect(g.size).toBe(3);
  });

  it('F133 — mesmo furo com caixas PINADAS (curto pinada também é inelegível)', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('a', 'curto', 'A');
    g.pinBox('a');
    g.openBox('b', 'curto', 'B');
    g.pinBox('b');
    expect(g.size).toBe(2);
    expect(g.openBox('c', 'curto', 'C')).toBeNull();
    expect(g.size).toBe(2);
  });

  it('F133 — com vítima elegível (curto não-pinada), openBox SEGUE evictando e criando (não regrediu)', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('longa', 'longo', 'Longa');
    g.openBox('curta', 'curto', 'Curta'); // elegível p/ eviction
    expect(g.size).toBe(2);
    const r = g.openBox('nova', 'médio', 'Nova'); // evicta 'curta', cria 'nova'
    expect(r).not.toBeNull();
    expect(r!.created).toBe(true);
    expect(g.getBox('nova')).not.toBeNull();
    expect(g.getBox('curta')).toBeNull(); // a elegível foi evictada
    expect(g.size).toBe(2); // teto mantido
  });

  it('F133 — reabrir caixa EXISTENTE no teto NUNCA recusa (idempotência, não cresce)', () => {
    const g = new ContextGraph({ maxBoxes: 2, clock: fakeClock() });
    g.openBox('a', 'longo', 'A');
    g.openBox('b', 'longo', 'B');
    const r = g.openBox('a', 'longo', 'A'); // já existe ⇒ idempotente
    expect(r).not.toBeNull();
    expect(r!.created).toBe(false);
    expect(g.size).toBe(2);
  });

  it('pin/unpin altera o flag corretamente', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('x', 'curto', 'X');
    expect(g.getBox('x')!.pinned).toBe(false);
    g.pinBox('x');
    expect(g.getBox('x')!.pinned).toBe(true);
    g.unpinBox('x');
    expect(g.getBox('x')!.pinned).toBe(false);
  });

  it('pinBox/unpinBox retornam null para caixa inexistente', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g.pinBox('fantasma')).toBeNull();
    expect(g.unpinBox('fantasma')).toBeNull();
  });
});

// ── CA-GRAFO-FRONTEIRA — sem I/O (ADR-0053 §8) ────────────────────────────

describe('CA-GRAFO-FRONTEIRA — portável, sem I/O (ADR-0053 §8)', () => {
  it('ContextGraph não tem dependência de node:* ou I/O', () => {
    // A classe é criada sem imports de fs, path, child_process, http, etc.
    const g = new ContextGraph({ clock: fakeClock() });
    expect(g).toBeInstanceOf(ContextGraph);
    expect(g.size).toBe(0);
  });

  it('boxId é determinístico e legível', () => {
    const id1 = ContextGraph.boxId('Minha Tarefa!', 1000);
    const id2 = ContextGraph.boxId('Minha Tarefa!', 1000);
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^minha-tarefa-/);
  });

  it('boxId trunca labels muito longos', () => {
    const longLabel = 'a'.repeat(200);
    const id = ContextGraph.boxId(longLabel, 1000);
    // slug truncado em 60 chars + timestamp
    expect(id.length).toBeLessThanOrEqual(60 + 1 + 8); // slug + '-' + ts36
  });
});

// ── Cenários integrados ─────────────────────────────────────────────────────

describe('Cenários integrados — grafo de caixas', () => {
  it('fluxo completo: trabalho longo → subatividades → fechamento → eviction seletiva', () => {
    const clock = fakeClock();
    const g = new ContextGraph({ maxBoxes: 5, clock });

    // 1. Abre o trabalho longo.
    const mainId = makeId('projeto-maestro');
    const main = g.openBox(mainId, 'longo', 'Projeto Maestro');
    expect(main.created).toBe(true);

    // 2. Abre subatividades.
    const sub1Id = makeId('sub-frontend');
    const sub2Id = makeId('sub-backend');
    const sub3Id = makeId('sub-testes');

    g.openBox(sub1Id, 'médio', 'Sub Frontend', mainId);
    g.openBox(sub2Id, 'médio', 'Sub Backend', mainId);
    g.openBox(sub3Id, 'curto', 'Sub Testes', mainId);

    // 3. Verifica containment.
    const mainBox = g.getBox(mainId)!;
    expect(new Set(mainBox.children)).toEqual(new Set([sub1Id, sub2Id, sub3Id]));

    // 4. Adiciona contexto com isolamento.
    g.addContext(mainId, 'Objetivo: implementar Maestro v1');
    g.addContext(sub1Id, 'Criar componente de UI do grafo');
    g.addContext(sub2Id, 'Implementar engine de regência');
    g.addContext(sub3Id, 'Testar isolamento de caixas');

    // Contexto da subatividade NÃO contamina o main.
    const mainCtx = g.getContext(mainId);
    expect(mainCtx.map((e) => e.text)).not.toContain('Testar isolamento de caixas');

    // 5. Dependência entre subatividades.
    g.addDependency(sub3Id, sub2Id); // testes depende de backend
    expect(g.getDependencies(sub3Id)).toEqual([sub2Id]);

    // 6. Fecha subatividades concluídas.
    g.closeBox(sub1Id);
    g.closeBox(sub2Id);
    g.closeBox(sub3Id);

    expect(g.isClosed(sub1Id)).toBe(true);
    expect(g.isClosed(sub2Id)).toBe(true);
    expect(g.isClosed(sub3Id)).toBe(true);

    // 7. Cria mais caixas para forçar eviction.
    // Subatividades fechadas (curto/médio) devem ser evictadas antes do
    // trabalho longo.
    g.openBox(makeId('extra-1'), 'curto', 'Extra 1', mainId);
    g.openBox(makeId('extra-2'), 'curto', 'Extra 2', mainId);

    // Trabalho longo DEVE continuar.
    expect(g.getBox(mainId)).not.toBeNull();

    // Subatividades fechadas devem ter sido evictadas.
    const survivors = g.listBoxes().map((b) => b.id);
    // main sobrevive, algumas fechadas podem ter ido embora.
    expect(survivors).toContain(mainId);
  });

  it('contexto sobrevive a acessos repetidos sem vazar', () => {
    const g = new ContextGraph({ clock: fakeClock() });
    g.openBox('caixa', 'médio', 'Caixa');
    g.addContext('caixa', 'linha 1');
    g.addContext('caixa', 'linha 2');
    g.addContext('caixa', 'linha 3');

    // Lê várias vezes — contexto permanece íntegro.
    for (let i = 0; i < 10; i++) {
      const ctx = g.getContext('caixa');
      expect(ctx).toHaveLength(3);
      expect(ctx[0]!.text).toBe('linha 1');
      expect(ctx[2]!.text).toBe('linha 3');
    }
  });

  // ── EST-1126 — mutadores p/ a heurística do plano ──────────────────────────
  describe('EST-1126 — setHorizon / reopenBox / setParent', () => {
    it('setHorizon reclassifica caixa existente (openBox é idempotente, não mexe)', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('b', 'longo', 'B');
      // openBox de novo NÃO muda o horizonte (idempotente).
      g.openBox('b', 'curto', 'B');
      expect(g.getBox('b')!.horizon).toBe('longo');
      // setHorizon SIM.
      const snap = g.setHorizon('b', 'curto');
      expect(snap!.horizon).toBe('curto');
      expect(g.getBox('b')!.horizon).toBe('curto');
      // no-op se não existe.
      expect(g.setHorizon('inexistente', 'médio')).toBeNull();
    });

    it('reopenBox reabre caixa fechada; no-op se inexistente', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('b', 'médio', 'B');
      g.closeBox('b');
      expect(g.isClosed('b')).toBe(true);
      g.reopenBox('b');
      expect(g.isClosed('b')).toBe(false);
      expect(g.reopenBox('nope')).toBeNull();
    });

    it('setParent move a caixa, ajustando containment dos dois lados', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('p1', 'longo', 'P1');
      g.openBox('p2', 'longo', 'P2');
      g.openBox('f', 'curto', 'F', 'p1'); // filha de p1
      expect(g.getBox('f')!.parentId).toBe('p1');
      expect(g.getBox('p1')!.children).toContain('f');

      // Move f de p1 → p2.
      g.setParent('f', 'p2');
      expect(g.getBox('f')!.parentId).toBe('p2');
      expect(g.getBox('p1')!.children).not.toContain('f'); // saiu do pai antigo
      expect(g.getBox('p2')!.children).toContain('f'); // entrou no novo

      // Desanexa (parent null).
      g.setParent('f', null);
      expect(g.getBox('f')!.parentId).toBeNull();
      expect(g.getBox('p2')!.children).not.toContain('f');
      // no-op se inexistente.
      expect(g.setParent('nope', 'p1')).toBeNull();
    });
  });

  // HUNT-GRAFO — containment é ÁRVORE: `setParent` NUNCA pode fechar ciclo (senão os
  // walks recursivos `getContextChain`/`getDepth` PENDURAM/estouram = DoS/limbo). O
  // `update_plan` hoje não cria ciclo, mas `setParent` é API pública da porta `graph`.
  describe('HUNT-GRAFO — setParent não fecha ciclo + walks não penduram', () => {
    it('setParent recusa AUTO-pai (id == parentId) — no-op, devolve null', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('a', 'médio', 'A');
      expect(g.setParent('a', 'a')).toBeNull();
      expect(g.getBox('a')!.parentId).toBeNull(); // intocado
    });

    it('setParent recusa CICLO de 2 (a→b então b→a) — preserva o pai anterior', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('a', 'médio', 'A');
      g.openBox('b', 'médio', 'B');
      expect(g.setParent('a', 'b')).not.toBeNull(); // a vira filha de b: ok
      // b vira filha de a fecharia o ciclo a→b→a ⇒ REFUSA.
      expect(g.setParent('b', 'a')).toBeNull();
      expect(g.getBox('b')!.parentId).toBeNull(); // b segue raiz (não mutou)
      expect(g.getBox('a')!.parentId).toBe('b'); // a aresta legítima permanece
    });

    it('setParent recusa CICLO de 3 (descendente vira pai) — cadeia a→b→c, c→a refuta', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('a', 'médio', 'A');
      g.openBox('b', 'médio', 'B', 'a'); // b filha de a
      g.openBox('c', 'médio', 'C', 'b'); // c filha de b  (a→b→c)
      // tornar 'a' filha de 'c' (seu descendente) fecharia o ciclo ⇒ REFUSA.
      expect(g.setParent('a', 'c')).toBeNull();
      expect(g.getBox('a')!.parentId).toBeNull();
    });

    it('getContextChain NÃO pendura mesmo se um ciclo for forçado por trás (defesa-em-prof.)', () => {
      const g = new ContextGraph({ clock: fakeClock() });
      g.openBox('a', 'médio', 'A');
      g.openBox('b', 'médio', 'B', 'a');
      // setParent recusaria; o teste prova o GUARD do walk: a chamada retorna (não trava).
      g.setParent('a', 'b'); // refused (no-op) — grafo segue acíclico a←b
      const chain = g.getContextChain('b'); // b → a → null
      expect(chain.map((c) => c.boxId)).toEqual(['b', 'a']);
    });
  });
});

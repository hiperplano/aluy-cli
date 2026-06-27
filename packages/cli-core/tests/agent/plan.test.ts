// EST-1015 (pedido do dono) — tool `update_plan` (checklist vivo): normalização do
// input do modelo (não-confiável, tolerante à forma), render do checklist e o run da
// tool (porta opcional). PURO/determinístico — sem Ink/IO.

import { describe, expect, it, vi } from 'vitest';
import {
  PLAN_TOOL,
  normalizePlanInput,
  renderPlanChecklist,
  syncPlanToGraph,
  projectPlanFromGraph,
  renderPlanChecklistFromGraph,
  MAX_PLAN_STEPS,
  MAX_STEP_TITLE,
  type PlanStep,
  type PlanPort,
} from '../../src/agent/tools/plan.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { ContextGraph } from '../../src/agent/maestro/context-box-graph.js';
import type { BoxSnapshot } from '../../src/agent/maestro/context-box-graph.js';

function portsWith(plan?: PlanPort, graph?: ContextGraph): ToolPorts {
  return {
    fs: {
      async readFile() {
        return '';
      },
      async writeFile() {},
      async exists() {
        return false;
      },
    },
    shell: {
      async exec() {
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    },
    search: {
      async search() {
        return [];
      },
    },
    ...(plan ? { plan } : {}),
    ...(graph ? { graph } : {}),
  } as ToolPorts;
}

describe('plan — normalizePlanInput (input do modelo, não-confiável)', () => {
  it('aceita objetos {title,status} e valida o status', () => {
    const r = normalizePlanInput({
      steps: [
        { title: 'ler o código', status: 'completed' },
        { title: 'escrever o fix', status: 'in_progress' },
        { title: 'rodar testes', status: 'pending' },
      ],
    });
    expect('steps' in r && r.steps).toEqual([
      { title: 'ler o código', status: 'completed' },
      { title: 'escrever o fix', status: 'in_progress' },
      { title: 'rodar testes', status: 'pending' },
    ]);
  });

  it('tolera STRINGS (vira passo pending) e aliases de campo/lista', () => {
    expect(normalizePlanInput({ steps: ['passo um', 'passo dois'] })).toEqual({
      steps: [
        { title: 'passo um', status: 'pending' },
        { title: 'passo dois', status: 'pending' },
      ],
    });
    // alias de lista (plan/todos/items) + alias de título (step/text/name)
    expect(normalizePlanInput({ plan: [{ step: 'x' }] })).toEqual({
      steps: [{ title: 'x', status: 'pending' }],
    });
    expect(normalizePlanInput({ todos: [{ name: 'y' }] })).toEqual({
      steps: [{ title: 'y', status: 'pending' }],
    });
  });

  it('status inválido ⇒ pending (não confia no rótulo do modelo)', () => {
    const r = normalizePlanInput({ steps: [{ title: 'a', status: 'DONE!!' }] });
    expect('steps' in r && r.steps[0]!.status).toBe('pending');
  });

  it('rejeita lista ausente/não-lista, vazia, e passo sem título', () => {
    expect('error' in normalizePlanInput({})).toBe(true);
    expect('error' in normalizePlanInput({ steps: 'nope' })).toBe(true);
    expect('error' in normalizePlanInput({ steps: [] })).toBe(true);
    expect('error' in normalizePlanInput({ steps: [{ status: 'pending' }] })).toBe(true);
    expect('error' in normalizePlanInput({ steps: ['   '] })).toBe(true); // título só-espaço
  });

  it('aplica tetos: nº de passos e tamanho do título', () => {
    const many = Array.from({ length: MAX_PLAN_STEPS + 1 }, (_, i) => `p${i}`);
    expect('error' in normalizePlanInput({ steps: many })).toBe(true);
    const long = 'x'.repeat(MAX_STEP_TITLE + 50);
    const r = normalizePlanInput({ steps: [long] });
    expect('steps' in r && r.steps[0]!.title.length).toBe(MAX_STEP_TITLE);
  });

  it('parseia sub-passos (substeps/subtasks/subpassos/children) — 1 nível', () => {
    const r = normalizePlanInput({
      steps: [
        {
          title: 'passo pai',
          status: 'in_progress',
          substeps: [
            { title: 'sub 1', status: 'completed' },
            'sub 2', // string também vira sub-passo pending
          ],
        },
        { title: 'passo solto' },
      ],
    });
    expect('steps' in r).toBe(true);
    if (!('steps' in r)) return;
    expect(r.steps[0]!.substeps).toEqual([
      { title: 'sub 1', status: 'completed' },
      { title: 'sub 2', status: 'pending' },
    ]);
    expect(r.steps[1]!.substeps).toBeUndefined();
    // alias `subtasks` funciona igual
    const r2 = normalizePlanInput({ steps: [{ title: 'p', subtasks: [{ title: 's' }] }] });
    expect('steps' in r2 && r2.steps[0]!.substeps?.[0]!.title).toBe('s');
  });

  it('sub-passo aninha só 1 nível (substeps de substeps são ignorados)', () => {
    const r = normalizePlanInput({
      steps: [
        {
          title: 'pai',
          substeps: [{ title: 'filho', substeps: [{ title: 'neto' }] }],
        },
      ],
    });
    expect('steps' in r && r.steps[0]!.substeps?.[0]!.title).toBe('filho');
    // o "neto" não vira sub-sub-passo (achatamento de profundidade 1).
    expect(
      'steps' in r && (r.steps[0]!.substeps?.[0] as { substeps?: unknown }).substeps,
    ).toBeUndefined();
  });

  it('o teto de passos conta o TOTAL achatado (passos + sub-passos)', () => {
    // 1 pai + MAX sub-passos = MAX+1 no total achatado ⇒ rejeita.
    const subs = Array.from({ length: MAX_PLAN_STEPS }, (_, i) => `s${i}`);
    const r = normalizePlanInput({ steps: [{ title: 'pai', substeps: subs }] });
    expect('error' in r).toBe(true);
  });

  it('sub-passo sem título é rejeitado (erro propaga do nível filho)', () => {
    const r = normalizePlanInput({ steps: [{ title: 'pai', substeps: [{ status: 'pending' }] }] });
    expect('error' in r).toBe(true);
  });
});

describe('plan — renderPlanChecklist', () => {
  it('mostra progresso (feitos/total) + glifo por status', () => {
    const steps: PlanStep[] = [
      { title: 'a', status: 'completed' },
      { title: 'b', status: 'in_progress' },
      { title: 'c', status: 'pending' },
    ];
    const out = renderPlanChecklist(steps);
    expect(out).toContain('plano (1/3):');
    expect(out).toContain('☑ a');
    expect(out).toContain('▶ b');
    expect(out).toContain('☐ c');
  });
});

describe('plan — PLAN_TOOL.run', () => {
  it('effect read + nome update_plan (silent-allow, sem efeito externo)', () => {
    expect(PLAN_TOOL.name).toBe('update_plan');
    expect(PLAN_TOOL.effect).toBe('read');
  });

  it('run válido ⇒ ok + checklist na observação E empurra à PORTA (substitui o plano inteiro)', async () => {
    const set = vi.fn();
    const res = await PLAN_TOOL.run(
      { steps: [{ title: 'fazer X', status: 'in_progress' }, 'fazer Y'] },
      portsWith({ set }),
    );
    expect(res.ok).toBe(true);
    expect(res.observation).toContain('plano (0/2):');
    expect(res.observation).toContain('▶ fazer X');
    expect(set).toHaveBeenCalledWith([
      { title: 'fazer X', status: 'in_progress' },
      { title: 'fazer Y', status: 'pending' },
    ]);
  });

  it('SEM porta de plano: ainda funciona (observação), não quebra (não-regressão)', async () => {
    const res = await PLAN_TOOL.run({ steps: ['só um passo'] }, portsWith());
    expect(res.ok).toBe(true);
    expect(res.observation).toContain('☐ só um passo');
  });

  it('input inválido ⇒ ok:false com erro acionável, NÃO toca a porta', async () => {
    const set = vi.fn();
    const res = await PLAN_TOOL.run({ steps: [] }, portsWith({ set }));
    expect(res.ok).toBe(false);
    expect(res.observation).toMatch(/vazia|passos/i);
    expect(set).not.toHaveBeenCalled();
  });
});

// ── EST-1126 · CA-PROJ-NOREG — não-regressão (sem grafo, render flat) ──────
describe('EST-1126 — CA-PROJ-NOREG (não-regressão sem grafo)', () => {
  it('sem porta graph, render é o flat clássico (byte-a-byte como antes)', async () => {
    const res = await PLAN_TOOL.run(
      { steps: [{ title: 'fazer X', status: 'in_progress' }, 'fazer Y'] },
      portsWith(),
    );
    expect(res.ok).toBe(true);
    // Render flat clássico: sem marcadores de horizonte, sem indentação extra.
    expect(res.observation).toContain('plano (0/2):');
    expect(res.observation).toContain('▶ fazer X');
    expect(res.observation).toContain('☐ fazer Y');
    // NÃO deve conter marcadores de horizonte.
    expect(res.observation).not.toContain('[📐]');
    expect(res.observation).not.toContain('[📋]');
    expect(res.observation).not.toContain('[📌]');
  });

  it('sem porta graph, PlanPort ainda recebe os passos', async () => {
    const set = vi.fn();
    const res = await PLAN_TOOL.run({ steps: ['passo A', 'passo B'] }, portsWith({ set }));
    expect(res.ok).toBe(true);
    expect(set).toHaveBeenCalledWith([
      { title: 'passo A', status: 'pending' },
      { title: 'passo B', status: 'pending' },
    ]);
  });
});

// ── EST-1126 · CA-PROJ-1 — projeção com horizonte e aninhamento ─────────────
describe('EST-1126 — CA-PROJ-1 (projeção do grafo: horizonte + aninhamento)', () => {
  function freshGraph(): ContextGraph {
    let t = 0;
    return new ContextGraph({ clock: () => (t += 1) });
  }

  it('render com grafo: heurística de horizonte (foco curto, futuro longo)', async () => {
    const graph = freshGraph();
    const res = await PLAN_TOOL.run(
      {
        steps: [
          { title: 'Trabalho atual', status: 'in_progress' },
          { title: 'Trabalho futuro', status: 'pending' },
        ],
      },
      portsWith(undefined, graph),
    );
    expect(res.ok).toBe(true);
    const lines = res.observation.split('\n');
    const atual = lines.find((l) => l.includes('Trabalho atual'))!;
    const futuro = lines.find((l) => l.includes('Trabalho futuro'))!;
    // in_progress → foco (curto 📌); passo posterior ainda não iniciado → horizonte (longo 📐).
    expect(atual).toContain('[📌]');
    expect(atual).toContain('▶ Trabalho atual');
    expect(futuro).toContain('[📐]');
    expect(futuro).toContain('☐ Trabalho futuro');
  });

  it('syncPlanToGraph espelha status completed ⇒ fecha a caixa', () => {
    const graph = freshGraph();
    syncPlanToGraph(
      [
        { title: 'Fazer X', status: 'completed' },
        { title: 'Fazer Y', status: 'pending' },
      ],
      graph,
    );
    const boxXId = ContextGraph.boxId('Fazer X', 0);
    const boxYId = ContextGraph.boxId('Fazer Y', 0);
    expect(graph.isClosed(boxXId)).toBe(true);
    expect(graph.isClosed(boxYId)).toBe(false);
    expect(graph.getBox(boxXId)).not.toBeNull();
    expect(graph.getBox(boxYId)).not.toBeNull();
  });

  it('projectPlanFromGraph devolve PlanStep[] a partir das caixas do grafo', () => {
    const graph = freshGraph();
    graph.openBox(ContextGraph.boxId('A', 0), 'médio', 'A');
    graph.openBox(ContextGraph.boxId('B', 0), 'curto', 'B');
    graph.openBox(ContextGraph.boxId('C', 0), 'médio', 'C');
    graph.closeBox(ContextGraph.boxId('C', 0)); // C está concluída

    const steps = projectPlanFromGraph(graph);
    expect(steps).toHaveLength(3);
    expect(steps.find((s) => s.title === 'A')!.status).toBe('pending');
    expect(steps.find((s) => s.title === 'B')!.status).toBe('pending');
    expect(steps.find((s) => s.title === 'C')!.status).toBe('completed');
  });

  it('HUNT-GRAFO: containment CÍCLICO (escapado) NÃO estoura a pilha — degrada gracioso', () => {
    // `setParent` impede ciclo por construção, mas `projectPlanFromGraph` só consome
    // `listBoxes()`. Defesa-em-profundidade (igual ao `getContextChain`): um ciclo que
    // ESCAPASSE deve degradar, não derrubar o CLI com RangeError no `getDepth` recursivo.
    const mk = (id: string, parentId: string, createdAt: number): BoxSnapshot => ({
      id,
      horizon: 'curto',
      label: id,
      parentId,
      children: [],
      dependencies: [],
      pinned: false,
      closed: false,
      createdAt,
      lastAccessedAt: createdAt,
      accessCount: 0,
      contextSize: 0,
    });
    // A.parent=B, B.parent=A (ciclo de 2). Grafo-fake: só `listBoxes` é consumido.
    const cyclic = [mk('A', 'B', 1), mk('B', 'A', 2)];
    const fakeGraph = { listBoxes: () => cyclic } as unknown as ContextGraph;

    // ANTES do fix: RangeError "Maximum call stack size exceeded".
    const steps = projectPlanFromGraph(fakeGraph);
    expect(steps.map((s) => s.title).sort()).toEqual(['A', 'B']);
  });

  // HUNT-GRAFO (render WIRED) — o `renderPlanChecklistFromGraph` (plan.ts:468, a OBSERVAÇÃO
  // que o update_plan devolve ao modelo) tem seu PRÓPRIO `getDepth` recursivo, DISTINTO do
  // `projectPlanFromGraph` coberto acima. O guard (`seen` + `!box`) também vive lá — mas só
  // a projeção era provada contra ciclo. Estes 2 casos blindam o render WIRED: um ciclo
  // escapado OU um pai dangling (pai removido via removeBox, filho com parentId pendurado)
  // NÃO podem dar RangeError/loop e crashar o turno do update_plan.
  const mkBox = (id: string, parentId: string | null): BoxSnapshot => ({
    id,
    horizon: 'curto',
    label: id,
    parentId,
    children: [],
    dependencies: [],
    pinned: false,
    closed: false,
    createdAt: 1,
    lastAccessedAt: 1,
    accessCount: 0,
    contextSize: 0,
  });

  it('render WIRED: containment CÍCLICO escapado NÃO estoura a pilha (getDepth do render)', () => {
    // A.parent=B, B.parent=A — ciclo de 2 (grafo-fake; só listBoxes é consumido).
    const cyclic = [mkBox('A', 'B'), mkBox('B', 'A')];
    const fakeGraph = { listBoxes: () => cyclic } as unknown as ContextGraph;
    const steps: PlanStep[] = [
      { title: 'A', status: 'pending' },
      { title: 'B', status: 'in_progress' },
    ];
    // ANTES (sem `seen` no getDepth do render): RangeError. Agora: string, sem throw.
    let out = '';
    expect(() => {
      out = renderPlanChecklistFromGraph(steps, fakeGraph);
    }).not.toThrow();
    expect(out).toContain('A');
    expect(out).toContain('B');
  });

  it('render WIRED: parentId DANGLING (pai removido) ⇒ profundidade degrada, sem loop', () => {
    // 'filho' aponta p/ 'pai-fantasma' AUSENTE de listBoxes (o pai foi removido via
    // removeBox, que não re-parenteia os filhos — parentId fica pendurado). O getDepth
    // recursivo deve PARAR (byId.get(parentId) = undefined ⇒ `!box` ⇒ 0), não pendurar.
    const boxes = [mkBox('filho', 'pai-fantasma')];
    const fakeGraph = { listBoxes: () => boxes } as unknown as ContextGraph;
    const steps: PlanStep[] = [{ title: 'filho', status: 'in_progress' }];
    let out = '';
    expect(() => {
      out = renderPlanChecklistFromGraph(steps, fakeGraph);
    }).not.toThrow();
    expect(out).toContain('filho');
  });

  it('render com aninhamento: sub-passos do INPUT viram caixas-filhas indentadas', async () => {
    const graph = freshGraph();
    // O containment nasce dos `substeps` do próprio update_plan (caminho do runtime).
    const res = await PLAN_TOOL.run(
      {
        steps: [
          {
            title: 'Trabalho principal',
            status: 'in_progress',
            substeps: [{ title: 'Subtarefa', status: 'pending' }],
          },
        ],
      },
      portsWith(undefined, graph),
    );
    expect(res.ok).toBe(true);
    const lines = res.observation.split('\n');
    const paiLine = lines.find((l) => l.includes('Trabalho principal'))!;
    const filhaLine = lines.find((l) => l.includes('Subtarefa'))!;
    // Pai sem indentação, filha com 2 espaços.
    expect(paiLine).not.toMatch(/^ {2}/);
    expect(filhaLine).toMatch(/^ {2}/);
    // E a aresta de containment existe MESMO no grafo (não é só render).
    const paiId = ContextGraph.boxId('Trabalho principal', 0);
    const filhaId = ContextGraph.boxId('Subtarefa', 0);
    expect(graph.getBox(filhaId)!.parentId).toBe(paiId);
    expect(graph.getBox(paiId)!.children).toContain(filhaId);
  });

  it('heurística reclassifica horizonte ao AVANÇAR o plano (mesmo grafo)', async () => {
    const graph = freshGraph();
    const ports = portsWith(undefined, graph);
    // Passo 1 em curso, passo 2 no horizonte.
    await PLAN_TOOL.run(
      {
        steps: [
          { title: 'Etapa A', status: 'in_progress' },
          { title: 'Etapa B', status: 'pending' },
        ],
      },
      ports,
    );
    expect(graph.getBox(ContextGraph.boxId('Etapa A', 0))!.horizon).toBe('curto');
    expect(graph.getBox(ContextGraph.boxId('Etapa B', 0))!.horizon).toBe('longo');

    // Avança: A concluída, B agora em curso → horizonte deve TROCAR.
    await PLAN_TOOL.run(
      {
        steps: [
          { title: 'Etapa A', status: 'completed' },
          { title: 'Etapa B', status: 'in_progress' },
        ],
      },
      ports,
    );
    expect(graph.getBox(ContextGraph.boxId('Etapa A', 0))!.horizon).toBe('médio'); // já passou
    expect(graph.getBox(ContextGraph.boxId('Etapa B', 0))!.horizon).toBe('curto'); // foco agora
    expect(graph.isClosed(ContextGraph.boxId('Etapa A', 0))).toBe(true);
  });
});

// ── EST-1126 · CA-PROJ-UNICA — plano e grafo são a mesma verdade ───────────
describe('EST-1126 — CA-PROJ-UNICA (plano e grafo são a mesma verdade)', () => {
  function freshGraph(): ContextGraph {
    let t = 0;
    return new ContextGraph({ clock: () => (t += 1) });
  }

  it('após update_plan, as caixas do grafo refletem os passos (mesma verdade)', async () => {
    const graph = freshGraph();
    await PLAN_TOOL.run(
      {
        steps: [
          { title: 'Ler código', status: 'completed' },
          { title: 'Escrever fix', status: 'in_progress' },
          { title: 'Rodar testes', status: 'pending' },
        ],
      },
      portsWith(undefined, graph),
    );

    // Projeta o grafo: deve bater com os passos declarados.
    const projected = projectPlanFromGraph(graph);
    expect(projected).toHaveLength(3);
    expect(projected.find((s) => s.title === 'Ler código')!.status).toBe('completed');
    expect(projected.find((s) => s.title === 'Escrever fix')!.status).toBe('pending'); // aberta ≠ completed
    expect(projected.find((s) => s.title === 'Rodar testes')!.status).toBe('pending');
  });

  it('plan e grafo não divergem: toda caixa do plano existe no grafo', async () => {
    const graph = freshGraph();
    await PLAN_TOOL.run({ steps: ['Passo 1', 'Passo 2', 'Passo 3'] }, portsWith(undefined, graph));

    // Cada passo DEVE ter virado uma caixa.
    for (const label of ['Passo 1', 'Passo 2', 'Passo 3']) {
      const boxId = ContextGraph.boxId(label, 0);
      expect(graph.getBox(boxId)).not.toBeNull();
    }
    expect(graph.listBoxes()).toHaveLength(3);
  });

  it('re-chamada de update_plan re-sincroniza (fecha caixas concluídas)', async () => {
    const graph = freshGraph();
    // Primeira chamada: tudo pending.
    await PLAN_TOOL.run({ steps: ['A', 'B'] }, portsWith(undefined, graph));
    expect(graph.isClosed(ContextGraph.boxId('A', 0))).toBe(false);
    expect(graph.isClosed(ContextGraph.boxId('B', 0))).toBe(false);

    // Segunda chamada: A concluído, B continua.
    await PLAN_TOOL.run(
      {
        steps: [
          { title: 'A', status: 'completed' },
          { title: 'B', status: 'pending' },
        ],
      },
      portsWith(undefined, graph),
    );
    expect(graph.isClosed(ContextGraph.boxId('A', 0))).toBe(true);
    expect(graph.isClosed(ContextGraph.boxId('B', 0))).toBe(false);
  });
});

describe('F86 — syncPlanToGraph PODA caixas órfãs (sem acumulador sem teto)', () => {
  function freshGraph(): ContextGraph {
    let t = 0;
    return new ContextGraph({ clock: () => (t += 1) });
  }

  it('plano que troca de passos ⇒ o grafo espelha SÓ o plano atual (órfãs removidas)', () => {
    const graph = freshGraph();
    syncPlanToGraph(
      [
        { title: 'A', status: 'completed' },
        { title: 'B', status: 'pending' },
        { title: 'C', status: 'pending' },
      ],
      graph,
    );
    expect(graph.listBoxes()).toHaveLength(3);

    // Plano totalmente novo (re-planejamento) — A/B/C sumiram.
    syncPlanToGraph(
      [
        { title: 'X', status: 'in_progress' },
        { title: 'Y', status: 'pending' },
      ],
      graph,
    );
    const labels = graph
      .listBoxes()
      .map((b) => b.label)
      .sort();
    expect(labels).toEqual(['X', 'Y']); // A/B/C podadas — não vazaram.
  });

  it('caixa órfã de horizonte `longo` TAMBÉM é podada (removeBox ignora a trava de forceEvict)', () => {
    const graph = freshGraph();
    // "Futuro" fica longe do in_progress ⇒ horizonte longo.
    syncPlanToGraph(
      [
        { title: 'Atual', status: 'in_progress' },
        { title: 'Futuro distante', status: 'pending' },
      ],
      graph,
    );
    const futuroId = ContextGraph.boxId('Futuro distante', 0);
    expect(graph.getBox(futuroId)?.horizon).toBe('longo'); // confirma a trava do forceEvict.
    // forceEvict RECUSARIA (longo); mas a poda usa removeBox ⇒ remove mesmo assim.
    syncPlanToGraph([{ title: 'Atual', status: 'in_progress' }], graph);
    expect(graph.getBox(futuroId)).toBeNull(); // podada apesar do horizonte longo.
    expect(graph.listBoxes()).toHaveLength(1);
  });

  it('N updates com títulos sempre novos ⇒ o grafo NÃO cresce sem limite', () => {
    const graph = freshGraph();
    for (let i = 0; i < 30; i++) {
      syncPlanToGraph([{ title: `passo-${i}`, status: 'in_progress' }], graph);
    }
    // Sem a poda seriam 30 caixas (acumulador). Com a poda, só a atual.
    expect(graph.listBoxes()).toHaveLength(1);
    expect(graph.listBoxes()[0]!.label).toBe('passo-29');
  });

  it('passo que SOBREVIVE entre updates mantém a MESMA caixa (não é podado nem recriado)', () => {
    const graph = freshGraph();
    syncPlanToGraph(
      [
        { title: 'fica', status: 'in_progress' },
        { title: 'vai', status: 'pending' },
      ],
      graph,
    );
    const ficaId = graph.listBoxes().find((b) => b.label === 'fica')!.id;
    syncPlanToGraph([{ title: 'fica', status: 'in_progress' }], graph);
    const after = graph.listBoxes();
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(ficaId); // mesma caixa, preservada.
  });
});

// HUNT-GRAFO — títulos DUPLICADOS colidiam no boxId determinístico (slug-0): a
// projeção do grafo fundia os homônimos numa caixa só ⇒ o horizonte de um (ex.: o
// in_progress 📌) era CLOBBERADO. Desambiguados como o spawn_agent faz com labels.
describe('plan — desambiguação de títulos duplicados (anti-colisão de boxId)', () => {
  it('títulos repetidos ganham " #2", " #3"… (1º fica)', () => {
    const r = normalizePlanInput({
      steps: [
        { title: 'Testar', status: 'in_progress' },
        { title: 'Testar', status: 'pending' },
        { title: 'Testar', status: 'pending' },
      ],
    });
    expect('steps' in r).toBe(true);
    const titles = (r as { steps: PlanStep[] }).steps.map((s) => s.title);
    expect(titles).toEqual(['Testar', 'Testar #2', 'Testar #3']);
  });

  it('homônimo pending NÃO clobbera o horizonte CURTO do passo in_progress no grafo', () => {
    const r = normalizePlanInput({
      steps: [
        { title: 'Testar', status: 'in_progress' }, // 📌 curto
        { title: 'Testar', status: 'pending' }, // vira "Testar #2" — caixa própria
      ],
    });
    const steps = (r as { steps: PlanStep[] }).steps;
    const g = new ContextGraph();
    syncPlanToGraph(steps, g);
    const boxes = g.listBoxes();
    // O in_progress mantém CURTO (não foi sobrescrito pelo homônimo).
    expect(boxes.find((b) => b.label === 'Testar')?.horizon).toBe('curto');
    // O duplicata é uma caixa SEPARADA (não fundida).
    expect(boxes.find((b) => b.label === 'Testar #2')).toBeDefined();
  });

  it('dedup é DETERMINÍSTICO entre updates (re-emitir o mesmo plano ⇒ mesmos títulos)', () => {
    const input = {
      steps: [
        { title: 'X', status: 'pending' },
        { title: 'X', status: 'pending' },
      ],
    };
    const a = (normalizePlanInput(input) as { steps: PlanStep[] }).steps.map((s) => s.title);
    const b = (normalizePlanInput(input) as { steps: PlanStep[] }).steps.map((s) => s.title);
    expect(a).toEqual(['X', 'X #2']);
    expect(b).toEqual(a);
  });
});

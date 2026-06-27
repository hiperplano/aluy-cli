// EST-1126 · ADR-0123 §4 — PROVA DE FIO do grafo de caixas ligado ao `update_plan`.
//
// O VALOR FELT: hoje o `update_plan` renderiza uma lista FLAT. Com o ContextGraph
// injetado por sessão (`ports.graph`), o plano vira HIERÁRQUICO — sub-tarefas
// indentadas sob os pais + marcadores de horizonte ([📐]/[📋]/[📌]).
//
// Provas (sem placebo, sem `|| true`):
//   1. buildSession injeta um ContextGraph real em ports.graph (o fio existe).
//   2. POSITIVA — com o grafo da sessão sincronizado (pai + filha), o `update_plan`
//      produz observação INDENTADA + marcador de horizonte (≠ flat).
//   3. NEGATIVA — SEM o sync (ports sem graph), o MESMO `update_plan` cai no render
//      flat clássico: sem indentação, sem marcador de horizonte.

import { describe, expect, it } from 'vitest';
import { NATIVE_TOOLS, ContextGraph, type NativeTool, type ToolPorts } from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

/** Acha a tool `update_plan` no conjunto nativo (a MESMA que o loop usa). */
function planTool(): NativeTool<ToolPorts> {
  const t = NATIVE_TOOLS.find((x) => x.name === 'update_plan');
  if (!t) throw new Error('update_plan não está em NATIVE_TOOLS');
  return t;
}

describe('EST-1126 · grafo de caixas wired ao update_plan (buildSession)', () => {
  it('1 — buildSession injeta um ContextGraph real em ports.graph', () => {
    const s = buildSession({ env: {} });
    expect(s.ports.graph).toBeInstanceOf(ContextGraph);
  });

  it('2 — POSITIVA: update_plan com sub-passos vira plano hierárquico + horizonte (caminho REAL)', async () => {
    const s = buildSession({ env: {} });
    expect(s.ports.graph).toBeInstanceOf(ContextGraph);

    // EST-1126 — o containment nasce dos `substeps` do PRÓPRIO update_plan (não
    // de pré-semeadura): é o caminho que o agente realmente percorre no runtime.
    const res = await planTool().run(
      {
        steps: [
          {
            title: 'Construir feature',
            status: 'in_progress',
            substeps: [{ title: 'Escrever testes', status: 'pending' }],
          },
          { title: 'Publicar release', status: 'pending' },
        ],
      },
      s.ports,
    );

    expect(res.ok).toBe(true);
    const lines = res.observation.split('\n');
    const paiLine = lines.find((l) => l.includes('Construir feature'))!;
    const filhaLine = lines.find((l) => l.includes('Escrever testes'))!;
    const futuroLine = lines.find((l) => l.includes('Publicar release'))!;

    // Pai sem indentação; filha indentada (2 espaços) — HIERARQUIA visível.
    expect(paiLine).not.toMatch(/^ {2}/);
    expect(filhaLine).toMatch(/^ {2}/);
    // Heurística de horizonte: foco (in_progress) curto [📌]; futuro distante longo [📐].
    expect(paiLine).toContain('📌'); // in_progress → foco
    expect(filhaLine).toContain('📌'); // sub-passo do foco → também perto
    expect(futuroLine).toContain('📐'); // passo posterior ainda não iniciado → horizonte

    // E a aresta de containment existe DE FATO no grafo da sessão (não é só render).
    const filhaBox = s.ports.graph!.getBox(ContextGraph.boxId('Escrever testes', 0));
    expect(filhaBox!.parentId).toBe(ContextGraph.boxId('Construir feature', 0));
  });

  it('3 — NEGATIVA: SEM o grafo (ports sem graph), o MESMO update_plan cai no flat', async () => {
    const s = buildSession({ env: {} });
    // Remove a porta graph ⇒ força o fallback flat (não-regressão EST-1015).
    const portsSemGrafo: ToolPorts = { ...s.ports, graph: undefined };

    const res = await planTool().run(
      {
        steps: [
          { title: 'Construir feature', status: 'in_progress' },
          { title: 'Escrever testes', status: 'pending' },
        ],
      },
      portsSemGrafo,
    );

    expect(res.ok).toBe(true);
    const out = res.observation;
    // Flat: NENHUM marcador de horizonte e NENHUMA linha indentada.
    expect(out).not.toContain('📐');
    expect(out).not.toContain('📋');
    expect(out).not.toContain('📌');
    expect(out.split('\n').some((l) => /^ {2}/.test(l))).toBe(false);
  });
});

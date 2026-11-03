// Dica de delegação: plano com >= 3 passos independentes + execução em série ⇒ UMA dica
// `reanchor` (canal `assistant`, trusted). Nunca em tarefa trivial, no máx. uma vez, desligável.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import {
  DELEGATION_NUDGE_MARKER,
  DelegationNudger,
  countIndependentSteps,
  delegationNudgeEnabled,
} from '../../src/agent/delegation-nudge.js';
import { normalizePlanInput } from '../../src/agent/tools/plan.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

const registry = (): ToolRegistry<ToolPorts> => new ToolRegistry(NATIVE_TOOLS);

const PLAN3 = {
  steps: [
    { title: 'Criar src/a.ts', status: 'in_progress' },
    { title: 'Criar src/b.ts' },
    { title: 'Criar src/c.ts' },
  ],
};

describe('heurística de independência (pura)', () => {
  it('passos com arquivos distintos contam; compartilhando arquivo não', () => {
    const p = normalizePlanInput(PLAN3);
    expect('steps' in p && countIndependentSteps(p.steps)).toBe(3);
    const q = normalizePlanInput({
      steps: ['Editar src/a.ts', 'Testar src/a.ts', 'Documentar'],
    });
    expect('steps' in q && countIndependentSteps(q.steps)).toBe(0);
  });

  it('parallel:true / owner:subagente marcam o passo', () => {
    const p = normalizePlanInput({
      steps: [
        { title: 'Auditar módulo de auth', parallel: true },
        { title: 'Auditar módulo de billing', owner: 'subagente' },
        { title: 'Auditar módulo de infra', parallel: true },
      ],
    });
    expect('steps' in p && countIndependentSteps(p.steps)).toBe(3);
  });

  it('env: default ligada; 0/off desliga', () => {
    expect(delegationNudgeEnabled(undefined)).toBe(true);
    expect(delegationNudgeEnabled('0')).toBe(false);
    expect(delegationNudgeEnabled('off')).toBe(false);
    expect(delegationNudgeEnabled('1')).toBe(true);
  });

  it('nudger: dispara 1x após plano>=3 + execução; leitura e spawn_agent não disparam', () => {
    const n = new DelegationNudger();
    expect(n.note('update_plan', PLAN3, true)).toBeUndefined();
    expect(n.note('read_file', {}, true)).toBeUndefined();
    expect(n.note('write_file', {}, true)).toContain(DELEGATION_NUDGE_MARKER);
    expect(n.note('write_file', {}, true)).toBeUndefined();
    const d = new DelegationNudger();
    d.note('update_plan', PLAN3, true);
    d.note('spawn_agent', {}, true);
    expect(d.note('write_file', {}, true)).toBeUndefined();
    const small = new DelegationNudger();
    small.note('update_plan', { steps: ['Criar src/a.ts', 'Criar src/b.ts'] }, true);
    expect(small.note('write_file', {}, true)).toBeUndefined();
  });
});

function countNudges(model: ScriptedModelCaller): number {
  const last = model.calls[model.calls.length - 1]!;
  return last.messages.filter(
    (m) => m.role === 'assistant' && m.content.includes(DELEGATION_NUDGE_MARKER),
  ).length;
}

function script(): ScriptedModelCaller {
  return new ScriptedModelCaller([
    { text: toolCallBlock('update_plan', PLAN3) },
    { text: toolCallBlock('write_file', { path: 'src/a.ts', content: 'a' }) },
    { text: toolCallBlock('write_file', { path: 'src/b.ts', content: 'b' }) },
    { text: toolCallBlock('write_file', { path: 'src/c.ts', content: 'c' }) },
    { text: 'pronto.' },
  ]);
}

describe('dica de delegação no loop', () => {
  it('ligada: UMA dica no canal assistant (não user/system), a execução segue', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map()) });
    const model = script();
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      delegationNudge: true,
    });
    const res = await loop.run('crie a, b e c');
    expect(res.stop.kind).toBe('final');
    expect(countNudges(model)).toBe(1);
    const last = model.calls[model.calls.length - 1]!;
    expect(
      last.messages.some(
        (m) =>
          (m.role === 'user' || m.role === 'system') && m.content.includes(DELEGATION_NUDGE_MARKER),
      ),
    ).toBe(false);
  });

  it('desligada (default / env flag): nenhuma dica — baseline', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map()) });
    const model = script();
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
    });
    await loop.run('crie a, b e c');
    expect(countNudges(model)).toBe(0);
  });

  it('tarefa trivial (sem plano / plano pequeno): nenhuma dica', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map()) });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('write_file', { path: 'src/a.ts', content: 'a' }) },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      delegationNudge: true,
    });
    await loop.run('crie a');
    expect(countNudges(model)).toBe(0);
  });
});

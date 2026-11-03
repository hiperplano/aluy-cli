// Auditoria de cobertura — dica de delegação: condições finas de disparo e "uma por turno".
// Complementa `delegation-nudge.test.ts` (heurística + caminho feliz no loop).

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { DELEGATION_NUDGE_MARKER, DelegationNudger } from '../../src/agent/delegation-nudge.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

const PLAN3 = {
  steps: [
    { title: 'Criar src/a.ts', status: 'in_progress' },
    { title: 'Criar src/b.ts' },
    { title: 'Criar src/c.ts' },
  ],
};

describe('dica de delegação · condições de disparo', () => {
  it('plano que FALHOU (ok=false) não arma a dica', () => {
    const n = new DelegationNudger();
    expect(n.note('update_plan', PLAN3, false)).toBeUndefined();
    expect(n.note('write_file', {}, true)).toBeUndefined();
  });

  it('só passos ABERTOS contam: 2 abertos + 1 concluído não dispara', () => {
    const n = new DelegationNudger();
    n.note(
      'update_plan',
      {
        steps: [
          { title: 'Criar src/a.ts', status: 'completed' },
          { title: 'Criar src/b.ts', status: 'in_progress' },
          { title: 'Criar src/c.ts' },
        ],
      },
      true,
    );
    expect(n.note('write_file', {}, true)).toBeUndefined();
  });

  it('um replano menor DESARMA: vale o último plano', () => {
    const n = new DelegationNudger();
    n.note('update_plan', PLAN3, true);
    n.note('update_plan', { steps: ['Criar src/a.ts'] }, true);
    expect(n.note('write_file', {}, true)).toBeUndefined();
  });

  it('tools de meta/leitura/delegação não contam como "executar" e não gastam a dica', () => {
    for (const nome of ['grep', 'glob', 'agent_send', 'agents_status', 'perguntar']) {
      const n = new DelegationNudger();
      n.note('update_plan', PLAN3, true);
      expect(n.note(nome, {}, true)).toBeUndefined();
      expect(n.note('write_file', {}, true)).toContain(DELEGATION_NUDGE_MARKER);
    }
  });

  it('o texto cita a contagem real de passos independentes', () => {
    const n = new DelegationNudger();
    n.note('update_plan', PLAN3, true);
    expect(n.note('edit_file', {}, true)).toContain('tem 3 passos');
  });
});

describe('dica de delegação · uma por turno (execução do loop)', () => {
  const script = (): ScriptedModelCaller =>
    new ScriptedModelCaller([
      { text: toolCallBlock('update_plan', PLAN3) },
      { text: toolCallBlock('write_file', { path: 'src/a.ts', content: 'a' }) },
      { text: toolCallBlock('write_file', { path: 'src/b.ts', content: 'b' }) },
      { text: 'pronto.' },
    ]);
  const dicas = (m: ScriptedModelCaller): number =>
    m.calls[m.calls.length - 1]!.messages.filter((x) => x.content.includes(DELEGATION_NUDGE_MARKER))
      .length;

  it('várias execuções em série na mesma run: exatamente UMA dica', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map()) });
    const model = script();
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
      delegationNudge: true,
    });
    await loop.run('crie a e b');
    expect(dicas(model)).toBe(1);
  });

  it('o modelo que JÁ delega (spawn_agent) antes de executar não recebe a dica', async () => {
    const { ports } = makePorts({ fs: new MemoryFs(new Map()) });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('update_plan', PLAN3) },
      { text: toolCallBlock('spawn_agent', { agents: [{ label: 'x', objective: 'faça a' }] }) },
      { text: toolCallBlock('write_file', { path: 'src/b.ts', content: 'b' }) },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
      delegationNudge: true,
    });
    await loop.run('crie a, b e c');
    expect(dicas(model)).toBe(0);
  });
});

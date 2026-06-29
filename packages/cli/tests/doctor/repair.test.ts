// Auto-reparo dos sidecars — helpers do `/doctor fix` (agente-dirigido): logs + objetivo.
import { describe, expect, it } from 'vitest';
import {
  buildRepairGoal,
  gatherLogTails,
  defaultReadLogTail,
  SIDECAR_KINDS,
  type SidecarKind,
} from '../../src/doctor/repair.js';

describe('gatherLogTails', () => {
  it('coleta só os logs que existem (ausentes ficam de fora)', () => {
    const read = (k: SidecarKind) => (k === 'mem0' ? 'boom no mem0' : undefined);
    expect(gatherLogTails(SIDECAR_KINDS, read)).toEqual({ mem0: 'boom no mem0' });
  });
});

describe('buildRepairGoal', () => {
  it('com `down` conhecido ⇒ nomeia os alvos e manda diagnosticar+reparar', () => {
    const goal = buildRepairGoal({ down: ['mem0', 'headroom'] });
    expect(goal).toMatch(/mem0, headroom/);
    expect(goal).toMatch(/aluy bootstrap --no-agent/);
    expect(goal).toMatch(/aluy doctor/);
    // instrui a NÃO recursar no modo agente
    expect(goal).toMatch(/JÁ é o agente/);
  });

  it('sem `down` ⇒ manda o agente descobrir quais estão fora', () => {
    const goal = buildRepairGoal({});
    expect(goal).toMatch(/um ou mais complementos|estão fora/i);
    expect(goal).toMatch(/aluy doctor/);
  });

  it('anexa a cauda dos logs quando fornecida', () => {
    const goal = buildRepairGoal({
      down: ['mem0'],
      logTails: { mem0: "can't open file 'aluy-mem0-server.py'" },
    });
    expect(goal).toMatch(/~\/\.aluy\/logs\/mem0\.log/);
    expect(goal).toMatch(/can't open file/);
  });

  it('sem logs ⇒ não inclui a seção de logs', () => {
    const goal = buildRepairGoal({ down: ['ollama'] });
    expect(goal).not.toMatch(/Logs que já capturei/);
  });
});

describe('defaultReadLogTail', () => {
  it('arquivo ausente ⇒ undefined (best-effort)', () => {
    expect(defaultReadLogTail('mem0', 12, '/nao/existe/aluy')).toBeUndefined();
  });
});

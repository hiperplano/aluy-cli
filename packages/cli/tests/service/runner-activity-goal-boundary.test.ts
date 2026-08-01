// ADR-0158 §4.1 (FUNIL) — `buildActivityGoal`: fecha sobreviventes de MUTAÇÃO nos
// ternários `resumeContext !== undefined ? ... : ''` / `ownerSayContext !==
// undefined ? ... : ''` que `runner-activity-goal.test.ts` (arquivo PRÉ-EXISTENTE,
// não editado aqui) não distinguia — os testes de lá sempre CONTINHAM os textos
// esperados, mas nunca afirmavam a AUSÊNCIA de "undefined" quando os dois campos
// opcionais são omitidos (o que um `? true-branch : false-branch` forçado pra
// sempre "true" vazaria: `${undefined}\n\n`). Arquivo NOVO e SEPARADO.
import { describe, expect, it } from 'vitest';
import { buildActivityGoal } from '../../src/service/runner.js';

describe('buildActivityGoal — ausência de resumeContext/ownerSayContext nunca vaza "undefined"', () => {
  const base = {
    orchestratorPreamble: 'PREAMBULO',
    index: 0,
    total: 1,
  };

  it('nenhum dos dois presente ⇒ o goal é EXATAMENTE preâmbulo + cabeçalho (sem "undefined", sem linhas em branco extras)', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'x', goal: 'faça x', agent: undefined },
    });
    expect(goal).toBe('PREAMBULO\n\n[Atividade 1/1 do workflow — id "x"]\nfaça x');
    expect(goal).not.toContain('undefined');
  });

  it('só resumeContext presente (sem ownerSayContext) ⇒ EXATO, sem "undefined" vazando do outro campo', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'x', goal: 'faça x', agent: undefined },
      resumeContext: 'RETOMADA-X',
    });
    expect(goal).toBe('PREAMBULO\n\nRETOMADA-X\n\n[Atividade 1/1 do workflow — id "x"]\nfaça x');
    expect(goal).not.toContain('undefined');
  });

  it('só ownerSayContext presente (sem resumeContext) ⇒ EXATO, sem "undefined" vazando do outro campo', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'x', goal: 'faça x', agent: undefined },
      ownerSayContext: 'FALA-X',
    });
    expect(goal).toBe('PREAMBULO\n\nFALA-X\n\n[Atividade 1/1 do workflow — id "x"]\nfaça x');
    expect(goal).not.toContain('undefined');
  });

  it('atividade COM agente, nenhum dos dois presente ⇒ EXATO, sem preâmbulo, sem "undefined"', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'x', goal: 'faça x', agent: 'persona' },
    });
    expect(goal).toBe('[Atividade 1/1 do workflow — id "x"]\nfaça x');
    expect(goal).not.toContain('undefined');
    expect(goal).not.toContain('PREAMBULO');
  });
});

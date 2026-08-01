// ADR-0158 §11 (FASE 4 — attach) — `decideSayRouting`: a decisão PURA de para
// onde vai um evento `say` do socket de attach, extraída do handler `onSay` de
// `runServiceRunner` (que fechava sobre `currentPhase`/`pendingSay`/`localAnswers`
// — nada testável sem subir o runner inteiro). Ver `runner.ts`.
import { describe, expect, it } from 'vitest';
import { decideSayRouting } from '../../src/service/runner.js';

describe('decideSayRouting — PURA (ADR-0158 §11)', () => {
  it('texto vazio ⇒ ignore (nunca vira instrução/resposta vazia)', () => {
    expect(decideSayRouting('sleeping', '')).toEqual({ action: 'ignore' });
  });

  it('texto só com whitespace ⇒ ignore (trim reduz a vazio)', () => {
    expect(decideSayRouting('running-turn', '   \n\t  ')).toEqual({ action: 'ignore' });
    expect(decideSayRouting('awaiting-owner', '  ')).toEqual({ action: 'ignore' });
  });

  it('fase "awaiting-owner" ⇒ answer-local, com o texto TRIMADO e a logLine de ASK-ESPERA', () => {
    const decision = decideSayRouting('awaiting-owner', '  Sim, até 3 lotes.  ');
    expect(decision).toEqual({
      action: 'answer-local',
      text: 'Sim, até 3 lotes.',
      logLine: '[attach] "say" recebido durante ASK-ESPERA — tratado como resposta LOCAL do dono.',
    });
  });

  it('fase "sleeping" ⇒ queue, com a logLine de "vira instrução do PRÓXIMO despertar"', () => {
    const decision = decideSayRouting('sleeping', 'pare tudo amanhã');
    expect(decision.action).toBe('queue');
    expect(decision).toMatchObject({ text: 'pare tudo amanhã' });
    expect((decision as { logLine: string }).logLine).toContain('DORMINDO');
    expect((decision as { logLine: string }).logLine).toContain('PRÓXIMO despertar');
  });

  it('fase "running-turn" ⇒ queue, com a logLine de "turno EM ANDAMENTO" (degrade documentado)', () => {
    const decision = decideSayRouting('running-turn', 'atenção nisso');
    expect(decision.action).toBe('queue');
    expect((decision as { logLine: string }).logLine).toContain('EM ANDAMENTO');
    expect((decision as { logLine: string }).logLine).not.toContain('DORMINDO');
  });

  it('fase "running-turn" ⇒ a logLine é o texto EXATO completo (as DUAS metades concatenadas, sem truncar)', () => {
    const decision = decideSayRouting('running-turn', 'atenção nisso');
    expect(decision).toEqual({
      action: 'queue',
      text: 'atenção nisso',
      logLine:
        '[attach] "say" recebido com turno EM ANDAMENTO — entregue à PRÓXIMA atividade do ' +
        'workflow (degrade documentado — ADR-0158 §11: sem plumbing de mid-turno de verdade ' +
        'no processo-filho).',
    });
  });

  it('"queue" preserva o texto TRIMADO (espaços nas bordas removidos, meio preservado)', () => {
    const decision = decideSayRouting('sleeping', '  duas   palavras  ');
    expect(decision).toMatchObject({ action: 'queue', text: 'duas   palavras' });
  });
});

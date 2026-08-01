// ADR-0158 §4.1 (FUNIL) — fecha o DEGRADE #3 da rc.113: `buildActivityGoal`/
// `buildActivityEnv` (PURAS, extraídas de `runActivityTurn`) decidem o QUE vai no
// `goal`/`env` do turno-filho de UMA atividade. Antes, TODA atividade recebia o
// preâmbulo do orquestrador + (se `[agente]`) só uma DICA TEXTUAL ignorável. Agora:
// atividade COM `[agente]` ⇒ SEM preâmbulo do orquestrador + `ALUY_SERVICE_PERSONA`
// setada (TRAVA real, consumida por `run.tsx`); SEM `[agente]` ⇒ comportamento
// IDÊNTICO ao de antes (preâmbulo entra, sem env de persona).
import { describe, expect, it } from 'vitest';
import { buildActivityGoal, buildActivityEnv } from '../../src/service/runner.js';

describe('buildActivityGoal — PURA (ADR-0158 §4.1)', () => {
  const base = {
    orchestratorPreamble: 'Você coordena o serviço "trader" (ADR-0158) — rege, não opera:\nCORPO-ORQUESTRADOR',
    index: 0,
    total: 2,
  };

  it('atividade SEM [agente] ⇒ o preâmbulo do orquestrador ENTRA (comportamento de sempre)', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'abrir-book', goal: 'Abra o book do dia.', agent: undefined },
    });
    expect(goal).toContain('CORPO-ORQUESTRADOR');
    expect(goal).toContain('Abra o book do dia.');
    expect(goal).toContain('[Atividade 1/2 do workflow — id "abrir-book"]');
    // SEM dica de spawn_agent — atividade sem persona nunca teve isso.
    expect(goal).not.toContain('spawn_agent');
  });

  it('atividade COM [agente] ⇒ o preâmbulo do orquestrador NÃO entra (a atividade É da persona)', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'analisar', goal: 'Analise o momentum.', agent: 'estudo-momentum' },
    });
    expect(goal).not.toContain('CORPO-ORQUESTRADOR');
    expect(goal).not.toContain('rege, não opera');
    expect(goal).toContain('Analise o momentum.');
  });

  it('atividade COM [agente] ⇒ a DICA TEXTUAL de spawn_agent SAI do prompt (virou trava, não dica)', () => {
    const goal = buildActivityGoal({
      ...base,
      activity: { id: 'analisar', goal: 'Analise o momentum.', agent: 'estudo-momentum' },
    });
    expect(goal).not.toContain('spawn_agent');
    expect(goal).not.toContain('estudo-momentum'); // nome da persona não precisa mais aparecer no goal.
  });

  it('resumeContext/ownerSayContext entram ANTES do cabeçalho da atividade, com ou sem [agente]', () => {
    const withAgent = buildActivityGoal({
      ...base,
      activity: { id: 'x', goal: 'faça x', agent: 'risco' },
      resumeContext: 'RETOMADA: pergunta/resposta anexadas.',
      ownerSayContext: 'FALA DO DONO: pare.',
    });
    expect(withAgent.indexOf('RETOMADA')).toBeLessThan(withAgent.indexOf('[Atividade'));
    expect(withAgent.indexOf('FALA DO DONO')).toBeLessThan(withAgent.indexOf('[Atividade'));

    const withoutAgent = buildActivityGoal({
      ...base,
      activity: { id: 'x', goal: 'faça x', agent: undefined },
      resumeContext: 'RETOMADA: pergunta/resposta anexadas.',
    });
    expect(withoutAgent.indexOf('CORPO-ORQUESTRADOR')).toBeLessThan(withoutAgent.indexOf('RETOMADA'));
    expect(withoutAgent.indexOf('RETOMADA')).toBeLessThan(withoutAgent.indexOf('[Atividade'));
  });
});

describe('buildActivityEnv — PURA (ADR-0158 §4.1)', () => {
  it('sempre seta ALUY_SERVICE_HOME (§2, wiring escopado)', () => {
    const env = buildActivityEnv('/svc/trader', undefined, {});
    expect(env.ALUY_SERVICE_HOME).toBe('/svc/trader');
    expect(env.ALUY_SERVICE_PERSONA).toBeUndefined();
  });

  it('com agent definido ⇒ TAMBÉM seta ALUY_SERVICE_PERSONA (a trava real)', () => {
    const env = buildActivityEnv('/svc/trader', 'risco', {});
    expect(env.ALUY_SERVICE_HOME).toBe('/svc/trader');
    expect(env.ALUY_SERVICE_PERSONA).toBe('risco');
  });

  it('preserva o resto do baseEnv (herda process.env por padrão, sem apagar nada)', () => {
    const env = buildActivityEnv('/svc/trader', 'risco', { PATH: '/usr/bin', OUTRO: 'x' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.OUTRO).toBe('x');
    expect(env.ALUY_SERVICE_PERSONA).toBe('risco');
  });
});

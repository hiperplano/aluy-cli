// Auditoria — pontos das partes puras do eval que as mutações deixaram passar:
// ordem plano×efeito, parada por limite, exit code no veredito 'ok', 429 só por status,
// teto (<=) de planUpdatesMax, repetições com timeout contando e cenário sem run válida.
import { describe, expect, it } from 'vitest';
import { aggregateScenario, classifyOutcome, computeMetrics, scoreExpectations } from './lib.mjs';

const call = (name) => ({ type: 'tool_call', name, status: 'running' });
const res = (name) => ({ type: 'tool_result', name, status: 'done', exitCode: 0 });
const think = { type: 'phase', phase: 'thinking' };

describe('computeMetrics · ordem e parada', () => {
  it('plano DEPOIS do efeito não vale como "planejou antes"', () => {
    const m = computeMetrics([
      think,
      call('edit'),
      res('edit'),
      call('update_plan'),
      res('update_plan'),
    ]);
    expect(m.plan_chamado).toBe(true);
    expect(m.planejou_antes_do_efeito).toBe(false);
  });

  it('plano antes do efeito vale; sem nenhum efeito é null (não aplicável)', () => {
    const antes = computeMetrics([
      call('update_plan'),
      res('update_plan'),
      call('edit'),
      res('edit'),
    ]);
    expect(antes.planejou_antes_do_efeito).toBe(true);
    const nenhum = computeMetrics([call('read'), res('read')]);
    expect(nenhum.planejou_antes_do_efeito).toBeNull();
  });

  it('parada_por_limite só quando o result diz stop=limit', () => {
    const lim = computeMetrics([{ type: 'result', ok: false, stop: 'limit' }]);
    expect(lim.parada_por_limite).toBe(true);
    const ok = computeMetrics([{ type: 'result', ok: true, stop: 'final' }]);
    expect(ok.parada_por_limite).toBe(false);
    expect(ok.resultado_ok).toBe(true);
  });
});

describe('classifyOutcome · veredito', () => {
  it('result ok MAS processo saiu com código ≠ 0 não é "ok"', () => {
    const events = [{ type: 'result', ok: true }];
    expect(classifyOutcome({ events, exitCode: 0 })).toBe('ok');
    expect(classifyOutcome({ events, exitCode: 1 })).not.toBe('ok');
  });

  it('erro com status 429 é sem_cota mesmo com mensagem genérica (sem a palavra "quota")', () => {
    const events = [{ type: 'error', status: 429, message: 'alguma coisa ruim' }];
    expect(classifyOutcome({ events, exitCode: 1 })).toBe('sem_cota');
  });

  it('erro de provider com outro status NÃO é sem_cota', () => {
    const events = [{ type: 'error', status: 500, message: 'boom' }];
    expect(classifyOutcome({ events, exitCode: 1 })).toBe('erro_provider');
  });
});

describe('scoreExpectations · limites', () => {
  const m = {
    plan_updates: 3,
    efeitos: 2,
    delegou: false,
    plan_chamado: true,
    planejou_antes_do_efeito: true,
  };
  it('planUpdatesMax é inclusivo (<=) e planUpdatesMin também (>=)', () => {
    expect(scoreExpectations({ planUpdatesMax: 3 }, m)[0].ok).toBe(true);
    expect(scoreExpectations({ planUpdatesMax: 2 }, m)[0].ok).toBe(false);
    expect(scoreExpectations({ planUpdatesMin: 3 }, m)[0].ok).toBe(true);
    expect(scoreExpectations({ planUpdatesMin: 4 }, m)[0].ok).toBe(false);
  });
  it('effectsMax é inclusivo', () => {
    expect(scoreExpectations({ effectsMax: 2 }, m)[0].ok).toBe(true);
    expect(scoreExpectations({ effectsMax: 1 }, m)[0].ok).toBe(false);
  });
});

describe('aggregateScenario · quais repetições valem', () => {
  const run = (outcome, ok = true) => ({
    outcome,
    checks: [{ chave: 'k', ok }],
    metrics: { plan_updates: 1, filhos: 0, efeitos: 1, iteracoes_aprox: 2, wall_ms: 1000 },
  });

  it('timeout CONTA como repetição válida (falha de comportamento, não de infra)', () => {
    const a = aggregateScenario([run('ok'), run('timeout', false)]);
    expect(a.validas).toBe(2);
    expect(a.aprovado).toBe(false);
  });

  it('sem cota/erro de provider não contam; sem NENHUMA válida ⇒ não aprovado', () => {
    const a = aggregateScenario([run('sem_cota'), run('erro_provider')]);
    expect(a.validas).toBe(0);
    expect(a.aprovado).toBe(false);
    expect(a.plan_updates).toBeNull();
  });
});

// Testes das partes puras do eval (sem rede, sem provider). Streams gravados à mão no
// formato real do stream-json (linear.ts › runHeadlessStreamJson).
import { describe, expect, it } from 'vitest';
import {
  aggregateScenario,
  classifyOutcome,
  compareResults,
  computeMetrics,
  parseStream,
  renderComparison,
  renderSummary,
  scoreExpectations,
  toolSequence,
} from './lib.mjs';

const nd = (...evs) => evs.map((e) => JSON.stringify(e)).join('\n') + '\n';
const call = (name) => ({ type: 'tool_call', name, status: 'running' });
const res = (name) => ({ type: 'tool_result', name, status: 'done', exitCode: 0 });
const think = { type: 'phase', phase: 'thinking' };

const STREAM_PLANEJA = nd(
  think,
  call('read'),
  res('read'),
  call('update_plan'),
  res('update_plan'),
  think,
  call('spawn_agent'),
  res('spawn_agent'),
  call('spawn_agent'),
  res('spawn_agent'),
  call('edit'),
  res('edit'),
  call('update_plan'),
  res('update_plan'),
  { type: 'text', text: 'feito' },
  { type: 'result', result: 'feito', ok: true },
);

const STREAM_SEM_PLANO = nd(think, call('edit'), res('edit'), call('bash'), res('bash'), {
  type: 'result',
  result: 'ok',
  ok: true,
});

describe('parseStream', () => {
  it('ignora linhas inválidas e conta', () => {
    const { events, invalidas } = parseStream('lixo\n{"type":"text","text":"a"}\n\n{"x":1}\n');
    expect(events).toHaveLength(1);
    expect(invalidas).toBe(2);
  });
});

describe('toolSequence', () => {
  it('conta tool_result órfão como chamada (running coalescido)', () => {
    const { events } = parseStream(nd(res('update_plan'), call('read'), res('read')));
    expect(toolSequence(events)).toEqual(['update_plan', 'read']);
  });
});

describe('computeMetrics', () => {
  it('stream que planeja e delega', () => {
    const m = computeMetrics(parseStream(STREAM_PLANEJA).events, { wallMs: 5000, exitCode: 0 });
    expect(m.planejou_antes_do_efeito).toBe(true);
    expect(m.plan_updates).toBe(2);
    expect(m.delegou).toBe(true);
    expect(m.filhos).toBe(2);
    expect(m.efeitos).toBe(1);
    expect(m.iteracoes_aprox).toBe(2);
    expect(m.resultado_ok).toBe(true);
    expect(m.tool_calls).toMatchObject({ read: 1, update_plan: 2, spawn_agent: 2 });
  });
  it('stream sem plano', () => {
    const m = computeMetrics(parseStream(STREAM_SEM_PLANO).events);
    expect(m.planejou_antes_do_efeito).toBe(false);
    expect(m.delegou).toBe(false);
    expect(m.efeitos).toBe(2);
  });
  it('sem efeitos => planejou_antes_do_efeito é null', () => {
    const m = computeMetrics(parseStream(nd(call('read'), res('read'))).events);
    expect(m.planejou_antes_do_efeito).toBeNull();
  });
});

describe('classifyOutcome', () => {
  const ev = (s) => parseStream(s).events;
  it('ok', () => {
    expect(classifyOutcome({ events: ev(STREAM_PLANEJA), exitCode: 0 })).toBe('ok');
  });
  it('429 em evento error => sem_cota', () => {
    const events = ev(
      nd(
        { type: 'error', message: 'Too Many Requests', status: 429 },
        { type: 'result', result: '', ok: false },
      ),
    );
    expect(classifyOutcome({ events, exitCode: 1 })).toBe('sem_cota');
  });
  it('mensagem de quota no stderr => sem_cota', () => {
    expect(
      classifyOutcome({ events: [], stderr: 'provider: insufficient_quota', exitCode: 1 }),
    ).toBe('sem_cota');
  });
  it('timeout', () => {
    expect(classifyOutcome({ events: [], exitCode: null, timedOut: true })).toBe('timeout');
  });
  it('erro de provider não-cota', () => {
    const events = ev(nd({ type: 'error', message: 'bad gateway', status: 502 }));
    expect(classifyOutcome({ events, exitCode: 1 })).toBe('erro_provider');
  });
  it('sem resultado e sem erro => falha', () => {
    expect(classifyOutcome({ events: [], exitCode: 1 })).toBe('falha');
  });
});

describe('scoreExpectations', () => {
  const grande = { planBeforeEffect: true, planUpdatesMin: 2, delegated: true };
  it('passa no stream que planeja', () => {
    const m = computeMetrics(parseStream(STREAM_PLANEJA).events);
    expect(scoreExpectations(grande, m).every((c) => c.ok)).toBe(true);
  });
  it('reprova no stream sem plano', () => {
    const m = computeMetrics(parseStream(STREAM_SEM_PLANO).events);
    expect(
      scoreExpectations(grande, m)
        .filter((c) => !c.ok)
        .map((c) => c.chave),
    ).toEqual(['planBeforeEffect', 'planUpdatesMin', 'delegated']);
  });
  it('controle: não delegar', () => {
    const m = computeMetrics(parseStream(STREAM_SEM_PLANO).events);
    expect(
      scoreExpectations({ delegated: false, planUpdatesMax: 1, effectsMax: 2 }, m).every(
        (c) => c.ok,
      ),
    ).toBe(true);
  });
});

function reg(id, stream, outcome = 'ok', expectativa = { delegated: true }) {
  const metrics = computeMetrics(parseStream(stream).events, { wallMs: 2000 });
  const runs = [{ outcome, metrics, checks: scoreExpectations(expectativa, metrics) }];
  return { id, kind: 'grande', runs, agregado: aggregateScenario(runs) };
}
const meta = (rotulo) => ({
  rotulo,
  entry: '/x/aluy.js',
  modelo: null,
  permissao: 'normal',
  repeticoes: 1,
});

describe('planBeforeEffect sem efeito visível (efeitos negados no modo normal)', () => {
  it('usa plan_chamado como proxy', () => {
    const com = computeMetrics(parseStream(nd(call('read'), call('update_plan'))).events);
    const sem = computeMetrics(parseStream(nd(call('read'))).events);
    expect(scoreExpectations({ planBeforeEffect: true }, com)[0].ok).toBe(true);
    expect(scoreExpectations({ planBeforeEffect: true }, sem)[0].ok).toBe(false);
  });
});

describe('compare / render', () => {
  const base = { meta: meta('main'), cenarios: [reg('c1', STREAM_SEM_PLANO)] };
  const novo = {
    meta: meta('feat'),
    cenarios: [reg('c1', STREAM_PLANEJA), reg('c2', STREAM_PLANEJA)],
  };
  it('compara deltas e vereditos', () => {
    const [l1, l2] = compareResults(base, novo);
    expect(l1).toMatchObject({ base: 'FALHOU', novo: 'PASSOU', d_plan_updates: 2, d_filhos: 2 });
    expect(l2.base).toBe('ausente');
  });
  it('renderiza tabelas em PT-BR', () => {
    expect(renderComparison(base, novo)).toContain('| c1 | grande | FALHOU | PASSOU | +2 |');
    const md = renderSummary(novo);
    expect(md).toContain('| c1 | grande | PASSOU (ok) | sim |');
  });
  it('sem_cota aparece como SEM COTA e não vira falha de comportamento', () => {
    const r = reg('c3', '', 'sem_cota');
    expect(r.agregado.validas).toBe(0);
    expect(
      renderSummary({ meta: { ...meta('x'), abortado: 'sem cota' }, cenarios: [r] }),
    ).toContain('SEM COTA');
  });
});

// PAUSA POR COTA — coordenador + integração no AgentLoop e no SubAgentSpawner.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type { ModelCaller } from '../../src/agent/loop.js';
import { QuotaPauseCoordinator } from '../../src/agent/quota-pause.js';
import type { QuotaPauseEvent } from '../../src/agent/quota-pause.js';
import { SubAgentSpawner } from '../../src/agent/subagent.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { formatSubAgentResults } from '../../src/agent/tools/spawn-agent.js';
import { BrokerError, QuotaPauseStoppedError } from '../../src/model/errors.js';
import type { ModelCallResult } from '../../src/model/types.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { MemoryFs, RecordingShell, MemorySearch, allowAllEngine } from './helpers.js';

const ports = (): ToolPorts => ({
  fs: new MemoryFs(),
  shell: new RecordingShell(),
  search: new MemorySearch(),
});
const registry = (): ToolRegistry<ToolPorts> => new ToolRegistry(NATIVE_TOOLS);
const cfg = { enabled: true, maxWaitMs: 6 * 3_600_000 };
const quota = (resetInMs?: number): BrokerError =>
  new BrokerError({
    status: 429,
    code: 'USAGE_WINDOW_EXHAUSTED',
    detail: 'janela esgotada',
    ...(resetInMs !== undefined ? { reset_at_ms: Date.now() + resetInMs } : {}),
  });
const ok = (content = 'pronto.'): ModelCallResult => ({
  request_id: 'r',
  content,
  finish_reason: 'stop',
});

/** Modelo roteirizado: cada item é um resultado ou um erro a lançar. */
class Script implements ModelCaller {
  calls = 0;
  constructor(private readonly steps: (ModelCallResult | Error)[]) {}
  async call(): Promise<ModelCallResult> {
    const s = this.steps[Math.min(this.calls, this.steps.length - 1)]!;
    this.calls += 1;
    if (s instanceof Error) throw s;
    return s;
  }
}
const newLoop = (model: ModelCaller, co?: QuotaPauseCoordinator): AgentLoop =>
  new AgentLoop({
    model,
    permission: allowAllEngine,
    tools: registry(),
    ports: ports(),
    sessionId: 's',
    ...(co ? { quotaPause: co.forAgent({ label: 'principal', kind: 'principal' }) } : {}),
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('pausa e retomada automática', () => {
  it('o agente pausa na cota e retoma sozinho no horário de reset, sem morrer', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const events: QuotaPauseEvent[] = [];
    co.subscribe((e) => events.push(e));
    const model = new Script([quota(60_000), ok('feito')]);
    const p = newLoop(model, co).run('faça');
    await vi.advanceTimersByTimeAsync(10);
    expect(model.calls).toBe(1);
    expect(co.view?.agents.map((a) => a.label)).toEqual(['principal']);
    expect(co.snapshots()[0]!.history.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(model.calls).toBe(1); // ainda esperando
    await vi.advanceTimersByTimeAsync(31_000);
    const res = await p;
    expect(model.calls).toBe(2);
    expect(res.stop.kind).toBe('final');
    expect(co.view).toBeNull();
    expect(events.at(-1)).toMatchObject({ type: 'fim', how: 'retomada' });
  });

  it('sem horário: sondagem periódica na escada (uma chamada por vez)', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([quota(), quota(), ok()]);
    const p = newLoop(model, co).run('x');
    await vi.advanceTimersByTimeAsync(59_000);
    expect(model.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000); // 1ª sondagem (1m) falha
    expect(model.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(model.calls).toBe(2); // próxima só em +2m
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await p).stop.kind).toBe('final');
    expect(model.calls).toBe(3);
  });

  it('"tentar agora" antecipa a sondagem', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([quota(3_600_000), ok()]);
    const p = newLoop(model, co).run('x');
    await vi.advanceTimersByTimeAsync(10);
    co.resumeNow();
    expect((await p).stop.kind).toBe('final');
  });

  it('ESC (abort) tira o agente da pausa com cancelamento', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const ac = new AbortController();
    const model = new Script([quota(3_600_000), ok()]);
    const p = newLoop(model, co).run('x', ac.signal);
    const assertion = expect(p).rejects.toThrow(/cancelada/);
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await assertion;
    expect(co.view).toBeNull();
  });

  it('parar salvando: erro de parada com histórico parcial; só pausa de novo após rearm', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([quota(3_600_000), ok()]);
    const p = newLoop(model, co).run('meu objetivo');
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    co.stop('usuario');
    const e = (await caught) as QuotaPauseStoppedError;
    expect(e).toBeInstanceOf(QuotaPauseStoppedError);
    expect(e.partialHistory?.[0]).toMatchObject({ role: 'goal', text: 'meu objetivo' });
    // parado: a próxima chamada falha na hora, sem martelar o provider
    await expect(newLoop(new Script([ok()]), co).run('y')).rejects.toBeInstanceOf(
      QuotaPauseStoppedError,
    );
    co.rearm();
    expect((await newLoop(new Script([ok()]), co).run('y')).stop.kind).toBe('final');
  });

  it('espera máxima estourada vira parar salvando automático', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 120_000 } });
    const model = new Script([quota(3_600_000)]);
    const p = newLoop(model, co).run('x');
    const assertion = expect(p).rejects.toMatchObject({ why: 'tempo-maximo' });
    await vi.advanceTimersByTimeAsync(121_000);
    await assertion;
  });
});

describe('falhas definitivas continuam falhando', () => {
  it.each([
    [401, 'UNAUTHENTICATED'],
    [404, 'HTTP_404'],
    [400, 'VALIDATION_FAILED'],
  ])('HTTP %i não pausa', async (status, code) => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([new BrokerError({ status, code, detail: 'ruim' })]);
    await expect(newLoop(model, co).run('x')).rejects.toBeInstanceOf(BrokerError);
    expect(co.view).toBeNull();
    expect(model.calls).toBe(1);
  });
  it('pausa desligada: cota esgotada sobe como antes', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: false, maxWaitMs: 1 } });
    await expect(newLoop(new Script([quota()]), co).run('x')).rejects.toBeInstanceOf(BrokerError);
  });
});

describe('rate-limit curto (429 simples)', () => {
  const plain429 = (): BrokerError => new BrokerError({ status: 429, code: 'RATE_LIMITED' });

  it('agente principal: segue a retentativa em camadas de sempre (não pausa)', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    await expect(newLoop(new Script([plain429()]), co).run('x')).rejects.toBeInstanceOf(
      BrokerError,
    );
    expect(co.view).toBeNull();
  });

  it('sub-agente: pausa em vez de morrer (N filhos num provider esgotam o rate limit)', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const sp = new SubAgentSpawner({
      model: new Script([plain429(), ok('depois')]),
      permission: allowAllEngine,
      ports: ports(),
      baseTools: NATIVE_TOOLS,
      quotaPause: co,
    });
    const p = sp.spawn([{ label: 'f', goal: 't' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.scope).toBe('taxa');
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await p)[0]).toMatchObject({ ok: true, result: 'depois' });
  });
});

describe('Z.ai coding: 429 com corpo de limite de uso', () => {
  // reset daqui a 10 min, escrito como a Z.ai escreve: hora de Pequim (UTC+8), sem fuso.
  const zai = (): BrokerError => {
    const t = new Date(Date.now() + 600_000 + 8 * 3_600_000).toISOString();
    return new BrokerError({
      status: 429,
      code: 'RATE_LIMITED',
      type: 'provider_code:1308',
      detail: `Usage limit reached for 5 hour. Your limit will reset at ${t.slice(0, 10)} ${t.slice(11, 19)}`,
    });
  };

  it('agente PRINCIPAL pausa (não é retry curto) e retoma no horário do corpo', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([zai(), ok('feito')]);
    const p = newLoop(model, co).run('x');
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.scope).toBe('janela');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(model.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(305_000);
    expect((await p).stop.kind).toBe('final');
    expect(model.calls).toBe(2);
  });

  it('SUB-AGENTE também pausa', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const sp = new SubAgentSpawner({
      model: new Script([zai(), ok('ok')]),
      permission: allowAllEngine,
      ports: ports(),
      baseTools: NATIVE_TOOLS,
      quotaPause: co,
    });
    const p = sp.spawn([{ label: 'f', goal: 't' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.agents[0]?.label).toBe('f');
    await vi.advanceTimersByTimeAsync(610_000);
    expect((await p)[0]).toMatchObject({ ok: true });
  });

  it('429 de corpo genérico (limite de uso) sem header pausa o principal; 429 pelado não', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const body = new BrokerError({
      status: 429,
      code: 'RATE_LIMITED',
      detail: 'You exceeded your current quota',
    });
    void newLoop(new Script([body]), co)
      .run('x')
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.scope).toBe('credito');
    const co2 = new QuotaPauseCoordinator({ config: cfg });
    await expect(
      newLoop(new Script([new BrokerError({ status: 429, code: 'RATE_LIMITED' })]), co2).run('x'),
    ).rejects.toBeInstanceOf(BrokerError);
  });
});

describe('saldo esgotado (402): só recarga resolve', () => {
  const noBalance = (): BrokerError =>
    new BrokerError({ status: 402, code: 'INSUFFICIENT_CREDIT', detail: 'Insufficient Balance' });

  it('marca manual, sonda de forma esparsa (5, 10 min) e NÃO espera horas: salva em 30 min', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg }); // maxWait configurado = 6h
    const model = new Script([noBalance()]);
    const p = newLoop(model, co).run('x');
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.manual).toBe(true);
    expect(co.view!.deadlineAtMs - co.view!.startedAt).toBe(30 * 60_000);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(model.calls).toBe(1); // nada de sondar a cada minuto
    await vi.advanceTimersByTimeAsync(61_000);
    expect(model.calls).toBe(2); // 1ª sondagem aos 5 min
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(model.calls).toBe(2); // a próxima só +10 min
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(model.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(await caught).toMatchObject({ why: 'tempo-maximo' }); // teto curto de saldo
  });

  it('recarregou e pressionou ↵ (tentar agora): retoma de onde parou', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([noBalance(), ok('voltei')]);
    const p = newLoop(model, co).run('x');
    await vi.advanceTimersByTimeAsync(10);
    co.resumeNow();
    expect((await p).stop.kind).toBe('final');
  });
});

describe('pausa compartilhada entre irmãos', () => {
  it('o irmão não martela o provider: espera o mesmo portão e libera junto', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const a = new Script([quota(60_000), ok('a')]);
    const b = new Script([ok('b')]);
    const pa = newLoop(a, co).run('a');
    await vi.advanceTimersByTimeAsync(10);
    const pb = newLoop(b, co).run('b'); // chega com a sessão pausada
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.calls).toBe(0); // nenhuma chamada ao provider enquanto pausado
    await vi.advanceTimersByTimeAsync(31_000);
    await Promise.all([pa, pb]);
    expect(a.calls).toBe(2);
    expect(b.calls).toBe(1);
  });
});

describe('sub-agentes', () => {
  const spawner = (model: ModelCaller, co: QuotaPauseCoordinator): SubAgentSpawner =>
    new SubAgentSpawner({
      model,
      permission: allowAllEngine,
      ports: ports(),
      baseTools: NATIVE_TOOLS,
      quotaPause: co,
      idleTimeoutMs: 1000, // curto: a pausa NÃO pode contar como "travado"
    });

  it('o filho pausa (sem ser morto pelo idle) e conclui após o reset', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([quota(120_000), ok('resultado')]);
    const p = spawner(model, co).spawn([{ label: 'f1', goal: 'tarefa' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(co.view?.agents[0]).toEqual({ label: 'f1', kind: 'subagente' });
    await vi.advanceTimersByTimeAsync(61_000);
    const [o] = await p;
    expect(o).toMatchObject({ ok: true, stop: 'final', result: 'resultado' });
  });

  it('parar salvando: o pai vê PAUSADO (não falha) com a foto para retomar', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([quota(3_600_000)]);
    const p = spawner(model, co).spawn([{ label: 'f1', goal: 'tarefa', context: 'ctx' }]);
    await vi.advanceTimersByTimeAsync(10);
    co.stop('usuario');
    const [o] = await p;
    expect(o!.stop).toBe('paused');
    expect(o!.paused?.profile).toMatchObject({ label: 'f1', goal: 'tarefa', context: 'ctx' });
    expect(o!.paused?.history[0]).toMatchObject({ role: 'goal', text: 'tarefa' });
    const txt = formatSubAgentResults([o!]);
    expect(txt).toMatch(/PAUSADO/);
    expect(txt).toMatch(/NÃO os dispare de novo/);
  });

  it('persistir e retomar: o filho continua do histórico guardado', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const p1 = spawner(new Script([quota(3_600_000)]), co).spawn([{ label: 'f1', goal: 'tarefa' }]);
    await vi.advanceTimersByTimeAsync(10);
    co.stop('usuario');
    const [paused] = await p1;
    const snap = JSON.parse(JSON.stringify(paused!.paused)); // ida e volta pelo disco
    // "novo processo": coordenador novo, spawner novo, retomada com o histórico guardado
    const co2 = new QuotaPauseCoordinator({ config: cfg });
    const model2 = new Script([ok('terminei')]);
    const [o] = await spawner(model2, co2).spawn([snap.profile], undefined, {
      resume: new Map([[snap.label, snap.history]]),
    });
    expect(o).toMatchObject({ ok: true, stop: 'final', result: 'terminei' });
  });

  it('falha definitiva do filho continua sendo falha', async () => {
    const co = new QuotaPauseCoordinator({ config: cfg });
    const model = new Script([new BrokerError({ status: 401, code: 'UNAUTHENTICATED' })]);
    const [o] = await spawner(model, co).spawn([{ label: 'f1', goal: 't' }]);
    expect(o!.stop).toBe('error');
  });
});

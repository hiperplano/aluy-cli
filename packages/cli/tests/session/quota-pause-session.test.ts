// PAUSA POR COTA (locus) — persistência da pausa, texto do banner e ciclo pausa → salvar →
// retomar num "processo novo".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentLoop,
  BrokerError,
  NATIVE_TOOLS,
  SubAgentSpawner,
  ToolRegistry,
  type ModelCallResult,
  type QuotaPauseView,
} from '@hiperplano/aluy-cli-core';
import { PausaStore } from '../../src/io/pausa-store.js';
import {
  QuotaPauseSession,
  formatCountdown,
  quotaPauseConfigFromEnv,
  quotaPauseLines,
} from '../../src/session/quota-pause-session.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aluy-pausa-'));
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

const quota = (inMs: number): BrokerError =>
  new BrokerError({
    status: 429,
    code: 'USAGE_WINDOW_EXHAUSTED',
    reset_at_ms: Date.now() + inMs,
  });
const ok = (content: string): ModelCallResult => ({
  request_id: 'r',
  content,
  finish_reason: 'stop',
});
function script(steps: (ModelCallResult | Error)[]): { call(): Promise<ModelCallResult> } {
  let n = 0;
  return {
    async call() {
      const s = steps[Math.min(n++, steps.length - 1)]!;
      if (s instanceof Error) throw s;
      return s;
    },
  };
}
const allow = {
  decide: () => ({ kind: 'allow' as const }),
} as never;

describe('texto', () => {
  it('contagem regressiva', () => {
    expect(formatCountdown(37_000)).toBe('37s');
    expect(formatCountdown(12 * 60_000 + 4_000)).toBe('12min 04s');
    expect(formatCountdown(2 * 3_600_000 + 5 * 60_000)).toBe('2h 05min');
  });
  it('banner com e sem horário do provedor', () => {
    const base: QuotaPauseView = {
      scope: 'janela',
      reason: 'x',
      resetAtMs: 1_000_000 + 600_000,
      nextProbeAtMs: 1_000_000 + 600_000,
      startedAt: 1_000_000,
      deadlineAtMs: 1_000_000 + 3_600_000,
      probes: 0,
      probing: false,
      manual: false,
      agents: [{ label: 'pesquisa', kind: 'subagente' }],
    };
    const com = quotaPauseLines(base, 1_000_000).join('\n');
    expect(com).toMatch(/pausado — cota esgotada/);
    expect(com).toMatch(/pesquisa/);
    expect(com).toMatch(/tentando de novo a cada ~5 min/);
    expect(com).toMatch(/limite informado pelo provedor/);
    expect(com).toMatch(/retoma sozinho se a cota voltar antes/);
    expect(com).not.toMatch(/volta às|deve liberar/);
    const recusada = quotaPauseLines({ ...base, lastProbeAtMs: 1_000_000 - 3_000 }, 1_000_000).join(
      '\n',
    );
    expect(recusada).toMatch(/ainda sem cota \(última tentativa \d\d:\d\d\)/);
    expect(quotaPauseLines({ ...base, probing: true }, 1_000_000).join('\n')).toMatch(
      /verificando a cota/,
    );
    const sem = quotaPauseLines({ ...base, resetAtMs: undefined }, 1_000_000).join('\n');
    expect(sem).toMatch(/sem horário do provedor/);
  });
  it('banner de saldo esgotado: diz que esperar não repõe e pede a recarga (↵)', () => {
    const view: QuotaPauseView = {
      scope: 'credito',
      reason: 'x',
      resetAtMs: undefined,
      nextProbeAtMs: 1_000_000 + 300_000,
      startedAt: 1_000_000,
      deadlineAtMs: 1_000_000 + 1_800_000,
      probes: 0,
      probing: false,
      manual: true,
      agents: [{ label: 'principal', kind: 'principal' }],
    };
    const txt = quotaPauseLines(view, 1_000_000).join('\n');
    expect(txt).toMatch(/recarregue o saldo/);
    expect(txt).toMatch(/esperar não repõe saldo: recarregue no provedor e pressione ↵/);
    expect(txt).toMatch(/verificação automática \(esparsa\)/);
    expect(txt).toMatch(/salvo sozinho em 30min/);
  });
  it('env: default ligado; off desliga; max wait', () => {
    expect(quotaPauseConfigFromEnv({}).enabled).toBe(true);
    expect(quotaPauseConfigFromEnv({ ALUY_QUOTA_PAUSE: 'off' }).enabled).toBe(false);
    expect(quotaPauseConfigFromEnv({ ALUY_QUOTA_MAX_WAIT: '2h' }).maxWaitMs).toBe(7_200_000);
  });
});

describe('PausaStore', () => {
  it('grava 0600, redige segredo, lê de volta e remove', () => {
    const store = new PausaStore({ baseDir: dir });
    const saved = store.save({
      sessionId: 's1',
      scope: 'janela',
      reason: 'r',
      agents: [
        {
          label: 'f1',
          kind: 'subagente',
          profile: { label: 'f1', goal: 'g' },
          history: [
            { role: 'goal', text: 'g' },
            {
              role: 'observation',
              toolName: 'run_command',
              text: 'TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
            },
          ],
          pausedAt: 1,
        },
      ],
    });
    expect(saved).toBe(true);
    const file = store.pathFor('s1');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    const back = store.load('s1');
    expect(back?.agents[0]?.profile?.goal).toBe('g');
    store.remove('s1');
    expect(store.load('s1')).toBeNull();
  });
  it('fail-safe: id inválido, ausente e corrompido', () => {
    const store = new PausaStore({ baseDir: dir });
    expect(store.load('../x')).toBeNull();
    expect(store.load('nao-existe')).toBeNull();
    expect(
      new PausaStore({ baseDir: dir, disabled: true }).save({
        sessionId: 's',
        scope: 'a',
        reason: '',
        agents: [],
      }),
    ).toBe(false);
  });
});

describe('ciclo completo: pausa → parar salvando → "novo processo" retoma o filho', () => {
  it('persiste a foto do filho pausado e a retomada conclui de onde parou', async () => {
    const store = new PausaStore({ baseDir: dir });
    const notes: string[] = [];
    const views: (QuotaPauseView | undefined)[] = [];
    const s1 = new QuotaPauseSession({
      config: { enabled: true, maxWaitMs: 3_600_000 },
      store: () => store,
      sessionId: () => 'sessA',
      onView: (v) => views.push(v),
      note: (t) => notes.push(t),
    });
    const common = {
      permission: allow,
      ports: {} as never,
      baseTools: NATIVE_TOOLS,
      idleTimeoutMs: 1000,
    };
    const sp1 = new SubAgentSpawner({
      ...common,
      model: script([quota(3_600_000)]),
      quotaPause: s1.coordinator,
    });
    const run = sp1.spawn([{ label: 'f1', goal: 'tarefa longa' }]);
    await vi.advanceTimersByTimeAsync(50);
    // pausou: a foto já está em disco (sobrevive a um kill do processo)
    expect(store.load('sessA')?.agents.map((a) => a.label)).toEqual(['f1']);
    expect(views.at(-1)?.agents[0]?.label).toBe('f1');
    s1.coordinator.stop('usuario');
    const [o] = await run;
    expect(o!.stop).toBe('paused');
    expect(notes).toContain('pausado e salvo');
    expect(views.at(-1)).toBeUndefined();

    // "processo novo"
    const rec = new PausaStore({ baseDir: dir }).load('sessA')!;
    const s2 = new QuotaPauseSession({
      config: { enabled: true, maxWaitMs: 3_600_000 },
      store: () => store,
      sessionId: () => 'sessA',
      onView: () => undefined,
      note: () => undefined,
    });
    const sp2 = new SubAgentSpawner({
      ...common,
      model: script([ok('concluído')]),
      quotaPause: s2.coordinator,
    });
    const kid = rec.agents[0]!;
    const [r] = await sp2.spawn([kid.profile!], undefined, {
      resume: new Map([[kid.label, kid.history]]),
    });
    expect(r).toMatchObject({ ok: true, stop: 'final', result: 'concluído' });
  });

  it('retomada automática no reset remove a foto do disco', async () => {
    const store = new PausaStore({ baseDir: dir });
    const s = new QuotaPauseSession({
      config: { enabled: true, maxWaitMs: 3_600_000 },
      store: () => store,
      sessionId: () => 'sessB',
      onView: () => undefined,
      note: () => undefined,
    });
    const loop = new AgentLoop({
      model: script([quota(60_000), ok('feito')]),
      permission: allow,
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports: {} as never,
      quotaPause: s.coordinator.forAgent({ label: 'principal', kind: 'principal' }),
    });
    const p = loop.run('obj');
    await vi.advanceTimersByTimeAsync(100);
    expect(store.load('sessB')?.agents[0]?.kind).toBe('principal');
    await vi.advanceTimersByTimeAsync(61_000);
    expect((await p).stop.kind).toBe('final');
    expect(store.load('sessB')).toBeNull();
  });
});

// Auditoria — coordenador da pausa por cota usado DIRETO (a API que o loop e os sub-agentes
// consomem): espera máxima por episódio, o fim do episódio ("parada" × "tempo-maximo"), a
// suspensão do relógio de inatividade do filho (`hold`) e o horário de reset que só cresce.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuotaPauseCoordinator } from '../../src/agent/quota-pause.js';
import type { QuotaPauseEvent } from '../../src/agent/quota-pause.js';
import { BrokerError, QuotaPauseStoppedError } from '../../src/model/errors.js';

const ctx = { history: () => [] };
const janela = (resetInMs?: number): BrokerError =>
  new BrokerError({
    status: 429,
    code: 'USAGE_WINDOW_EXHAUSTED',
    ...(resetInMs !== undefined ? { reset_at_ms: Date.now() + resetInMs } : {}),
  });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('espera máxima do episódio', () => {
  it('um irmão que chega DEPOIS do prazo encerra a pausa (tempo-maximo) e solta quem esperava', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 100_000 } });
    const eventos: QuotaPauseEvent[] = [];
    co.subscribe((e) => eventos.push(e));
    const a = co.forAgent({ label: 'a', kind: 'subagente' });
    const b = co.forAgent({ label: 'b', kind: 'subagente' });

    const pa = a.handle(janela(3_600_000), ctx).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.agents.map((x) => x.label)).toEqual(['a']);

    // o relógio do coordenador passou do prazo sem o timer disparar (chegada tardia de um irmão).
    vi.setSystemTime(Date.now() + 101_000);
    await expect(b.handle(janela(3_600_000), ctx)).rejects.toMatchObject({ why: 'tempo-maximo' });
    expect(await pa).toBeInstanceOf(QuotaPauseStoppedError);
    expect(eventos.at(-1)).toMatchObject({ type: 'fim', how: 'tempo-maximo' });
  });

  it('antes do prazo o mesmo irmão apenas entra na pausa (não encerra)', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 100_000 } });
    const a = co.forAgent({ label: 'a', kind: 'subagente' });
    const b = co.forAgent({ label: 'b', kind: 'subagente' });
    void a.handle(janela(3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    void b.handle(janela(3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.agents.map((x) => x.label).sort()).toEqual(['a', 'b']);
  });

  it('parar salvando pelo dono termina como "parada"; estourar o prazo como "tempo-maximo"', async () => {
    const eventosDoDono: QuotaPauseEvent[] = [];
    const c1 = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 600_000 } });
    c1.subscribe((e) => eventosDoDono.push(e));
    void c1
      .forAgent({ label: 'a', kind: 'subagente' })
      .handle(janela(3_600_000), ctx)
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    c1.stop('usuario');
    expect(eventosDoDono.at(-1)).toMatchObject({ type: 'fim', how: 'parada' });

    const eventosPrazo: QuotaPauseEvent[] = [];
    const c2 = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 120_000 } });
    c2.subscribe((e) => eventosPrazo.push(e));
    void c2
      .forAgent({ label: 'a', kind: 'subagente' })
      .handle(janela(3_600_000), ctx)
      .catch(() => undefined);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(eventosPrazo.at(-1)).toMatchObject({ type: 'fim', how: 'tempo-maximo' });
  });
});

describe('hold do relógio de inatividade do filho', () => {
  it('é suspenso ao pausar e SOLTO tanto na retomada quanto no parar salvando', async () => {
    for (const saida of ['retomada', 'parada'] as const) {
      const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 600_000 } });
      let abertos = 0;
      let soltos = 0;
      const a = co.forAgent({
        label: 'a',
        kind: 'subagente',
        hold: () => {
          abertos += 1;
          return () => {
            soltos += 1;
          };
        },
      });
      const p = a.handle(janela(3_600_000), ctx).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(10);
      expect(abertos).toBe(1);
      expect(soltos).toBe(0); // enquanto pausado o relógio do filho segue suspenso
      if (saida === 'retomada') co.resumeNow();
      else co.stop('usuario');
      await p;
      expect(soltos).toBe(1);
    }
  });
});

describe('horário de reset', () => {
  it('só cresce: um irmão com reset mais curto não antecipa a retomada', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 8 * 3_600_000 } });
    const a = co.forAgent({ label: 'a', kind: 'subagente' });
    const b = co.forAgent({ label: 'b', kind: 'subagente' });
    const t0 = Date.now();
    void a.handle(janela(3 * 3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    void b.handle(janela(2 * 3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.resetAtMs).toBeGreaterThanOrEqual(t0 + 3 * 3_600_000);
    expect(co.view?.nextProbeAtMs).toBeGreaterThanOrEqual(t0 + 3 * 3_600_000);
  });

  it('um irmão com reset mais longo adia a retomada', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 8 * 3_600_000 } });
    const a = co.forAgent({ label: 'a', kind: 'subagente' });
    const b = co.forAgent({ label: 'b', kind: 'subagente' });
    const t0 = Date.now();
    void a.handle(janela(2 * 3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    void b.handle(janela(4 * 3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.resetAtMs).toBeGreaterThanOrEqual(t0 + 4 * 3_600_000);
  });
});

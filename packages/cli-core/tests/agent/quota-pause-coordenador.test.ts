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
  it('só cresce (exibição): um irmão com reset mais curto não encolhe o horário informado', async () => {
    const co = new QuotaPauseCoordinator({ config: { enabled: true, maxWaitMs: 8 * 3_600_000 } });
    const a = co.forAgent({ label: 'a', kind: 'subagente' });
    const b = co.forAgent({ label: 'b', kind: 'subagente' });
    const t0 = Date.now();
    void a.handle(janela(3 * 3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    void b.handle(janela(2 * 3_600_000), ctx).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.resetAtMs).toBeGreaterThanOrEqual(t0 + 3 * 3_600_000);
    // o reset só alimenta a exibição: a sondagem segue a escada (≤5 min), não é empurrada.
    expect(co.view?.nextProbeAtMs).toBeLessThanOrEqual(t0 + 60_000 + 20);
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

describe('"tentar agora" (↵) e o estado visível da sondagem', () => {
  const h = { history: () => [] };
  const cfgH = { enabled: true, maxWaitMs: 7 * 24 * 3_600_000 };
  const H80 = 80 * 3_600_000;

  it('lastProbeAtMs: ausente antes da 1ª sondagem; preenchido após uma recusa', async () => {
    const co = new QuotaPauseCoordinator({ config: cfgH });
    const a = co.forAgent({ label: 'a', kind: 'principal' });
    void a.handle(janela(H80), h).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.lastProbeAtMs).toBeUndefined();
    co.resumeNow();
    expect(co.view?.probing).toBe(true); // a TUI vê "verificando" na hora
    const t = Date.now();
    void a.handle(janela(H80), h).catch(() => undefined); // a sondagem foi recusada
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view?.probing).toBe(false);
    expect(co.view?.lastProbeAtMs).toBe(t);
    co.stop('usuario');
  });

  it('↵ repetido com sondagem em voo é no-op (não empilha e não elege outro)', async () => {
    const co = new QuotaPauseCoordinator({ config: cfgH });
    const a = co.forAgent({ label: 'a', kind: 'subagente' });
    const b = co.forAgent({ label: 'b', kind: 'subagente' });
    void a.handle(janela(H80), h).catch(() => undefined);
    void b.handle(janela(H80), h).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    co.resumeNow();
    const quem = co.view?.agents.length;
    co.resumeNow();
    co.resumeNow();
    // só UM foi eleito: o outro segue esperando no portão (view.probing já é true)
    expect(co.view?.probing).toBe(true);
    expect(quem).toBe(2);
    const pend = [a, b].map((x) => x.gate(h).catch(() => 'parou'));
    await vi.advanceTimersByTimeAsync(10);
    co.stop('usuario');
    expect(await Promise.all(pend)).toEqual(['parou', 'parou']);
    return;
    co.stop('usuario');
  });

  it('pai + sub-agentes: ↵ elege UM (aqui um filho) e o sucesso dele libera todos', async () => {
    const co = new QuotaPauseCoordinator({ config: cfgH });
    const filho = co.forAgent({ label: 'filho', kind: 'subagente' });
    const pai = co.forAgent({ label: 'principal', kind: 'principal' });
    const feito = { filho: false, pai: false };
    void filho.handle(janela(H80), h).then(() => (feito.filho = true));
    void pai.handle(janela(H80), h).then(() => (feito.pai = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(feito).toEqual({ filho: false, pai: false });
    co.resumeNow(); // o filho entrou primeiro: ele é o sondador (refaz a própria chamada)
    await vi.advanceTimersByTimeAsync(10);
    expect(feito).toEqual({ filho: true, pai: false });
    expect(co.view?.probing).toBe(true);
    co.resumeNow(); // no-op: há sondagem em voo, o pai segue esperando
    await vi.advanceTimersByTimeAsync(10);
    expect(feito.pai).toBe(false);
    filho.ok(); // a chamada do filho passou: a cota voltou
    await vi.advanceTimersByTimeAsync(10);
    expect(feito.pai).toBe(true); // o pai é liberado junto
    expect(co.view).toBeNull();
  });

  it('só um filho aguardando: depois de uma recusa o ↵ seguinte volta a sondar (não trava com probing órfão)', async () => {
    const co = new QuotaPauseCoordinator({ config: cfgH });
    const f = co.forAgent({ label: 'f', kind: 'subagente' });
    let calls = 0;
    const p = (async () => {
      await f.handle(janela(H80), h);
      for (;;) {
        calls += 1;
        try {
          if (calls >= 3) {
            f.ok();
            return;
          }
          throw janela(H80);
        } catch (e) {
          await f.handle(e, h);
        }
      }
    })();
    await vi.advanceTimersByTimeAsync(10);
    co.resumeNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
    co.resumeNow();
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(2);
    co.resumeNow();
    await p;
    expect(calls).toBe(3);
  });

  it('não reinicia a escada: depois de ↵ recusado a próxima sondagem automática vem de um degrau maior', async () => {
    const co = new QuotaPauseCoordinator({ config: cfgH });
    const a = co.forAgent({ label: 'a', kind: 'principal' });
    void a.handle(janela(H80), h).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    co.resumeNow();
    void a.handle(janela(H80), h).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    expect(co.view!.nextProbeAtMs - Date.now()).toBeGreaterThan(100_000); // 2º degrau (2 min)
    co.stop('usuario');
  });
});

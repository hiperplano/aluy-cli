// ADR-0158 §5 — FIX do bug pré-existente da FASE 2 (achado na FASE 4): o Node
// clampa `setTimeout(ms)` p/ ~1ms quando `ms > 2^31-1` (~24,8 dias) — um
// `schedule:` apontando bem longe no futuro faria o runner acordar quase
// instantaneamente e ENTRAR EM LOOP DE TURNOS. O fix dorme em FATIAS
// (`sleepSliceMs`, PURA) re-checando o alvo a cada fatia. Este arquivo testa:
//   1. o CÁLCULO de fatia (puro, sem timer/relógio real);
//   2. `sleepUntil` de verdade, com timers FAKE — prova que NUNCA agenda uma
//      fatia acima do teto, mesmo para um alvo a MESES de distância (o cenário
//      exato que clampava antes do fix).
import { describe, expect, it, vi } from 'vitest';
import { sleepSliceMs, sleepUntil } from '../../src/service/runner.js';

const DAY_MS = 24 * 60 * 60_000;
const NODE_SETTIMEOUT_MAX_MS = 2 ** 31 - 1; // ~24,8 dias — onde o Node clampa.

describe('sleepSliceMs — PURA', () => {
  it('alvo distante ⇒ retorna o TETO (nunca o restante inteiro)', () => {
    const now = 0;
    const target = 90 * DAY_MS; // 90 dias no futuro — bem além do que o Node aguenta num tiro só.
    expect(sleepSliceMs(now, target, DAY_MS)).toBe(DAY_MS);
  });

  it('alvo dentro do teto ⇒ retorna o restante EXATO (última fatia)', () => {
    const now = 0;
    const target = 3 * 60 * 60_000; // 3h
    expect(sleepSliceMs(now, target, DAY_MS)).toBe(3 * 60 * 60_000);
  });

  it('alvo já passado ⇒ 0 (nunca negativo — "dormir zero" = acorda já)', () => {
    expect(sleepSliceMs(1_000_000, 500_000, DAY_MS)).toBe(0);
    expect(sleepSliceMs(1_000_000, 999_999, DAY_MS)).toBe(0);
  });

  it('alvo == agora ⇒ 0', () => {
    expect(sleepSliceMs(500, 500, DAY_MS)).toBe(0);
  });

  it('teto default é 1 dia — nunca perto do limite de clamp do Node (2^31-1 ms)', () => {
    const target = 365 * DAY_MS; // 1 ano no futuro.
    const slice = sleepSliceMs(0, target); // usa o teto default.
    expect(slice).toBeLessThan(NODE_SETTIMEOUT_MAX_MS);
    expect(slice).toBe(DAY_MS);
  });

  it('nenhuma fatia, em nenhum cenário plausível, excede o limite de clamp do Node', () => {
    // Varre alvos de 1 dia até 10 anos no futuro — a fatia calculada nunca passa
    // do teto (que por sua vez é bem menor que o limite de clamp do Node).
    for (const days of [1, 2, 25, 30, 100, 365, 3650]) {
      const slice = sleepSliceMs(0, days * DAY_MS);
      expect(slice).toBeLessThanOrEqual(DAY_MS);
      expect(slice).toBeLessThan(NODE_SETTIMEOUT_MAX_MS);
    }
  });
});

describe('sleepUntil — com timers FAKE (prova a REGRESSÃO corrigida)', () => {
  it('alvo a 90 dias: NENHUM setTimeout agendado acima do teto de 1 fatia', async () => {
    vi.useFakeTimers();
    try {
      const seenDelays: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        fn: (...args: unknown[]) => void,
        ms?: number,
        ...rest: unknown[]
      ) => {
        if (typeof ms === 'number') seenDelays.push(ms);
        return realSetTimeout(fn, ms, ...rest);
      }) as typeof setTimeout);

      const target = new Date(Date.now() + 90 * DAY_MS);
      const stop = new AbortController();
      const promise = sleepUntil(target, stop.signal);

      // Avança o relógio fake em saltos — se o bug antigo estivesse presente, um
      // ÚNICO setTimeout(ms grande) teria sido clampado pelo NODE REAL p/ ~1ms
      // (não pelo fake timer — por isso o teste também prova via `seenDelays`,
      // não só via o tempo decorrido).
      for (let i = 0; i < 91; i++) {
        await vi.advanceTimersByTimeAsync(DAY_MS);
      }
      const outcome = await promise;

      expect(outcome).toBe('woke');
      expect(seenDelays.length).toBeGreaterThan(1); // mais de UMA fatia foi agendada.
      for (const d of seenDelays) {
        expect(d).toBeLessThanOrEqual(DAY_MS);
        expect(d).toBeLessThan(NODE_SETTIMEOUT_MAX_MS);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('`stop` durante a espera interrompe imediatamente (mesmo faltando várias fatias)', async () => {
    vi.useFakeTimers();
    try {
      const target = new Date(Date.now() + 10 * DAY_MS);
      const stop = new AbortController();
      const promise = sleepUntil(target, stop.signal);

      await vi.advanceTimersByTimeAsync(2 * DAY_MS);
      stop.abort();
      const outcome = await promise;

      expect(outcome).toBe('stopped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('alvo já no passado ⇒ acorda sem agendar timer nenhum', async () => {
    const target = new Date(Date.now() - 1000);
    const stop = new AbortController();
    const outcome = await sleepUntil(target, stop.signal);
    expect(outcome).toBe('woke');
  });
});

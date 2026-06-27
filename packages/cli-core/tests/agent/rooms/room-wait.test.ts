// EST-ROOMS-WAIT · ADR-0081 — LÓGICA PURA da espera produtor-consumidor do room_read.
// Sem timers reais: testa decisão (quem postou/quando parar), clamp do teto anti-DoS,
// e a NOTA loud (timeout com writers faltando ≠ vazio silencioso). Cada um falha sem o fix.

import { describe, expect, it } from 'vitest';
import {
  MAX_ROOM_WAIT_MS,
  DEFAULT_ROOM_WAIT_MS,
  clampWaitTimeout,
  normalizeWaitFor,
  evaluateWait,
  buildWaitTimeoutNote,
  buildWaitSatisfiedNote,
} from '../../../src/agent/rooms/room-wait.js';
import type { AgentMessage } from '../../../src/agent/rooms/message.js';

function msg(from: string, body = 'x'): AgentMessage {
  return { msg_id: `m-${from}-${Math.random()}`, from, to: 'coord', kind: 'inform', body, ts: 1 };
}

describe('clampWaitTimeout — teto DURO anti-DoS (nunca infinito)', () => {
  it('ausente ⇒ default sensato', () => {
    expect(clampWaitTimeout(undefined)).toBe(DEFAULT_ROOM_WAIT_MS);
  });

  it('acima do teto ⇒ CLAMPADO em MAX_ROOM_WAIT_MS', () => {
    expect(clampWaitTimeout(10 * 60_000)).toBe(MAX_ROOM_WAIT_MS);
    expect(clampWaitTimeout(Number.MAX_SAFE_INTEGER)).toBe(MAX_ROOM_WAIT_MS);
  });

  it('0 / negativo / NaN / Infinity ⇒ default (NUNCA interpretado como espera infinita)', () => {
    expect(clampWaitTimeout(0)).toBe(DEFAULT_ROOM_WAIT_MS);
    expect(clampWaitTimeout(-1)).toBe(DEFAULT_ROOM_WAIT_MS);
    expect(clampWaitTimeout(Number.NaN)).toBe(DEFAULT_ROOM_WAIT_MS);
    expect(clampWaitTimeout(Number.POSITIVE_INFINITY)).toBe(DEFAULT_ROOM_WAIT_MS);
    // o teto é absoluto: o maior valor PERMITIDO é exatamente MAX_ROOM_WAIT_MS
    expect(clampWaitTimeout(MAX_ROOM_WAIT_MS + 1)).toBe(MAX_ROOM_WAIT_MS);
  });

  it('valor válido na janela ⇒ preservado (arredondado p/ inteiro de ms)', () => {
    expect(clampWaitTimeout(5_000)).toBe(5_000);
    expect(clampWaitTimeout(1234.7)).toBe(1235);
  });
});

describe('normalizeWaitFor — trim/dedup, ordem preservada', () => {
  it('ausente ⇒ []', () => {
    expect(normalizeWaitFor(undefined)).toEqual([]);
  });
  it('trim + descarta vazios + dedup', () => {
    expect(normalizeWaitFor([' alpha ', 'beta', '', 'alpha', '  '])).toEqual(['alpha', 'beta']);
  });
});

describe('evaluateWait — quem já postou / quando parar (PURO)', () => {
  it('lista vazia de writers ⇒ satisfeito imediatamente (snapshot, sem espera)', () => {
    expect(evaluateWait([], [])).toEqual({ satisfied: true, missing: [] });
  });

  it('TODOS postaram ⇒ satisfied, missing vazio', () => {
    const feed = [msg('prod-A'), msg('prod-B')];
    expect(evaluateWait(feed, ['prod-A', 'prod-B'])).toEqual({ satisfied: true, missing: [] });
  });

  it('um writer FALTANDO ⇒ não-satisfeito, listado em missing', () => {
    const feed = [msg('prod-A')]; // prod-B ainda não postou
    const r = evaluateWait(feed, ['prod-A', 'prod-B']);
    expect(r.satisfied).toBe(false);
    expect(r.missing).toEqual(['prod-B']);
  });

  it('feed VAZIO ⇒ todos faltando (a corrida do dogfood: leu antes de qualquer post)', () => {
    const r = evaluateWait([], ['prod-A', 'prod-B']);
    expect(r.satisfied).toBe(false);
    expect(r.missing).toEqual(['prod-A', 'prod-B']);
  });

  it('match EXATO do label (não confunde "bob" com "bob2")', () => {
    const feed = [msg('bob2')];
    expect(evaluateWait(feed, ['bob']).missing).toEqual(['bob']);
    expect(evaluateWait(feed, ['bob2']).satisfied).toBe(true);
  });

  it('≥1 msg satisfaz (múltiplas do mesmo writer não mudam o resultado)', () => {
    const feed = [msg('prod-A'), msg('prod-A'), msg('prod-A')];
    expect(evaluateWait(feed, ['prod-A']).satisfied).toBe(true);
  });
});

describe('buildWaitTimeoutNote — FAIL-MODE LOUD (parcial ≠ vazio silencioso)', () => {
  it('writers faltando ⇒ aviso EXPLÍCITO com os nomes', () => {
    const note = buildWaitTimeoutNote(['prod-B', 'prod-C']);
    expect(note).toContain('espera expirou');
    expect(note).toContain('prod-B');
    expect(note).toContain('prod-C');
    expect(note).toMatch(/⚠/);
  });

  it('missing vazio ⇒ SEM aviso (não inventa incompletude falsa)', () => {
    expect(buildWaitTimeoutNote([])).toBe('');
  });
});

describe('buildWaitSatisfiedNote — caminho feliz auto-explicado', () => {
  it('confirma quais writers postaram', () => {
    const note = buildWaitSatisfiedNote(['prod-A', 'prod-B']);
    expect(note).toContain('prod-A');
    expect(note).toContain('prod-B');
    expect(note).toMatch(/✓/);
  });
  it('lista vazia ⇒ vazio', () => {
    expect(buildWaitSatisfiedNote([])).toBe('');
  });
});

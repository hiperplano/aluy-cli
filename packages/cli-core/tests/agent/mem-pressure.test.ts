// EST-1012 — ROBUSTEZ DE MEMÓRIA · backstop de OOM. Provas do JUÍZO PURO + config:
//
//  1. resolveHeapLimitMb: precedência operador > env `ALUY_MAX_HEAP_MB` > default,
//     clampado a `[MIN,MAX]` — o teto que o launcher aplica no `--max-old-space-size`;
//  2. resolveMemPressure: limiares ESCALONADOS (compactar<avisar<encerrar), deslocáveis
//     por `ALUY_MEM_PRESSURE_AT`, clampados, ordem ESTRITA garantida; inerte sem teto;
//  3. heapPressureRatio: razão clampada [0,1], fail-safe sem teto/uso;
//  4. decideMemPressure: ESCALONAMENTO (degrau mais alto vence) + ANTI-SPAM por episódio
//     + histerese (relaxMemPressure re-arma após recuo) + shutdown terminal one-shot;
//  5. isMemPressureEnabled: ligado por default, só `_OFF` truthy desliga.

import { describe, expect, it } from 'vitest';
import {
  resolveHeapLimitMb,
  resolveMemPressure,
  decideMemPressure,
  heapPressureRatio,
  parseMemPressureAt,
  isMemPressureEnabled,
  newMemPressureState,
  noteMemAction,
  relaxMemPressure,
  bytesToMb,
  MEM_PRESSURE_OFF,
  DEFAULT_COMPACT_AT,
  DEFAULT_WARN_AT,
  DEFAULT_SHUTDOWN_AT,
  DEFAULT_MAX_HEAP_MB,
  MIN_MAX_HEAP_MB,
  MAX_MAX_HEAP_MB,
} from '../../src/agent/mem-pressure.js';

const MB = 1024 * 1024;

describe('resolveHeapLimitMb — teto do --max-old-space-size (env/operador/default)', () => {
  it('default quando nada foi passado', () => {
    expect(resolveHeapLimitMb({})).toBe(DEFAULT_MAX_HEAP_MB);
  });

  it('env ALUY_MAX_HEAP_MB vence o default e é clampado', () => {
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '2048' })).toBe(2048);
    // abaixo do piso ⇒ piso; acima do teto ⇒ teto.
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '64' })).toBe(MIN_MAX_HEAP_MB);
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '999999' })).toBe(MAX_MAX_HEAP_MB);
  });

  it('valor explícito do operador (NODE_OPTIONS já posto) VENCE o env', () => {
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '2048' }, 3000)).toBe(3000);
  });

  it('env inválido/vazio ⇒ default', () => {
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: 'abc' })).toBe(DEFAULT_MAX_HEAP_MB);
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '0' })).toBe(DEFAULT_MAX_HEAP_MB);
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '' })).toBe(DEFAULT_MAX_HEAP_MB);
  });

  // ADAPTATIVO (fração da RAM) — o bug do Tiago: 4 GiB fixo capava sessões num host de
  // 32 GiB (20 sub-agentes estouravam 4 GiB com 28 GiB livres → "Killed").
  it('ADAPTATIVO: sem flag/env, escala com a RAM total (32 GiB ⇒ ~22 GiB, NÃO 4 GiB)', () => {
    const r = resolveHeapLimitMb({}, undefined, 32768);
    expect(r).toBeGreaterThan(DEFAULT_MAX_HEAP_MB); // muito acima dos 4 GiB fixos
    expect(r).toBe(Math.floor(32768 * 0.7)); // 22937
  });

  it('ADAPTATIVO escala p/ baixo em máquina pequena (4 GiB ⇒ ~2,8 GiB, folga p/ OS)', () => {
    expect(resolveHeapLimitMb({}, undefined, 4096)).toBe(Math.floor(4096 * 0.7));
  });

  it('precedência: operador e env VENCEM o adaptativo', () => {
    expect(resolveHeapLimitMb({ ALUY_MAX_HEAP_MB: '2000' }, undefined, 32768)).toBe(2000);
    expect(resolveHeapLimitMb({}, 3000, 32768)).toBe(3000);
  });

  it('sem totalMem (ambiente não-Node/teste) ⇒ cai no default fixo (sem regressão)', () => {
    expect(resolveHeapLimitMb({})).toBe(DEFAULT_MAX_HEAP_MB);
  });

  it('adaptativo é clampado em [MIN, MAX]', () => {
    expect(resolveHeapLimitMb({}, undefined, 256)).toBe(MIN_MAX_HEAP_MB); // máquina minúscula
    expect(resolveHeapLimitMb({}, undefined, 999999)).toBe(MAX_MAX_HEAP_MB); // host gigante
  });
});

describe('resolveMemPressure — limiares escalonados (compactar<avisar<encerrar)', () => {
  it('defaults a partir do heapLimitMb', () => {
    const cfg = resolveMemPressure({ heapLimitMb: 4096 });
    expect(cfg.heapLimitBytes).toBe(4096 * MB);
    expect(cfg.compactAt).toBeCloseTo(DEFAULT_COMPACT_AT, 5);
    expect(cfg.warnAt).toBeCloseTo(DEFAULT_WARN_AT, 5);
    expect(cfg.shutdownAt).toBeCloseTo(DEFAULT_SHUTDOWN_AT, 5);
    // ordem ESTRITA
    expect(cfg.compactAt).toBeLessThan(cfg.warnAt);
    expect(cfg.warnAt).toBeLessThan(cfg.shutdownAt);
  });

  it('heapLimitMb<=0 ⇒ INERTE (MEM_PRESSURE_OFF)', () => {
    expect(resolveMemPressure({ heapLimitMb: 0 })).toEqual(MEM_PRESSURE_OFF);
    expect(resolveMemPressure({ heapLimitMb: -5 }).heapLimitBytes).toBe(0);
  });

  it('ALUY_MEM_PRESSURE_AT desloca a base (e mantém os deltas dos degraus)', () => {
    const cfg = resolveMemPressure({ heapLimitMb: 4096, pressureAtEnv: '0.7' });
    expect(cfg.compactAt).toBeCloseTo(0.7, 5);
    // warn = base + (0.88-0.8) = 0.78 ; shutdown = base + (0.95-0.8) = 0.85
    expect(cfg.warnAt).toBeCloseTo(0.78, 5);
    expect(cfg.shutdownAt).toBeCloseTo(0.85, 5);
  });

  it('aceita porcentagem (75 ⇒ 0.75) e clampa/preserva a ordem perto do teto', () => {
    expect(resolveMemPressure({ heapLimitMb: 4096, pressureAtEnv: '75' }).compactAt).toBeCloseTo(
      0.75,
      5,
    );
    // base alta (0.99): ainda assim compact<warn<shutdown por STEP, sob MAX (0.99).
    const c = resolveMemPressure({ heapLimitMb: 4096, pressureAtEnv: '0.99' });
    expect(c.compactAt).toBeLessThan(c.warnAt);
    expect(c.warnAt).toBeLessThan(c.shutdownAt);
    expect(c.shutdownAt).toBeLessThanOrEqual(0.99);
  });

  it('env inválido ⇒ cai no default da base', () => {
    expect(resolveMemPressure({ heapLimitMb: 4096, pressureAtEnv: 'xyz' }).compactAt).toBeCloseTo(
      DEFAULT_COMPACT_AT,
      5,
    );
  });
});

describe('parseMemPressureAt', () => {
  it('razão / porcentagem / inválido', () => {
    expect(parseMemPressureAt('0.8')).toBeCloseTo(0.8, 5);
    expect(parseMemPressureAt('80')).toBeCloseTo(0.8, 5);
    expect(parseMemPressureAt(0.9)).toBeCloseTo(0.9, 5);
    expect(parseMemPressureAt('')).toBeUndefined();
    expect(parseMemPressureAt('abc')).toBeUndefined();
    expect(parseMemPressureAt('0')).toBeUndefined();
    expect(parseMemPressureAt(undefined)).toBeUndefined();
  });
});

describe('heapPressureRatio — razão clampada e fail-safe', () => {
  const limit = 1000 * MB;
  it('razão correta clampada [0,1]', () => {
    expect(heapPressureRatio(500 * MB, limit)).toBeCloseTo(0.5, 5);
    expect(heapPressureRatio(2000 * MB, limit)).toBe(1); // clamp em 1
  });
  it('fail-safe: sem teto / uso inválido ⇒ 0 (não dispara)', () => {
    expect(heapPressureRatio(500 * MB, 0)).toBe(0);
    expect(heapPressureRatio(undefined, limit)).toBe(0);
    expect(heapPressureRatio(-5, limit)).toBe(0);
    expect(heapPressureRatio(NaN, limit)).toBe(0);
  });
});

describe('decideMemPressure — escalonamento + anti-spam + histerese', () => {
  const cfg = resolveMemPressure({ heapLimitMb: 4096 }); // compact .8 warn .88 shutdown .95

  it('abaixo de compactAt ⇒ none', () => {
    const st = newMemPressureState();
    expect(decideMemPressure(cfg, 0.5, st).action).toBe('none');
    expect(decideMemPressure(cfg, 0.79, st).action).toBe('none');
  });

  it('inerte (sem teto) ⇒ none mesmo com razão alta', () => {
    expect(decideMemPressure(MEM_PRESSURE_OFF, 0.99, newMemPressureState()).action).toBe('none');
  });

  it('≥compactAt ⇒ compact (1×); anti-spam suprime repetições no mesmo degrau', () => {
    const st = newMemPressureState();
    const d1 = decideMemPressure(cfg, 0.82, st);
    expect(d1.action).toBe('compact');
    noteMemAction(st, 'compact');
    // ainda no degrau de compactação ⇒ não re-dispara
    expect(decideMemPressure(cfg, 0.83, st).action).toBe('none');
  });

  it('≥warnAt (após compactar) ⇒ warn (1×)', () => {
    const st = newMemPressureState();
    noteMemAction(st, 'compact'); // simula já compactado neste episódio
    const d = decideMemPressure(cfg, 0.9, st);
    expect(d.action).toBe('warn');
    noteMemAction(st, 'warn');
    expect(decideMemPressure(cfg, 0.91, st).action).toBe('none'); // anti-spam
  });

  it('≥shutdownAt ⇒ shutdown firstTime; depois none (terminal one-shot)', () => {
    const st = newMemPressureState();
    const d = decideMemPressure(cfg, 0.96, st);
    expect(d).toEqual({ action: 'shutdown', firstTime: true });
    noteMemAction(st, 'shutdown');
    // já iniciado ⇒ nunca mais emite (terminal)
    expect(decideMemPressure(cfg, 0.99, st).action).toBe('none');
    expect(decideMemPressure(cfg, 0.5, st).action).toBe('none');
  });

  it('degrau MAIS ALTO vence (warn/shutdown antes de compact)', () => {
    const st = newMemPressureState();
    // pula direto p/ 96%: shutdown vence mesmo sem ter compactado antes
    expect(decideMemPressure(cfg, 0.96, st).action).toBe('shutdown');
  });

  it('HISTERESE: recuo abaixo do degrau re-arma a ação p/ um novo pico', () => {
    const st = newMemPressureState();
    // pico → compacta
    expect(decideMemPressure(cfg, 0.82, st).action).toBe('compact');
    noteMemAction(st, 'compact');
    expect(decideMemPressure(cfg, 0.83, st).action).toBe('none');
    // recuou abaixo de compactAt (compactação liberou RAM): relax re-arma
    relaxMemPressure(cfg, 0.6, st);
    expect(st.compactedThisEpisode).toBe(false);
    // novo pico ⇒ compacta DE NOVO
    expect(decideMemPressure(cfg, 0.82, st).action).toBe('compact');
  });

  it('HISTERESE NÃO re-arma o shutdown (terminal)', () => {
    const st = newMemPressureState();
    noteMemAction(st, 'shutdown');
    relaxMemPressure(cfg, 0.1, st);
    expect(st.shutdownInitiated).toBe(true);
  });
});

describe('isMemPressureEnabled — ligado por default, só _OFF desliga', () => {
  it('default ligado', () => {
    expect(isMemPressureEnabled({})).toBe(true);
  });
  it('_OFF truthy desliga; valores neutros não', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE']) {
      expect(isMemPressureEnabled({ ALUY_MEM_PRESSURE_OFF: v })).toBe(false);
    }
    expect(isMemPressureEnabled({ ALUY_MEM_PRESSURE_OFF: '0' })).toBe(true);
    expect(isMemPressureEnabled({ ALUY_MEM_PRESSURE_OFF: '' })).toBe(true);
  });
});

describe('bytesToMb — legível p/ as mensagens', () => {
  it('arredonda; fail-safe em 0', () => {
    expect(bytesToMb(2048 * MB)).toBe(2048);
    expect(bytesToMb(0)).toBe(0);
    expect(bytesToMb(-5)).toBe(0);
  });
});

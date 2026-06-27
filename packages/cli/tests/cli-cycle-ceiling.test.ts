// EST-1019 · ADR-0062 §Addendum 1 (APR-0086) · BUG-0023 — lógica do TETO do `--cycle`
// HEADLESS: resolução das flags de boot, pré-check do no-cap (exit 2) e a mensagem que de
// fato FUNCIONA. Não-tautológico: testa a regra "sem teto ⇒ não inicia" (CA-1/CA-4), a
// vitória da flag de boot sobre o teto embutido (CA-2) e que a mensagem só sugere flags
// que o parser do `-p` aceita (CA-3, guard anti-F10).

import { describe, it, expect } from 'vitest';
import {
  resolveCycleBootCeilings,
  preflightCycleCeiling,
  NO_CYCLE_CEILING_MESSAGE,
} from '../src/session/run.js';
import { parseArgs } from '../src/cli.js';

describe('resolveCycleBootCeilings — flags de boot → override de ceilings', () => {
  it('--cycles 2 ⇒ maxIterations 2', () => {
    expect(resolveCycleBootCeilings({ cycles: '2' })).toEqual({ maxIterations: 2 });
  });

  it('--cycle-for 30s ⇒ maxDurationMs 30000', () => {
    expect(resolveCycleBootCeilings({ cycleFor: '30s' })).toEqual({ maxDurationMs: 30_000 });
  });

  it('--cycle-for 30m ⇒ maxDurationMs 1.800.000', () => {
    expect(resolveCycleBootCeilings({ cycleFor: '30m' })).toEqual({ maxDurationMs: 30 * 60_000 });
  });

  it('--cycles e --cycle-for coexistem no override', () => {
    expect(resolveCycleBootCeilings({ cycles: '5', cycleFor: '10m' })).toEqual({
      maxIterations: 5,
      maxDurationMs: 10 * 60_000,
    });
  });

  it('nenhuma flag de boot ⇒ undefined (só o goal-embutido decide)', () => {
    expect(resolveCycleBootCeilings({})).toBeUndefined();
  });

  it('valores inválidos/≤0 são IGNORADOS (caem no teto embutido)', () => {
    expect(resolveCycleBootCeilings({ cycles: '0' })).toBeUndefined();
    expect(resolveCycleBootCeilings({ cycles: 'abc' })).toBeUndefined();
    expect(resolveCycleBootCeilings({ cycleFor: 'xyz' })).toBeUndefined();
    expect(resolveCycleBootCeilings({ cycleFor: '0' })).toBeUndefined();
  });

  // HUNT-CYCLE — `--cycles <fração em (0,1)>` (ex.: `0.5`) passava o guard `n > 0` e o
  // `Math.floor` o virava `0`, passado como override `maxIterations: 0` ⇒ `isPositive(0)`
  // rejeita no `resolveCycleCeilings` ⇒ recaía SILENCIOSO no DEFAULT de 20 ciclos (teto
  // MAIS FROUXO que o pedido < 1, sem aviso). Agora inteiro-only ⇒ IGNORADO (cai no teto
  // embutido; sem ele, o pré-check recusa por no-ceiling → exit 2), nunca teto mascarado.
  it('--cycles 0.5 (fração) é IGNORADO — não vira maxIterations:0 mascarado', () => {
    expect(resolveCycleBootCeilings({ cycles: '0.5' })).toBeUndefined();
    expect(resolveCycleBootCeilings({ cycles: '1.5' })).toBeUndefined();
    // Sem teto embutido no goal, a fração ignorada ⇒ o pré-check recusa (não 20 ciclos).
    expect(preflightCycleCeiling('diga oi', resolveCycleBootCeilings({ cycles: '0.5' }))).toEqual({
      kind: 'no-ceiling',
    });
  });
});

describe('preflightCycleCeiling — invariante "sem teto ⇒ não inicia" (CLI-SEC-14)', () => {
  it('CA-1/CA-4: sem teto algum (goal puro, sem flag de boot) ⇒ no-ceiling', () => {
    expect(preflightCycleCeiling('diga oi', undefined)).toEqual({ kind: 'no-ceiling' });
  });

  it('CA-2: --cycles N (flag de boot) ⇒ ok, mesmo com goal puro', () => {
    expect(preflightCycleCeiling('diga oi', { maxIterations: 2 })).toEqual({ kind: 'ok' });
  });

  it('CA-2: --cycle-for <dur> (flag de boot) ⇒ ok, mesmo com goal puro', () => {
    expect(preflightCycleCeiling('diga oi', { maxDurationMs: 30_000 })).toEqual({ kind: 'ok' });
  });

  it('CA-2 (paridade TUI): teto EMBUTIDO no goal (intervalo) ⇒ ok, sem flag de boot', () => {
    // `-p "1m tarefa" --cycle`: o intervalo embutido recai num default duro de duração.
    expect(preflightCycleCeiling('1m diga oi', undefined)).toEqual({ kind: 'ok' });
  });

  it('CA-2 (--por embutido) ⇒ ok', () => {
    expect(preflightCycleCeiling('--por 30m diga oi', undefined)).toEqual({ kind: 'ok' });
  });

  it('falta a tarefa ⇒ parse-error (não no-ceiling)', () => {
    const r = preflightCycleCeiling('', { maxIterations: 2 });
    expect(r.kind).toBe('parse-error');
  });
});

describe('NO_CYCLE_CEILING_MESSAGE — a dica que de fato FUNCIONA (CA-3, guard anti-F10)', () => {
  it('sugere --cycles e --cycle-for', () => {
    expect(NO_CYCLE_CEILING_MESSAGE).toContain('--cycles');
    expect(NO_CYCLE_CEILING_MESSAGE).toContain('--cycle-for');
  });

  it('NÃO sugere --max-iter/--max-iterations (teto do LOOP, não do ciclo)', () => {
    expect(NO_CYCLE_CEILING_MESSAGE).not.toContain('--max-iter');
  });

  // CA-3 (o cerne) — a dica copiada LITERALMENTE deve ser parseável pelo `-p` SEM virar
  // "sem prompt" (caso F10). Extraímos o exemplo `aluy -p "..." --cycle --cycles 2` da
  // mensagem e o passamos ao MESMO parser: tem que dar `launch` com print+cycle+cycles
  // (e o prompt intacto), nunca usage-error de "-p sem prompt".
  it('o exemplo da mensagem, parseado pelo `-p`, INICIA o ciclo (não "sem prompt")', () => {
    // Reconstrói exatamente o exemplo sugerido (sem o `aluy` líder).
    const a = parseArgs(['-p', 'diga oi', '--cycle', '--cycles', '2']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.print).toBe(true);
      expect(a.printArg).toBe('diga oi'); // o prompt NÃO foi engolido (anti-F10)
      expect(a.cycle).toBe(true);
      expect(a.cycles).toBe('2');
    }
  });

  it('o exemplo --cycle-for da mensagem também parseia e inicia', () => {
    const a = parseArgs(['-p', 'diga oi', '--cycle', '--cycle-for', '30m']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.printArg).toBe('diga oi');
      expect(a.cycleFor).toBe('30m');
    }
    // Contra-prova do F10: a sintaxe PROIBIDA (cap embutido no início do goal) QUEBRA —
    // o parser vê `--max-iter` como flag e o prompt fica vazio ("sem prompt").
    const bad = parseArgs(['-p', '--max-iter 2 diga oi']);
    expect(bad.kind).toBe('launch');
    if (bad.kind === 'launch') {
      // `-p` seguido de `--max-iter...` (começa com `-`) ⇒ printArg ausente (cai no stdin/
      // posicional vazio) ⇒ no runtime headless vira "aluy: -p sem prompt". Confirma por que
      // a mensagem NUNCA sugere isso.
      expect(bad.printArg).toBeUndefined();
    }
  });
});

describe('CA-2 (não-confusão) — --max-iterations NÃO é teto de ciclo', () => {
  it('--cycle --max-iterations 2 SEM --cycles/--cycle-for ⇒ ainda no-ceiling (recusa)', () => {
    // O parser separa os tetos; a resolução do teto de CICLO só olha --cycles/--cycle-for.
    const a = parseArgs(['-p', 'diga oi', '--cycle', '--max-iterations', '2']);
    expect(a.kind).toBe('launch');
    if (a.kind === 'launch') {
      expect(a.maxIterations).toBe('2');
      expect(a.cycles).toBeUndefined();
      expect(a.cycleFor).toBeUndefined();
      // o override de teto de CICLO ignora --max-iterations ⇒ undefined ⇒ no-ceiling.
      const ov = resolveCycleBootCeilings(a);
      expect(ov).toBeUndefined();
      expect(preflightCycleCeiling('diga oi', ov)).toEqual({ kind: 'no-ceiling' });
    }
  });
});

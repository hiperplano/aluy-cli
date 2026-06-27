// EST-0981 · ADR-0062 (APR-0067) · CLI-SEC-14 — a bateria do gate FORTE do `seguranca`
// (anti-runaway de autonomia) sobre as PARADAS DURAS e o parsing de `/cycle`. Foca:
//   • GS-L2/RES-L-1 — "sem teto ⇒ NÃO inicia" (inclusive auto-pacing), defaults
//     conservadores CODIFICADOS, intervalo sem duração recai num default duro.
//   • GS-L3 — tetos clampados aos teto-tetos (não dá p/ configurar infinito).
//   • GS-L8 — os DOIS ritmos, mesmos tetos.

import { describe, expect, it } from 'vitest';
import {
  resolveCycleCeilings,
  aggregateLimitsOf,
  NoCeilingError,
  parseCycleInput,
  parseDuration,
  CycleParseError,
  MAX_CYCLE_DURATION_MS,
  MAX_CYCLE_ITERATIONS,
  DEFAULT_CYCLE_DURATION_MS,
  DEFAULT_CYCLE_ITERATIONS,
  type CycleRequest,
} from '../../src/index.js';

describe('EST-0981 · GS-L2/RES-L-1 — PARADAS DURAS: sem teto ⇒ NÃO inicia', () => {
  it('recusa iniciar quando NÃO há NENHUM teto (fixed) — falha-fechada', () => {
    const req: CycleRequest = { rhythm: 'fixed' };
    expect(() => resolveCycleCeilings(req)).toThrow(NoCeilingError);
  });

  it('recusa iniciar quando NÃO há teto também em AUTO-PACE (auto sem teto = runaway puro, GS-L8)', () => {
    const req: CycleRequest = { rhythm: 'auto-pace' };
    expect(() => resolveCycleCeilings(req)).toThrow(NoCeilingError);
  });

  it('um INTERVALO sozinho recai no DEFAULT DURO de duração total (intervalo ≠ "para sempre")', () => {
    const c = resolveCycleCeilings({ rhythm: 'fixed', intervalMs: 5 * 60_000 });
    expect(c.maxDurationMs).toBe(DEFAULT_CYCLE_DURATION_MS);
    expect(c.maxIterations).toBe(DEFAULT_CYCLE_ITERATIONS);
    expect(c.intervalMs).toBe(5 * 60_000);
    // budget agregado SEMPRE existe (obrigatório), mesmo sem --budget.
    expect(c.maxTokens).toBeGreaterThan(0);
  });

  it('uma DURAÇÃO explícita basta como teto (e mantém defaults nos demais)', () => {
    const c = resolveCycleCeilings({ rhythm: 'fixed', maxDurationMs: 10 * 60_000 });
    expect(c.maxDurationMs).toBe(10 * 60_000);
    expect(c.maxIterations).toBe(DEFAULT_CYCLE_ITERATIONS);
  });

  it('só ITERAÇÕES também basta (duração cai no default duro — cinto + suspensório)', () => {
    const c = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 3 });
    expect(c.maxIterations).toBe(3);
    expect(c.maxDurationMs).toBe(DEFAULT_CYCLE_DURATION_MS);
  });
});

describe('EST-0981 · GS-L3 — tetos clampados aos teto-tetos (não-configurável infinito)', () => {
  it('clampa duração ACIMA do teto-teto duro', () => {
    const c = resolveCycleCeilings({ rhythm: 'fixed', maxDurationMs: 999 * 3_600_000 });
    expect(c.maxDurationMs).toBe(MAX_CYCLE_DURATION_MS);
  });

  it('clampa iterações ACIMA do teto-teto duro', () => {
    const c = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 99_999 });
    expect(c.maxIterations).toBe(MAX_CYCLE_ITERATIONS);
  });
});

describe('EST-0981 · GS-L8 — os DOIS ritmos, MESMOS tetos', () => {
  it('auto-pace COM teto resolve igual (tetos iguais; intervalo zerado)', () => {
    const fixed = resolveCycleCeilings({
      rhythm: 'fixed',
      maxIterations: 3,
      maxDurationMs: 60_000,
    });
    const auto = resolveCycleCeilings({
      rhythm: 'auto-pace',
      maxIterations: 3,
      maxDurationMs: 60_000,
    });
    expect(auto.maxIterations).toBe(fixed.maxIterations);
    expect(auto.maxDurationMs).toBe(fixed.maxDurationMs);
    expect(auto.maxTokens).toBe(fixed.maxTokens);
    expect(auto.intervalMs).toBe(0); // auto não tem intervalo fixo
    expect(auto.rhythm).toBe('auto-pace');
  });
});

describe('EST-0981 · aggregateLimitsOf — budget agregado herda o teto de tokens', () => {
  it('o teto de TOKENS do budget agregado é o dos ceilings (soma de todos os ciclos)', () => {
    const c = resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 3, maxTokens: 12_345 });
    const limits = aggregateLimitsOf(c);
    expect(limits.maxTokens).toBe(12_345);
    expect(limits.maxIterations).toBeGreaterThan(0);
    expect(limits.maxToolCalls).toBeGreaterThan(0);
  });
});

describe('EST-0981 · parseDuration — 5m/30s/1h/90', () => {
  it.each([
    ['5m', 5 * 60_000],
    ['30s', 30_000],
    ['1h', 3_600_000],
    ['90', 90_000], // sem sufixo = segundos
    ['500ms', 500],
  ])('parseia %s', (token, ms) => {
    expect(parseDuration(token)).toBe(ms);
  });

  it('rejeita lixo', () => {
    expect(parseDuration('abc')).toBeUndefined();
    expect(parseDuration('5x')).toBeUndefined();
  });

  // HUNT-SLASH — uma duração ZERO não é uma duração válida. Antes (`< 0`) o `0`/`0s`
  // passava como `0`, gerando dois misparses silenciosos (ver parseDuration/cycle-parse).
  it('rejeita duração ZERO (0/0s/0m) — não é uma duração válida', () => {
    expect(parseDuration('0')).toBeUndefined();
    expect(parseDuration('0s')).toBeUndefined();
    expect(parseDuration('0m')).toBeUndefined();
    expect(parseDuration('0ms')).toBeUndefined();
  });
});

describe('EST-0981 · parseCycleInput — contrato `/cycle <intervalo|dur> "tarefa"`', () => {
  it('intervalo posicional + tarefa entre aspas (ritmo fixo)', () => {
    const { request, task } = parseCycleInput('5m "rode os testes e corrija o que quebrar"');
    expect(request.rhythm).toBe('fixed');
    expect(request.intervalMs).toBe(5 * 60_000);
    expect(task).toBe('rode os testes e corrija o que quebrar');
  });

  it('--por <dur> + tarefa', () => {
    const { request, task } = parseCycleInput('--por 30m "refine os PRs abertos"');
    expect(request.maxDurationMs).toBe(30 * 60_000);
    expect(task).toBe('refine os PRs abertos');
  });

  it('--auto + --max-iter + tarefa (auto-pace)', () => {
    const { request, task } = parseCycleInput('--auto --max-iter 10 "acompanhe o deploy"');
    expect(request.rhythm).toBe('auto-pace');
    expect(request.maxIterations).toBe(10);
    expect(task).toBe('acompanhe o deploy');
  });

  it('--budget <tokens>', () => {
    const { request } = parseCycleInput('5m --budget 50000 "x"');
    expect(request.maxTokens).toBe(50_000);
  });

  it('falta a tarefa ⇒ erro de sintaxe', () => {
    expect(() => parseCycleInput('5m')).toThrow(CycleParseError);
  });

  it('--por sem duração ⇒ erro', () => {
    expect(() => parseCycleInput('--por "x"')).toThrow(CycleParseError);
  });

  // HUNT-SLASH — `--por 0` é um erro de parse CLARO (antes: parseDuration('0')=0 ⇒ sem
  // erro; isPositive(0) falso ⇒ 0 ignorado ⇒ duração caía no DEFAULT de 30min, sem aviso).
  it('--por 0 ⇒ erro de sintaxe (não silencia p/ o default de 30min)', () => {
    expect(() => parseCycleInput('--por 0 "tarefa"')).toThrow(CycleParseError);
    expect(() => parseCycleInput('--por 0s "tarefa"')).toThrow(CycleParseError);
  });

  // HUNT-SLASH — `/cycle 0 "tarefa"`: o `0` posicional NÃO é mais tratado como intervalo
  // (duração zero é inválida). Antes, era ENGOLIDO como intervalo=0 (sumia, e ainda caía
  // em NoCeilingError). Agora não vira intervalo — fica como token literal da linha (o
  // parser não dropa posicional desconhecido), preservando o que o usuário digitou.
  it('/cycle 0 "tarefa": o 0 não é tratado como intervalo (intervalMs undefined)', () => {
    const { request, task } = parseCycleInput('0 "rode os testes"');
    expect(request.intervalMs).toBeUndefined(); // 0 NÃO virou intervalo (≠ engolido).
    expect(task).toBe('0 rode os testes'); // o token literal sobrevive na linha.
  });

  it('a tarefa entre aspas NÃO é confundida com flag (ex.: aspas com hífen)', () => {
    const { task } = parseCycleInput('5m "--por isso, rode --auto de novo"');
    expect(task).toBe('--por isso, rode --auto de novo');
  });

  // HUNT-CYCLE — `--max-iter <fração em (0,1)>` (ex.: `0.5`) passava o guard `> 0` e o
  // `Math.floor` o virava `0`, que `isPositive(0)` rejeita em `resolveCycleCeilings` ⇒ o
  // teto pedido (< 1) recaía SILENCIOSO no DEFAULT de 20 ciclos — o MESMO misparse que o
  // HUNT-SLASH fechou no `--por 0`. Agora exige inteiro ≥ 1: `0.5`/`0`/`1.5` ⇒ erro CLARO.
  it('--max-iter 0.5 ⇒ erro de sintaxe (não silencia p/ o default de 20 ciclos)', () => {
    expect(() => parseCycleInput('--max-iter 0.5 "tarefa"')).toThrow(CycleParseError);
    expect(() => parseCycleInput('--max-iter 0 "tarefa"')).toThrow(CycleParseError);
    expect(() => parseCycleInput('--max-iter 1.5 "tarefa"')).toThrow(CycleParseError);
  });

  // PROVA do EFEITO (não só do parse): sem o fix, `--max-iter 0.5` resolveria p/ o DEFAULT
  // de 20 ciclos — um teto MAIS FROUXO que o pedido, sem aviso. Com o fix, nem chega a
  // resolver (o parse já recusa), então o usuário vê o erro em vez de um teto mascarado.
  it('--max-iter 0.5 NÃO resolve p/ um teto frouxo mascarado (default 20)', () => {
    // O TAMANHO do furo: um `maxIterations:0` (o que `Math.floor(0.5)` produzia) com um
    // OUTRO teto presente (intervalo) NÃO recusa — recai SILENCIOSO no default de 20 ciclos
    // (teto MAIS FROUXO que o `< 1` pedido). Isto é o que o usuário ganharia sem o fix.
    expect(
      resolveCycleCeilings({ rhythm: 'fixed', maxIterations: 0, intervalMs: 60_000 }).maxIterations,
    ).toBe(DEFAULT_CYCLE_ITERATIONS);
    // …mas o parse agora barra a fração ANTES de chegar a esse default mascarado.
    expect(() => parseCycleInput('--max-iter 0.5 "tarefa"')).toThrow(CycleParseError);
  });

  // HUNT-CYCLE — idem p/ `--budget`: `--budget 0.9` virava `0` (floor) e recaía SILENCIOSO
  // no budget DEFAULT da sessão (o usuário pedia < 1 token e ganhava o teto cheio).
  it('--budget 0.9 ⇒ erro de sintaxe (não silencia p/ o budget default)', () => {
    expect(() => parseCycleInput('5m --budget 0.9 "tarefa"')).toThrow(CycleParseError);
    expect(() => parseCycleInput('5m --budget 0 "tarefa"')).toThrow(CycleParseError);
  });

  // Não-regressão: inteiros válidos seguem aceitos (o fix só barra fração/zero).
  it('--max-iter 3 e --budget 50000 seguem válidos (inteiros)', () => {
    const a = parseCycleInput('--max-iter 3 "x"');
    expect(a.request.maxIterations).toBe(3);
    const b = parseCycleInput('5m --budget 50000 "x"');
    expect(b.request.maxTokens).toBe(50_000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EST-1155 · ADR-0132 §3 §4 — formas naturais, erro didático, aspas opcionais
// ═══════════════════════════════════════════════════════════════════════════════

describe('EST-1155 · CA-1 — "a cada <dur>" ⇒ intervalo', () => {
  it('a cada 30s ⇒ intervalo 30s', () => {
    const { request, task } = parseCycleInput('a cada 30s "tarefa" 5x');
    expect(request.intervalMs).toBe(30_000);
    expect(task).toBe('tarefa');
  });

  it('a cada 5m ⇒ intervalo 5min', () => {
    const { request, task } = parseCycleInput('a cada 5m "busque dados" 3x');
    expect(request.intervalMs).toBe(5 * 60_000);
    expect(task).toBe('busque dados');
  });

  it('a cada 1h ⇒ intervalo 1h', () => {
    const { request, task } = parseCycleInput('a cada 1h "monitore" 10x');
    expect(request.intervalMs).toBe(3_600_000);
    expect(task).toBe('monitore');
  });
});

describe('EST-1155 · CA-2 — "<N>x" / "<N> vezes" ⇒ --max-iter', () => {
  it('5x no final ⇒ max-iter 5', () => {
    const { request, task } = parseCycleInput('30s "tarefa" 5x');
    expect(request.maxIterations).toBe(5);
    expect(task).toBe('tarefa');
  });

  it('5 vezes no final ⇒ max-iter 5', () => {
    const { request, task } = parseCycleInput('5m "tarefa" 5 vezes');
    expect(request.maxIterations).toBe(5);
    expect(task).toBe('tarefa');
  });

  it('10x no começo (before_task) ⇒ max-iter 10', () => {
    const { request, task } = parseCycleInput('10x a cada 30s busque geladeira');
    expect(request.maxIterations).toBe(10);
    expect(request.intervalMs).toBe(30_000);
    expect(task).toBe('busque geladeira');
  });

  it('3 vezes no começo (before_task) ⇒ max-iter 3', () => {
    const { request, task } = parseCycleInput('3 vezes a cada 1m rode testes');
    expect(request.maxIterations).toBe(3);
    expect(request.intervalMs).toBe(60_000);
    expect(task).toBe('rode testes');
  });

  it('combina com intervalo canônico: 5m "tarefa" 5x ⇒ intervalo + max-iter', () => {
    const { request, task } = parseCycleInput('5m "tarefa" 5x');
    expect(request.intervalMs).toBe(5 * 60_000);
    expect(request.maxIterations).toBe(5);
    expect(task).toBe('tarefa');
  });
});

describe('EST-1155 · CA-3 — formas canônicas intactas (não-regressão)', () => {
  it('5m "x" --max-iter 12 ainda funciona', () => {
    const { request, task } = parseCycleInput('5m "x" --max-iter 12');
    expect(request.intervalMs).toBe(5 * 60_000);
    expect(request.maxIterations).toBe(12);
    expect(task).toBe('x');
  });

  it('--por 1h "x" ainda funciona', () => {
    const { request, task } = parseCycleInput('--por 1h "refine PRs"');
    expect(request.maxDurationMs).toBe(3_600_000);
    expect(task).toBe('refine PRs');
  });

  it('--auto --max-iter 10 "x" ainda funciona', () => {
    const { request, task } = parseCycleInput('--auto --max-iter 10 "acompanhe deploy"');
    expect(request.rhythm).toBe('auto-pace');
    expect(request.maxIterations).toBe(10);
    expect(task).toBe('acompanhe deploy');
  });

  it('5m --budget 50000 "x" ainda funciona', () => {
    const { request, task } = parseCycleInput('5m --budget 50000 "verifique logs"');
    expect(request.intervalMs).toBe(5 * 60_000);
    expect(request.maxTokens).toBe(50_000);
    expect(task).toBe('verifique logs');
  });
});

describe('EST-1155 · CA-4 — CAP EXPLÍCITO obrigatório (CLI-SEC-14)', () => {
  it('a cada 30s "tarefa" SEM max-iter ⇒ intervalo recai no default duro de duração', () => {
    // ADR-0062 §2(a): intervalo sozinho NÃO é "para sempre" — recai no
    // DEFAULT_CYCLE_DURATION_MS. O parser extrai o intervalo; o ceiling
    // aplica o default conservador de duração total.
    const { request } = parseCycleInput('a cada 30s "tarefa sem teto explícito"');
    expect(request.intervalMs).toBe(30_000);
    expect(request.maxIterations).toBeUndefined();
    expect(request.maxDurationMs).toBeUndefined();
    // resolveCycleCeilings NÃO lança: intervalo → default de duração.
    const c = resolveCycleCeilings(request);
    expect(c.maxDurationMs).toBe(DEFAULT_CYCLE_DURATION_MS);
    expect(c.intervalMs).toBe(30_000);
  });

  it('SEM intervalo, SEM duração, SEM iterações ⇒ NoCeilingError (anti-runaway)', () => {
    // Este é o caso "sem teto NENHUM" que o CLI-SEC-14 protege.
    const req: CycleRequest = { rhythm: 'fixed' };
    expect(() => resolveCycleCeilings(req)).toThrow(NoCeilingError);
  });

  it('a cada 30s "tarefa" 5x ⇒ teto presente (max-iter), inicia', () => {
    const { request } = parseCycleInput('a cada 30s "tarefa com teto" 5x');
    expect(request.intervalMs).toBe(30_000);
    expect(request.maxIterations).toBe(5);
    const c = resolveCycleCeilings(request);
    expect(c.maxIterations).toBe(5);
    expect(c.intervalMs).toBe(30_000);
  });
});

describe('EST-1155 · CA-5 — erro didático que roda', () => {
  it('mensagem de erro contém "tente:" com uma linha que parseia', () => {
    // Erro por falta de tarefa → sugestão deve conter "tente:"
    try {
      parseCycleInput('a cada 30s');
      expect.fail('deveria lançar CycleParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(CycleParseError);
      const msg: string = (err as Error).message;
      expect(msg).toContain('tente:');
      expect(msg).toContain('/cycle');
      // A sugestão deve ser parseável (não pode causar outro erro de sintaxe).
      // Extrai a linha "tente: /cycle ..."
      const match = msg.match(/tente: \/cycle (.+)$/m);
      expect(match).not.toBeNull();
      if (match) {
        const suggestion = match[1]!.trim();
        // Deve parsear sem erro
        expect(() => parseCycleInput(suggestion)).not.toThrow();
      }
    }
  });

  it('erro de --por sem duração tem sugestão didática', () => {
    try {
      parseCycleInput('--por');
      expect.fail('deveria lançar');
    } catch (err) {
      expect(err).toBeInstanceOf(CycleParseError);
      const msg: string = (err as Error).message;
      expect(msg).toContain('tente:');
      const match = msg.match(/tente: \/cycle (.+)$/m);
      expect(match).not.toBeNull();
      if (match) {
        const suggestion = match[1]!.trim();
        expect(() => parseCycleInput(suggestion)).not.toThrow();
      }
    }
  });

  it('erro de --max-iter inválido tem sugestão didática', () => {
    try {
      parseCycleInput('--max-iter 0.5 "tarefa"');
      expect.fail('deveria lançar');
    } catch (err) {
      expect(err).toBeInstanceOf(CycleParseError);
      const msg: string = (err as Error).message;
      expect(msg).toContain('tente:');
      const match = msg.match(/tente: \/cycle (.+)$/m);
      expect(match).not.toBeNull();
      if (match) {
        const suggestion = match[1]!.trim();
        expect(() => parseCycleInput(suggestion)).not.toThrow();
      }
    }
  });
});

describe('EST-1155 · CA-6 — aspas opcionais sem ambiguidade', () => {
  it('a cada 30s busque geladeira 5x ⇒ tarefa sem aspas', () => {
    const { request, task } = parseCycleInput('a cada 30s busque geladeira 5x');
    expect(request.intervalMs).toBe(30_000);
    expect(request.maxIterations).toBe(5);
    expect(task).toBe('busque geladeira');
  });

  it('5x a cada 1m rode os testes ⇒ tarefa sem aspas', () => {
    const { request, task } = parseCycleInput('5x a cada 1m rode os testes');
    expect(request.maxIterations).toBe(5);
    expect(request.intervalMs).toBe(60_000);
    expect(task).toBe('rode os testes');
  });

  it('a cada 5m busque 5x geladeira ⇒ AMBÍGUO: 5x no meio da tarefa', () => {
    // "5x" no meio da tarefa (não é o último token) → ambiguidade.
    expect(() => parseCycleInput('a cada 5m busque 5x geladeira')).toThrow(CycleParseError);
    try {
      parseCycleInput('a cada 5m busque 5x geladeira');
    } catch (err) {
      expect(err).toBeInstanceOf(CycleParseError);
      const msg: string = (err as Error).message;
      expect(msg).toContain('ambígua');
      expect(msg).toContain('aspas');
      expect(msg).toContain('tente:');
    }
  });

  it('com aspas, "busque 5x geladeira" é seguro ⇒ tarefa preservada', () => {
    const { task } = parseCycleInput('a cada 5m "busque 5x geladeira"');
    expect(task).toBe('busque 5x geladeira');
  });

  it('30s busque 5x dados ⇒ ambíguo (5x no meio, sem aspas)', () => {
    expect(() => parseCycleInput('30s busque 5x dados')).toThrow(CycleParseError);
  });

  it('30s "busque 5x dados" ⇒ OK com aspas', () => {
    const { request, task } = parseCycleInput('30s "busque 5x dados"');
    expect(request.intervalMs).toBe(30_000);
    expect(task).toBe('busque 5x dados');
  });
});

describe('EST-1155 · CA-7 — TUI e headless: mesmos sinônimos', () => {
  // O parser é o mesmo para TUI e headless — testamos que as formas
  // naturais parseiam corretamente (o dispatch é testado em separado).
  it('formas naturais parseiam igual no caminho do parser (compartilhado)', () => {
    const tui = parseCycleInput('a cada 30s "monitore preços" 5x');
    const headless = parseCycleInput('a cada 30s "monitore preços" 5x');
    expect(tui).toEqual(headless);
    expect(tui.request.intervalMs).toBe(30_000);
    expect(tui.request.maxIterations).toBe(5);
    expect(tui.task).toBe('monitore preços');
  });
});

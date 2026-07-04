import { describe, expect, it } from 'vitest';
import {
  SessionBudget,
  resolveMaxTokens,
  resolveMaxIterations,
  resolveMaxOutputTokens,
  MAX_OUTPUT_TOKENS_CEILING,
  MIN_OUTPUT_TOKENS_FLOOR,
  budgetPct,
  DEFAULT_LIMITS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_ITERATIONS,
  MAX_TOKENS_CEILING,
  MAX_ITERATIONS_CEILING,
  MIN_TOKENS_FLOOR,
  MIN_ITERATIONS_FLOOR,
  BUDGET_WARN_PCT,
  resolveMaxMemoryWritesPerSession,
  DEFAULT_MAX_MEMORY_WRITES_PER_SESSION,
  MAX_MEMORY_WRITES_PER_SESSION_CEILING,
} from '../../src/agent/limits.js';

describe('EST-0944 · CLI-SEC-8 — SessionBudget (circuit-breaker)', () => {
  it('teto de iterações dispara', () => {
    const b = new SessionBudget({ maxIterations: 2, maxToolCalls: 99 });
    expect(b.exceeded()).toBeNull();
    b.countIteration();
    expect(b.exceeded()).toBeNull();
    b.countIteration();
    expect(b.exceeded()).toBe('iterations');
  });

  it('teto de tool-calls dispara', () => {
    const b = new SessionBudget({ maxIterations: 99, maxToolCalls: 1 });
    expect(b.exceeded()).toBeNull();
    b.countToolCall();
    expect(b.exceeded()).toBe('tool_calls');
  });

  it('budget de tokens dispara (fail-safe pré-429)', () => {
    const b = new SessionBudget({ maxIterations: 99, maxToolCalls: 99, maxTokens: 100 });
    b.addTokens(60);
    expect(b.exceeded()).toBeNull();
    b.addTokens(50);
    expect(b.exceeded()).toBe('tokens');
  });

  it('sem maxTokens ⇒ tokens nunca disparam', () => {
    const b = new SessionBudget({ maxIterations: 99, maxToolCalls: 99 });
    b.addTokens(1_000_000);
    expect(b.exceeded()).toBeNull();
  });

  it('addTokens ignora valores não-positivos/inválidos', () => {
    const b = new SessionBudget({ maxIterations: 99, maxToolCalls: 99, maxTokens: 10 });
    b.addTokens(-5);
    b.addTokens(Number.NaN);
    expect(b.usage.tokens).toBe(0);
  });

  it('reasonFor produz mensagem com os números', () => {
    const b = new SessionBudget({ maxIterations: 1, maxToolCalls: 1, maxTokens: 1 });
    b.countIteration();
    expect(b.reasonFor('iterations')).toContain('1/1');
    expect(b.reasonFor('iterations')).toContain('pausado para confirmação');
  });
});

describe('EST-0948 · CLI-SEC-8 — extend() do `[c] continuar` (re-arma o teto, RETOMA)', () => {
  it('extend sobe tokens+iterações+tool-calls SEM zerar os contadores', () => {
    const b = new SessionBudget({ maxIterations: 1, maxToolCalls: 1, maxTokens: 100 });
    b.addTokens(100);
    b.countIteration();
    b.countToolCall();
    expect(b.exceeded()).not.toBeNull(); // estourou
    // estende: +50 it, +1 janela (100) de tokens. tool-calls cresce junto (+50).
    b.extend(100, 50);
    // contadores PRESERVADOS (o trabalho não foi jogado fora)
    expect(b.usage.iterations).toBe(1);
    expect(b.usage.toolCalls).toBe(1);
    expect(b.usage.tokens).toBe(100);
    // mas agora cabe sob o teto novo ⇒ não estoura mais
    expect(b.exceeded()).toBeNull();
  });

  it('extend é CLAMPADO no teto-teto (anti-runaway: [c] não vira cheque em branco)', () => {
    const b = new SessionBudget({
      maxIterations: 1,
      maxToolCalls: 1,
      maxTokens: MAX_TOKENS_CEILING,
    });
    b.extend(MAX_TOKENS_CEILING, 50); // tentaria dobrar o teto
    b.addTokens(MAX_TOKENS_CEILING); // bate exatamente o teto-teto
    expect(b.exceeded()).toBe('tokens'); // o clamp segurou: não passou do teto-teto
  });

  it('extend sem maxTokens só estende iterações/tool-calls (não cria teto de tokens)', () => {
    const b = new SessionBudget({ maxIterations: 1, maxToolCalls: 1 });
    b.extend(999_999, 50);
    b.addTokens(10_000_000);
    expect(b.exceeded()).toBeNull(); // sem teto de tokens, tokens nunca disparam
  });

  it('extend pode ser chamado REPETIDAMENTE (o ciclo [c] funciona várias vezes)', () => {
    const b = new SessionBudget({ maxIterations: 0, maxToolCalls: 0, maxTokens: 1 });
    expect(b.exceeded()).not.toBeNull();
    b.extend(1, 10);
    b.countIteration();
    // re-estoura (teto de tokens minúsculo) e estende de novo
    b.addTokens(5);
    expect(b.exceeded()).toBe('tokens');
    b.extend(1, 10);
    // o teto de tokens subiu (1+1+1=3 ≥ 5? não — ainda estoura) — prova que re-arma sempre
    b.extend(100, 10);
    expect(b.exceeded()).toBeNull();
  });
});

describe('EST-0948 · CLI-SEC-8 — reset() re-arma o circuit-breaker p/ novo objetivo', () => {
  it('reset zera contadores E restaura os tetos originais (desfaz extend)', () => {
    const b = new SessionBudget({ maxIterations: 2, maxToolCalls: 2, maxTokens: 100 });
    b.countIteration();
    b.countToolCall();
    b.addTokens(50);
    b.extend(1000, 100); // sobe os tetos
    b.reset();
    // contadores zerados
    expect(b.usage).toEqual({ iterations: 0, toolCalls: 0, tokens: 0 });
    // tetos restaurados ao original: 100 tokens dispara de novo
    b.addTokens(100);
    expect(b.exceeded()).toBe('tokens');
  });
});

describe('EST-0948 — resolveMaxTokens (precedência flag>env>default, validação, clamp)', () => {
  it('sem flag nem env ⇒ default (10M)', () => {
    expect(resolveMaxTokens(undefined, undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(DEFAULT_MAX_TOKENS).toBe(10_000_000);
  });

  it('flag VENCE env', () => {
    expect(resolveMaxTokens('500000', '2000000')).toBe(500_000);
  });

  it('só env ⇒ usa o env', () => {
    expect(resolveMaxTokens(undefined, '750000')).toBe(750_000);
  });

  it('aceita número direto (flag programática)', () => {
    expect(resolveMaxTokens(300_000)).toBe(300_000);
  });

  it('entrada inválida (NaN/negativo/zero/não-inteiro/abaixo do piso) ⇒ cai p/ o próximo', () => {
    expect(resolveMaxTokens('abc', '600000')).toBe(600_000); // flag inválida ⇒ env
    expect(resolveMaxTokens('-1', undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens('0', undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens('1.5', undefined)).toBe(DEFAULT_MAX_TOKENS);
    expect(resolveMaxTokens('500', undefined)).toBe(DEFAULT_MAX_TOKENS); // < piso
  });

  it('CLAMPA no teto-teto (anti-runaway preservado mesmo com config absurda)', () => {
    expect(resolveMaxTokens(String(MAX_TOKENS_CEILING * 10))).toBe(MAX_TOKENS_CEILING);
  });

  it('CLAMPA no piso (entrada válida mas baixa não vira teto≤0)', () => {
    // exatamente o piso passa; o clamp garante ≥ piso de qualquer forma
    expect(resolveMaxTokens(String(MIN_TOKENS_FLOOR))).toBe(MIN_TOKENS_FLOOR);
  });

  it('ADR-0150: config.limits.maxTokens entra entre env e default (flag>env>config>default)', () => {
    expect(resolveMaxTokens(undefined, undefined, 500000)).toBe(500_000); // só config
    expect(resolveMaxTokens(undefined, '750000', 500000)).toBe(750_000); // env vence config
    expect(resolveMaxTokens('600000', '750000', 500000)).toBe(600_000); // flag vence tudo
    expect(resolveMaxTokens(undefined, undefined, MAX_TOKENS_CEILING * 10)).toBe(
      MAX_TOKENS_CEILING,
    ); // config clampada
  });
});

describe('EST-0948 — DEFAULT_LIMITS de iterações (subiu de 25 p/ 300)', () => {
  it('o default de iterações é 300 (projeto multi-arquivo cabe)', () => {
    expect(DEFAULT_MAX_ITERATIONS).toBe(300);
    expect(DEFAULT_LIMITS.maxIterations).toBe(300);
  });

  it('tool-calls derivam do default de iterações (2× — não viram o gargalo novo)', () => {
    expect(DEFAULT_LIMITS.maxToolCalls).toBe(DEFAULT_MAX_ITERATIONS * 2);
    expect(DEFAULT_LIMITS.maxToolCalls).toBe(600);
  });
});

describe('EST-0948 — resolveMaxIterations (precedência flag>env>default, validação, clamp)', () => {
  it('sem flag nem env ⇒ default (300)', () => {
    expect(resolveMaxIterations(undefined, undefined)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations(undefined, undefined)).toBe(300);
  });

  it('ALUY_MAX_ITERATIONS (env) faz override do default', () => {
    expect(resolveMaxIterations(undefined, '500')).toBe(500);
  });

  it('flag (--max-iterations) VENCE o env', () => {
    expect(resolveMaxIterations('1000', '500')).toBe(1000);
  });

  it('aceita número direto (flag programática)', () => {
    expect(resolveMaxIterations(750)).toBe(750);
  });

  it('valor inválido (NaN/negativo/zero/não-inteiro) ⇒ cai p/ o próximo (por fim default)', () => {
    expect(resolveMaxIterations('abc', '400')).toBe(400); // flag inválida ⇒ env
    expect(resolveMaxIterations('abc', undefined)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations('-1', undefined)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations('0', undefined)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations('1.5', undefined)).toBe(DEFAULT_MAX_ITERATIONS);
    expect(resolveMaxIterations('', undefined)).toBe(DEFAULT_MAX_ITERATIONS);
  });

  it('ADR-0150: config.limits.maxIterations entra entre env e default (flag>env>config>default)', () => {
    expect(resolveMaxIterations(undefined, undefined, 500)).toBe(500); // só config
    expect(resolveMaxIterations(undefined, '400', 500)).toBe(400); // env vence config
    expect(resolveMaxIterations('600', '400', 500)).toBe(600); // flag vence tudo
  });

  it('CLAMPA no teto-teto (anti-runaway preservado mesmo com config absurda)', () => {
    expect(resolveMaxIterations(String(MAX_ITERATIONS_CEILING * 100))).toBe(MAX_ITERATIONS_CEILING);
    // env absurdo também é clampado
    expect(resolveMaxIterations(undefined, '99999999')).toBe(MAX_ITERATIONS_CEILING);
  });

  it('CLAMPA no piso (entrada válida mas baixa não vira teto≤0)', () => {
    expect(resolveMaxIterations(String(MIN_ITERATIONS_FLOOR))).toBe(MIN_ITERATIONS_FLOOR);
  });
});

describe('EST-0948 — resolveMaxOutputTokens (max_tokens de OUTPUT por chamada; DEFAULT UNSET)', () => {
  it('sem flag nem env ⇒ UNSET (undefined): por padrão o CLI NÃO manda max_tokens ⇒ broker decide', () => {
    expect(resolveMaxOutputTokens(undefined, undefined)).toBeUndefined();
    expect(resolveMaxOutputTokens('', '')).toBeUndefined();
  });

  it('ALUY_MAX_OUTPUT_TOKENS (env) define o teto de output por chamada', () => {
    expect(resolveMaxOutputTokens(undefined, '16384')).toBe(16384);
  });

  it('flag (--max-output-tokens) VENCE o env', () => {
    expect(resolveMaxOutputTokens('32768', '16384')).toBe(32768);
  });

  it('aceita número direto (uso programático)', () => {
    expect(resolveMaxOutputTokens(8192)).toBe(8192);
  });

  it('inválido (NaN/negativo/zero/não-inteiro) ⇒ UNSET + AVISO, sem quebrar', () => {
    const warns: string[] = [];
    const warn = (m: string): void => void warns.push(m);
    expect(resolveMaxOutputTokens('abc', undefined, undefined, warn)).toBeUndefined();
    expect(resolveMaxOutputTokens('-1', undefined, undefined, warn)).toBeUndefined();
    expect(resolveMaxOutputTokens('0', undefined, undefined, warn)).toBeUndefined();
    expect(resolveMaxOutputTokens('1.5', undefined, undefined, warn)).toBeUndefined();
    expect(warns.length).toBe(4);
    expect(warns.every((w) => /max-output-tokens|MAX_OUTPUT/i.test(w))).toBe(true);
  });

  it('flag inválida ⇒ cai p/ o env (precedência preservada), avisa do typo da flag', () => {
    const warns: string[] = [];
    expect(resolveMaxOutputTokens('abc', '16384', undefined, (m) => void warns.push(m))).toBe(
      16384,
    );
    expect(warns.length).toBe(1); // só o aviso da flag inválida; o env era válido
  });

  it('ADR-0150: config.limits.maxOutputTokens entra entre env e UNSET (flag>env>config)', () => {
    expect(resolveMaxOutputTokens(undefined, undefined, 16384)).toBe(16384); // só config
    expect(resolveMaxOutputTokens(undefined, '8192', 16384)).toBe(8192); // env vence config
    expect(resolveMaxOutputTokens('4096', '8192', 16384)).toBe(4096); // flag vence tudo
  });

  it('CLAMPA no teto CLI-side (um typo absurdo não vai inteiro ao broker) + avisa', () => {
    const warns: string[] = [];
    expect(
      resolveMaxOutputTokens(
        String(MAX_OUTPUT_TOKENS_CEILING * 10),
        undefined,
        undefined,
        (m) => void warns.push(m),
      ),
    ).toBe(MAX_OUTPUT_TOKENS_CEILING);
    expect(warns.some((w) => /teto/i.test(w))).toBe(true);
  });

  it('valor no piso é aceito (é um teto de output, não há clamp inferior além do piso)', () => {
    expect(resolveMaxOutputTokens(String(MIN_OUTPUT_TOKENS_FLOOR))).toBe(MIN_OUTPUT_TOKENS_FLOOR);
  });

  it('sem onWarn, valor inválido ainda NÃO quebra (só retorna UNSET silencioso)', () => {
    expect(() => resolveMaxOutputTokens('lixo')).not.toThrow();
    expect(resolveMaxOutputTokens('lixo')).toBeUndefined();
  });
});

describe('EST-0948 — a pausa de iterações dispara no NOVO teto e o `[c]` ainda estende', () => {
  it('o circuit-breaker pausa exatamente no teto configurado (não antes)', () => {
    const max = resolveMaxIterations('300');
    const b = new SessionBudget({ maxIterations: max, maxToolCalls: max * 2 });
    // 299 iterações: ainda há folga (não pausa cedo)
    for (let i = 0; i < max - 1; i++) b.countIteration();
    expect(b.exceeded()).toBeNull();
    // a 300ª bate o teto ⇒ pausa p/ confirmação (CLI-SEC-8)
    b.countIteration();
    expect(b.exceeded()).toBe('iterations');
    expect(b.usage.iterations).toBe(300);
  });

  it('no teto, o `[c]` (extend +50) RETOMA — e pode repetir', () => {
    const b = new SessionBudget({ maxIterations: 2, maxToolCalls: 4 });
    b.countIteration();
    b.countIteration();
    expect(b.exceeded()).toBe('iterations'); // pausou no teto
    // [c]: +50 iterações (mesmo CONTINUE_EXTRA_ITERATIONS do controller), trabalho preservado
    b.extend(0, 50);
    expect(b.usage.iterations).toBe(2); // contador NÃO zerou
    expect(b.exceeded()).toBeNull(); // cabe sob o novo teto ⇒ retoma
    // gasta a janela nova e re-pausa; o [c] funciona repetidamente
    for (let i = 0; i < 50; i++) b.countIteration();
    expect(b.exceeded()).toBe('iterations');
    b.extend(0, 50);
    expect(b.exceeded()).toBeNull();
  });
});

describe('EST-0948 — budgetPct (% do teto consumido, p/ os indicadores)', () => {
  it('calcula o % do teto', () => {
    expect(budgetPct(65_000, 100_000)).toBe(65);
    expect(budgetPct(50, 100)).toBe(50);
  });

  it('pode passar de 100% quando o último turno estoura o teto', () => {
    expect(budgetPct(260_239, 200_000)).toBe(130);
  });

  it('sem teto (undefined/0) ⇒ 0% (sem % a mostrar)', () => {
    expect(budgetPct(1000, undefined)).toBe(0);
    expect(budgetPct(1000, 0)).toBe(0);
  });

  it('o limiar de aviso é 70%', () => {
    expect(BUDGET_WARN_PCT).toBe(70);
  });
});

describe('ADR-0150 (balde b) — resolveMaxMemoryWritesPerSession (flag > env > config > default + clamp)', () => {
  it('default quando nada é dado', () => {
    expect(resolveMaxMemoryWritesPerSession()).toBe(DEFAULT_MAX_MEMORY_WRITES_PER_SESSION);
  });

  it('config vence o default', () => {
    expect(resolveMaxMemoryWritesPerSession(undefined, undefined, 50)).toBe(50);
  });

  it('env vence o config', () => {
    expect(resolveMaxMemoryWritesPerSession(undefined, '30', 50)).toBe(30);
  });

  it('flag vence tudo', () => {
    expect(resolveMaxMemoryWritesPerSession(10, '30', 50)).toBe(10);
  });

  it('CLAMPA ao teto-teto — config pedindo 10000 ⇒ clampa a 100', () => {
    expect(resolveMaxMemoryWritesPerSession(undefined, undefined, 10_000)).toBe(
      MAX_MEMORY_WRITES_PER_SESSION_CEILING,
    );
    expect(MAX_MEMORY_WRITES_PER_SESSION_CEILING).toBe(100);
  });

  it('piso — nunca abaixo de 1 (config ≤0 ⇒ ignorado, cai no default)', () => {
    expect(resolveMaxMemoryWritesPerSession(undefined, undefined, 0)).toBe(
      DEFAULT_MAX_MEMORY_WRITES_PER_SESSION,
    );
    expect(resolveMaxMemoryWritesPerSession(undefined, undefined, -5)).toBe(
      DEFAULT_MAX_MEMORY_WRITES_PER_SESSION,
    );
  });

  it('entrada inválida (não-inteiro/lixo) ⇒ ignorada, cai no próximo nível', () => {
    expect(resolveMaxMemoryWritesPerSession('abc', undefined, 25)).toBe(25);
    expect(resolveMaxMemoryWritesPerSession(undefined, 'lixo', 25)).toBe(25);
  });
});

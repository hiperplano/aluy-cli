// EST-0948 (server-limits / FU-VAU-003) — o LIMITE/QUOTA REAL lido do `usage` (o
// canal que JÁ carrega `balance_after`). TOLERANTE a ausência (degrada p/ o
// comportamento atual). PROVA a DISTINÇÃO: fail-safe LOCAL (anti-runaway, em
// `agent/limits.ts`) × quota de PRODUTO (server). CLI-SEC-7: nada hardcoded.

import { describe, expect, it } from 'vitest';
import {
  parseServerLimits,
  serverTokenLimit,
  serverUsedPct,
  serverLimitLevel,
  isLowBalance,
  formatBalance,
  formatServerLimits,
  LOW_BALANCE_THRESHOLD,
  DEFAULT_MAX_TOKENS,
  type ModelUsage,
} from '../../src/index.js';

function usage(extra: Partial<ModelUsage>): ModelUsage {
  return { request_id: 'r', tier: 'aluy-flux', ...extra };
}

describe('parseServerLimits — leitura tolerante do `usage`', () => {
  it('AUSENTE: usage sem balance_after nem limits ⇒ undefined (degrada)', () => {
    expect(parseServerLimits(usage({ tokens_in: 10, tokens_out: 20 }))).toBeUndefined();
    expect(parseServerLimits(undefined)).toBeUndefined();
  });

  it('balance_after (JÁ existe no broker) ⇒ surfaçado AGORA, sem o campo limits novo', () => {
    const s = parseServerLimits(usage({ balance_after: '4.20' }));
    expect(s?.balanceAfter).toBe(4.2);
    // Sem `limits`: o teto de tokens do server permanece ausente (degrada p/ fail-safe).
    expect(serverTokenLimit(s)).toBeUndefined();
    expect(serverUsedPct(s)).toBeUndefined();
  });

  it('campo limits NOVO (tokens): limit/used ⇒ remaining derivado; % e teto reais', () => {
    const s = parseServerLimits(
      usage({ limits: { limit: 1_000_000, used: 700_000, period: 'week', unit: 'tokens' } }),
    );
    expect(s?.limit).toBe(1_000_000);
    expect(s?.used).toBe(700_000);
    expect(s?.remaining).toBe(300_000); // derivado
    expect(s?.period).toBe('week');
    expect(serverTokenLimit(s)).toBe(1_000_000);
    expect(serverUsedPct(s)).toBe(70);
  });

  it('limits só com remaining+limit ⇒ used derivado', () => {
    const s = parseServerLimits(usage({ limits: { limit: 200, remaining: 50 } }));
    expect(s?.used).toBe(150);
    expect(serverUsedPct(s)).toBe(75);
  });

  it('unidade CREDIT: limit não é teto de TOKENS (vira aviso de saldo à parte)', () => {
    const s = parseServerLimits(usage({ limits: { limit: 100, used: 90, unit: 'credit' } }));
    // serverTokenLimit ignora unidade de crédito (não é teto de tokens).
    expect(serverTokenLimit(s)).toBeUndefined();
  });

  it('reset_at normaliza ISO / epoch-seg / epoch-ms', () => {
    const iso = parseServerLimits(
      usage({ limits: { limit: 10, used: 1, reset_at: '2030-01-01T00:00:00Z' } }),
    );
    expect(iso?.resetAt).toBe(Date.parse('2030-01-01T00:00:00Z'));
    const secs = parseServerLimits(
      usage({ limits: { limit: 10, used: 1, reset_at: 1_900_000_000 } }),
    );
    expect(secs?.resetAt).toBe(1_900_000_000_000);
  });

  it('LIXO/parcial nunca lança: campos inválidos viram undefined, não quebram', () => {
    const s = parseServerLimits(
      usage({ balance_after: 'abc', limits: { limit: 'x', used: -5, reset_at: 'nope' } }),
    );
    // balance_after inválido + limits sem nada válido ⇒ undefined inteiro.
    expect(s).toBeUndefined();
  });

  it('balance_after válido + limits LIXO ⇒ devolve só o saldo (parcial)', () => {
    const s = parseServerLimits(usage({ balance_after: '2', limits: { limit: 'x' } }));
    expect(s?.balanceAfter).toBe(2);
    expect(s?.limit).toBeUndefined();
  });
});

describe('crédito (balance_after) — surfaçado AGORA, sem o broker mudar', () => {
  it('isLowBalance: saldo ≤ piso ⇒ true; folga ⇒ false; ausente ⇒ false (não inventa)', () => {
    expect(isLowBalance(parseServerLimits(usage({ balance_after: '0.5' })))).toBe(true);
    expect(
      isLowBalance(parseServerLimits(usage({ balance_after: String(LOW_BALANCE_THRESHOLD) }))),
    ).toBe(true);
    expect(isLowBalance(parseServerLimits(usage({ balance_after: '50' })))).toBe(false);
    expect(isLowBalance(parseServerLimits(usage({})))).toBe(false);
    expect(isLowBalance(undefined)).toBe(false);
  });

  it('saldo 0 ou negativo ⇒ baixo (esgotado)', () => {
    expect(isLowBalance(parseServerLimits(usage({ balance_after: '0' })))).toBe(true);
    expect(isLowBalance(parseServerLimits(usage({ balance_after: '-3' })))).toBe(true);
  });

  it('formatBalance: sem casas espúrias; ausente ⇒ undefined', () => {
    expect(formatBalance(parseServerLimits(usage({ balance_after: '4.20' })))).toBe('4.2');
    expect(formatBalance(parseServerLimits(usage({ balance_after: '10' })))).toBe('10');
    expect(formatBalance(undefined)).toBeUndefined();
  });
});

describe('DISTINÇÃO fail-safe LOCAL × quota de PRODUTO (server)', () => {
  it('o fail-safe DEFAULT_MAX_TOKENS é 10M e NÃO depende deste módulo (#116 preservado)', () => {
    // O server-limits NÃO mexe no fail-safe: ele segue sendo o número de `agent/limits.ts`.
    expect(DEFAULT_MAX_TOKENS).toBe(10_000_000);
  });

  it('quota do server PRESENTE ⇒ o TETO REAL é o do server, NÃO o fail-safe', () => {
    // O server diz: limite de 1M tokens, 700k usados. O % REAL é 70% (do server),
    // independente do fail-safe local de 10M (que veria só 7%).
    const s = parseServerLimits(usage({ limits: { limit: 1_000_000, used: 700_000 } }));
    expect(serverTokenLimit(s)).toBe(1_000_000);
    expect(serverTokenLimit(s)).not.toBe(DEFAULT_MAX_TOKENS);
    expect(serverUsedPct(s)).toBe(70);
  });

  it('quota do server AUSENTE ⇒ serverTokenLimit undefined (o chamador mantém o fail-safe)', () => {
    const s = parseServerLimits(usage({ balance_after: '5' })); // só saldo, sem limite
    expect(serverTokenLimit(s)).toBeUndefined();
  });
});

describe('serverLimitLevel — limiares 70/90 consistentes', () => {
  it('ok < 70, warn 70–89, crit ≥ 90', () => {
    expect(serverLimitLevel(10)).toBe('ok');
    expect(serverLimitLevel(70)).toBe('warn');
    expect(serverLimitLevel(89)).toBe('warn');
    expect(serverLimitLevel(90)).toBe('crit');
    expect(serverLimitLevel(130)).toBe('crit');
  });
});

describe('formatServerLimits — view do footer (degrada oculta)', () => {
  it('sem nada ⇒ undefined (footer oculto)', () => {
    expect(formatServerLimits(undefined)).toBeUndefined();
    expect(formatServerLimits(parseServerLimits(usage({})))).toBeUndefined();
  });

  it('só crédito (hoje) ⇒ 1 segmento `crédito`', () => {
    const v = formatServerLimits(parseServerLimits(usage({ balance_after: '12' })));
    expect(v?.segments).toEqual([{ label: 'crédito', value: '12', level: 'ok' }]);
    expect(v?.resetText).toBeUndefined();
  });

  it('crédito BAIXO ⇒ segmento nível crit', () => {
    const v = formatServerLimits(parseServerLimits(usage({ balance_after: '0.3' })));
    expect(v?.segments[0]?.level).toBe('crit');
  });

  it('quota de tokens + período + reset ⇒ segmento de % com rótulo do período + resetText', () => {
    const resetAt = Date.now() + 2 * 60 * 60_000 + 13 * 60_000;
    const v = formatServerLimits(
      parseServerLimits(
        usage({ limits: { limit: 100, used: 42, period: 'week', reset_at: resetAt } }),
      ),
      Date.now(),
    );
    expect(v?.segments[0]).toEqual({ label: 'week', value: '42%', level: 'ok' });
    expect(v?.resetText).toMatch(/^reseta em/);
  });

  it('quota de tokens + crédito juntos ⇒ DOIS segmentos', () => {
    const v = formatServerLimits(
      parseServerLimits(usage({ balance_after: '5', limits: { limit: 100, used: 95 } })),
    );
    expect(v?.segments.map((s) => s.label)).toEqual(['quota', 'crédito']);
    expect(v?.maxLevel).toBe('crit'); // 95% ⇒ crit domina
  });
});

// ── EST-1015: endurecimento de ramos puros ──────────────────────────────────────

describe('serverUsedPct — ramo REMAINING (linhas 166-168)', () => {
  it('remaining SEM used: deriva used = limit - remaining e calcula pct', () => {
    // limit=100, remaining=30 ⇒ used=70 ⇒ 70%
    expect(serverUsedPct({ limit: 100, remaining: 30 })).toBe(70);
  });

  it('used direto (sanity): limit=100, used=25 ⇒ 25%', () => {
    expect(serverUsedPct({ limit: 100, used: 25 })).toBe(25);
  });

  it('undefined ⇒ undefined', () => {
    expect(serverUsedPct(undefined)).toBeUndefined();
  });

  it('limit=0 ⇒ undefined (divisão por zero evitada)', () => {
    expect(serverUsedPct({ limit: 0 })).toBeUndefined();
  });

  it('limit=100 sem used nem remaining ⇒ undefined', () => {
    expect(serverUsedPct({ limit: 100 })).toBeUndefined();
  });
});

describe('normalizeUnit via parseServerLimits (linhas 301-302)', () => {
  it('unidade "tokens" ⇒ unit "tokens"', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100, unit: 'tokens' } }));
    expect(s?.unit).toBe('tokens');
  });

  it('unidade "token" (singular) ⇒ unit "tokens"', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100, unit: 'token' } }));
    expect(s?.unit).toBe('tokens');
  });

  it('unidade "credit" ⇒ unit "credit"', () => {
    const s = parseServerLimits(usage({ limits: { limit: 100, used: 10, unit: 'credit' } }));
    expect(s?.unit).toBe('credit');
  });

  it('unidade "credits" (plural) ⇒ unit "credit"', () => {
    const s = parseServerLimits(usage({ limits: { limit: 100, used: 10, unit: 'credits' } }));
    expect(s?.unit).toBe('credit');
  });

  it('unidade "currency" ⇒ unit "credit"', () => {
    const s = parseServerLimits(usage({ limits: { limit: 100, used: 10, unit: 'currency' } }));
    expect(s?.unit).toBe('credit');
  });

  it('unidade DESCONHECIDA ("xpto") ⇒ unit undefined (default tokens implícito)', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100, unit: 'xpto' } }));
    // normalizeUnit retorna undefined para desconhecido ⇒ o campo unit não entra no objeto
    expect(s?.unit).toBeUndefined();
  });

  it('unidade AUSENTE ⇒ unit undefined (default implícito)', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100 } }));
    expect(s?.unit).toBeUndefined();
  });
});

// ── EST-1015: endurecimento — formatServerLimits (vazio/reset) e normalizePeriod ──

describe('formatServerLimits — SEM segmentos (linha 258)', () => {
  it('{} vazio sem limit nem balance ⇒ undefined (segmentos zerados)', () => {
    // `serverUsedPct` retorna undefined (sem `limit`), `formatBalance` retorna
    // undefined (sem `balanceAfter`) ⇒ segments.length === 0 ⇒ return undefined.
    const v = formatServerLimits({} as Parameters<typeof formatServerLimits>[0]);
    expect(v).toBeUndefined();
  });

  it('limit=0 sem balance ⇒ undefined (serverUsedPct pula limit ≤ 0)', () => {
    const v = formatServerLimits({ limit: 0 });
    expect(v).toBeUndefined();
  });
});

describe('formatServerLimits — com RESET (linha 264)', () => {
  it('resetAt FUTURO ⇒ resetText "reseta em …"', () => {
    const now = 1_700_000_000_000;
    const resetAt = now + 2 * 60 * 60_000 + 13 * 60_000; // +2h13
    const v = formatServerLimits({ limit: 100, used: 50, resetAt }, now);
    expect(v?.segments.length).toBe(1);
    expect(v?.segments[0]).toEqual({ label: 'quota', value: '50%', level: 'ok' });
    expect(v?.resetText).toBe('reseta em 2h13');
  });

  it('resetAt ~= now ⇒ resetText "reseta agora"', () => {
    const now = 1_700_000_000_000;
    const v = formatServerLimits({ limit: 100, used: 50, resetAt: now }, now);
    // formatResetIn(resetAtMs=now, now=now) → deltaMs=0 → retorna 'agora'
    expect(v?.resetText).toBe('reseta agora');
  });

  it('resetAt LIGEIRAMENTE no passado ⇒ "reseta agora"', () => {
    const now = 1_700_000_000_000;
    const v = formatServerLimits({ limit: 100, used: 50, resetAt: now - 5000 }, now);
    // deltaMs < 0 → 'agora'
    expect(v?.resetText).toBe('reseta agora');
  });
});

describe('normalizePeriod via parseServerLimits (linhas 308-309)', () => {
  it('period longo (> 16 chars) ⇒ truncado para ≤ 16', () => {
    const longPeriod = 'este-periodo-e-muito-longo-mesmo';
    expect(longPeriod.length).toBeGreaterThan(16);
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100, period: longPeriod } }));
    expect(s?.period?.length).toBeLessThanOrEqual(16);
    expect(s?.period).toBe(longPeriod.slice(0, 16));
  });

  it('period = "" (vazio) ⇒ undefined (periodo ausente)', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100, period: '' } }));
    // normalizePeriod('') → trim → '' → return undefined; campo period não entra no objeto
    expect(s?.period).toBeUndefined();
  });

  it('period = " " (só espaço) ⇒ undefined (trim vira vazio)', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 100, period: '   ' } }));
    expect(s?.period).toBeUndefined();
  });
});

// ── EST-1015: serverTokenLimit — ramo CRÉDITO (linha 137 do src) ────────────────

describe('serverTokenLimit — ramo CRÉDITO', () => {
  it('unit=credit com limit=100 ⇒ undefined (crédito não é teto de tokens)', () => {
    expect(serverTokenLimit({ unit: 'credit', limit: 100 })).toBeUndefined();
  });

  it('unit=tokens com limit=100 ⇒ 100', () => {
    expect(serverTokenLimit({ unit: 'tokens', limit: 100 })).toBe(100);
  });

  it('limit=0 ⇒ undefined (valor não-positivo)', () => {
    expect(serverTokenLimit({ limit: 0 })).toBeUndefined();
  });

  it('{} (sem unit, sem limit) ⇒ undefined', () => {
    expect(serverTokenLimit({})).toBeUndefined();
  });

  it('undefined ⇒ undefined', () => {
    expect(serverTokenLimit(undefined)).toBeUndefined();
  });

  it('unit=tokens com limit=0 ⇒ undefined (0 não é > 0)', () => {
    expect(serverTokenLimit({ unit: 'tokens', limit: 0 })).toBeUndefined();
  });

  it('unit=credit com limit=0 ⇒ undefined (ramo credit bate antes)', () => {
    expect(serverTokenLimit({ unit: 'credit', limit: 0 })).toBeUndefined();
  });
});

// ── EST-1015: parseServerLimits — campos PARCIAIS (linhas 119-121) ──────────────

describe('parseServerLimits — campos PARCIAIS (ramo ...(X !== undefined ? {X} : {}))', () => {
  it('só remaining presente (sem limit, used, period, resetAt) ⇒ objeto só com remaining', () => {
    // parseLimitsPayload: remaining=50, limit/used/period/resetAt ausentes.
    // remaining sozinho NÃO faz parseLimitsPayload retornar undefined (ele tem algo útil).
    const s = parseServerLimits(usage({ limits: { remaining: 50 } }));
    expect(s).toBeDefined();
    expect(s?.remaining).toBe(50);
    expect(s?.limit).toBeUndefined();
    expect(s?.used).toBeUndefined();
    expect(s?.period).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
    expect(s?.balanceAfter).toBeUndefined();
  });

  it('só used presente ⇒ objeto só com used', () => {
    const s = parseServerLimits(usage({ limits: { used: 30 } }));
    expect(s).toBeDefined();
    expect(s?.used).toBe(30);
    expect(s?.limit).toBeUndefined();
    expect(s?.remaining).toBeUndefined();
    expect(s?.period).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
  });

  it('só limit presente (sem used/remaining) ⇒ objeto só com limit', () => {
    const s = parseServerLimits(usage({ limits: { limit: 100 } }));
    expect(s).toBeDefined();
    expect(s?.limit).toBe(100);
    expect(s?.used).toBeUndefined();
    expect(s?.remaining).toBeUndefined();
    expect(s?.period).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
  });

  it('só period presente ⇒ objeto só com period', () => {
    const s = parseServerLimits(usage({ limits: { period: 'month' } }));
    expect(s).toBeDefined();
    expect(s?.period).toBe('month');
    expect(s?.limit).toBeUndefined();
    expect(s?.used).toBeUndefined();
    expect(s?.remaining).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
  });

  it('só resetAt presente ⇒ objeto só com resetAt (epoch-seg normalizado)', () => {
    const s = parseServerLimits(usage({ limits: { reset_at: 2_000_000_000 } }));
    expect(s).toBeDefined();
    expect(s?.resetAt).toBe(2_000_000_000_000);
    expect(s?.limit).toBeUndefined();
    expect(s?.used).toBeUndefined();
    expect(s?.remaining).toBeUndefined();
    expect(s?.period).toBeUndefined();
  });

  it('só resetAt ISO presente ⇒ objeto só com resetAt', () => {
    const s = parseServerLimits(usage({ limits: { reset_at: '2035-06-15T12:00:00Z' } }));
    expect(s).toBeDefined();
    expect(s?.resetAt).toBe(Date.parse('2035-06-15T12:00:00Z'));
    expect(s?.limit).toBeUndefined();
    expect(s?.used).toBeUndefined();
    expect(s?.remaining).toBeUndefined();
    expect(s?.period).toBeUndefined();
  });

  it('limit + remaining (sem used) ⇒ derivado used=limit-remaining, mas só remaining fica presente no objeto bruto', () => {
    // parseLimitsPayload deriva used de (limit - remaining). Então used passa a existir.
    const s = parseServerLimits(usage({ limits: { limit: 200, remaining: 50 } }));
    expect(s).toBeDefined();
    expect(s?.limit).toBe(200);
    expect(s?.remaining).toBe(50);
    expect(s?.used).toBe(150); // derivado
    expect(s?.period).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
  });

  it('limit + used (sem remaining) ⇒ derivado remaining=limit-used, usado entra no objeto', () => {
    const s = parseServerLimits(usage({ limits: { limit: 1000, used: 400 } }));
    expect(s).toBeDefined();
    expect(s?.limit).toBe(1000);
    expect(s?.used).toBe(400);
    expect(s?.remaining).toBe(600); // derivado
    expect(s?.period).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
  });

  it('todos os campos do limits presentes ⇒ todos no objeto', () => {
    const resetAt = Date.parse('2030-01-01T00:00:00Z');
    const s = parseServerLimits(
      usage({
        limits: {
          limit: 5000,
          used: 1234,
          remaining: 3766,
          unit: 'tokens',
          period: 'day',
          reset_at: '2030-01-01T00:00:00Z',
        },
      }),
    );
    expect(s?.limit).toBe(5000);
    expect(s?.used).toBe(1234);
    expect(s?.remaining).toBe(3766);
    expect(s?.unit).toBe('tokens');
    expect(s?.period).toBe('day');
    expect(s?.resetAt).toBe(resetAt);
  });

  it('balanceAfter + só 1 campo de limits ⇒ objeto mescla ambos', () => {
    const s = parseServerLimits(usage({ balance_after: '9.99', limits: { period: 'week' } }));
    expect(s?.balanceAfter).toBe(9.99);
    expect(s?.period).toBe('week');
    expect(s?.limit).toBeUndefined();
    expect(s?.used).toBeUndefined();
    expect(s?.remaining).toBeUndefined();
    expect(s?.resetAt).toBeUndefined();
  });
});

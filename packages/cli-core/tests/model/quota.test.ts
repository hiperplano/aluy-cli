// EST-0948 (footer/quota) — testes PUROS do parse tolerante + display da quota do
// broker (5h/semana). Sem rede, sem Ink. Cobre: headers completos/parciais/ausentes,
// ISO vs epoch (seg/ms), `formatResetIn` (2h13 / 45min / agora), `formatQuota` e o
// nível de cor (70/90%).

import { describe, expect, it } from 'vitest';
import {
  formatQuota,
  formatResetIn,
  parseQuotaBody,
  parseQuotaHeaders,
  parseQuotaResponse,
  parseQuotaFromUsage,
  serverWindowLimit,
  findWindow,
  quotaLevel,
  toEpochMs,
  windowPct,
  QUOTA_HEADERS,
  type HeaderReader,
  type Quota,
} from '../../src/model/quota.js';

/** HeaderReader fake case-insensitive a partir de um mapa lowercase. */
function headers(map: Record<string, string>): HeaderReader {
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) lower[k.toLowerCase()] = v;
  return { get: (name) => lower[name.toLowerCase()] ?? null };
}

const NOW = Date.UTC(2026, 5, 9, 12, 0, 0); // 2026-06-09T12:00:00Z

describe('parseQuotaHeaders — tolerante (primário)', () => {
  it('headers COMPLETOS (5h + semana) ⇒ ambas as janelas', () => {
    const q = parseQuotaHeaders(
      headers({
        [QUOTA_HEADERS.fiveHourUsed]: '42000',
        [QUOTA_HEADERS.fiveHourLimit]: '100000',
        [QUOTA_HEADERS.fiveHourResetAt]: '2026-06-09T14:13:00Z',
        [QUOTA_HEADERS.weekUsed]: '18000',
        [QUOTA_HEADERS.weekLimit]: '100000',
        [QUOTA_HEADERS.weekResetAt]: '2026-06-12T00:00:00Z',
      }),
    );
    expect(q?.windows.fiveHour).toEqual({
      used: 42000,
      limit: 100000,
      resetAt: Date.UTC(2026, 5, 9, 14, 13, 0),
    });
    expect(q?.windows.week?.used).toBe(18000);
    expect(windowPct(q!.windows.fiveHour!)).toBe(42);
    expect(windowPct(q!.windows.week!)).toBe(18);
  });

  it('headers AUSENTES ⇒ undefined (degrada: footer oculto)', () => {
    expect(parseQuotaHeaders(headers({}))).toBeUndefined();
  });

  it('headers PARCIAIS (só 5h) ⇒ só a janela 5h; semana omitida', () => {
    const q = parseQuotaHeaders(
      headers({
        [QUOTA_HEADERS.fiveHourUsed]: '70000',
        [QUOTA_HEADERS.fiveHourLimit]: '100000',
        [QUOTA_HEADERS.fiveHourResetAt]: '1749477180', // epoch seg
      }),
    );
    expect(q?.windows.fiveHour).toBeDefined();
    expect(q?.windows.week).toBeUndefined();
  });

  it('janela INCOMPLETA (limit faltando) ⇒ a janela é descartada (sem % de lixo)', () => {
    const q = parseQuotaHeaders(
      headers({
        [QUOTA_HEADERS.fiveHourUsed]: '50',
        // sem limit
        [QUOTA_HEADERS.fiveHourResetAt]: '2026-06-09T14:00:00Z',
        [QUOTA_HEADERS.weekUsed]: '10',
        [QUOTA_HEADERS.weekLimit]: '100',
        [QUOTA_HEADERS.weekResetAt]: '2026-06-12T00:00:00Z',
      }),
    );
    expect(q?.windows.fiveHour).toBeUndefined();
    expect(q?.windows.week).toBeDefined();
  });

  it('limit ZERO ⇒ janela descartada (divisão por zero evitada)', () => {
    const q = parseQuotaHeaders(
      headers({
        [QUOTA_HEADERS.fiveHourUsed]: '0',
        [QUOTA_HEADERS.fiveHourLimit]: '0',
        [QUOTA_HEADERS.fiveHourResetAt]: '2026-06-09T14:00:00Z',
      }),
    );
    expect(q).toBeUndefined();
  });

  it('valores LIXO (não-numéricos) ⇒ janela descartada, nunca lança', () => {
    const q = parseQuotaHeaders(
      headers({
        [QUOTA_HEADERS.fiveHourUsed]: 'abc',
        [QUOTA_HEADERS.fiveHourLimit]: 'NaN',
        [QUOTA_HEADERS.fiveHourResetAt]: 'não-é-data',
      }),
    );
    expect(q).toBeUndefined();
  });
});

describe('toEpochMs — ISO / epoch seg / epoch ms', () => {
  it('ISO-8601 → epoch ms', () => {
    expect(toEpochMs('2026-06-09T12:00:00Z')).toBe(NOW);
  });
  it('epoch em SEGUNDOS (string) → ×1000', () => {
    expect(toEpochMs('1749470400')).toBe(1749470400 * 1000);
  });
  it('epoch em SEGUNDOS (número) → ×1000', () => {
    expect(toEpochMs(1749470400)).toBe(1749470400 * 1000);
  });
  it('epoch em MS (≥1e12) → como está', () => {
    expect(toEpochMs(1749470400000)).toBe(1749470400000);
  });
  it('lixo / vazio → undefined', () => {
    expect(toEpochMs('')).toBeUndefined();
    expect(toEpochMs('zzz')).toBeUndefined();
    expect(toEpochMs(null)).toBeUndefined();
    expect(toEpochMs(undefined)).toBeUndefined();
  });
});

describe('formatResetIn — 2h13 / 45min / agora', () => {
  it('≥ 1h ⇒ "2h13" (minutos com 2 dígitos)', () => {
    const resetAt = NOW + (2 * 60 + 13) * 60_000;
    expect(formatResetIn(resetAt, NOW)).toBe('2h13');
  });
  it('hora cheia ⇒ "1h00"', () => {
    expect(formatResetIn(NOW + 60 * 60_000, NOW)).toBe('1h00');
  });
  it('< 1h ⇒ "45min"', () => {
    expect(formatResetIn(NOW + 45 * 60_000, NOW)).toBe('45min');
  });
  it('< 1min restante ⇒ "agora"', () => {
    expect(formatResetIn(NOW + 30_000, NOW)).toBe('agora');
  });
  it('já passou / igual ⇒ "agora"', () => {
    expect(formatResetIn(NOW - 5_000, NOW)).toBe('agora');
    expect(formatResetIn(NOW, NOW)).toBe('agora');
  });
});

describe('quotaLevel / windowPct — limiar 70/90% (cor de aviso)', () => {
  it('< 70% ⇒ ok', () => {
    expect(quotaLevel(42)).toBe('ok');
    expect(quotaLevel(69)).toBe('ok');
  });
  it('70–89% ⇒ warn (âmbar)', () => {
    expect(quotaLevel(70)).toBe('warn');
    expect(quotaLevel(89)).toBe('warn');
  });
  it('≥ 90% ⇒ crit (vermelho)', () => {
    expect(quotaLevel(90)).toBe('crit');
    expect(quotaLevel(100)).toBe('crit');
  });
  it('windowPct trunca p/ baixo e satura em 0–100', () => {
    expect(windowPct({ used: 4299, limit: 10000, resetAt: NOW })).toBe(42);
    expect(windowPct({ used: 99999, limit: 100, resetAt: NOW })).toBe(100);
    expect(windowPct({ used: 0, limit: 100, resetAt: NOW })).toBe(0);
  });
});

describe('formatQuota — view do footer', () => {
  it('ambas as janelas ⇒ dois segmentos + reset da 5h', () => {
    const view = formatQuota(
      {
        windows: {
          fiveHour: { used: 42, limit: 100, resetAt: NOW + (2 * 60 + 13) * 60_000 },
          week: { used: 18, limit: 100, resetAt: NOW + 3 * 24 * 60 * 60_000 },
        },
      },
      NOW,
    );
    expect(view?.segments.map((s) => `${s.label}:${s.pct}`)).toEqual(['5h:42', 'semana:18']);
    expect(view?.resetText).toBe('reseta em 2h13');
    expect(view?.maxLevel).toBe('ok');
  });

  it('só semana ⇒ um segmento, reset da semana', () => {
    const view = formatQuota(
      { windows: { week: { used: 95, limit: 100, resetAt: NOW + 45 * 60_000 } } },
      NOW,
    );
    expect(view?.segments).toHaveLength(1);
    expect(view?.segments[0]).toMatchObject({ label: 'semana', pct: 95, level: 'crit' });
    expect(view?.resetText).toBe('reseta em 45min');
    expect(view?.maxLevel).toBe('crit');
  });

  it('quota undefined ⇒ undefined (footer NÃO renderiza)', () => {
    expect(formatQuota(undefined, NOW)).toBeUndefined();
  });

  it('maxLevel é o MÁXIMO entre as janelas (warn em uma ⇒ warn)', () => {
    const view = formatQuota(
      {
        windows: {
          fiveHour: { used: 75, limit: 100, resetAt: NOW + 60_000 * 60 },
          week: { used: 10, limit: 100, resetAt: NOW + 60_000 * 120 },
        },
      },
      NOW,
    );
    expect(view?.maxLevel).toBe('warn');
  });
});

describe('parseQuotaBody — fallback no corpo do `done`', () => {
  it('campo `quota` com fiveHour/week ⇒ janelas', () => {
    const q = parseQuotaBody({
      finish_reason: 'stop',
      quota: {
        fiveHour: { used: 42, limit: 100, resetAt: '2026-06-09T14:00:00Z' },
        week: { used: 18, limit: 100, reset_at: 1749600000 },
      },
    });
    expect(q?.windows.fiveHour?.used).toBe(42);
    expect(q?.windows.week?.used).toBe(18);
  });

  it('aceita a chave "5h" e `windows` aninhado', () => {
    const q = parseQuotaBody({
      quota: { windows: { '5h': { used: 5, limit: 100, resetAt: 1749600000 } } },
    });
    expect(q?.windows.fiveHour?.used).toBe(5);
  });

  it('sem `quota` no corpo ⇒ undefined', () => {
    expect(parseQuotaBody({ finish_reason: 'stop' })).toBeUndefined();
    expect(parseQuotaBody(undefined)).toBeUndefined();
  });
});

// ── FONTES REAIS (ADR-0069 / broker#59) ──────────────────────────────────────

describe('parseQuotaResponse — corpo do GET /v1/quota (ADR-0069)', () => {
  it('windows[] + credit ⇒ 5h/semana (used/limit/reset) + balance', () => {
    const q = parseQuotaResponse({
      windows: [
        {
          period: '5h',
          limit: '100000',
          used: '42000',
          remaining: '58000',
          reset_at: '2026-06-10T18:00:00+00:00',
        },
        {
          period: 'week',
          limit: '500000',
          used: '18000',
          remaining: '482000',
          reset_at: '2026-06-15T00:00:00+00:00',
        },
      ],
      credit: { balance: '42.118000' },
    });
    expect(q?.windows.fiveHour).toMatchObject({ used: 42000, limit: 100000 });
    expect(q?.windows.fiveHour?.resetAt).toBe(Date.parse('2026-06-10T18:00:00+00:00'));
    expect(q?.windows.week?.used).toBe(18000);
    expect(q?.credit?.balance).toBe('42.118000');
  });

  it('estado dev (`{windows:[], credit:{balance:null}}`) ⇒ sem janela/sem crédito (lido OK)', () => {
    const q = parseQuotaResponse({ windows: [], credit: { balance: null } });
    expect(q).toBeDefined();
    expect(q?.windows.fiveHour).toBeUndefined();
    expect(q?.windows.week).toBeUndefined();
    expect(q?.credit).toBeUndefined();
  });

  it('janela ilimitada (`limit:null`) ⇒ descartada (sem % a mostrar)', () => {
    const q = parseQuotaResponse({ windows: [{ period: 'week', limit: null, used: '99' }] });
    expect(q?.windows.week).toBeUndefined();
  });

  it('tolerante: campo a mais ignorado; period desconhecido ignorado; corpo não-objeto ⇒ undefined', () => {
    const q = parseQuotaResponse({
      windows: [{ period: 'month', limit: '1', used: '0', reset_at: '2026-07-01T00:00:00Z' }],
      credit: { balance: '1.0', currency: 'USD' },
      extra: 1,
    });
    expect(q?.windows.fiveHour).toBeUndefined();
    expect(q?.windows.week).toBeUndefined();
    expect(q?.credit?.balance).toBe('1.0');
    expect(parseQuotaResponse(42)).toBeUndefined();
  });
});

describe('parseQuotaFromUsage — campos achatados do evento `usage` (ADR-0069 path A)', () => {
  it('quota_5h_* + quota_week_* ⇒ as duas janelas (strings ⇒ números)', () => {
    const q = parseQuotaFromUsage({
      tokens_in: 5,
      quota_5h_used: '300',
      quota_5h_limit: '1000',
      quota_5h_remaining: '700',
      quota_5h_reset_at: '2026-06-10T18:00:00+00:00',
      quota_week_used: '300',
      quota_week_limit: '5000',
      quota_week_reset_at: '2026-06-15T00:00:00+00:00',
    });
    expect(q?.windows.fiveHour).toMatchObject({ used: 300, limit: 1000 });
    expect(q?.windows.week).toMatchObject({ used: 300, limit: 5000 });
  });

  it('semana ilimitada (campos omitidos) ⇒ só 5h', () => {
    const q = parseQuotaFromUsage({
      quota_5h_used: '300',
      quota_5h_limit: '1000',
      quota_5h_reset_at: '2026-06-10T18:00:00+00:00',
    });
    expect(q?.windows.fiveHour?.used).toBe(300);
    expect(q?.windows.week).toBeUndefined();
  });

  it('nenhum campo de quota ⇒ undefined (chamador preserva o estado)', () => {
    expect(parseQuotaFromUsage({ tokens_in: 5, tokens_out: 3 })).toBeUndefined();
    expect(parseQuotaFromUsage(undefined)).toBeUndefined();
  });
});

describe('serverWindowLimit / findWindow — limite SERVER-DRIVEN (§4)', () => {
  const q: Quota = {
    windows: {
      fiveHour: { used: 42000, limit: 100000, resetAt: Date.now() + 1000 },
    },
  };

  it('janela COM teto ⇒ usa o número REAL do server (limit/remaining derivado)', () => {
    const sl = serverWindowLimit(findWindow(q, '5h'));
    expect(sl).toEqual({ limit: 100000, remaining: 58000 });
  });

  it('janela AUSENTE ⇒ undefined (chamador cai no fail-safe LOCAL DEFAULT_MAX_TOKENS)', () => {
    expect(serverWindowLimit(findWindow(q, 'week'))).toBeUndefined();
    expect(serverWindowLimit(undefined)).toBeUndefined();
  });

  it('findWindow resolve 5h/week da quota', () => {
    expect(findWindow(q, '5h')?.used).toBe(42000);
    expect(findWindow(q, 'week')).toBeUndefined();
    expect(findWindow(undefined, '5h')).toBeUndefined();
  });
});

describe('formatQuota — CRÉDITO (dimensão primária ADR-0069) + degradação', () => {
  it('crédito presente ⇒ view com creditBalance', () => {
    const view = formatQuota({ windows: {}, credit: { balance: '42.118000' } });
    expect(view?.creditBalance).toBe('42.118000');
    expect(view?.segments).toHaveLength(0);
  });

  it('crédito + janelas ⇒ view com ambos', () => {
    const view = formatQuota({
      windows: { fiveHour: { used: 42, limit: 100, resetAt: Date.now() + 60_000 } },
      credit: { balance: '9.5' },
    });
    expect(view?.creditBalance).toBe('9.5');
    expect(view?.segments[0]).toMatchObject({ label: '5h', pct: 42 });
  });

  it('estado dev (`{windows:{}}` sem crédito) ⇒ undefined (footer OCULTO)', () => {
    expect(formatQuota({ windows: {} })).toBeUndefined();
  });
});

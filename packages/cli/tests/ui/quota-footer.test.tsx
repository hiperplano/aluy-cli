// EST-0948 (footer/quota) — render do <QuotaFooter>: mostra `5h: X% · semana: Y% ·
// reseta em ...`; DEGRADA (não renderiza) sem quota; parcial mostra só a janela
// presente; cor de aviso ≥70% e crítico ≥90%. ink-testing-library + DS (papéis).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { Quota, ServerLimits } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { QuotaFooter } from '../../src/ui/components/QuotaFooter.js';

const NOW = Date.UTC(2026, 5, 9, 12, 0, 0); // 2026-06-09T12:00:00Z

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv = { TERM: 'xterm-256color' }) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

const FULL: Quota = {
  windows: {
    fiveHour: { used: 42, limit: 100, resetAt: NOW + (2 * 60 + 13) * 60_000 },
    week: { used: 18, limit: 100, resetAt: NOW + 3 * 24 * 60 * 60_000 },
  },
};

describe('QuotaFooter — exibe a quota do broker (5h · semana · reseta)', () => {
  it('COM quota completa ⇒ "5h: 42% · semana: 18% · reseta em 2h13"', () => {
    const { lastFrame } = wrap(<QuotaFooter quota={FULL} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('5h: 42%');
    expect(out).toContain('semana: 18%');
    expect(out).toContain('reseta em 2h13');
  });

  it('SEM quota (undefined) ⇒ NÃO renderiza NADA (degrada/oculto)', () => {
    const { lastFrame } = wrap(<QuotaFooter quota={undefined} now={NOW} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('PARCIAL (só 5h) ⇒ mostra só `5h`, sem `semana`', () => {
    const partial: Quota = {
      windows: { fiveHour: { used: 30, limit: 100, resetAt: NOW + 45 * 60_000 } },
    };
    const { lastFrame } = wrap(<QuotaFooter quota={partial} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('5h: 30%');
    expect(out).not.toContain('semana');
    expect(out).toContain('reseta em 45min');
  });

  it('rótulos `5h`/`semana` presentes — não confunde com o budget LOCAL', () => {
    const { lastFrame } = wrap(<QuotaFooter quota={FULL} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    // distingue do <StatusBar> (◷ tokens / □ %): aqui os rótulos são explícitos.
    expect(out).toMatch(/5h:/);
    expect(out).toMatch(/semana:/);
  });

  it('≥ 70% ⇒ o % ganha COR de aviso (ANSI no frame cru), rótulo segue dim', () => {
    const warn: Quota = {
      windows: { fiveHour: { used: 75, limit: 100, resetAt: NOW + 60 * 60_000 } },
    };
    const { lastFrame } = wrap(<QuotaFooter quota={warn} now={NOW} />);
    const raw = lastFrame() ?? '';
    // o frame cru carrega sequência ANSI de cor (o % é pintado por papel accent).
    expect(raw).toMatch(new RegExp(ESC + '\\['));
    expect(plain(raw)).toContain('5h: 75%');
  });

  it('≥ 90% ⇒ crítico (vermelho); texto continua legível', () => {
    const crit: Quota = {
      windows: { week: { used: 95, limit: 100, resetAt: NOW + 30 * 60_000 } },
    };
    const { lastFrame } = wrap(<QuotaFooter quota={crit} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('semana: 95%');
  });

  it('reset já passou ⇒ "reseta agora"', () => {
    const q: Quota = {
      windows: { fiveHour: { used: 10, limit: 100, resetAt: NOW - 1000 } },
    };
    const { lastFrame } = wrap(<QuotaFooter quota={q} now={NOW} />);
    expect(plain(lastFrame() ?? '')).toContain('reseta agora');
  });
});

describe('QuotaFooter — server-limits do `usage` (crédito agora + quota quando vier)', () => {
  it('só CRÉDITO (balance_after, hoje) ⇒ "crédito: 12"', () => {
    const sl: ServerLimits = { balanceAfter: 12 };
    const { lastFrame } = wrap(<QuotaFooter serverLimits={sl} now={NOW} />);
    expect(plain(lastFrame() ?? '')).toContain('crédito: 12');
  });

  it('crédito BAIXO ⇒ pintado (ANSI de cor crit no frame cru)', () => {
    const sl: ServerLimits = { balanceAfter: 0.3 };
    const { lastFrame } = wrap(<QuotaFooter serverLimits={sl} now={NOW} />);
    const raw = lastFrame() ?? '';
    expect(raw).toMatch(new RegExp(ESC + '\\['));
    expect(plain(raw)).toContain('crédito: 0.3');
  });

  it('LIMITE de tokens + período + reset ⇒ "week: 42% · reseta em 2h13"', () => {
    const sl: ServerLimits = {
      limit: 100,
      used: 42,
      remaining: 58,
      period: 'week',
      resetAt: NOW + (2 * 60 + 13) * 60_000,
    };
    const { lastFrame } = wrap(<QuotaFooter serverLimits={sl} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('week: 42%');
    expect(out).toContain('reseta em 2h13');
  });

  it('AUSENTE (ambos undefined) ⇒ NÃO renderiza NADA (degrada/oculto)', () => {
    const { lastFrame } = wrap(<QuotaFooter now={NOW} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('quota 5h/semana E server-limits juntos ⇒ ambos no MESMO footer', () => {
    const sl: ServerLimits = { balanceAfter: 7 };
    const { lastFrame } = wrap(<QuotaFooter quota={FULL} serverLimits={sl} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('5h: 42%');
    expect(out).toContain('crédito: 7');
  });
});

describe('QuotaFooter — CRÉDITO do /v1/quota (path B · ADR-0069 dimensão primária)', () => {
  it('quota com CRÉDITO (de /v1/quota) ⇒ "crédito: 42.118000"', () => {
    const q: Quota = { windows: {}, credit: { balance: '42.118000' } };
    const { lastFrame } = wrap(<QuotaFooter quota={q} now={NOW} />);
    expect(plain(lastFrame() ?? '')).toContain('crédito: 42.118000');
  });

  it('CRÉDITO (quota) + janelas (5h/semana) juntos no MESMO footer', () => {
    const q: Quota = {
      windows: {
        fiveHour: { used: 42, limit: 100, resetAt: NOW + (2 * 60 + 13) * 60_000 },
        week: { used: 18, limit: 100, resetAt: NOW + 3 * 24 * 60 * 60_000 },
      },
      credit: { balance: '9.500000' },
    };
    const { lastFrame } = wrap(<QuotaFooter quota={q} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('crédito: 9.500000');
    expect(out).toContain('5h: 42%');
    expect(out).toContain('semana: 18%');
    expect(out).toContain('reseta em 2h13');
  });

  it('ESTADO DEV real (`{windows:{}}` sem crédito) ⇒ NÃO renderiza (degrada/oculto)', () => {
    const empty: Quota = { windows: {} }; // = parseQuotaResponse({windows:[],credit:{balance:null}})
    const { lastFrame } = wrap(<QuotaFooter quota={empty} now={NOW} />);
    expect((lastFrame() ?? '').trim()).toBe('');
  });

  it('crédito do `quota` TEM PRECEDÊNCIA sobre o `balance_after` (não duplica "crédito")', () => {
    const q: Quota = { windows: {}, credit: { balance: '20.000000' } };
    const sl: ServerLimits = { balanceAfter: 5 }; // valor DIFERENTE — não deve aparecer 2×.
    const { lastFrame } = wrap(<QuotaFooter quota={q} serverLimits={sl} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('crédito: 20.000000');
    expect(out).not.toContain('crédito: 5'); // o do server-limits NÃO repinta.
    // exatamente UMA ocorrência de "crédito:".
    expect((out.match(/crédito:/g) ?? []).length).toBe(1);
  });

  it('janela com teto mas SEM reset ⇒ mostra a % sem "reseta em" (tolerante)', () => {
    const q: Quota = { windows: { fiveHour: { used: 50, limit: 100 } } };
    const { lastFrame } = wrap(<QuotaFooter quota={q} now={NOW} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('5h: 50%');
    expect(out).not.toContain('reseta');
  });
});

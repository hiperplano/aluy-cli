// F-SALDO-BYO — testa a descoberta de SALDO/CONSUMO do gateway BYO, ISOLADA (sem
// bootar a TUI/run.tsx — mesmo padrão de `context-window-discovery.test.ts`). O que
// esta bateria protege:
//   - PARSE puro de cada dialeto contra CORPO REAL capturado ao vivo (não inventado —
//     ver `fixtures/balance/*.json`, medidos contra `api.tokenrouter.com` e
//     `openrouter.ai` com as chaves reais do dono/verificação);
//   - a ORDEM de tentativa (`discoverBalance`) e a guarda de `wireFormat`;
//   - DEGRADAÇÃO SILENCIOSA em TODA forma de falha (401, timeout, corpo não-JSON,
//     corpo grande demais, `getKey` que lança, dialeto que lança) — NUNCA lança,
//     resultado = `undefined`;
//   - a MEMOIZAÇÃO (1 chamada de rede por dialeto por porta) + o `cacheMs` opcional;
//   - CLI-SEC-10: a credencial nunca aparece em URL/corpo, só no header
//     `authorization` — e uma falha que ecoa a credencial na MENSAGEM do erro nunca
//     escapa deste módulo (é engolida, o chamador só vê `undefined`).

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  discoverBalance,
  createDiscoverBalancePort,
  openAiCompatBillingDialect,
  openRouterCreditsDialect,
  parseOpenAiCompatBillingSubscription,
  parseOpenAiCompatBillingUsage,
  combineOpenAiCompatBilling,
  parseOpenRouterCredits,
  formatBalanceAmount,
  ALL_BALANCE_DIALECTS,
  MAX_BALANCE_BODY_CHARS,
  type BalanceDialect,
  type BalanceIoDeps,
} from '../../../src/model/local/balance-discovery.js';
import type { ConnectivityFetch } from '../../../src/model/local/connectivity-check.js';

// ── fixtures REAIS (capturadas ao vivo — ver cabeçalho dos arquivos) ──────────────

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/balance/${name}`, import.meta.url), 'utf8');
}

const TOKENROUTER_SUBSCRIPTION = fixture('tokenrouter-billing-subscription.json');
const TOKENROUTER_USAGE = fixture('tokenrouter-billing-usage.json');
const TOKENROUTER_SUBSCRIPTION_401 = fixture('tokenrouter-billing-subscription-401.json');
const TOKENROUTER_USER_SELF_401 = fixture('tokenrouter-user-self.json');
const OPENROUTER_CREDITS = fixture('openrouter-credits.json');
const OPENROUTER_CREDITS_401 = fixture('openrouter-credits-401.json');

// ── fetch fake: roteia por SUFIXO de path, registra cada chamada ─────────────────

interface Route {
  readonly ok?: boolean;
  readonly status?: number;
  readonly text?: string;
  readonly throws?: Error;
  /** nunca resolve nem rejeita até o `signal` abortar (simula timeout real). */
  readonly hang?: boolean;
}

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly hasBody: boolean;
}

function routedFetch(routes: Record<string, Route>): {
  readonly fetchImpl: ConnectivityFetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: ConnectivityFetch = (input, init) => {
    calls.push({
      url: input,
      method: init.method,
      headers: init.headers,
      hasBody: init.body !== undefined,
    });
    const suffix = Object.keys(routes).find((s) => input.endsWith(s));
    const route = suffix !== undefined ? routes[suffix] : undefined;
    if (route?.hang === true) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }
    if (route?.throws !== undefined) return Promise.reject(route.throws);
    return Promise.resolve({
      ok: route?.ok ?? true,
      status: route?.status ?? 200,
      text: async () => route?.text ?? '{}',
    });
  };
  return { fetchImpl, calls };
}

function deps(overrides: Partial<BalanceIoDeps> = {}): BalanceIoDeps {
  return {
    wireFormat: 'openai-compat',
    baseUrl: 'https://gateway.test/v1',
    key: 'sk-test-secret',
    fetchImpl: routedFetch({}).fetchImpl,
    ...overrides,
  };
}

// ── PARSE puro — contra corpo REAL capturado ao vivo ──────────────────────────────

describe('parse puro — dialeto de billing legado (tokenrouter, medido ao vivo)', () => {
  it('lê o teto (hard_limit_usd) do corpo real de /dashboard/billing/subscription', () => {
    const body = JSON.parse(TOKENROUTER_SUBSCRIPTION) as unknown;
    expect(parseOpenAiCompatBillingSubscription(body)).toBe(50);
  });

  it('lê o consumido (total_usage/100) do corpo real de /dashboard/billing/usage', () => {
    const body = JSON.parse(TOKENROUTER_USAGE) as unknown;
    expect(parseOpenAiCompatBillingUsage(body)).toBe(0);
  });

  it('combina teto+consumo reais em um LocalBalance (o caso medido: 50 USD livres)', () => {
    const limit = parseOpenAiCompatBillingSubscription(JSON.parse(TOKENROUTER_SUBSCRIPTION));
    const usage = parseOpenAiCompatBillingUsage(JSON.parse(TOKENROUTER_USAGE));
    expect(combineOpenAiCompatBilling(limit, usage)).toEqual({ remaining: '50', unit: 'USD' });
  });

  it('teto ausente ⇒ undefined (corpo do /api/user/self, sessão — NÃO é este dialeto)', () => {
    // MEDIDO: /api/user/self com a API key devolve 401 "Session validation failed" —
    // mesmo que o corpo fosse alcançado, ele não tem `hard_limit_usd` (formato errado).
    expect(parseOpenAiCompatBillingSubscription(JSON.parse(TOKENROUTER_USER_SELF_401))).toBeUndefined();
  });

  it('corpo de erro (401 real) não tem hard_limit_usd ⇒ undefined', () => {
    expect(
      parseOpenAiCompatBillingSubscription(JSON.parse(TOKENROUTER_SUBSCRIPTION_401)),
    ).toBeUndefined();
  });

  it('usage ausente/inválido ⇒ undefined (combinador trata como "desconhecido", não zero)', () => {
    expect(parseOpenAiCompatBillingUsage({})).toBeUndefined();
    expect(parseOpenAiCompatBillingUsage(null)).toBeUndefined();
    expect(parseOpenAiCompatBillingUsage('corpo estranho')).toBeUndefined();
  });

  it('sem teto ⇒ combinador degrada p/ undefined (mesmo com consumo válido)', () => {
    expect(combineOpenAiCompatBilling(undefined, 3)).toBeUndefined();
  });

  it('consumo > teto ⇒ satura em 0 (nunca negativo)', () => {
    expect(combineOpenAiCompatBilling(10, 999)).toEqual({ remaining: '0', unit: 'USD' });
  });

  it('teto sem usage (2ª chamada falhou) ⇒ mostra o teto inteiro (consumo tratado como 0)', () => {
    expect(combineOpenAiCompatBilling(50, undefined)).toEqual({ remaining: '50', unit: 'USD' });
  });
});

describe('parse puro — dialeto OpenRouter /credits (medido ao vivo)', () => {
  it('lê o corpo real e calcula o saldo restante (105 − 100.697326477 ≈ 4.3 USD)', () => {
    const body = JSON.parse(OPENROUTER_CREDITS) as unknown;
    expect(parseOpenRouterCredits(body)).toEqual({ remaining: '4.3', unit: 'USD' });
  });

  it('corpo de erro real (401) não tem `data` ⇒ undefined', () => {
    expect(parseOpenRouterCredits(JSON.parse(OPENROUTER_CREDITS_401))).toBeUndefined();
  });

  it('total_credits ausente ⇒ undefined; total_usage ausente ⇒ tratado como 0', () => {
    expect(parseOpenRouterCredits({ data: {} })).toBeUndefined();
    expect(parseOpenRouterCredits({ data: { total_credits: 10 } })).toEqual({
      remaining: '10',
      unit: 'USD',
    });
  });

  it('corpo não-objeto/sem `data` ⇒ undefined', () => {
    expect(parseOpenRouterCredits(null)).toBeUndefined();
    expect(parseOpenRouterCredits('string qualquer')).toBeUndefined();
    expect(parseOpenRouterCredits({})).toBeUndefined();
  });
});

describe('formatBalanceAmount — sem casas decimais espúrias de float', () => {
  it('inteiro ⇒ sem casas', () => {
    expect(formatBalanceAmount(50)).toBe('50');
    expect(formatBalanceAmount(0)).toBe('0');
  });
  it('decimal ⇒ no máx. 2 casas', () => {
    expect(formatBalanceAmount(4.302673523)).toBe('4.3');
    expect(formatBalanceAmount(1.005)).toBe('1');
  });
});

// ── I/O isolado — dialetos individuais (fetch fake, corpo real como texto) ────────

describe('dialeto de billing legado — I/O isolado', () => {
  it('caminho feliz: duas chamadas sequenciais, corpo real, credencial só no header', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/dashboard/billing/subscription': { text: TOKENROUTER_SUBSCRIPTION },
      '/dashboard/billing/usage': { text: TOKENROUTER_USAGE },
    });
    const result = await openAiCompatBillingDialect(deps({ fetchImpl }));
    expect(result).toEqual({ remaining: '50', unit: 'USD' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://gateway.test/v1/dashboard/billing/subscription');
    expect(calls[1]?.url).toBe('https://gateway.test/v1/dashboard/billing/usage');
    for (const c of calls) {
      expect(c.method).toBe('GET');
      expect(c.hasBody).toBe(false);
      expect(c.headers['authorization']).toBe('Bearer sk-test-secret');
      // a credencial NUNCA vai na URL.
      expect(c.url).not.toContain('sk-test-secret');
    }
  });

  it('teto não encontrado (1ª chamada falha) ⇒ NÃO faz a 2ª chamada (poupa rede)', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/dashboard/billing/subscription': { ok: false, status: 401, text: TOKENROUTER_SUBSCRIPTION_401 },
    });
    const result = await openAiCompatBillingDialect(deps({ fetchImpl }));
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('wireFormat não-openai-compat ⇒ nem tenta a rede', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/dashboard/billing/subscription': { text: TOKENROUTER_SUBSCRIPTION },
    });
    const result = await openAiCompatBillingDialect(deps({ fetchImpl, wireFormat: 'anthropic' }));
    expect(result).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('auth:none (key vazia) ⇒ sem header authorization', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/dashboard/billing/subscription': { text: TOKENROUTER_SUBSCRIPTION },
      '/dashboard/billing/usage': { text: TOKENROUTER_USAGE },
    });
    await openAiCompatBillingDialect(deps({ fetchImpl, key: '' }));
    for (const c of calls) expect(c.headers['authorization']).toBeUndefined();
  });
});

describe('dialeto OpenRouter — I/O isolado', () => {
  it('caminho feliz: uma chamada, corpo real, credencial só no header', async () => {
    const { fetchImpl, calls } = routedFetch({ '/credits': { text: OPENROUTER_CREDITS } });
    const result = await openRouterCreditsDialect(deps({ fetchImpl }));
    expect(result).toEqual({ remaining: '4.3', unit: 'USD' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://gateway.test/v1/credits');
    expect(calls[0]?.headers['authorization']).toBe('Bearer sk-test-secret');
  });

  it('401 real ⇒ undefined, sem lançar', async () => {
    const { fetchImpl } = routedFetch({ '/credits': { ok: false, status: 401, text: OPENROUTER_CREDITS_401 } });
    await expect(openRouterCreditsDialect(deps({ fetchImpl }))).resolves.toBeUndefined();
  });
});

// ── degradação em TODA forma de falha (nunca lança) ────────────────────────────────

describe('degradação silenciosa — nunca lança', () => {
  it('timeout real (aborta pelo signal) ⇒ undefined, sem lançar', async () => {
    const { fetchImpl } = routedFetch({ '/dashboard/billing/subscription': { hang: true } });
    const result = await openAiCompatBillingDialect(deps({ fetchImpl, timeoutMs: 20 }));
    expect(result).toBeUndefined();
  });

  it('corpo não-JSON ⇒ undefined, sem lançar', async () => {
    const { fetchImpl } = routedFetch({ '/credits': { text: 'isto não é json{' } });
    await expect(openRouterCreditsDialect(deps({ fetchImpl }))).resolves.toBeUndefined();
  });

  it('corpo maior que o teto ⇒ undefined, sem sequer tentar o parse', async () => {
    const grande = JSON.stringify({ data: { total_credits: 1 } }).padEnd(
      MAX_BALANCE_BODY_CHARS + 1,
      ' ',
    );
    const { fetchImpl } = routedFetch({ '/credits': { text: grande } });
    await expect(openRouterCreditsDialect(deps({ fetchImpl }))).resolves.toBeUndefined();
  });

  it('rede fora (fetch rejeita) ⇒ undefined, sem lançar', async () => {
    const { fetchImpl } = routedFetch({ '/credits': { throws: new Error('ECONNREFUSED') } });
    await expect(openRouterCreditsDialect(deps({ fetchImpl }))).resolves.toBeUndefined();
  });

  it('NENHUM dialeto reconhece o gateway ⇒ discoverBalance devolve undefined', async () => {
    const { fetchImpl } = routedFetch({
      '/dashboard/billing/subscription': { ok: false, status: 404 },
      '/credits': { ok: false, status: 404 },
    });
    await expect(discoverBalance(deps({ fetchImpl }))).resolves.toBeUndefined();
  });
});

// ── CLI-SEC-10 — a credencial NUNCA aparece numa mensagem de erro ─────────────────

describe('CLI-SEC-10 — a credencial nunca escapa deste módulo', () => {
  const SECRET = 'sk-super-secreta-nao-pode-vazar-jamais';

  it('fetch que lança um erro CONTENDO a credencial ⇒ resolve undefined, nunca rejeita', async () => {
    const vazando: BalanceDialect = async () => {
      throw new Error(`falha ao chamar https://gateway.test/v1/credits?key=${SECRET}`);
    };
    // `discoverBalance` é a rede de segurança — mesmo um dialeto que ESQUECESSE de
    // engolir sua falha nunca deixa a mensagem (com a credencial) escapar como rejeição.
    await expect(discoverBalance(deps({ key: SECRET }), [vazando])).resolves.toBeUndefined();
  });

  it('getKey que lança (erro contendo a credencial) ⇒ a porta resolve undefined, sem rejeitar', async () => {
    const port = createDiscoverBalancePort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl: routedFetch({}).fetchImpl,
      getKey: async () => {
        throw new Error(`keychain devolveu lixo perto de ${SECRET}`);
      },
    });
    await expect(port()).resolves.toBeUndefined();
  });

  it('a credencial só aparece no header authorization — nunca na URL/corpo da requisição', async () => {
    const { fetchImpl, calls } = routedFetch({
      '/dashboard/billing/subscription': { text: TOKENROUTER_SUBSCRIPTION },
      '/dashboard/billing/usage': { text: TOKENROUTER_USAGE },
      '/credits': { text: OPENROUTER_CREDITS },
    });
    await discoverBalance(deps({ fetchImpl, key: SECRET }));
    for (const c of calls) {
      expect(c.url).not.toContain(SECRET);
      expect(c.hasBody).toBe(false);
    }
    expect(calls.some((c) => c.headers['authorization'] === `Bearer ${SECRET}`)).toBe(true);
  });
});

// ── ordem de tentativa ────────────────────────────────────────────────────────────

describe('discoverBalance — ordem de tentativa', () => {
  it('tenta em ORDEM e para no primeiro dialeto que resolve', async () => {
    const ordem: string[] = [];
    const falha: BalanceDialect = async () => {
      ordem.push('falha');
      return undefined;
    };
    const acha: BalanceDialect = async () => {
      ordem.push('acha');
      return { remaining: '7', unit: 'USD' };
    };
    const nuncaChamado: BalanceDialect = async () => {
      ordem.push('nunca deveria rodar');
      return { remaining: '999', unit: 'USD' };
    };
    const result = await discoverBalance(deps(), [falha, acha, nuncaChamado]);
    expect(result).toEqual({ remaining: '7', unit: 'USD' });
    expect(ordem).toEqual(['falha', 'acha']);
  });

  it('a lista DEFAULT usa SÓ o OpenRouter, mesmo com o billing legado respondendo', async () => {
    const { fetchImpl } = routedFetch({
      '/dashboard/billing/subscription': { text: TOKENROUTER_SUBSCRIPTION },
      '/dashboard/billing/usage': { text: TOKENROUTER_USAGE },
      '/credits': { text: OPENROUTER_CREDITS },
    });
    // A ORIGEM (relato do dono: "os créditos não estão aparecendo corretamente"): os DOIS
    // dialetos respondem neste fake, e o legado vinha PRIMEIRO — ele lê `hard_limit_usd`,
    // que é o TETO da conta, não o saldo. O número pintado não era saldo nenhum.
    //
    // Saldo errado é PIOR que saldo ausente: um número na tela é usado para decidir. O
    // default passa a ser só o `/api/v1/credits` do OpenRouter, onde a conta fecha
    // (`total_credits` − `total_usage`), e não `50` (o teto do outro).
    const r = await discoverBalance(deps({ fetchImpl }));
    expect(r?.remaining).not.toBe('50');
    expect(r).toEqual({ remaining: '4.3', unit: 'USD' });
  });

  it('o dialeto legado continua disponível por OPT-IN explícito (não foi apagado)', async () => {
    const { fetchImpl } = routedFetch({
      '/dashboard/billing/subscription': { text: TOKENROUTER_SUBSCRIPTION },
      '/dashboard/billing/usage': { text: TOKENROUTER_USAGE },
    });
    await expect(discoverBalance(deps({ fetchImpl }), ALL_BALANCE_DIALECTS)).resolves.toEqual({
      remaining: '50',
      unit: 'USD',
    });
  });
});

// ── porta memoizada (createDiscoverBalancePort) ───────────────────────────────────

describe('createDiscoverBalancePort', () => {
  it('memoiza: 2 chamadas à porta ⇒ só 1 rodada de rede', async () => {
    const { fetchImpl, calls } = routedFetch({ '/credits': { text: OPENROUTER_CREDITS } });
    const port = createDiscoverBalancePort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl,
      getKey: async () => 'sk-test',
      dialects: [openRouterCreditsDialect],
    });
    const a = await port();
    const b = await port();
    expect(a).toEqual({ remaining: '4.3', unit: 'USD' });
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it('resultado `undefined` (gateway desconhecido) TAMBÉM é memoizado', async () => {
    const { fetchImpl, calls } = routedFetch({ '/credits': { ok: false, status: 404 } });
    const port = createDiscoverBalancePort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl,
      getKey: async () => 'sk-test',
      dialects: [openRouterCreditsDialect],
    });
    await port();
    await port();
    expect(calls).toHaveLength(1);
  });

  it('sem credencial (getKey lança) ⇒ undefined, e nunca chega a tocar a rede', async () => {
    const { fetchImpl, calls } = routedFetch({ '/credits': { text: OPENROUTER_CREDITS } });
    const port = createDiscoverBalancePort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl,
      getKey: async () => {
        throw new Error('sem credencial apikey p/ "openrouter"');
      },
    });
    await expect(port()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it('com `cacheMs`, refresca após expirar (clock injetável)', async () => {
    let tick = 0;
    const { fetchImpl, calls } = routedFetch({ '/credits': { text: OPENROUTER_CREDITS } });
    const port = createDiscoverBalancePort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl,
      getKey: async () => 'sk-test',
      dialects: [openRouterCreditsDialect],
      cacheMs: 60_000,
      now: () => tick,
    });
    await port();
    expect(calls).toHaveLength(1);
    await port(); // ainda dentro da janela ⇒ não refaz.
    expect(calls).toHaveLength(1);
    tick += 60_001; // expira.
    await port();
    expect(calls).toHaveLength(2);
  });
});

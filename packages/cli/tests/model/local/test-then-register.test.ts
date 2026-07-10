// ADR-0153 — TEST-THEN-REGISTER: fábrica `createVerifyAndRegisterLocalModelPort`,
// testada ISOLADA (sem bootar a TUI/run.tsx — mesmo padrão de
// `local-child-caller-factory.test.ts`). Cobre os testes de segurança 6 (memoização
// por slug), 7 (teto de sessão) e 9 (fail-closed não derruba irmãos) do parecer do
// `seguranca`, além do formato exato do texto de sucesso (D4/COND-S4).

import { describe, expect, it } from 'vitest';
import {
  createVerifyAndRegisterLocalModelPort,
  MAX_LOCAL_MODEL_TESTS_PER_SESSION,
} from '../../../src/model/local/test-then-register.js';
import type { ConnectivityFetch } from '../../../src/model/local/connectivity-check.js';

/** `fetchImpl` fake que conta chamadas e decide ok/erro por slug (via o `model` do body). */
function countingFetch(opts: {
  readonly okSlugs?: readonly string[];
  readonly httpStatus?: number;
}): { fetchImpl: ConnectivityFetch; calls: string[] } {
  const calls: string[] = [];
  const okSlugs = new Set(opts.okSlugs ?? []);
  const fetchImpl: ConnectivityFetch = async (_input, init) => {
    const body = init.body !== undefined ? (JSON.parse(init.body) as { model: string }) : { model: '' };
    calls.push(body.model);
    const ok = okSlugs.has(body.model);
    return {
      ok,
      status: ok ? 200 : (opts.httpStatus ?? 404),
      text: async () => '',
    };
  };
  return { fetchImpl, calls };
}

function basePort(overrides: {
  readonly fetchImpl?: ConnectivityFetch;
  readonly getKey?: () => Promise<string>;
  readonly registerLocalModel?: (slug: string) => boolean;
  readonly markSessionRegistered?: (slug: string) => void;
  readonly maxTestsPerSession?: number;
}) {
  return createVerifyAndRegisterLocalModelPort({
    wireFormat: 'openai-compat',
    baseUrl: 'https://gateway.test',
    fetchImpl: overrides.fetchImpl ?? (async () => ({ ok: true, status: 200, text: async () => '' })),
    getKey: overrides.getKey ?? (async () => 'sk-test'),
    registerLocalModel: overrides.registerLocalModel ?? (() => true),
    markSessionRegistered: overrides.markSessionRegistered ?? (() => {}),
    ...(overrides.maxTestsPerSession !== undefined
      ? { maxTestsPerSession: overrides.maxTestsPerSession }
      : {}),
  });
}

describe('D4/COND-S4 — texto de sucesso', () => {
  it('ok + registrado no config ⇒ nota SEM "(registrado nesta sessão)"', async () => {
    const { fetchImpl } = countingFetch({ okSlugs: ['vendor/model-x'] });
    const port = basePort({ fetchImpl, registerLocalModel: () => true });
    const r = await port('vendor/model-x');
    expect(r).toEqual({
      ok: true,
      detail: 'modelo "vendor/model-x" respondeu — registrado no catálogo do provider local.',
      registered: true,
    });
  });

  it('ok + provider BUILT-IN sem entrada (registerLocalModel devolve false) ⇒ nota COM "(registrado nesta sessão)"', async () => {
    const { fetchImpl } = countingFetch({ okSlugs: ['m'] });
    const port = basePort({ fetchImpl, registerLocalModel: () => false });
    const r = await port('m');
    expect(r.ok).toBe(true);
    expect(r.registered).toBe(false);
    expect(r.detail).toBe(
      'modelo "m" respondeu — registrado no catálogo do provider local (registrado nesta sessão).',
    );
  });

  it('ok ⇒ markSessionRegistered É chamado com o slug (união em listNames())', async () => {
    const { fetchImpl } = countingFetch({ okSlugs: ['m'] });
    const marked: string[] = [];
    const port = basePort({ fetchImpl, markSessionRegistered: (s) => marked.push(s) });
    await port('m');
    expect(marked).toEqual(['m']);
  });

  it('!ok ⇒ registerLocalModel/markSessionRegistered NUNCA chamados (só slug testado E ok registra)', async () => {
    const { fetchImpl } = countingFetch({ okSlugs: [] });
    let registerCalls = 0;
    const marked: string[] = [];
    const port = basePort({
      fetchImpl,
      registerLocalModel: () => {
        registerCalls += 1;
        return true;
      },
      markSessionRegistered: (s) => marked.push(s),
    });
    const r = await port('m-ruim');
    expect(r.ok).toBe(false);
    expect(registerCalls).toBe(0);
    expect(marked).toEqual([]);
  });
});

describe('TESTE DE SEGURANÇA 6 — memoização: N chamadas do MESMO slug ⇒ exatamente 1 checkModelConnectivity', () => {
  it('5 chamadas concorrentes do mesmo slug desconhecido ⇒ 1 request de rede só', async () => {
    const { fetchImpl, calls } = countingFetch({ okSlugs: ['vendor/model-x'] });
    const port = basePort({ fetchImpl });
    const results = await Promise.all([
      port('vendor/model-x'),
      port('vendor/model-x'),
      port('vendor/model-x'),
      port('vendor/model-x'),
      port('vendor/model-x'),
    ]);
    expect(calls).toEqual(['vendor/model-x']); // 1 SÓ request
    for (const r of results) {
      expect(r).toEqual(results[0]); // MESMA promise resolvida — resultado idêntico
    }
  });

  it('chamadas SEQUENCIAIS do mesmo slug (após o 1º resolver) ⇒ idem, 1 request só (memoização persiste)', async () => {
    const { fetchImpl, calls } = countingFetch({ okSlugs: ['m'] });
    const port = basePort({ fetchImpl });
    await port('m');
    await port('m');
    await port('m');
    expect(calls).toEqual(['m']);
  });

  it('slugs DISTINTOS ⇒ 1 request POR slug (a memoização é POR slug, não global)', async () => {
    const { fetchImpl, calls } = countingFetch({ okSlugs: ['a', 'b'] });
    const port = basePort({ fetchImpl });
    await Promise.all([port('a'), port('b'), port('a'), port('b')]);
    expect(calls.sort()).toEqual(['a', 'b']);
  });

  it('COND-S7 — uma REJEIÇÃO (ok:false) TAMBÉM fica memoizada (blip transitório não re-testa)', async () => {
    const { fetchImpl, calls } = countingFetch({ okSlugs: [] }); // nunca ok
    const port = basePort({ fetchImpl });
    const r1 = await port('slug-ruim');
    const r2 = await port('slug-ruim');
    expect(calls).toEqual(['slug-ruim']); // 1 SÓ tentativa, mesmo com !ok
    expect(r1).toEqual(r2);
    expect(r1.ok).toBe(false);
  });
});

describe('TESTE DE SEGURANÇA 7 — teto de sessão: o (N+1)-ésimo slug distinto ⇒ erro SEM ping', () => {
  it('teto=3: os 3 primeiros slugs testam; o 4º (novo) falha SEM chamar fetchImpl', async () => {
    const { fetchImpl, calls } = countingFetch({ okSlugs: ['a', 'b', 'c', 'd'] });
    const port = basePort({ fetchImpl, maxTestsPerSession: 3 });
    const ra = await port('a');
    const rb = await port('b');
    const rc = await port('c');
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(rc.ok).toBe(true);
    expect(calls).toEqual(['a', 'b', 'c']);

    const rd = await port('d'); // 4º slug DISTINTO — acima do teto de 3.
    expect(rd.ok).toBe(false);
    expect(rd.registered).toBe(false);
    expect(rd.detail).toMatch(/teto de verificações da sessão/);
    expect(rd.detail).toMatch(/"d"/);
    expect(calls).toEqual(['a', 'b', 'c']); // SEM ping — 'd' nunca chegou ao fetchImpl

    // o teto NÃO afrouxa: chamar 'd' de novo (ou um 5º slug) continua falhando sem ping.
    const rd2 = await port('d');
    expect(rd2.ok).toBe(false);
    const re = await port('e');
    expect(re.ok).toBe(false);
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('default do teto é MAX_LOCAL_MODEL_TESTS_PER_SESSION = 64', () => {
    expect(MAX_LOCAL_MODEL_TESTS_PER_SESSION).toBe(64);
  });

  it('slugs JÁ testados (memoizados) NÃO contam contra o teto — só re-servem o cache', async () => {
    const { fetchImpl, calls } = countingFetch({ okSlugs: ['a'] });
    const port = basePort({ fetchImpl, maxTestsPerSession: 1 });
    await port('a'); // usa a única vaga do teto
    await port('a'); // memoizado — não conta de novo
    await port('a');
    expect(calls).toEqual(['a']);
    const rb = await port('b'); // 2º slug DISTINTO — teto=1 já ocupado por 'a'.
    expect(rb.ok).toBe(false);
    expect(rb.detail).toMatch(/teto de verificações da sessão/);
  });
});

describe('TESTE DE SEGURANÇA 9 — fail-closed: throw (rede/credencial) NUNCA escapa, vira {ok:false}', () => {
  it('getKey lança (ex.: MissingLocalCredentialError) ⇒ {ok:false}, mensagem SEM interpolar a exceção', async () => {
    const port = basePort({
      getKey: async () => {
        throw new Error('backend local: sem credencial apikey p/ "openai". configure ANTHROPIC_API_KEY=...');
      },
    });
    const r = await port('m');
    expect(r.ok).toBe(false);
    expect(r.registered).toBe(false);
    // texto FIXO — NUNCA a mensagem da exceção (poderia citar env vars/hints do provider).
    expect(r.detail).toBe(
      'modelo local "m" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).',
    );
    expect(r.detail).not.toMatch(/ANTHROPIC_API_KEY/);
    expect(r.detail).not.toMatch(/credencial/);
  });

  it('fetchImpl lança (timeout/anti-SSRF) ⇒ {ok:false}, mensagem FIXA sem e.message', async () => {
    const port = basePort({
      fetchImpl: async () => {
        throw new Error('backend local: redirect (302 → http://169.254.169.254/) BLOQUEADO (PROV-SEC-1)');
      },
    });
    const r = await port('m');
    expect(r.ok).toBe(false);
    expect(r.detail).toBe(
      'modelo local "m" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).',
    );
    expect(r.detail).not.toMatch(/169\.254/);
  });

  it('o throw NUNCA escapa da porta — a Promise resolve, nunca rejeita', async () => {
    const port = basePort({
      getKey: async () => {
        throw new Error('boom');
      },
    });
    await expect(port('m')).resolves.toMatchObject({ ok: false });
  });
});

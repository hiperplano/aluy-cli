import { describe, expect, it } from 'vitest';
import { LoginService } from '../../src/auth/login-service.js';
import {
  InvalidPatError,
  RefreshUnavailableError,
  SessionExpiredError,
} from '../../src/auth/errors.js';
import { InMemoryStore, makeMockFetch } from './helpers.js';
import type { FetchLike } from '../../src/auth/identity-client.js';

const BASE = 'https://id.test/api/v1';
const HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const PAT = `pat_${HEX}_supersecretvalue`;

function svc(fetch: FetchLike, store: InMemoryStore, now = () => 1_000_000) {
  // HUNT-IO-NET: injeta um sleep INSTANTÂNEO (determinístico, sem timer real). Antes
  // o device-flow usava o sleep real e o teste dependia da fragilidade `interval:0` =
  // sleep(0); com o piso anti-hot-loop, isso esperaria segundos de relógio real.
  return new LoginService(
    { baseUrl: BASE, clientId: 'aluy-cli', fetch, store },
    { now, sleep: async () => {} },
  );
}

const TOKENS = (over: Partial<Record<string, unknown>> = {}) => ({
  access_token: 'acc',
  refresh_token: 'ref',
  token_type: 'Bearer',
  expires_in: 900,
  scope: 'assistant:session llm:call',
  organization_id: 'org-1',
  ...over,
});

describe('LoginService — device-flow (CA-1)', () => {
  it('guarda a credencial e devolve forma REDIGIDA (sem segredo)', async () => {
    const { fetch } = makeMockFetch({
      '/api/v1/identity/device/authorize': {
        status: 200,
        body: {
          device_code: 'dc',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
          expires_in: 600,
          interval: 5, // sleep é instantâneo via deps.sleep injetado (não real)
        },
      },
      '/api/v1/identity/token': { status: 200, body: TOKENS() },
    });
    const store = new InMemoryStore();
    const red = await svc(fetch, store).loginWithDeviceFlow({
      organizationId: 'org-1',
      onPrompt: () => {},
    });
    // Redigido: nenhum campo de segredo.
    expect(red).not.toHaveProperty('access_token');
    expect(red).not.toHaveProperty('refresh_token');
    expect(red.kind).toBe('device');
    expect(red.scopes).toEqual(['assistant:session', 'llm:call']);
    // No keychain (store), sim, o segredo está — mas redigido p/ fora.
    const stored = await store.get();
    expect(stored?.access_token).toBe('acc');
    expect(stored?.expires_at).toBe(1_000_000 + 900_000);
  });
});

describe('LoginService — PAT (CA-2)', () => {
  it('PAT válido ⇒ guarda no store como kind=pat', async () => {
    const { fetch } = makeMockFetch({});
    const store = new InMemoryStore();
    const red = await svc(fetch, store).loginWithPat(PAT, 'org-9');
    expect(red.kind).toBe('pat');
    expect(red.organization_id).toBe('org-9');
    const stored = await store.get();
    expect(stored?.pat).toBe(PAT);
  });

  it('PAT com formato inválido ⇒ InvalidPatError e NADA gravado', async () => {
    const { fetch } = makeMockFetch({});
    const store = new InMemoryStore();
    await expect(svc(fetch, store).loginWithPat('lixo', 'org-9')).rejects.toBeInstanceOf(
      InvalidPatError,
    );
    expect(await store.get()).toBeNull();
  });

  it('a mensagem de InvalidPatError NÃO ecoa o token', () => {
    const e = new InvalidPatError();
    expect(e.message).not.toContain('lixo');
    expect(e.message).toContain('pat_<id>_<segredo>');
  });
});

describe('LoginService — refresh rotativo (CLI-SEC-1)', () => {
  it('access expirado ⇒ refresca e GUARDA o novo par (rotação)', async () => {
    const { fetch, calls } = makeMockFetch({
      '/api/v1/identity/headless/refresh': {
        status: 200,
        body: TOKENS({ access_token: 'acc2', refresh_token: 'ref2' }),
      },
    });
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'acc1',
      refresh_token: 'ref1',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 0, // já expirado
      v: 1,
    });
    const token = await svc(fetch, store).getAccessToken();
    expect(token).toBe('acc2');
    // O par anterior foi substituído (rotação).
    const stored = await store.get();
    expect(stored?.refresh_token).toBe('ref2');
    expect(calls[0]?.body).toMatchObject({ refresh_token: 'ref1' });
  });

  it('access ainda válido ⇒ NÃO chama refresh', async () => {
    const { fetch, calls } = makeMockFetch({});
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'accValid',
      refresh_token: 'ref1',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 9_999_999_999,
      v: 1,
    });
    const token = await svc(fetch, store).getAccessToken();
    expect(token).toBe('accValid');
    expect(calls).toHaveLength(0);
  });

  it('refresh rejeitado (reuse/revogado) ⇒ limpa store e SessionExpiredError', async () => {
    const { fetch } = makeMockFetch({
      '/api/v1/identity/headless/refresh': { status: 401, body: {} },
    });
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'acc1',
      refresh_token: 'reused',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 0,
      v: 1,
    });
    await expect(svc(fetch, store).getAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
    expect(await store.get()).toBeNull();
  });

  // HUNT-AUTH-HONESTY — o blip TRANSITÓRIO (identity 5xx) NÃO pode apagar a credencial.
  it('refresh com identity 5xx (transitório) ⇒ PRESERVA a credencial e RefreshUnavailableError', async () => {
    const { fetch } = makeMockFetch({
      '/api/v1/identity/headless/refresh': { status: 503, body: {} },
    });
    const store = new InMemoryStore();
    const cred = {
      kind: 'device' as const,
      access_token: 'acc1',
      refresh_token: 'still-valid',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 0,
      v: 1 as const,
    };
    await store.set(cred);
    await expect(svc(fetch, store).getAccessToken()).rejects.toBeInstanceOf(
      RefreshUnavailableError,
    );
    // O ponto: a credencial CONTINUA no keychain (um blip não derruba a sessão).
    expect(await store.get()).toMatchObject({ refresh_token: 'still-valid' });
  });

  // ...e um erro de REDE (o doFetch lança CRU, não um IdentityHttpError) também preserva.
  it('refresh com erro de REDE (fetch lança) ⇒ PRESERVA a credencial e RefreshUnavailableError', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('fetch failed: ECONNREFUSED');
    };
    const store = new InMemoryStore();
    const cred = {
      kind: 'device' as const,
      access_token: 'acc1',
      refresh_token: 'still-valid',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 0,
      v: 1 as const,
    };
    await store.set(cred);
    await expect(svc(fetch, store).getAccessToken()).rejects.toBeInstanceOf(
      RefreshUnavailableError,
    );
    expect(await store.get()).toMatchObject({ refresh_token: 'still-valid' });
  });

  it('PAT ⇒ getAccessToken devolve o próprio PAT (sem refresh)', async () => {
    const { fetch, calls } = makeMockFetch({});
    const store = new InMemoryStore();
    await svc(fetch, store).loginWithPat(PAT, 'org-1');
    const token = await svc(fetch, store).getAccessToken();
    expect(token).toBe(PAT);
    expect(calls).toHaveLength(0);
  });

  it('sem credencial ⇒ SessionExpiredError', async () => {
    const { fetch } = makeMockFetch({});
    await expect(svc(fetch, new InMemoryStore()).getAccessToken()).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
  });

  it('access expirado SEM refresh_token ⇒ SessionExpiredError IMEDIATO (sem chamar refresh)', async () => {
    const { fetch, calls } = makeMockFetch({});
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'accExpired',
      // refresh_token intencionalmente ausente
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 0, // expirado vs now()=1_000_000
      v: 1,
    });
    await expect(svc(fetch, store).getAccessToken()).rejects.toBeInstanceOf(SessionExpiredError);
    // Nenhuma chamada de rede — refresh NÃO foi invocado.
    expect(calls).toHaveLength(0);
  });
});

// EST-0940 (hunt login) — `ALUY_TOKEN` no ambiente sem `aluy login` no keychain.
// O boot (`isLoggedOut`) trata `ALUY_TOKEN` presente como "logado" e NÃO avisa; mas
// `getAccessToken` só lia o keychain ⇒ a 1ª chamada ao broker estourava
// `SessionExpiredError` ("sessão expirou — rode aluy login") — enganoso: não há
// sessão expirada e o usuário FORNECEU o token pelo caminho documentado. O fallback
// `envToken` consome o `ALUY_TOKEN` quando o keychain está vazio.
describe('LoginService — fallback ALUY_TOKEN do ambiente (EST-0940 hunt login)', () => {
  function svcEnv(store: InMemoryStore, envToken: () => string | undefined): LoginService {
    const { fetch } = makeMockFetch({});
    return new LoginService(
      { baseUrl: BASE, clientId: 'aluy-cli', fetch, store },
      { now: () => 1_000_000, sleep: async () => {}, envToken },
    );
  }

  it('keychain VAZIO + ALUY_TOKEN PAT válido ⇒ getAccessToken devolve o PAT do env (sem rede, sem SessionExpiredError)', async () => {
    // SEM o fix: keychain vazio ⇒ SessionExpiredError, ignorando o ALUY_TOKEN.
    const token = await svcEnv(new InMemoryStore(), () => PAT).getAccessToken();
    expect(token).toBe(PAT);
  });

  it('keychain VAZIO + ALUY_TOKEN de FORMATO inválido ⇒ SessionExpiredError (não vira Bearer lixo num 401 genérico)', async () => {
    await expect(
      svcEnv(new InMemoryStore(), () => 'lixo-sem-formato-pat').getAccessToken(),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('keychain VAZIO + ALUY_TOKEN vazio/whitespace ⇒ SessionExpiredError', async () => {
    await expect(svcEnv(new InMemoryStore(), () => '   ').getAccessToken()).rejects.toBeInstanceOf(
      SessionExpiredError,
    );
    await expect(
      svcEnv(new InMemoryStore(), () => undefined).getAccessToken(),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('credencial NO KEYCHAIN tem PRECEDÊNCIA sobre o ALUY_TOKEN do env', async () => {
    const store = new InMemoryStore();
    await store.set({
      kind: 'pat',
      pat: 'pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_doKeychain',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      v: 1,
    });
    const token = await svcEnv(store, () => PAT).getAccessToken();
    expect(token).toBe('pat_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_doKeychain');
    expect(token).not.toBe(PAT);
  });

  it('sem envToken injetado (comportamento antigo) ⇒ keychain vazio segue SessionExpiredError', async () => {
    const { fetch } = makeMockFetch({});
    await expect(
      new LoginService(
        { baseUrl: BASE, clientId: 'aluy-cli', fetch, store: new InMemoryStore() },
        { now: () => 1_000_000, sleep: async () => {} },
      ).getAccessToken(),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });
});

describe('LoginService — refresh SINGLE-FLIGHT concorrente (CLI-SEC-1)', () => {
  // O refresh é ROTATIVO: o 1º sucesso invalida o refresh_token e a reutilização
  // dispara reuse-detection no identity. A fila do mock reproduz isso: 1ª resposta
  // OK (rotaciona ref1→ref2), 2ª resposta 401 (reuse). SEM single-flight, duas
  // chamadas concorrentes de getAccessToken disparariam 2 refresh com o MESMO
  // ref1 ⇒ a 2ª bate 401 ⇒ store.clear() APAGA a credencial recém-rotacionada e
  // a sessão morre (re-login espúrio). É o cenário de sub-agentes paralelos /
  // boot carregando catálogo+quota+modelos em paralelo.
  function expiredDeviceStore(): InMemoryStore {
    const store = new InMemoryStore();
    void store.set({
      kind: 'device',
      access_token: 'old',
      refresh_token: 'ref1',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 0, // expirado vs now()=1_000_000
      v: 1,
    });
    return store;
  }

  it('N chamadas concorrentes em token expirado ⇒ UM refresh, todas recebem o novo token', async () => {
    const { fetch, calls } = makeMockFetch({
      '/api/v1/identity/headless/refresh': [
        { status: 200, body: TOKENS({ access_token: 'acc2', refresh_token: 'ref2' }) },
        // Se o single-flight falhasse, esta 2ª resposta (reuse 401) seria consumida.
        { status: 401, body: {} },
      ],
    });
    const store = expiredDeviceStore();
    const service = svc(fetch, store);

    const tokens = await Promise.all([
      service.getAccessToken(),
      service.getAccessToken(),
      service.getAccessToken(),
    ]);

    // Todas as concorrentes recebem o MESMO token rotacionado — nenhuma falhou.
    expect(tokens).toEqual(['acc2', 'acc2', 'acc2']);
    // UMA só chamada de rede de refresh (coalescido).
    const refreshCalls = calls.filter((c) => c.url.endsWith('/identity/headless/refresh'));
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.body).toMatchObject({ refresh_token: 'ref1' });
    // A credencial rotacionada PERMANECE no store (não foi apagada por reuse-detection).
    const stored = await store.get();
    expect(stored?.refresh_token).toBe('ref2');
    expect(stored?.access_token).toBe('acc2');
  });

  it('após a corrida terminar, um novo ciclo de expiração refresca de novo (slot liberado)', async () => {
    const { fetch, calls } = makeMockFetch({
      '/api/v1/identity/headless/refresh': [
        {
          status: 200,
          body: TOKENS({ access_token: 'acc2', refresh_token: 'ref2', expires_in: 0 }),
        },
        { status: 200, body: TOKENS({ access_token: 'acc3', refresh_token: 'ref3' }) },
      ],
    });
    const store = expiredDeviceStore();
    const service = svc(fetch, store);

    // 1ª corrida ⇒ acc2 (mas expires_in:0 ⇒ continua expirado).
    await Promise.all([service.getAccessToken(), service.getAccessToken()]);
    // 2ª chamada SEQUENCIAL ⇒ slot já liberado ⇒ novo refresh com ref2.
    const t2 = await service.getAccessToken();
    expect(t2).toBe('acc3');
    const refreshCalls = calls.filter((c) => c.url.endsWith('/identity/headless/refresh'));
    expect(refreshCalls).toHaveLength(2);
    expect(refreshCalls[1]?.body).toMatchObject({ refresh_token: 'ref2' });
  });

  it('refresh concorrente que FALHA ⇒ todas as concorrentes recebem SessionExpiredError SEM vazar token', async () => {
    const { fetch } = makeMockFetch({
      '/api/v1/identity/headless/refresh': { status: 401, body: {} },
    });
    const store = expiredDeviceStore();
    const service = svc(fetch, store);

    const results = await Promise.allSettled([service.getAccessToken(), service.getAccessToken()]);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect(r.reason).toBeInstanceOf(SessionExpiredError);
        // Mensagem acionável, sem ecoar nenhum segredo (CLI-SEC-7).
        expect((r.reason as Error).message).not.toContain('ref1');
        expect((r.reason as Error).message.toLowerCase()).toContain('login');
      }
    }
    // Store limpo (uma única vez é suficiente) — força re-login.
    expect(await store.get()).toBeNull();
  });
});

describe('LoginService — logout (CA-5)', () => {
  it('device ⇒ revoga no identity E apaga do store', async () => {
    const { fetch, calls } = makeMockFetch({
      '/api/v1/identity/headless/revoke': { status: 204 },
    });
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'acc',
      refresh_token: 'ref',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 9_999_999_999,
      v: 1,
    });
    const r = await svc(fetch, store).logout();
    expect(r.revoked).toBe(true);
    expect(await store.get()).toBeNull();
    expect(calls[0]?.url).toContain('/headless/revoke');
    expect(calls[0]?.body).toMatchObject({ refresh_token: 'ref' });
  });

  it('revoke falha (offline) ⇒ ainda assim apaga local (revoked=false)', async () => {
    const failFetch: FetchLike = async () => {
      throw new Error('network down');
    };
    const store = new InMemoryStore();
    await store.set({
      kind: 'device',
      access_token: 'acc',
      refresh_token: 'ref',
      organization_id: 'org-1',
      scopes: ['llm:call'],
      expires_at: 9_999_999_999,
      v: 1,
    });
    const r = await svc(failFetch, store).logout();
    expect(r.revoked).toBe(false);
    expect(await store.get()).toBeNull();
  });

  it('PAT ⇒ apaga local, sem chamar revoke (revogação é via web)', async () => {
    const { fetch, calls } = makeMockFetch({});
    const store = new InMemoryStore();
    await svc(fetch, store).loginWithPat(PAT, 'org-1');
    const r = await svc(fetch, store).logout();
    expect(r.revoked).toBe(false);
    expect(await store.get()).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('sem credencial ⇒ no-op (revoked=false)', async () => {
    const { fetch } = makeMockFetch({});
    const r = await svc(fetch, new InMemoryStore()).logout();
    expect(r.revoked).toBe(false);
  });
});

describe('LoginService — whoami', () => {
  it('sem login ⇒ null', async () => {
    const { fetch } = makeMockFetch({});
    expect(await svc(fetch, new InMemoryStore()).whoami()).toBeNull();
  });
  it('com login ⇒ forma redigida (sem segredo)', async () => {
    const { fetch } = makeMockFetch({});
    const store = new InMemoryStore();
    await svc(fetch, store).loginWithPat(PAT, 'org-1');
    const w = await svc(fetch, store).whoami();
    expect(w?.token_hint).toBe('pat_…');
    expect(JSON.stringify(w)).not.toContain('supersecretvalue');
  });
});

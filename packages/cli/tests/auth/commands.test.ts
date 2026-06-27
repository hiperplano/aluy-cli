import { describe, expect, it } from 'vitest';
import { runLogin } from '../../src/commands/login.js';
import { runLogout } from '../../src/commands/logout.js';
import { runWhoami } from '../../src/commands/whoami.js';
import { FakeIO, InMemoryStore, makeMockFetch } from './helpers.js';
import type { CredentialStore, StoredCredential } from '@aluy/cli-core';

const HEX = 'deadbeefdeadbeefdeadbeefdeadbeef';
const PAT = `pat_${HEX}_TOPSECRETvalue`;
const ORG = '11111111-1111-1111-1111-111111111111';

/** Monta um access JWT com `sub` (assinatura fake — display-only, não verificada). */
function makeAccessJwt(sub: string): string {
  const b64url = (obj: unknown): string =>
    Buffer.from(JSON.stringify(obj), 'utf8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url({ sub })}.SIG-SECRET-NOT-SHOWN`;
}

const AUTHORIZE = {
  status: 200,
  body: {
    device_code: 'dc',
    user_code: 'WXYZ-1234',
    verification_uri: 'https://app.test/device',
    verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
    expires_in: 600,
    interval: 0,
  },
};
const DEVICE_TOKENS = {
  status: 200,
  body: {
    access_token: 'DEVICE-ACCESS-SECRET',
    refresh_token: 'DEVICE-REFRESH-SECRET',
    token_type: 'Bearer',
    expires_in: 900,
    scope: 'assistant:session llm:call',
    organization_id: ORG,
  },
};

/** Store que LANÇA — p/ cobrir o ramo de erro genérico dos comandos. */
class ThrowingStore implements CredentialStore {
  async get(): Promise<StoredCredential | null> {
    throw new Error('keychain explodiu');
  }
  async set(): Promise<void> {
    throw new Error('keychain explodiu');
  }
  async clear(): Promise<void> {
    throw new Error('keychain explodiu');
  }
}

describe('runLogin — PAT (CA-2)', () => {
  // EST-1015 — o login agora VALIDA o PAT na rede (GET /v1/quota) antes de gravar; os testes
  // de sucesso injetam um fetch que responde 200 (PAT bom). Sem isso o código tentaria a rede.
  const okQuota = () => makeMockFetch({ '/v1/quota': { status: 200, body: {} } });

  it('--token + --org ⇒ guarda no store e imprime resumo SEM segredo', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const code = await runLogin({ token: PAT, org: ORG }, { io, store, env: {}, fetch: okQuota() });
    expect(code).toBe(0);
    expect(store.cred?.kind).toBe('pat');
    expect(store.cred?.pat).toBe(PAT);
    // O segredo NUNCA aparece no output.
    expect(io.allText()).not.toContain('TOPSECRETvalue');
    expect(io.outLines.join('\n')).toContain('login concluído');
  });

  it('PAT via env ALUY_TOKEN (caminho CI)', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const code = await runLogin(
      {},
      { io, store, env: { ALUY_TOKEN: PAT, ALUY_ORG: ORG }, fetch: okQuota() },
    );
    expect(code).toBe(0);
    expect(store.cred?.kind).toBe('pat');
  });

  // EST-1015 (decisão do dono) — PAT formato-válido mas com AUTENTICAÇÃO recusada pelo broker
  // (401) ⇒ NÃO grava + erro claro. Mata a confusão "logou mas não funciona" (token errado/
  // expirado).
  it('PAT recusado pelo broker (401) ⇒ exit 1, NADA gravado, erro claro', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const fetch = makeMockFetch({ '/v1/quota': { status: 401, body: {} } });
    const code = await runLogin({ token: PAT, org: ORG }, { io, store, env: {}, fetch });
    expect(code).toBe(1);
    expect(store.cred).toBeNull(); // NÃO sobrescreveu a credencial existente
    expect(io.errLines.join('\n')).toMatch(/recusado|inválido|expirado/i);
    expect(io.allText()).not.toContain('TOPSECRETvalue'); // nunca ecoa o token
  });

  // EST-1015 (BUG-FIX pós-#364) — 403 em /v1/quota = AUTENTICOU mas sem o escopo `quota:read`
  // (que é OPT-IN). Um PAT normal de chat recebe 403 aqui — e ANTES era rejeitado por engano,
  // BLOQUEANDO login válido (o dono ficou preso). Agora 403 ⇒ token VÁLIDO ⇒ GRAVA, sem aviso.
  it('PAT com 403 em /v1/quota (sem quota:read, opt-in) ⇒ GRAVA (token válido), exit 0', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const fetch = makeMockFetch({ '/v1/quota': { status: 403, body: {} } });
    const code = await runLogin({ token: PAT, org: ORG }, { io, store, env: {}, fetch });
    expect(code).toBe(0);
    expect(store.cred?.kind).toBe('pat'); // PAT válido ⇒ gravado
    // NÃO é o caminho "unverified" (broker fora): 403 é validação POSITIVA, sem aviso de falha.
    expect(io.errLines.join('\n')).not.toMatch(/não consegui validar|broker fora/i);
  });

  it('broker fora (erro de rede) ⇒ grava com AVISO (não bloqueia offline)', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as Parameters<typeof runLogin>[1]['fetch'];
    const code = await runLogin({ token: PAT, org: ORG }, { io, store, env: {}, fetch });
    expect(code).toBe(0);
    expect(store.cred?.kind).toBe('pat'); // gravou mesmo assim (degrada)
    expect(io.errLines.join('\n')).toMatch(/não consegui validar|broker fora/i);
  });

  it('--token sem org ⇒ erro claro, exit 1, nada gravado', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const code = await runLogin({ token: PAT }, { io, store, env: {} });
    expect(code).toBe(1);
    expect(store.cred).toBeNull();
    expect(io.errLines.join('\n')).toContain('--org');
  });

  it('PAT inválido ⇒ exit 1 e mensagem NÃO ecoa o token', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const code = await runLogin({ token: 'lixo-token', org: ORG }, { io, store, env: {} });
    expect(code).toBe(1);
    expect(store.cred).toBeNull();
    expect(io.allText()).not.toContain('lixo-token');
  });
});

describe('runWhoami (CA-1) — sem vazar segredo', () => {
  it('sem login ⇒ exit 1', async () => {
    const io = new FakeIO();
    const code = await runWhoami({ io, store: new InMemoryStore(), env: {} });
    expect(code).toBe(1);
    expect(io.outLines.join('\n')).toContain('não autenticado');
  });

  it('com login ⇒ mostra org/escopos/tipo, token redigido, SEM segredo', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    await runLogin({ token: PAT, org: ORG }, { io, store, env: {} });
    const io2 = new FakeIO();
    const code = await runWhoami({ io: io2, store, env: {} });
    expect(code).toBe(0);
    const text = io2.outLines.join('\n');
    expect(text).toContain(ORG);
    expect(text).toContain('redigido');
    expect(io2.allText()).not.toContain('TOPSECRETvalue');
  });

  it('device-flow ⇒ mostra o user a partir do `sub` do access JWT (CA-1)', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    store.cred = {
      kind: 'device',
      access_token: makeAccessJwt('user_device_007'),
      refresh_token: 'DEVICE-REFRESH-SECRET',
      organization_id: ORG,
      scopes: ['assistant:session', 'llm:call'],
      expires_at: 9_999_999_999_999,
      v: 1,
    };
    const code = await runWhoami({ io, store, env: {} });
    expect(code).toBe(0);
    const text = io.outLines.join('\n');
    expect(text).toContain('user:');
    expect(text).toContain('user_device_007');
    // O JWT inteiro e sua assinatura NUNCA aparecem.
    expect(io.allText()).not.toContain('SIG-SECRET-NOT-SHOWN');
    expect(io.allText()).not.toContain('DEVICE-REFRESH-SECRET');
  });

  it('PAT ⇒ mostra user "—" com a nota (user_id não conhecido localmente)', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    await runLogin({ token: PAT, org: ORG }, { io, store, env: {} });
    const io2 = new FakeIO();
    const code = await runWhoami({ io: io2, store, env: {} });
    expect(code).toBe(0);
    const text = io2.outLines.join('\n');
    expect(text).toContain('user:    —');
    expect(text).toContain('aluy login');
    expect(io2.allText()).not.toContain('TOPSECRETvalue');
  });
});

describe('runLogout (CA-5)', () => {
  it('PAT ⇒ apaga do store, exit 0', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    await runLogin({ token: PAT, org: ORG }, { io, store, env: {} });
    const io2 = new FakeIO();
    const code = await runLogout({ io: io2, store, env: {} });
    expect(code).toBe(0);
    expect(store.cred).toBeNull();
    // Uso subsequente (whoami) falha.
    const io3 = new FakeIO();
    expect(await runWhoami({ io: io3, store, env: {} })).toBe(1);
  });

  it('sem credencial ⇒ informa e exit 0', async () => {
    const io = new FakeIO();
    const code = await runLogout({ io, store: new InMemoryStore(), env: {} });
    expect(code).toBe(0);
    expect(io.outLines.join('\n')).toContain('nada a fazer');
  });
});

// CA-3 — a varredura forte de "credencial nunca em claro". Roda o fluxo
// completo (login PAT → whoami → logout) e garante que o segredo NUNCA tocou
// nenhuma saída de terminal (proxy de log/telemetria). O store em memória prova
// que o único lugar com o segredo é o "keychain" (store) — nunca o I/O.
describe('CLI-SEC-2 — credencial nunca em claro fora do keychain (CA-3)', () => {
  it('nenhuma saída de terminal contém o segredo em todo o fluxo', async () => {
    const store = new InMemoryStore();
    const ioLogin = new FakeIO();
    const ioWho = new FakeIO();
    const ioOut = new FakeIO();
    await runLogin({ token: PAT, org: ORG }, { io: ioLogin, store, env: {} });
    await runWhoami({ io: ioWho, store, env: {} });
    await runLogout({ io: ioOut, store, env: {} });

    const allOutput = [ioLogin.allText(), ioWho.allText(), ioOut.allText()].join('\n');
    expect(allOutput).not.toContain('TOPSECRETvalue');
    // O PAT inteiro também não pode aparecer.
    expect(allOutput).not.toContain(PAT);
  });
});

describe('runLogin — device-flow (CA-1, via fetch injetado)', () => {
  it('mostra user_code+URL, guarda tokens no store e NÃO vaza segredo', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const fetch = makeMockFetch({
      '/api/v1/identity/device/authorize': AUTHORIZE,
      '/api/v1/identity/token': [
        { status: 400, body: { error: 'authorization_pending' } },
        DEVICE_TOKENS,
      ],
    });
    // HUNT-IO-NET: sleep instantâneo (o piso anti-hot-loop tornaria o sleep REAL).
    const code = await runLogin({ org: ORG }, { io, store, env: {}, fetch, sleep: async () => {} });
    expect(code).toBe(0);
    // O store (keychain) tem o segredo; o terminal, NÃO.
    expect(store.cred?.kind).toBe('device');
    expect(store.cred?.access_token).toBe('DEVICE-ACCESS-SECRET');
    const text = io.allText();
    expect(text).toContain('WXYZ-1234'); // user_code é público
    expect(text).toContain('https://app.test/device');
    expect(text).not.toContain('DEVICE-ACCESS-SECRET');
    expect(text).not.toContain('DEVICE-REFRESH-SECRET');
  });

  it('device-flow sem org ⇒ erro e exit 1', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const code = await runLogin({}, { io, store, env: {} });
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('--org');
  });

  it('access_denied no polling ⇒ exit 1, nada gravado', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const fetch = makeMockFetch({
      '/api/v1/identity/device/authorize': AUTHORIZE,
      '/api/v1/identity/token': { status: 400, body: { error: 'access_denied' } },
    });
    const code = await runLogin({ org: ORG }, { io, store, env: {}, fetch, sleep: async () => {} });
    expect(code).toBe(1);
    expect(store.cred).toBeNull();
    expect(io.errLines.join('\n')).toContain('negada');
  });

  it('--device força device-flow mesmo com ALUY_TOKEN no ambiente', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    const fetch = makeMockFetch({
      '/api/v1/identity/device/authorize': AUTHORIZE,
      '/api/v1/identity/token': DEVICE_TOKENS,
    });
    const code = await runLogin(
      { org: ORG, forceDeviceFlow: true },
      { io, store, env: { ALUY_TOKEN: PAT }, fetch, sleep: async () => {} },
    );
    expect(code).toBe(0);
    // Ignorou o PAT do ambiente e fez device-flow.
    expect(store.cred?.kind).toBe('device');
  });
});

describe('runLogout — device revoga no servidor (CA-5)', () => {
  it('chama revoke e apaga; informa revogação', async () => {
    const io = new FakeIO();
    const store = new InMemoryStore();
    store.cred = {
      kind: 'device',
      access_token: 'a',
      refresh_token: 'r',
      organization_id: ORG,
      scopes: ['llm:call'],
      expires_at: 9_999_999_999,
      v: 1,
    };
    const fetch = makeMockFetch({ '/api/v1/identity/headless/revoke': { status: 204 } });
    const code = await runLogout({ io, store, env: {}, fetch });
    expect(code).toBe(0);
    expect(store.cred).toBeNull();
    expect(io.outLines.join('\n')).toContain('revogada no identity');
  });
});

describe('comandos — ramo de erro (store lança)', () => {
  it('login propaga erro como exit 1 sem vazar', async () => {
    const io = new FakeIO();
    const code = await runLogin(
      { token: PAT, org: ORG },
      { io, store: new ThrowingStore(), env: {} },
    );
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('erro');
  });
  it('logout com store que lança ⇒ exit 1', async () => {
    const io = new FakeIO();
    const code = await runLogout({ io, store: new ThrowingStore(), env: {} });
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('erro');
  });
  it('whoami com store que lança ⇒ exit 1', async () => {
    const io = new FakeIO();
    const code = await runWhoami({ io, store: new ThrowingStore(), env: {} });
    expect(code).toBe(1);
    expect(io.errLines.join('\n')).toContain('erro');
  });
});

import { describe, expect, it } from 'vitest';
import { IdentityClient } from '../../src/auth/identity-client.js';
import { IdentityHttpError } from '../../src/auth/errors.js';
import { makeMockFetch } from './helpers.js';

const BASE = 'https://id.test/api/v1';

function client(handlers: Parameters<typeof makeMockFetch>[0]) {
  const { fetch, calls } = makeMockFetch(handlers);
  return {
    client: new IdentityClient({ baseUrl: BASE, clientId: 'aluy-cli', fetch }),
    calls,
  };
}

describe('IdentityClient.deviceAuthorize', () => {
  it('POSTa client_id+org+scopes e devolve a resposta RFC 8628', async () => {
    const { client: c, calls } = client({
      '/api/v1/identity/device/authorize': {
        status: 200,
        body: {
          device_code: 'dc',
          user_code: 'WXYZ-1234',
          verification_uri: 'https://app.test/device',
          verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
          expires_in: 600,
          interval: 5,
        },
      },
    });
    const res = await c.deviceAuthorize({
      organizationId: 'org-1',
      scopes: ['assistant:session', 'llm:call'],
    });
    expect(res.user_code).toBe('WXYZ-1234');
    expect(res.interval).toBe(5);
    expect(calls[0]?.body).toMatchObject({
      client_id: 'aluy-cli',
      organization_id: 'org-1',
      scopes: ['assistant:session', 'llm:call'],
    });
  });

  it('status != 2xx ⇒ IdentityHttpError', async () => {
    const { client: c } = client({
      '/api/v1/identity/device/authorize': { status: 422, body: { detail: 'x' } },
    });
    await expect(c.deviceAuthorize({ organizationId: 'org-1' })).rejects.toBeInstanceOf(
      IdentityHttpError,
    );
  });
});

describe('IdentityClient.pollToken', () => {
  const ok = {
    status: 200,
    body: {
      access_token: 'acc',
      refresh_token: 'ref',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'assistant:session llm:call',
      organization_id: 'org-1',
    },
  };

  it('200 ⇒ success com tokens', async () => {
    const { client: c } = client({ '/api/v1/identity/token': ok });
    const r = await c.pollToken('dc');
    expect(r.status).toBe('success');
    if (r.status === 'success') expect(r.tokens.access_token).toBe('acc');
  });

  it.each([
    ['authorization_pending', 'pending'],
    ['slow_down', 'slow_down'],
    ['access_denied', 'denied'],
    ['expired_token', 'expired'],
  ])('corpo OAuth-error %s ⇒ %s', async (errorCode, expected) => {
    const { client: c } = client({
      '/api/v1/identity/token': { status: 400, body: { error: errorCode } },
    });
    const r = await c.pollToken('dc');
    expect(r.status).toBe(expected);
  });

  it('erro OAuth desconhecido ⇒ status error com o código', async () => {
    const { client: c } = client({
      '/api/v1/identity/token': {
        status: 400,
        body: { error: 'invalid_grant', error_description: 'no.' },
      },
    });
    const r = await c.pollToken('dc');
    expect(r.status).toBe('error');
    if (r.status === 'error') {
      expect(r.code).toBe('invalid_grant');
      expect(r.description).toBe('no.');
    }
  });
});

describe('IdentityClient.refresh/revoke', () => {
  it('refresh devolve novo par', async () => {
    const { client: c } = client({
      '/api/v1/identity/headless/refresh': {
        status: 200,
        body: {
          access_token: 'a2',
          refresh_token: 'r2',
          token_type: 'Bearer',
          expires_in: 900,
          scope: 'llm:call',
          organization_id: 'org-1',
        },
      },
    });
    const r = await c.refresh('r1');
    expect(r.access_token).toBe('a2');
    expect(r.refresh_token).toBe('r2');
  });

  it('refresh rejeitado (401) ⇒ IdentityHttpError', async () => {
    const { client: c } = client({
      '/api/v1/identity/headless/refresh': { status: 401, body: {} },
    });
    await expect(c.refresh('r1')).rejects.toBeInstanceOf(IdentityHttpError);
  });

  it('revoke 204 ⇒ ok; 404/401 ⇒ tratado como já-revogado (não lança)', async () => {
    const { client: c1 } = client({
      '/api/v1/identity/headless/revoke': { status: 204 },
    });
    await expect(c1.revoke('r1')).resolves.toBeUndefined();

    const { client: c2 } = client({
      '/api/v1/identity/headless/revoke': { status: 404, body: {} },
    });
    await expect(c2.revoke('r1')).resolves.toBeUndefined();
  });

  it('revoke 500 ⇒ IdentityHttpError', async () => {
    const { client: c } = client({
      '/api/v1/identity/headless/revoke': { status: 500, body: {} },
    });
    await expect(c.revoke('r1')).rejects.toBeInstanceOf(IdentityHttpError);
  });
});

// HUNT-IO-NET — boundary: 200/ok com CORPO NÃO-JSON (vazio / HTML de gateway /
// truncado). O `fetch` REAL faz `res.json()` LANÇAR; o cliente fazia `.json()` SEM
// try/catch no caminho de sucesso ⇒ `SyntaxError` CRU escapava (bypassa o contrato
// `IdentityHttpError`; o login estourava com erro técnico e o `getAccessToken` engolia
// e forçava re-login num 200 malformado transitório). O mock antigo nunca rejeitava
// `json()` (`jsonThrows` espelha a realidade — senão o teste mente).
describe('HUNT-IO-NET · IdentityClient corpo 2xx malformado', () => {
  it('deviceAuthorize 200 com corpo não-JSON ⇒ IdentityHttpError (não SyntaxError cru)', async () => {
    const { client: c } = client({
      '/api/v1/identity/device/authorize': { status: 200, jsonThrows: true },
    });
    await expect(c.deviceAuthorize({ organizationId: 'org-1' })).rejects.toBeInstanceOf(
      IdentityHttpError,
    );
    // E NÃO um SyntaxError técnico vazando o stack de parse.
    await expect(c.deviceAuthorize({ organizationId: 'org-1' })).rejects.not.toBeInstanceOf(
      SyntaxError,
    );
  });

  it('pollToken 200 com corpo não-JSON ⇒ IdentityHttpError (não trava o polling com SyntaxError)', async () => {
    const { client: c } = client({
      '/api/v1/identity/token': { status: 200, jsonThrows: true },
    });
    await expect(c.pollToken('dc')).rejects.toBeInstanceOf(IdentityHttpError);
  });

  it('refresh 200 com corpo não-JSON ⇒ IdentityHttpError (não SyntaxError)', async () => {
    const { client: c } = client({
      '/api/v1/identity/headless/refresh': { status: 200, jsonThrows: true },
    });
    await expect(c.refresh('r1')).rejects.toBeInstanceOf(IdentityHttpError);
  });
});

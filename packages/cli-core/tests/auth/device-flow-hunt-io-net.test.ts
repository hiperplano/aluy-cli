// HUNT-IO-NET — boundary do device-flow: `interval`/`expires_in` vêm da REDE e o
// `as DeviceAuthorizeResponse` NÃO os valida. Um corpo malformado (campo ausente,
// `null`, NaN) furava: `interval` indefinido ⇒ `sleep(NaN)` ⇒ `setTimeout(.,0)` ⇒
// POLLING EM LOOP QUENTE (martela o token endpoint); `expires_in` indefinido ⇒
// `deadline = NaN` ⇒ NUNCA expira (polling eterno).
//
// O verde atual NÃO pega: o fixture AUTHORIZE sempre traz `interval:5`/`expires_in:600`.
import { describe, expect, it } from 'vitest';
import { runDeviceFlow } from '../../src/auth/device-flow.js';
import { DeviceCodeExpiredError } from '../../src/auth/errors.js';
import { IdentityClient } from '../../src/auth/identity-client.js';
import { makeMockFetch } from './helpers.js';

const BASE = 'https://id.test/api/v1';
const TOKENS = {
  access_token: 'acc',
  refresh_token: 'ref',
  token_type: 'Bearer',
  expires_in: 900,
  scope: 'llm:call',
  organization_id: 'org-1',
};

function clientFor(
  authorizeBody: Record<string, unknown>,
  tokenResponses: { status: number; body?: unknown }[],
) {
  const { fetch } = makeMockFetch({
    '/api/v1/identity/device/authorize': { status: 200, body: authorizeBody },
    '/api/v1/identity/token': tokenResponses,
  });
  return new IdentityClient({ baseUrl: BASE, clientId: 'aluy-cli', fetch });
}

describe('HUNT-IO-NET · device-flow boundary', () => {
  it('interval AUSENTE no corpo ⇒ NÃO polla em hot-loop: usa o default RFC de 5s', async () => {
    // Sem o fix, `intervalSeconds = undefined` ⇒ sleep(NaN) ⇒ a 1ª espera seria NaN.
    const client = clientFor(
      {
        device_code: 'dc',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://app.test/device',
        verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
        expires_in: 600,
        // interval AUSENTE — o broker/identity malformado o omite (RFC: opcional).
      },
      [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: TOKENS },
      ],
    );
    let t = 0;
    const sleeps: number[] = [];
    const tokens = await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt: () => {} },
      {
        now: () => t,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          t += ms;
        },
      },
    );
    expect(tokens.access_token).toBe('acc');
    // A espera é o default de 5s — NUNCA NaN (que vira setTimeout 0 = hot-loop).
    expect(sleeps[0]).toBe(5000);
    expect(sleeps.every((ms) => Number.isFinite(ms) && ms >= 1000)).toBe(true);
  });

  it('interval=0 (legítimo mas perigoso) ⇒ piso de 1s (sem hot-loop)', async () => {
    const client = clientFor(
      {
        device_code: 'dc',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://app.test/device',
        verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
        expires_in: 600,
        interval: 0,
      },
      [
        { status: 400, body: { error: 'authorization_pending' } },
        { status: 200, body: TOKENS },
      ],
    );
    let t = 0;
    const sleeps: number[] = [];
    await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt: () => {} },
      {
        now: () => t,
        sleep: async (ms: number) => {
          sleeps.push(ms);
          t += ms;
        },
      },
    );
    expect(sleeps[0]).toBeGreaterThanOrEqual(1000);
  });

  it('expires_in AUSENTE ⇒ deadline finito: o fluxo EXPIRA (não polla eternamente)', async () => {
    // pending para SEMPRE: sem deadline finito, o loop nunca termina. Com o fix,
    // o teto duro (15min) faz o relógio cruzar a deadline ⇒ DeviceCodeExpiredError.
    const client = clientFor(
      {
        device_code: 'dc',
        user_code: 'WXYZ-1234',
        verification_uri: 'https://app.test/device',
        verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
        // expires_in AUSENTE (corpo malformado).
        interval: 5,
      },
      [{ status: 400, body: { error: 'authorization_pending' } }],
    );
    let t = 0;
    await expect(
      runDeviceFlow(
        client,
        { organizationId: 'org-1', onPrompt: () => {} },
        {
          now: () => t,
          sleep: async (ms: number) => {
            t += ms;
          },
        },
      ),
    ).rejects.toBeInstanceOf(DeviceCodeExpiredError);
    // Cruzou o teto duro de 15min (não ficou preso num deadline NaN).
    expect(t).toBeGreaterThanOrEqual(15 * 60 * 1000);
  });
});

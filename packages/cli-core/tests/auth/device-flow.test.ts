import { describe, expect, it, vi } from 'vitest';
import { runDeviceFlow } from '../../src/auth/device-flow.js';
import {
  AccessDeniedError,
  DeviceCodeExpiredError,
  DeviceFlowError,
} from '../../src/auth/errors.js';
import { IdentityClient } from '../../src/auth/identity-client.js';
import { makeMockFetch } from './helpers.js';

const BASE = 'https://id.test/api/v1';
const AUTHORIZE = {
  status: 200,
  body: {
    device_code: 'dc',
    user_code: 'WXYZ-1234',
    verification_uri: 'https://app.test/device',
    verification_uri_complete: 'https://app.test/device?user_code=WXYZ-1234',
    expires_in: 600,
    interval: 5,
  },
};
const TOKENS = {
  access_token: 'acc',
  refresh_token: 'ref',
  token_type: 'Bearer',
  expires_in: 900,
  scope: 'assistant:session llm:call',
  organization_id: 'org-1',
};

/** Relógio falso controlável + sleep que apenas avança o relógio. */
function fakeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function clientFor(tokenResponses: { status: number; body?: unknown }[]) {
  const { fetch } = makeMockFetch({
    '/api/v1/identity/device/authorize': AUTHORIZE,
    '/api/v1/identity/token': tokenResponses,
  });
  return new IdentityClient({ baseUrl: BASE, clientId: 'aluy-cli', fetch });
}

describe('runDeviceFlow', () => {
  it('mostra o prompt (user_code+URL) e devolve tokens no sucesso (CA-1)', async () => {
    const client = clientFor([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: TOKENS },
    ]);
    const clock = fakeClock();
    const onPrompt = vi.fn();
    const tokens = await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt },
      { now: clock.now, sleep: clock.sleep },
    );
    expect(tokens.access_token).toBe('acc');
    expect(onPrompt).toHaveBeenCalledOnce();
    // O prompt recebe APENAS dados públicos (user_code+URL), nunca segredo.
    const prompt = onPrompt.mock.calls[0]![0] as { userCode: string };
    expect(prompt.userCode).toBe('WXYZ-1234');
  });

  it('back-off no slow_down: aumenta o intervalo em +5s (RFC §3.5)', async () => {
    const client = clientFor([
      { status: 400, body: { error: 'slow_down' } },
      { status: 200, body: TOKENS },
    ]);
    const clock = fakeClock();
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    };
    await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt: () => {} },
      { now: clock.now, sleep },
    );
    // 1ª espera = interval (5s); após slow_down, 2ª espera = 5+5 = 10s.
    expect(sleeps).toEqual([5000, 10000]);
  });

  it('access_denied ⇒ AccessDeniedError', async () => {
    const client = clientFor([{ status: 400, body: { error: 'access_denied' } }]);
    const clock = fakeClock();
    await expect(
      runDeviceFlow(
        client,
        { organizationId: 'org-1', onPrompt: () => {} },
        { now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('expired_token ⇒ DeviceCodeExpiredError', async () => {
    const client = clientFor([{ status: 400, body: { error: 'expired_token' } }]);
    const clock = fakeClock();
    await expect(
      runDeviceFlow(
        client,
        { organizationId: 'org-1', onPrompt: () => {} },
        { now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toBeInstanceOf(DeviceCodeExpiredError);
  });

  it('deadline atingido (expires_in) ⇒ DeviceCodeExpiredError sem mais polling', async () => {
    // pending para sempre; o relógio passa do deadline (600s).
    const client = clientFor([{ status: 400, body: { error: 'authorization_pending' } }]);
    const clock = fakeClock();
    const sleep = async (ms: number) => clock.advance(ms);
    await expect(
      runDeviceFlow(
        client,
        { organizationId: 'org-1', onPrompt: () => {} },
        { now: clock.now, sleep },
      ),
    ).rejects.toBeInstanceOf(DeviceCodeExpiredError);
  });

  it('erro OAuth inesperado ⇒ DeviceFlowError', async () => {
    const client = clientFor([{ status: 400, body: { error: 'invalid_grant' } }]);
    const clock = fakeClock();
    await expect(
      runDeviceFlow(
        client,
        { organizationId: 'org-1', onPrompt: () => {} },
        { now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toBeInstanceOf(DeviceFlowError);
  });

  it('signal abortado ⇒ DeviceFlowError(cancelled)', async () => {
    const client = clientFor([{ status: 400, body: { error: 'authorization_pending' } }]);
    const clock = fakeClock();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      runDeviceFlow(
        client,
        { organizationId: 'org-1', onPrompt: () => {}, signal: ctrl.signal },
        { now: clock.now, sleep: clock.sleep },
      ),
    ).rejects.toBeInstanceOf(DeviceFlowError);
  });

  it('Ctrl-C DURANTE a espera do intervalo encerra cedo — sem esperar o intervalo nem pollar (#3)', async () => {
    // pending para sempre: sem o abort-durante-o-sleep, o loop esperaria o intervalo
    // inteiro e pollaria. Aqui o abort dispara NO MEIO da espera.
    const client = clientFor([{ status: 400, body: { error: 'authorization_pending' } }]);
    const pollSpy = vi.spyOn(client, 'pollToken');
    const clock = fakeClock();
    const ctrl = new AbortController();
    // `sleep` ABORTÁVEL real: aborta no meio da espera e resolve cedo (NÃO avança o
    // relógio o intervalo inteiro — espelha o setTimeout+abort de produção).
    let sleptFull = false;
    const sleep = async (ms: number, signal?: AbortSignal) => {
      ctrl.abort(); // Ctrl-C chega durante a espera.
      if (signal?.aborted) return; // resolve cedo — não consumiu os `ms`.
      clock.advance(ms);
      sleptFull = true;
    };
    const err = await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt: () => {}, signal: ctrl.signal },
      { now: clock.now, sleep },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeviceFlowError);
    expect((err as DeviceFlowError).code).toBe('cancelled');
    // Encerrou cedo: NÃO esperou o intervalo todo e NÃO pollou após o abort.
    expect(sleptFull).toBe(false);
    expect(pollSpy).not.toHaveBeenCalled();
  });

  it('o signal do login é repassado ao pollToken (cancela o fetch em voo) (#3)', async () => {
    const client = clientFor([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: TOKENS },
    ]);
    const pollSpy = vi.spyOn(client, 'pollToken');
    const clock = fakeClock();
    const ctrl = new AbortController();
    await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt: () => {}, signal: ctrl.signal },
      { now: clock.now, sleep: clock.sleep },
    );
    // pollToken recebe o device_code E o signal (2º arg).
    expect(pollSpy).toHaveBeenCalled();
    for (const call of pollSpy.mock.calls) {
      expect(call[0]).toBe('dc');
      expect(call[1]).toBe(ctrl.signal);
    }
  });

  it('sem signal: login normal segue funcionando (não regride #real)', async () => {
    const client = clientFor([
      { status: 400, body: { error: 'authorization_pending' } },
      { status: 200, body: TOKENS },
    ]);
    const clock = fakeClock();
    const tokens = await runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt: () => {} },
      { now: clock.now, sleep: clock.sleep },
    );
    expect(tokens.access_token).toBe('acc');
  });

  it('usa defaultSleep real (sem deps.sleep) com interval=0 — cobre linha 45', async () => {
    vi.useFakeTimers();
    // Mock com interval=0 (sleep(0) = setTimeout 0 = instantâneo) e pollToken
    // devolve sucesso já na 1ª chamada. NÃO passamos deps.sleep — o
    // defaultSleep REAL (setTimeout) roda, mas com 0ms é instantâneo.
    const authorizeZeroInterval = { ...AUTHORIZE, interval: 0 };
    const { fetch } = makeMockFetch({
      '/api/v1/identity/device/authorize': authorizeZeroInterval,
      '/api/v1/identity/token': { status: 200, body: TOKENS },
    });
    const client = new IdentityClient({
      baseUrl: BASE,
      clientId: 'aluy-cli',
      fetch,
    });
    const onPrompt = vi.fn();

    // Dispara runDeviceFlow (que vai chamar setTimeout(0) real via defaultSleep)
    const promise = runDeviceFlow(
      client,
      { organizationId: 'org-1', onPrompt },
      // Só now — NADA de sleep, para defaultSleep real rodar.
      {},
    );

    // Avança os timers fake para resolver o setTimeout(0) e qualquer pendência
    await vi.advanceTimersByTimeAsync(10_000);

    const tokens = await promise;
    expect(tokens.access_token).toBe('acc');
    expect(tokens.refresh_token).toBe('ref');
    expect(onPrompt).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});

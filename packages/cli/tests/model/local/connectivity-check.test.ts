// ADR-0153 — TEST-THEN-REGISTER: prova de segurança do `checkModelConnectivity` no
// caminho novo (fetch PINADO injetável, COND-S1) e da sanitização do `detail`
// (`formatConnectivityFailureDetail`, COND-S5) ANTES de qualquer nota/erro alcançar
// a TUI. Cobre os testes de segurança 1 (fetch pinado, nunca global), 2 (anti-SSRF:
// redirect ⇒ 169.254.169.254 bloqueado, sem vazar) e 3 (detail não vaza corpo/baseUrl)
// do parecer do `seguranca`.

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  checkModelConnectivity,
  formatConnectivityFailureDetail,
} from '../../../src/model/local/connectivity-check.js';
import { createPinnedStreamFetch } from '../../../src/model/local/pinned-stream-fetch.js';
import type { HostResolver } from '@hiperplano/aluy-cli-core';

function fakeResolver(map: Record<string, string[]>): HostResolver {
  return {
    resolve: async (host) => {
      const ips = map[host];
      if (ips === undefined) throw new Error(`no DNS for ${host}`);
      return ips;
    },
  };
}

function makeFakeRes(
  statusCode: number,
  body: string,
  headers: Record<string, string> = {},
): import('node:http').IncomingMessage {
  const chunks = body === '' ? [] : [Buffer.from(body)];
  const res = {
    statusCode,
    headers,
    resume() {
      /* drena (no-op no fake) */
    },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
  return res as unknown as import('node:http').IncomingMessage;
}

function makeFakeReq(): import('node:http').ClientRequest {
  return {
    on() {
      return this;
    },
    write() {
      return true;
    },
    end() {
      /* no-op */
    },
    destroy() {
      /* no-op */
    },
  } as unknown as import('node:http').ClientRequest;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TESTE DE SEGURANÇA 1 — ping usa o fetch PINADO, nunca globalThis.fetch', () => {
  it('checkModelConnectivity chama SÓ o fetchImpl injetado; globalThis.fetch nunca é tocado', async () => {
    const globalSpy = vi.spyOn(globalThis, 'fetch');
    const calls: Array<{ input: string; init: unknown }> = [];
    const spyFetch = async (
      input: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      calls.push({ input, init });
      return { ok: true, status: 200, text: async () => '' };
    };
    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test',
      model: 'vendor/model-x',
      key: 'sk-test',
      fetchImpl: spyFetch,
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input).toBe('https://gateway.test/chat/completions');
    expect((calls[0]!.init as { body?: string }).body).toContain('vendor/model-x');
    expect((calls[0]!.init as { body?: string }).body).toContain('"max_tokens":1');
    // PROVA: o fetch GLOBAL nunca foi invocado — o caminho de teste usou só o injetado.
    expect(globalSpy).not.toHaveBeenCalled();
  });

  it('sem fetchImpl injetado (chamador antigo — onboard/login), o default É o global (comportamento intocado)', async () => {
    const globalSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);
    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test',
      model: 'm',
      key: 'sk-test',
    });
    expect(r.ok).toBe(true);
    expect(globalSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TESTE DE SEGURANÇA 2 — anti-SSRF: 302 → 169.254.169.254 falha fail-closed, sem vazar', () => {
  it('provider responde 302 → http://169.254.169.254/ ⇒ ping falha; nem location nem "169.254" no erro surfaced', async () => {
    const mockRequest = ((_o: Record<string, unknown>, cb: (r: unknown) => void) => {
      const res = makeFakeRes(302, '', { location: 'http://169.254.169.254/latest/meta-data' });
      queueMicrotask(() => cb(res));
      return makeFakeReq();
    }) as never;
    const pinnedFetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'gateway.test': ['8.8.8.8'] }),
      httpsRequestFn: mockRequest,
      httpRequestFn: mockRequest,
    });
    // `checkModelConnectivity` NÃO seta `init.redirect` ⇒ o pinado cai no default
    // `'error'` (fail-closed) — o 302 NUNCA é seguido (COND-S1).
    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test',
      model: 'x',
      key: 'sk-test',
      fetchImpl: pinnedFetch,
    });
    expect(r.ok).toBe(false);
    // o `detail` CRU do checkModelConnectivity (antes da sanitização) inevitavelmente
    // carrega `e.message` do pinado (que cita location/BLOQUEADO) — é exatamente o que
    // `formatConnectivityFailureDetail` (COND-S5) tem de descartar a seguir.
    const surfaced = formatConnectivityFailureDetail('x', r.detail);
    expect(surfaced).not.toMatch(/169\.254/);
    expect(surfaced).not.toMatch(/location/i);
    expect(surfaced).not.toMatch(/latest\/meta-data/);
    expect(surfaced).not.toMatch(/gateway\.test/);
    // texto FIXO esperado (COND-S5, branch sem status HTTP).
    expect(surfaced).toBe(
      'modelo local "x" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).',
    );
  });

  it('DNS que (re)resolve p/ IP interno (rebinding) ⇒ egress recusado, sem vazar o IP/host no erro surfaced', async () => {
    const neverConnect = (() => {
      throw new Error('NÃO deveria conectar a um alvo interno');
    }) as never;
    const pinnedFetch = createPinnedStreamFetch({
      resolver: fakeResolver({ 'rebind.test': ['169.254.169.254'] }),
      httpsRequestFn: neverConnect,
      httpRequestFn: neverConnect,
    });
    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl: 'https://rebind.test',
      model: 'x',
      key: 'sk-test',
      fetchImpl: pinnedFetch,
    });
    expect(r.ok).toBe(false);
    const surfaced = formatConnectivityFailureDetail('x', r.detail);
    expect(surfaced).not.toMatch(/169\.254/);
    expect(surfaced).not.toMatch(/rebind\.test/);
  });
});

describe('TESTE DE SEGURANÇA 3 — detail NÃO vaza: corpo cru/ANSI/BEL/pseudo-segredo, nem baseUrl no branch de rede', () => {
  it('corpo do provider com ANSI/BEL/pseudo-segredo ⇒ erro surfaced mostra SÓ HTTP <ddd>+hint+slug', async () => {
    const dirtyBody =
      '\x1b[31mERRO\x1b[0m\x07 segredo-parece="sk-live-abc123DEADBEEF" detalhe interno do provider ' +
      'que não deveria vazar nunca jamais em hipótese alguma para a interface do usuário final';
    const fetchImpl = async () => ({
      ok: false,
      status: 404,
      text: async () => dirtyBody,
    });
    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test',
      model: 'deepseek/deepseek-v4-flash',
      key: 'sk-test',
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    // o `detail` CRU do checkModelConnectivity ecoa até 160 chars do corpo — é o
    // ACHADO-A que a sanitização (COND-S5) tem de descartar por completo a seguir.
    expect(r.detail).toContain('segredo-parece');
    const surfaced = formatConnectivityFailureDetail('deepseek/deepseek-v4-flash', r.detail);
    expect(surfaced).toBe(
      'modelo local "deepseek/deepseek-v4-flash" não respondeu: HTTP 404 — modelo ou baseURL errado?',
    );
    expect(surfaced).not.toContain('segredo-parece');
    expect(surfaced).not.toContain('sk-live-abc123DEADBEEF');
    expect(surfaced).not.toContain('\x1b');
    expect(surfaced).not.toContain('\x07');
    expect(surfaced).not.toMatch(/ERRO/);
  });

  it('HTTP 401/403 ⇒ hint "chave inválida?"; HTTP genérico (500) ⇒ sem hint, sem corpo', async () => {
    for (const [status, expectedHint] of [
      [401, ' — chave inválida?'],
      [403, ' — chave inválida?'],
      [404, ' — modelo ou baseURL errado?'],
      [500, ''],
    ] as const) {
      const surfaced = formatConnectivityFailureDetail('m', `HTTP ${status} corpo cru que some`);
      expect(surfaced).toBe(`modelo local "m" não respondeu: HTTP ${status}${expectedHint}`);
      expect(surfaced).not.toContain('corpo cru');
    }
  });

  it('branch de rede/timeout (sem status HTTP) com baseUrl no e.message ⇒ texto FIXO, sem baseUrl', async () => {
    // Espelha o formato real do branch `catch` de `checkModelConnectivity`
    // (`não conectou (baseURL/rede?): ${e.message}`), onde `e.message` pode citar
    // a baseURL/host — o texto sanitizado NUNCA a interpola.
    const rawDetail =
      'não conectou (baseURL/rede?): connect ECONNREFUSED 10.0.0.55:443 (https://internal-gateway.corp/v1)';
    const surfaced = formatConnectivityFailureDetail('m', rawDetail);
    expect(surfaced).toBe(
      'modelo local "m" não respondeu (rede/baseURL, ou egress bloqueado pelo anti-SSRF).',
    );
    expect(surfaced).not.toMatch(/10\.0\.0\.55/);
    expect(surfaced).not.toMatch(/internal-gateway\.corp/);
    expect(surfaced).not.toMatch(/ECONNREFUSED/);
  });

  it('ok:true não passa pelo sanitizador (o caller monta o texto fixo de sucesso à parte)', async () => {
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => '' });
    const r = await checkModelConnectivity({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test',
      model: 'm',
      key: 'sk-test',
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, detail: 'HTTP 200' });
  });
});

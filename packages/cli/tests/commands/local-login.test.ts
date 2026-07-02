// ADR-0120 / EST-1113/1114 — `aluy login --provider <p> [--oauth]` (backend local).
// F167 — TODO teste injeta um `configStore` de tmpdir: sem isso, o save de
// `backend/localProvider` do login batia no ~/.aluy/config.json REAL do dev/dono
// e cada `npm test` CLOBBERAVA o provider configurado ("perdi o login").
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { runLocalLogin, rejectNonGetCallback } from '../../src/commands/local-login.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import type { TerminalIO } from '../../src/auth/io.js';
import type { KeyringEntry } from '../../src/model/local/credential-resolver.js';

// F167 — store de config isolado por teste (tmpdir), NUNCA o ~/.aluy real.
const tmpDirs: string[] = [];
function tmpConfigStore(): UserConfigStore {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-login-cfg-'));
  tmpDirs.push(dir);
  return new UserConfigStore({ baseDir: join(dir, '.aluy') });
}
afterEach(() => {
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeIO(answers: string[] = []): { io: TerminalIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  let i = 0;
  return {
    io: {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt: async () => answers[i++] ?? '',
    },
    out,
    err,
  };
}

function fakeKeyring(store: Record<string, string>) {
  return (_s: string, account: string): KeyringEntry => ({
    getPassword: () => store[account] ?? '',
    setPassword: (p: string) => {
      store[account] = p;
    },
    deletePassword: () => {
      const had = account in store;
      delete store[account];
      return had;
    },
  });
}

describe('runLocalLogin — API key', () => {
  it('grava a chave de --token no keychain (exit 0)', async () => {
    const mem: Record<string, string> = {};
    const { io, out } = fakeIO();
    const code = await runLocalLogin(
      { provider: 'anthropic', token: 'sk-ant-123' },
      { configStore: tmpConfigStore(), io, entryFactory: fakeKeyring(mem) },
    );
    expect(code).toBe(0);
    expect(mem['anthropic:apikey']).toBe('sk-ant-123');
    expect(out.join('\n')).toMatch(/keychain/i);
  });

  it('F167 — o save de backend/localProvider vai ao store INJETADO (nunca ao ~/.aluy real)', async () => {
    const { io } = fakeIO();
    const store = tmpConfigStore();
    const code = await runLocalLogin(
      { provider: 'openrouter', token: 'sk-or-fake' },
      { configStore: store, io, entryFactory: fakeKeyring({}) },
    );
    expect(code).toBe(0);
    // O que o login configurou aterrissou no store isolado…
    const cfg = store.load();
    expect(cfg.backend).toBe('local');
    expect(cfg.localProvider).toBe('openrouter');
    // …e o caminho do store é o tmpdir do teste, não a HOME real.
    expect(store.configPath.includes('aluy-login-cfg-')).toBe(true);
  });

  it('sem --token, lê a chave do prompt secreto', async () => {
    const mem: Record<string, string> = {};
    const { io } = fakeIO(['sk-prompted']);
    const code = await runLocalLogin(
      { provider: 'openrouter' },
      { configStore: tmpConfigStore(), io, entryFactory: fakeKeyring(mem) },
    );
    expect(code).toBe(0);
    expect(mem['openrouter:apikey']).toBe('sk-prompted');
  });

  it('provider inválido ⇒ exit 2', async () => {
    const { io, err } = fakeIO();
    const code = await runLocalLogin(
      { provider: 'gemini' },
      { configStore: tmpConfigStore(), io, entryFactory: fakeKeyring({}) },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/desconhecido/i);
  });

  it('chave vazia ⇒ exit 1', async () => {
    const { io } = fakeIO(['']);
    const code = await runLocalLogin(
      { provider: 'openai' },
      { configStore: tmpConfigStore(), io, entryFactory: fakeKeyring({}) },
    );
    expect(code).toBe(1);
  });
});

describe('rejectNonGetCallback — callback loopback só GET (EST-1115, ressalva #3)', () => {
  function fakeRes() {
    const r = {
      statusCode: 200,
      headers: {} as Record<string, string>,
      ended: '' as string,
      setHeader(n: string, v: string) {
        r.headers[n] = v;
      },
      end(b: string) {
        r.ended = b;
      },
    };
    return r;
  }

  it('GET passa (devolve false ⇒ o handler segue)', () => {
    const res = fakeRes();
    expect(rejectNonGetCallback('GET', res)).toBe(false);
    expect(res.statusCode).toBe(200);
  });

  it('método ausente ⇒ tratado como GET (passa)', () => {
    expect(rejectNonGetCallback(undefined, fakeRes())).toBe(false);
  });

  it('POST é RECUSADO com 405 + Allow: GET', () => {
    const res = fakeRes();
    expect(rejectNonGetCallback('POST', res)).toBe(true);
    expect(res.statusCode).toBe(405);
    expect(res.headers['allow']).toBe('GET');
  });

  it('PUT/DELETE também recusados', () => {
    for (const m of ['PUT', 'DELETE', 'PATCH']) {
      const res = fakeRes();
      expect(rejectNonGetCallback(m, res)).toBe(true);
      expect(res.statusCode).toBe(405);
    }
  });
});

describe('runLocalLogin — OAuth (PKCE) com colar-código', () => {
  it('exibe o AVISO de ToS, troca o code por tokens (colar-código) e grava no keychain', async () => {
    const mem: Record<string, string> = {};
    // prompt[0] = código colado (o loopback falha p/ a porta — cai no colar-código? não:
    // forçamos o openBrowser a NÃO subir loopback usando uma porta inválida não é trivial;
    // em vez disso, testamos a via colar-código injetando um openBrowser que lança e um
    // server que não sobe — mas o server real subiria. Então exercitamos via fetch mock +
    // o caminho loopback NÃO é tocado: usamos a env client_id e validamos a TROCA.)
    // Estratégia: o loopback realmente sobe; simulamos o redirect batendo no callback.
    const { io, err } = fakeIO();
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
      text: async () => '',
    }));
    // openBrowser que dispara o redirect no loopback (simula o usuário autorizando).
    const openBrowser = async (authorizeUrl: string): Promise<void> => {
      const u = new URL(authorizeUrl);
      const state = u.searchParams.get('state') ?? '';
      const redirect = u.searchParams.get('redirect_uri') ?? '';
      // bate no callback do loopback com o code+state.
      const cb = new URL(redirect);
      cb.searchParams.set('code', 'the-code');
      cb.searchParams.set('state', state);
      // pequeno atraso p/ o server já estar ouvindo.
      await new Promise((r) => setTimeout(r, 30));
      await (globalThis.fetch as typeof globalThis.fetch)(cb.toString()).catch(() => undefined);
    };
    const code = await runLocalLogin(
      { provider: 'anthropic', oauth: true },
      {
        configStore: tmpConfigStore(),
        io,
        entryFactory: fakeKeyring(mem),
        fetch: fetch as never,
        openBrowser,
        env: { ALUY_OAUTH_ANTHROPIC_CLIENT_ID: 'cid-test' },
        now: () => 0,
      },
    );
    expect(err.join('\n')).toMatch(/ToS|zona cinzenta/i); // aviso de ToS exibido.
    expect(code).toBe(0);
    expect(fetch).toHaveBeenCalledTimes(1); // troca de token aconteceu.
    const saved = JSON.parse(mem['anthropic:oauth']);
    expect(saved.accessToken).toBe('AT');
    expect(saved.refreshToken).toBe('RT');
  });

  it('OAuth sem client_id configurado ⇒ exit 2 (erro acionável)', async () => {
    const { io, err } = fakeIO();
    const code = await runLocalLogin(
      { provider: 'anthropic', oauth: true },
      { configStore: tmpConfigStore(), io, entryFactory: fakeKeyring({}), env: {} },
    );
    expect(code).toBe(2);
    expect(err.join('\n')).toMatch(/client_id/i);
  });
});

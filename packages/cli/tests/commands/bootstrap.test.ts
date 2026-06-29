// EST-1133-wizard / ADR-0130 — testes unitários do wizard de 1ª execução no `aluy bootstrap`.
//
// Cobre:
//  - "sem config ⇒ pergunta e salva" (prompt → keychain + config.json)
//  - "com config ⇒ pula" (idempotente)
//  - "não-interativo ⇒ não trava" (reporta e instrui)
//  - Integração via `runInit` (wizard ANTES do provisionamento)

import { describe, expect, it, vi, afterEach } from 'vitest';
import { runInit, runFirstRunWizard, probeModelReachable } from '../../src/commands/bootstrap.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import {
  LOCAL_KEYCHAIN_SERVICE,
  apiKeyAccount,
} from '../../src/model/local/credential-resolver.js';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ── Fakes ────────────────────────────────────────────────────────────────────

/** Entry fake EM MEMÓRIA (simula o keychain disponível). */
class FakeEntry {
  constructor(
    private store: Map<string, string>,
    private key: string,
  ) {}
  getPassword(): string {
    const v = this.store.get(this.key);
    if (v === undefined) throw new Error('No matching entry');
    return v;
  }
  setPassword(p: string): void {
    this.store.set(this.key, p);
  }
  deletePassword(): boolean {
    return this.store.delete(this.key);
  }
}

function fakeEntryFactory(mem: Map<string, string>) {
  return (service: string, account: string) => new FakeEntry(mem, `${service}:${account}`);
}

function fixture(answers: string[], keychainMem?: Map<string, string>, baseDir?: string) {
  const mem = keychainMem ?? new Map<string, string>();
  let i = 0;
  const outLines: string[] = [];
  const errLines: string[] = [];
  const out = (l: string) => outLines.push(l);
  const err = (l: string) => errLines.push(l);
  const prompt: (q: string, opts?: { secret?: boolean }) => Promise<string> = async () =>
    answers[i++] ?? '';

  const tmp = baseDir ?? mkdtempSync(join(tmpdir(), 'aluy-bootstrap-wizard-'));
  const configStore = new UserConfigStore({ baseDir: tmp });

  return {
    out,
    outLines,
    err,
    errLines,
    prompt,
    entryFactory: fakeEntryFactory(mem),
    configStore,
    keychainMem: mem,
    tmpDir: tmp,
  };
}

// ── Testes unitários de runFirstRunWizard ────────────────────────────────────

describe('runFirstRunWizard — testes unitários', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
    tmpDirs = [];
  });

  it('sem config ⇒ pergunta provider, chave e modelo, salva tudo (exit 0)', async () => {
    const f = fixture(['anthropic', 'sk-ant-12345', 'claude-sonnet-4-8']);
    tmpDirs.push(f.tmpDir);

    const ok = await runFirstRunWizard({
      config: {},
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(true);

    // Chave foi p/ o keychain.
    const entry = f.entryFactory(LOCAL_KEYCHAIN_SERVICE, apiKeyAccount('anthropic'));
    expect(entry.getPassword()).toBe('sk-ant-12345');

    // Provider + modelo foram p/ config.json.
    const config = f.configStore.load();
    expect(config.localProvider).toBe('anthropic');
    expect(config.localModel).toBe('claude-sonnet-4-8');

    // Banner do wizard foi exibido.
    expect(f.outLines.join('\n')).toMatch(/1ª execução/);
    expect(f.outLines.join('\n')).toMatch(/keychain/);
    expect(f.outLines.join('\n')).toMatch(/config\.json/);
  });

  it('com provider + modelo + chave ⇒ PULA o wizard (idempotente)', async () => {
    const mem = new Map<string, string>();
    // Pré-popula o keychain.
    mem.set(`${LOCAL_KEYCHAIN_SERVICE}:${apiKeyAccount('openai')}`, 'sk-openai-key');

    const f = fixture([], mem);
    tmpDirs.push(f.tmpDir);

    // Pré-popula a config.
    f.configStore.save({ localProvider: 'openai', localModel: 'gpt-5' });

    const config = f.configStore.load();
    const ok = await runFirstRunWizard({
      config,
      configStore: f.configStore,
      prompt: f.prompt, // nunca chamado
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(true);

    // NÃO exibiu o banner (wizard pulado).
    expect(f.outLines.join('\n')).not.toMatch(/1ª execução/);

    // Nenhum prompt foi feito.
    expect(f.outLines.join('\n')).toBe('');
  });

  it('com provider mas SEM chave ⇒ pergunta SÓ a chave (preserva provider)', async () => {
    const mem = new Map<string, string>();
    const f = fixture(['sk-ant-nova-chave'], mem);
    tmpDirs.push(f.tmpDir);

    // Config tem provider E modelo, mas NÃO tem chave no keychain.
    f.configStore.save({ localProvider: 'anthropic', localModel: 'claude-opus-4-8' });

    const config = f.configStore.load();
    const ok = await runFirstRunWizard({
      config,
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(true);

    // Provider NÃO foi perguntado de novo.
    expect(f.outLines.join('\n')).toMatch(/já configurado/);

    // Chave foi gravada.
    const entry = f.entryFactory(LOCAL_KEYCHAIN_SERVICE, apiKeyAccount('anthropic'));
    expect(entry.getPassword()).toBe('sk-ant-nova-chave');

    // Modelo NÃO foi perguntado de novo.
    const cfg = f.configStore.load();
    expect(cfg.localModel).toBe('claude-opus-4-8');
  });

  it('com provider + chave mas SEM modelo ⇒ pergunta SÓ o modelo', async () => {
    const mem = new Map<string, string>();
    mem.set(`${LOCAL_KEYCHAIN_SERVICE}:${apiKeyAccount('openrouter')}`, 'sk-or-key');

    const f = fixture(['google/gemini-3-pro'], mem);
    tmpDirs.push(f.tmpDir);

    // Config tem provider, mas NÃO tem modelo.
    f.configStore.save({ localProvider: 'openrouter' });
    // Não salvamos modelo de propósito.

    const config = f.configStore.load();
    const ok = await runFirstRunWizard({
      config,
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(true);

    // Provider + chave NÃO foram perguntados.
    expect(f.outLines.join('\n')).toMatch(/já configurado/);
    expect(f.outLines.join('\n')).toMatch(/keychain/);

    // Modelo foi salvo.
    expect(f.configStore.load().localModel).toBe('google/gemini-3-pro');
  });

  it('provider inválido ⇒ retorna false e não salva nada', async () => {
    const f = fixture(['invalido']);
    tmpDirs.push(f.tmpDir);

    const ok = await runFirstRunWizard({
      config: {},
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(false);
    expect(f.errLines.join('\n')).toMatch(/inválido/i);
    expect(f.configStore.load().localProvider).toBeUndefined();
  });

  it('chave vazia ⇒ retorna false', async () => {
    const f = fixture(['anthropic', '']);
    tmpDirs.push(f.tmpDir);

    const ok = await runFirstRunWizard({
      config: {},
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(false);
  });

  it('modelo vazio ⇒ retorna false', async () => {
    const f = fixture(['anthropic', 'sk-ant-123', '']);
    tmpDirs.push(f.tmpDir);

    const ok = await runFirstRunWizard({
      config: {},
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(false);
  });

  describe('modo não-interativo', () => {
    it('sem config ⇒ reporta o que falta, NÃO trava, retorna false', async () => {
      const f = fixture([]);
      tmpDirs.push(f.tmpDir);

      const ok = await runFirstRunWizard({
        config: {},
        configStore: f.configStore,
        prompt: f.prompt,
        out: f.out,
        err: f.err,
        entryFactory: f.entryFactory,
        isInteractive: false, // ← NÃO-interativo
      });

      expect(ok).toBe(false);

      // Reportou o que falta.
      const stderr = f.errLines.join('\n');
      expect(stderr).toMatch(/provider/i);
      expect(stderr).toMatch(/modelo/i);
      expect(stderr).toMatch(/chave/i);
      expect(stderr).toMatch(/aluy login/);

      // NÃO tentou prompt (sem pendurar).
      expect(f.outLines.join('\n')).not.toMatch(/1ª execução/);
    });

    it('com config completa ⇒ retorna true (não reporta)', async () => {
      const mem = new Map<string, string>();
      mem.set(`${LOCAL_KEYCHAIN_SERVICE}:${apiKeyAccount('anthropic')}`, 'sk-ant-ok');

      const f = fixture([], mem);
      tmpDirs.push(f.tmpDir);
      f.configStore.save({ localProvider: 'anthropic', localModel: 'claude-sonnet-4-8' });

      const config = f.configStore.load();
      const ok = await runFirstRunWizard({
        config,
        configStore: f.configStore,
        prompt: f.prompt,
        out: f.out,
        err: f.err,
        entryFactory: f.entryFactory,
        isInteractive: false,
      });

      expect(ok).toBe(true);
      expect(f.errLines.join('\n')).toBe('');
    });
  });

  it('openrouter como provider (válido)', async () => {
    const f = fixture(['openrouter', 'sk-or-key-123', 'openai/gpt-5-pro']);
    tmpDirs.push(f.tmpDir);

    const ok = await runFirstRunWizard({
      config: {},
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(true);
    expect(f.configStore.load().localProvider).toBe('openrouter');
    const entry = f.entryFactory(LOCAL_KEYCHAIN_SERVICE, apiKeyAccount('openrouter'));
    expect(entry.getPassword()).toBe('sk-or-key-123');
  });

  it('openai como provider (válido)', async () => {
    const f = fixture(['openai', 'sk-openai-456', 'gpt-5']);
    tmpDirs.push(f.tmpDir);

    const ok = await runFirstRunWizard({
      config: {},
      configStore: f.configStore,
      prompt: f.prompt,
      out: f.out,
      err: f.err,
      entryFactory: f.entryFactory,
      isInteractive: true,
    });

    expect(ok).toBe(true);
    expect(f.configStore.load().localProvider).toBe('openai');
  });
});

// ── Testes de integração via runInit (wizard ANTES do provisionamento) ───────

// Mocka o provisionador p/ não disparar I/O de verdade.
vi.mock('../../src/provisioner/sidecar-provisioner.js', () => ({
  runProvisioner: vi.fn(async () => ({
    targets: [{ target: 'ollama', installed: true, message: 'mock ok' }],
    anySuccess: true,
    allFailed: false,
  })),
}));

import { runProvisioner } from '../../src/provisioner/sidecar-provisioner.js';

describe('runInit — integração wizard + provisionamento', () => {
  let tmpDirs: string[] = [];

  afterEach(() => {
    vi.clearAllMocks();
    for (const d of tmpDirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* cleanup */
      }
    }
    tmpDirs = [];
  });

  it('com config completa + interativo ⇒ wizard pula, provisiona direto (exit 0)', async () => {
    const mem = new Map<string, string>();
    mem.set(`${LOCAL_KEYCHAIN_SERVICE}:${apiKeyAccount('anthropic')}`, 'sk-ant-int');

    const tmp = mkdtempSync(join(tmpdir(), 'aluy-bootstrap-int-'));
    tmpDirs.push(tmp);
    const configStore = new UserConfigStore({ baseDir: tmp });
    configStore.save({
      localProvider: 'anthropic',
      localModel: 'claude-sonnet-4-8',
      profile: 'turbo',
    });

    const out: string[] = [];
    const err: string[] = [];

    const code = await runInit({
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      configStore,
      entryFactory: fakeEntryFactory(mem),
      isInteractive: true,
      prompt: async () => '', // não deve ser chamado
      modelProbe: async () => true, // hermético: não toca rede no preflight
    });

    expect(code).toBe(0);

    // Wizard NÃO rodou (config completa).
    expect(out.join('\n')).not.toMatch(/1ª execução/);

    // Provisionador foi chamado.
    expect(runProvisioner).toHaveBeenCalledTimes(1);
    expect(out.join('\n')).toMatch(/mock ok/);
  });

  it('sem config + interativo com prompt array ⇒ wizard salva e provisiona', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aluy-bootstrap-arr-'));
    tmpDirs.push(tmp);
    const configStore = new UserConfigStore({ baseDir: tmp });

    const answers = ['anthropic', 'sk-ant-arr-key', 'claude-sonnet-4-8'];
    let i = 0;
    const prompt = async () => answers[i++] ?? '';

    const out: string[] = [];
    const err: string[] = [];

    const code = await runInit({
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      prompt,
      entryFactory: fakeEntryFactory(new Map()),
      configStore,
      isInteractive: true,
      modelProbe: async () => true, // hermético: não toca rede no preflight
    });

    expect(code).toBe(0);

    // Provider + modelo na config.
    expect(configStore.load().localProvider).toBe('anthropic');
    expect(configStore.load().localModel).toBe('claude-sonnet-4-8');

    // Provisionador chamado.
    expect(runProvisioner).toHaveBeenCalled();

    // Wizard exibiu banner.
    expect(out.join('\n')).toMatch(/1ª execução/);
  });

  it('não-interativo sem config ⇒ reporta e NÃO provisiona, exit 0 (não trava)', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'aluy-bootstrap-ni-'));
    tmpDirs.push(tmp);
    const configStore = new UserConfigStore({ baseDir: tmp });

    const out: string[] = [];
    const err: string[] = [];

    const code = await runInit({
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      configStore,
      entryFactory: fakeEntryFactory(new Map()),
      isInteractive: false,
    });

    expect(code).toBe(0); // não trava

    // Reportou o que falta.
    expect(err.join('\n')).toMatch(/provider/i);
    expect(err.join('\n')).toMatch(/chave/i);

    // NÃO provisionou (não tinha config).
    // O provisionador pode ter sido chamado ou não, dependendo do perfil.
    // Como não salvamos perfil, cai default 'turbo'. Mas o wizard falhou,
    // então o código atual NÃO barra o provisionamento — só reporta e segue.
    // Precisamos verificar se o wizard impede ou não.
    // Pelo código, `if (!ok) { return 0; }` — então NÃO provisiona.
    expect(runProvisioner).not.toHaveBeenCalled();
  });

  it('modelo INACESSÍVEL + caminho agente ⇒ cai p/ direto (useAgent:false) e avisa', async () => {
    const mem = new Map<string, string>();
    mem.set(`${LOCAL_KEYCHAIN_SERVICE}:${apiKeyAccount('anthropic')}`, 'sk-ant');
    const tmp = mkdtempSync(join(tmpdir(), 'aluy-bootstrap-fb-'));
    tmpDirs.push(tmp);
    const configStore = new UserConfigStore({ baseDir: tmp });
    configStore.save({ localProvider: 'anthropic', localModel: 'claude-sonnet-4-8', profile: 'turbo' });

    const out: string[] = [];
    const code = await runInit({
      out: (l) => out.push(l),
      err: () => {},
      configStore,
      entryFactory: fakeEntryFactory(mem),
      isInteractive: true,
      prompt: async () => '',
      agent: true, // pediu o caminho agente…
      modelProbe: async () => false, // …mas o modelo não responde
    });

    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/caminho DIRETO|--no-agent/i);
    // Provisionou pelo caminho DIRETO (useAgent:false) — não polir no vazio.
    expect(runProvisioner).toHaveBeenCalledWith(
      'turbo',
      undefined,
      expect.objectContaining({ useAgent: false }),
    );
  });
});

describe('probeModelReachable — preflight de acessibilidade do modelo', () => {
  it('fetch resolve (mesmo 401) ⇒ alcançável (true); sonda <baseUrl>/models', async () => {
    let calledUrl = '';
    const ok = await probeModelReachable({
      config: { localProvider: 'ollama' } as never,
      env: {},
      fetchImpl: async (url) => {
        calledUrl = url;
        return { status: 401 };
      },
    });
    expect(ok).toBe(true);
    expect(calledUrl).toBe('http://127.0.0.1:11434/v1/models'); // baseUrl do catálogo + /models
  });

  it('fetch lança (rede caída) ⇒ inacessível (false)', async () => {
    const ok = await probeModelReachable({
      config: { localProvider: 'ollama' } as never,
      env: {},
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(ok).toBe(false);
  });
});

// `aluy config` — visão consolidada read-only: valor + ORIGEM (default/env/config.json).
import { describe, expect, it } from 'vitest';
import { collectSettings, runConfig } from '../../src/commands/config.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import type { TerminalIO } from '../../src/auth/io.js';

/** IO fake que captura as linhas do stdout. */
function captureIO(): { io: TerminalIO; lines: string[] } {
  const lines: string[] = [];
  const io: TerminalIO = {
    out: (l) => lines.push(l),
    err: () => {},
    prompt: async () => '',
  };
  return { io, lines };
}

/** Store fake que devolve um config pronto (sem tocar disco). */
function fakeStore(config: Record<string, unknown>): UserConfigStore {
  return { load: () => config } as unknown as UserConfigStore;
}

describe('collectSettings — precedência env > config.json > default', () => {
  it('config.json vence o default; origem reportada = config.json', () => {
    const s = collectSettings({}, { backend: 'local', localProvider: 'ollama' } as never);
    const backend = s.find((x) => x.key === 'backend');
    const provider = s.find((x) => x.key === 'localProvider');
    expect(backend).toMatchObject({
      value: 'local',
      origin: 'config.json',
      source: 'config.backend',
    });
    expect(provider).toMatchObject({ value: 'ollama', origin: 'config.json' });
  });

  it('env ALUY_* vence o config.json; origem = env e a fonte é a env var', () => {
    const s = collectSettings({ ALUY_LOCAL_PROVIDER: 'openrouter' }, {
      localProvider: 'ollama',
    } as never);
    const provider = s.find((x) => x.key === 'localProvider');
    expect(provider).toMatchObject({
      value: 'openrouter',
      origin: 'env',
      source: 'ALUY_LOCAL_PROVIDER',
    });
  });

  it('sem env nem config ⇒ origem = default (não inventa fonte)', () => {
    const s = collectSettings({}, {} as never);
    const backend = s.find((x) => x.key === 'backend');
    expect(backend?.origin).toBe('default');
    expect(backend?.source).toBe('—');
    // profile default = turbo (só-config, sem env)
    expect(s.find((x) => x.key === 'profile')).toMatchObject({ value: 'turbo', origin: 'default' });
  });

  it('env vazia ("") NÃO conta como override — cai p/ config/default', () => {
    const s = collectSettings({ ALUY_BACKEND: '   ' }, { backend: 'broker' } as never);
    expect(s.find((x) => x.key === 'backend')).toMatchObject({
      value: 'broker',
      origin: 'config.json',
    });
  });

  // F185 — limites/orçamento (ADR-0136) agora aparecem na view de config efetiva.
  it('F185 — maxTokens/maxOutputTokens/maxIterations com defaults quando ausentes', () => {
    const s = collectSettings({}, {} as never);
    expect(s.find((x) => x.key === 'maxTokens')).toMatchObject({
      value: '10000000',
      origin: 'default',
    });
    expect(s.find((x) => x.key === 'maxIterations')).toMatchObject({
      value: '300',
      origin: 'default',
    });
    expect(s.find((x) => x.key === 'maxOutputTokens')?.origin).toBe('default');
  });

  it('F185 — env ALUY_MAX_* vence; origem = env com a env var certa', () => {
    const s = collectSettings({ ALUY_MAX_TOKENS: '555', ALUY_MAX_ITERATIONS: '7' }, {} as never);
    expect(s.find((x) => x.key === 'maxTokens')).toMatchObject({
      value: '555',
      origin: 'env',
      source: 'ALUY_MAX_TOKENS',
    });
    expect(s.find((x) => x.key === 'maxIterations')).toMatchObject({
      value: '7',
      origin: 'env',
      source: 'ALUY_MAX_ITERATIONS',
    });
  });

  it('F185 — config.limits.* vence o default; fonte = config.limits.<chave> (aninhada)', () => {
    const s = collectSettings({}, { limits: { maxTokens: 42 } } as never);
    expect(s.find((x) => x.key === 'maxTokens')).toMatchObject({
      value: '42',
      origin: 'config.json',
      source: 'config.limits.maxTokens',
    });
  });
});

describe('runConfig — saída', () => {
  it('texto: imprime a precedência, as chaves e o aviso de segredo; exit 0', () => {
    const { io, lines } = captureIO();
    const code = runConfig({
      io,
      env: {},
      baseDir: '/tmp/x',
      configStore: fakeStore({ backend: 'local' }),
    });
    expect(code).toBe(0);
    const out = lines.join('\n');
    expect(out).toContain('flag > env (ALUY_*) > config.json > default');
    expect(out).toContain('backend');
    expect(out).toContain('keychain'); // o aviso de que segredo não vai no config.json
    expect(out).toContain('mcp.json'); // lista os outros arquivos
  });

  it('--json: imprime JSON estável com settings[] e files[]; exit 0', () => {
    const { io, lines } = captureIO();
    const code = runConfig({
      io,
      env: { ALUY_LOCAL_MODEL: 'x/y' },
      baseDir: '/tmp/x',
      json: true,
      configStore: fakeStore({ localProvider: 'openrouter' }),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(lines.join('\n')) as {
      configPath: string;
      settings: Array<{ key: string; origin: string; source: string; value: string }>;
      files: Array<{ path: string; role: string }>;
    };
    expect(parsed.configPath).toBe('/tmp/x/config.json');
    expect(parsed.settings.find((s) => s.key === 'localModel')).toMatchObject({
      value: 'x/y',
      origin: 'env',
      source: 'ALUY_LOCAL_MODEL',
    });
    expect(parsed.files.some((f) => f.path.endsWith('mcp.json'))).toBe(true);
  });

  // F186 — a lista de arquivos inclui o estado do usuário antes ausente da descoberta.
  it('F186 — files[] inclui sessions, audit.jsonl, cron, exports e undo', () => {
    const { io, lines } = captureIO();
    runConfig({
      io,
      env: {},
      baseDir: '/tmp/x',
      json: true,
      configStore: fakeStore({}),
    });
    const parsed = JSON.parse(lines.join('\n')) as { files: Array<{ path: string }> };
    for (const name of ['sessions', 'audit.jsonl', 'cron', 'exports', 'undo']) {
      expect(
        parsed.files.some((f) => f.path.endsWith(name)),
        `falta ${name}`,
      ).toBe(true);
    }
  });
});

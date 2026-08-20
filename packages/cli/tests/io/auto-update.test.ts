// Autoupdate (io/auto-update.ts): decisão de LIGADO/DESLIGADO, detecção de instalação
// por npm vs. repo, o fluxo fim-a-fim `runAutoUpdate` (fetch por dist-tag → decide →
// spawn com timeout → grava estado) e a nota `readAutoUpdateNote` pro rodapé. Tudo
// com fs/rede/child_process MOCKADOS — sem tocar disco, rede ou processo real.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/fake-user',
}));

import {
  autoUpdateEnabled,
  isNpmGlobalInstall,
  readAutoUpdateNote,
  runAutoUpdate,
} from '../../src/io/auto-update.js';

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);
const mockMkdir = vi.mocked(mkdirSync);

const STATE_PATH = '/home/fake-user/.aluy/auto-update.json';
const NPM_SCRIPT = '/usr/lib/node_modules/@hiperplano/aluy-cli/dist/bin/aluy.js';
const REPO_SCRIPT = '/home/dev/aluy-cli/packages/cli/dist/bin/aluy.js';

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('autoUpdateEnabled — precedência kill-switch > ALUY_AUTO_UPDATE > config > default ON', () => {
  it.each([
    ['ALUY_NO_UPDATE_CHECK', '1'],
    ['NO_UPDATE_NOTIFIER', '1'],
    ['CI', 'true'],
  ])('%s=%s desliga MESMO com config/env pedindo ligado', (key, value) => {
    expect(autoUpdateEnabled({ [key]: value, ALUY_AUTO_UPDATE: '1' }, true)).toBe(false);
  });

  it('ALUY_AUTO_UPDATE=0 desliga mesmo com config true', () => {
    expect(autoUpdateEnabled({ ALUY_AUTO_UPDATE: '0' }, true)).toBe(false);
  });

  it('ALUY_AUTO_UPDATE=1 liga mesmo com config false', () => {
    expect(autoUpdateEnabled({ ALUY_AUTO_UPDATE: '1' }, false)).toBe(true);
  });

  it('sem env algum: config decide', () => {
    expect(autoUpdateEnabled({}, false)).toBe(false);
    expect(autoUpdateEnabled({}, true)).toBe(true);
  });

  it('sem env e sem config (undefined): default LIGADO (decisão do dono)', () => {
    expect(autoUpdateEnabled({}, undefined)).toBe(true);
  });
});

describe('isNpmGlobalInstall — repo NUNCA tenta instalar', () => {
  it('caminho dentro de node_modules/@hiperplano/aluy-cli/ ⇒ true', () => {
    expect(isNpmGlobalInstall(NPM_SCRIPT, (p) => p)).toBe(true);
  });

  it('caminho de checkout do repo (sem node_modules do pacote) ⇒ false', () => {
    expect(isNpmGlobalInstall(REPO_SCRIPT, (p) => p)).toBe(false);
  });

  it('sem scriptPath ⇒ false (postura conservadora)', () => {
    expect(isNpmGlobalInstall(undefined, (p) => p)).toBe(false);
  });

  it('realpath lança (symlink quebrado) ⇒ false, não propaga', () => {
    const realpath = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(isNpmGlobalInstall(NPM_SCRIPT, realpath)).toBe(false);
  });
});

describe('readAutoUpdateNote', () => {
  it('kill-switch ligado ⇒ undefined, sem tocar o fs', () => {
    expect(readAutoUpdateNote('1.0.0-rc.137', { CI: 'true' })).toBeUndefined();
    expect(mockExists).not.toHaveBeenCalled();
  });

  it('sem estado (nunca instalou) ⇒ undefined', () => {
    mockExists.mockReturnValue(false);
    expect(readAutoUpdateNote('1.0.0-rc.137', {})).toBeUndefined();
  });

  it('estado corrompido ⇒ undefined, sem lançar', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('{not json');
    expect(readAutoUpdateNote('1.0.0-rc.137', {})).toBeUndefined();
  });

  it('versão em disco é a MESMA que já está rodando ⇒ undefined (nada a avisar)', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: Date.now(), installedOnDisk: '1.0.0-rc.137' }),
    );
    expect(readAutoUpdateNote('1.0.0-rc.137', {})).toBeUndefined();
  });

  it('versão em disco é MAIS NOVA que a rodando ⇒ nota de reinício', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: Date.now(), installedOnDisk: '1.0.0-rc.138' }),
    );
    const note = readAutoUpdateNote('1.0.0-rc.137', {});
    expect(note).toContain('1.0.0-rc.138');
    expect(note).toContain('1.0.0-rc.137');
    expect(note?.toLowerCase()).toContain('reinicie');
  });
});

describe('runAutoUpdate — orquestração fim-a-fim (fetch por dist-tag → decide → spawn → grava)', () => {
  it('desligado (config false, sem env) ⇒ nem olha instalação, nem faz fetch', async () => {
    await runAutoUpdate('1.0.0-rc.137', {}, false, { fetch: mockFetch });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExists).not.toHaveBeenCalled();
  });

  it('rodando do repo ⇒ nunca faz fetch nem spawn (guarda de instalação vem ANTES da rede)', async () => {
    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: REPO_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('estado ainda FRESCO (< 1 dia) ⇒ não faz fetch', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ lastCheck: Date.now() }));
    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('busca no dist-tag CERTO do canal instalado (rc → tag "rc", não "latest")', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.137' }) });
    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('registry.npmjs.org');
    expect(url).toContain('%2faluy-cli');
    expect(url.endsWith('/rc')).toBe(true);
  });

  it('estável instalada ⇒ busca no dist-tag "latest"', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0' }) });
    await runAutoUpdate('1.0.0', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url.endsWith('/latest')).toBe(true);
  });

  it('candidato MAIS NOVO no MESMO canal ⇒ spawna `npm install -g` e grava a versão instalada', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.138' }) });

    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return child as never;
    });

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@hiperplano/aluy-cli@1.0.0-rc.138'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mockMkdir).toHaveBeenCalledWith('/home/fake-user/.aluy', { recursive: true });
    const [path, body] = mockWrite.mock.calls[0] as [string, string];
    expect(path).toBe(STATE_PATH);
    expect(JSON.parse(body)).toMatchObject({ installedOnDisk: '1.0.0-rc.138' });
  });

  it('GUARDA DE CANAL: rc instalado, "latest" (estável) publicado ⇒ NÃO spawna (shouldAutoUpdate barra)', async () => {
    // cenário: dist-tag 'rc' do npm por algum motivo aponta pra uma estável — nunca deveria,
    // mas a decisão pura tem que blindar mesmo assim (defesa em profundidade).
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0' }) });
    const spawnImpl = vi.fn();

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('candidato IGUAL ao instalado ⇒ não spawna, mas grava o check (rate-limit vale)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.137' }) });
    const spawnImpl = vi.fn();

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('resposta NÃO-ok do registry ⇒ silêncio, NÃO grava o cache (tenta de novo no próximo boot)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ version: '1.0.0-rc.138' }) });

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('fetch lança (offline/timeout) ⇒ silêncio total, nunca propaga, não grava cache', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockRejectedValue(new Error('network down'));

    await expect(
      runAutoUpdate('1.0.0-rc.137', {}, true, {
        scriptPath: NPM_SCRIPT,
        realpath: (p) => p,
        fetch: mockFetch,
      }),
    ).resolves.toBeUndefined();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('npm install falha (exit≠0) ⇒ NÃO grava installedOnDisk, mas grava o lastCheck (rate-limit)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.138' }) });

    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 1));
      return child as never;
    });

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    const [, body] = mockWrite.mock.calls[0] as [string, string];
    expect(JSON.parse(body)).not.toHaveProperty('installedOnDisk');
  });

  it('spawn lança (ex.: sem npm no PATH, ENOENT síncrono) ⇒ silêncio, não propaga', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.138' }) });
    const spawnImpl = vi.fn(() => {
      throw new Error('ENOENT: npm não encontrado');
    });

    await expect(
      runAutoUpdate('1.0.0-rc.137', {}, true, {
        scriptPath: NPM_SCRIPT,
        realpath: (p) => p,
        fetch: mockFetch,
        spawn: spawnImpl as never,
      }),
    ).resolves.toBeUndefined();
  });
});

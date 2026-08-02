// Update-notifier (padrão "cache + refresh async", igual ao update-notifier do npm):
// `readUpdateNote` lê o cache (síncrono, offline) e `refreshUpdateCheck` refresca (no
// máx. 1x/dia) com um fetch FAIL-SOFT ao registry. Cobre: off por env (3 flags), cache
// ausente/corrompido/malformado, isNewer (nota aparece/não aparece), o rate-limit de
// 1x/dia, fetch não-ok / versão não-string / erro de rede (silêncio, nunca escreve nem
// lança), e a escrita bem-sucedida do cache (dir + arquivo 0600).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/fake-user',
}));

import { readUpdateNote, refreshUpdateCheck } from '../../src/io/update-check.js';

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);
const mockMkdir = vi.mocked(mkdirSync);

const CACHE_PATH = '/home/fake-user/.aluy/update-check.json';
const DAY_MS = 24 * 60 * 60 * 1000;

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('readUpdateNote — desligado por env', () => {
  it.each([
    ['ALUY_NO_UPDATE_CHECK', '1'],
    ['NO_UPDATE_NOTIFIER', '1'],
    ['CI', 'true'],
  ])('%s=%s ⇒ undefined, sem tocar o fs', (key, value) => {
    const note = readUpdateNote('1.0.0', { [key]: value });
    expect(note).toBeUndefined();
    expect(mockExists).not.toHaveBeenCalled();
  });
});

describe('readUpdateNote — cache', () => {
  it('sem cache (arquivo ausente) ⇒ undefined', () => {
    mockExists.mockReturnValue(false);
    expect(readUpdateNote('1.0.0', {})).toBeUndefined();
  });

  it('cache CORROMPIDO (JSON inválido) ⇒ undefined, sem lançar', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('{not json');
    expect(readUpdateNote('1.0.0', {})).toBeUndefined();
  });

  it('cache com shape ERRADO (campos faltando/tipo errado) ⇒ undefined', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ lastCheck: 'não-é-número', latest: '2.0.0' }));
    expect(readUpdateNote('1.0.0', {})).toBeUndefined();
  });

  it('cache válido, versão instalada já é a MAIS NOVA ⇒ undefined (sem nota)', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ lastCheck: Date.now(), latest: '1.0.0' }));
    expect(readUpdateNote('1.0.0', {})).toBeUndefined();
  });

  it('cache válido com versão MAIS NOVA ⇒ nota com o comando de update', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ lastCheck: Date.now(), latest: '2.5.0' }));
    const note = readUpdateNote('1.0.0', {});
    expect(note).toContain('2.5.0');
    expect(note).toContain('1.0.0');
    expect(note).toContain('npm i -g @hiperplano/aluy-cli');
  });
});

describe('refreshUpdateCheck — desligado por env', () => {
  it.each([
    ['ALUY_NO_UPDATE_CHECK', '1'],
    ['NO_UPDATE_NOTIFIER', '1'],
    ['CI', 'true'],
  ])('%s=%s ⇒ não faz fetch', async (key, value) => {
    await refreshUpdateCheck('1.0.0', { [key]: value });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('refreshUpdateCheck — rate limit (1x/dia)', () => {
  it('cache ainda FRESCO (< 1 dia) ⇒ não faz fetch', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ lastCheck: Date.now(), latest: '1.0.0' }));
    await refreshUpdateCheck('1.0.0', {});
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('cache VELHO (>= 1 dia) ⇒ faz fetch', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: Date.now() - DAY_MS - 1000, latest: '1.0.0' }),
    );
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.1.0' }) });
    await refreshUpdateCheck('1.0.0', {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('registry.npmjs.org');
    expect(url).toContain('%2faluy-cli');
  });

  it('sem cache algum ⇒ faz fetch', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.1.0' }) });
    await refreshUpdateCheck('1.0.0', {});
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('refreshUpdateCheck — escrita fail-soft do cache', () => {
  beforeEach(() => mockExists.mockReturnValue(false));

  it('fetch OK com versão válida ⇒ escreve dir (recursive) + arquivo 0600', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '3.0.0' }) });
    await refreshUpdateCheck('1.0.0', {});
    expect(mockMkdir).toHaveBeenCalledWith('/home/fake-user/.aluy', { recursive: true });
    expect(mockWrite).toHaveBeenCalledTimes(1);
    const [path, body, opts] = mockWrite.mock.calls[0] as [string, string, { mode: number }];
    expect(path).toBe(CACHE_PATH);
    expect(JSON.parse(body)).toMatchObject({ latest: '3.0.0' });
    expect(opts.mode).toBe(0o600);
  });

  it('resposta NÃO-ok (ex.: 404/500) ⇒ silêncio, não escreve', async () => {
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ version: '3.0.0' }) });
    await refreshUpdateCheck('1.0.0', {});
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('versão no payload não é string ⇒ silêncio, não escreve', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: 42 }) });
    await refreshUpdateCheck('1.0.0', {});
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('fetch lança (offline/timeout) ⇒ silêncio, nunca propaga o erro', async () => {
    mockFetch.mockRejectedValue(new Error('network down'));
    await expect(refreshUpdateCheck('1.0.0', {})).resolves.toBeUndefined();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

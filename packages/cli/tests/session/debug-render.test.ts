// Cobertura da instrumentação OPCIONAL do render (`ALUY_DEBUG_RENDER`): o toggle
// (`debugRenderEnabled`, incl. os valores falsy explícitos '0'/'false') e o append
// best-effort (`debugRenderLog`) — OFF por default (custo zero, sem escrita) e
// NUNCA lança mesmo se o `fs` falhar (a instrumentação não pode quebrar o render).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const appendFileSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/fake-user',
}));

describe('debugRenderEnabled — toggle por env', () => {
  it('ausente ⇒ desligado', async () => {
    const { debugRenderEnabled } = await import('../../src/session/debug-render.js');
    expect(debugRenderEnabled({})).toBe(false);
  });

  it.each(['', '0', 'false'])('valor falsy explícito %j ⇒ desligado', async (v) => {
    const { debugRenderEnabled } = await import('../../src/session/debug-render.js');
    expect(debugRenderEnabled({ ALUY_DEBUG_RENDER: v })).toBe(false);
  });

  it.each(['1', 'true', 'qualquer-coisa'])('valor "ligado" %j ⇒ ligado', async (v) => {
    const { debugRenderEnabled } = await import('../../src/session/debug-render.js');
    expect(debugRenderEnabled({ ALUY_DEBUG_RENDER: v })).toBe(true);
  });

  it('sem argumento, usa process.env real', async () => {
    const { debugRenderEnabled } = await import('../../src/session/debug-render.js');
    vi.stubEnv('ALUY_DEBUG_RENDER', '1');
    expect(debugRenderEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});

describe('debugRenderLog — append best-effort (guarded por env real)', () => {
  beforeEach(() => {
    vi.resetModules();
    appendFileSyncMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('desligado (env ausente) ⇒ NÃO escreve nada (custo zero)', async () => {
    vi.stubEnv('ALUY_DEBUG_RENDER', undefined);
    const { debugRenderLog } = await import('../../src/session/debug-render.js');
    debugRenderLog('linha de teste');
    expect(appendFileSyncMock).not.toHaveBeenCalled();
  });

  it('ligado ⇒ faz append em ~/.aluy/render-debug.log com timestamp ISO + msg', async () => {
    vi.stubEnv('ALUY_DEBUG_RENDER', '1');
    const { debugRenderLog } = await import('../../src/session/debug-render.js');
    debugRenderLog('gatilho: resize');
    expect(appendFileSyncMock).toHaveBeenCalledTimes(1);
    const [path, line] = appendFileSyncMock.mock.calls[0] as [string, string];
    expect(path).toBe('/home/fake-user/.aluy/render-debug.log');
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z gatilho: resize\n$/);
  });

  it('chamadas subsequentes reusam o path cacheado (mesmo módulo)', async () => {
    vi.stubEnv('ALUY_DEBUG_RENDER', '1');
    const { debugRenderLog } = await import('../../src/session/debug-render.js');
    debugRenderLog('primeira');
    debugRenderLog('segunda');
    expect(appendFileSyncMock).toHaveBeenCalledTimes(2);
    const path1 = (appendFileSyncMock.mock.calls[0] as [string, string])[0];
    const path2 = (appendFileSyncMock.mock.calls[1] as [string, string])[0];
    expect(path1).toBe(path2);
  });

  it('fs falha (ex.: disco cheio) ⇒ NUNCA lança (best-effort)', async () => {
    vi.stubEnv('ALUY_DEBUG_RENDER', '1');
    appendFileSyncMock.mockImplementation(() => {
      throw new Error('ENOSPC');
    });
    const { debugRenderLog } = await import('../../src/session/debug-render.js');
    expect(() => debugRenderLog('linha')).not.toThrow();
  });
});

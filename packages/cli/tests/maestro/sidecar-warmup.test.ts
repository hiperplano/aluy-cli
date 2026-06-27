// F90 — warm-up dos sidecars pós-boot. Prova que manda a query dummy certa p/ cada
// sidecar, é fail-safe (fetch que rejeita não derruba), e respeita os targets.

import { describe, it, expect, vi } from 'vitest';
import { warmupSidecars } from '../../src/maestro/sidecar-warmup.js';

function recordingFetch() {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe('F90 — warmupSidecars', () => {
  it('mem0: manda um search dummy p/ carregar embedder+chromadb', async () => {
    const { fetchFn, calls } = recordingFetch();
    await warmupSidecars({ targets: new Set(['mem0']), fetchFn, env: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(':11435'); // porta default do mem0
    expect(calls[0]!.url).toContain('/v1/memories/');
    expect(calls[0]!.url).toContain('query=warmup');
  });

  it('ollama: manda um generate dummy com o JUDGE_MODEL + keep_alive (PINA o qwen)', async () => {
    const { fetchFn, calls } = recordingFetch();
    await warmupSidecars({ targets: new Set(['ollama']), fetchFn, env: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain(':11434'); // porta default do ollama
    expect(calls[0]!.url).toContain('/api/generate');
    const body = JSON.parse(String(calls[0]!.init?.body));
    expect(body.model).toBe('qwen2.5:0.5b');
    expect(body.keep_alive).toBe('30m'); // pina contra eviction por idle.
  });

  it('os dois alvos ⇒ 2 pings (mem0 + ollama)', async () => {
    const { fetchFn, calls } = recordingFetch();
    await warmupSidecars({ targets: new Set(['mem0', 'ollama']), fetchFn, env: {} });
    expect(calls).toHaveLength(2);
  });

  it('FAIL-SAFE: um fetch que REJEITA não derruba o warm-up (nunca lança)', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('sidecar fora');
    }) as unknown as typeof fetch;
    await expect(
      warmupSidecars({ targets: new Set(['mem0', 'ollama']), fetchFn, env: {} }),
    ).resolves.toBeUndefined();
  });

  it('targets vazio ⇒ nenhum ping', async () => {
    const { fetchFn, calls } = recordingFetch();
    await warmupSidecars({ targets: new Set(), fetchFn, env: {} });
    expect(calls).toHaveLength(0);
  });

  it('respeita override de URL via env (ALUY_MEM0_URL / ALUY_OLLAMA_URL)', async () => {
    const { fetchFn, calls } = recordingFetch();
    await warmupSidecars({
      targets: new Set(['mem0', 'ollama']),
      fetchFn,
      env: { ALUY_MEM0_URL: 'http://127.0.0.1:9999', ALUY_OLLAMA_URL: 'http://127.0.0.1:8888' },
    });
    expect(calls.some((c) => c.url.includes(':9999'))).toBe(true);
    expect(calls.some((c) => c.url.includes(':8888'))).toBe(true);
  });
});

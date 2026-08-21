// BUG (relato do dono: "só o tokenrouter não traz a lista de modelos") — MEDIDO no
// gateway dele: `GET {base}/models` responde **400**, e `GET {base}/models?` — a MESMA
// URL com uma query string VAZIA — responde **200** com os 127 modelos. Defeito do
// roteador daquele gateway, mas o efeito era o dono achar que o aluy não listava os
// modelos DELE (caía no catálogo estático) enquanto listava os de todos os outros.
import { describe, expect, it } from 'vitest';
import { fetchModelsSlugs } from '../../src/model/local/context-window-discovery.js';

function fakeFetch(rotas: Record<string, { status: number; body?: unknown }>) {
  const vistas: string[] = [];
  const impl = async (url: string): Promise<Response> => {
    vistas.push(url);
    const r = rotas[url] ?? { status: 404 };
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => JSON.stringify(r.body ?? {}),
    } as unknown as Response;
  };
  return { impl, vistas };
}

const BASE = 'https://api.exemplo.com/v1';
const corpo = { data: [{ id: 'a/b', context_length: 128000 }, { id: 'c/d' }] };

describe('descoberta de modelos — a 2ª tentativa com query vazia', () => {
  it('A ORIGEM — 400 na URL nua, 200 com `?` ⇒ a lista chega', async () => {
    const { impl, vistas } = fakeFetch({
      [`${BASE}/models`]: { status: 400 },
      [`${BASE}/models?`]: { status: 200, body: corpo },
    });
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: BASE,
      key: 'k',
      fetchImpl: impl as never,
    });
    expect(slugs).toEqual(['a/b', 'c/d']);
    expect(vistas).toEqual([`${BASE}/models`, `${BASE}/models?`]);
  });

  it('quem já responde 200 NÃO ganha chamada extra (não-regressão)', async () => {
    const { impl, vistas } = fakeFetch({ [`${BASE}/models`]: { status: 200, body: corpo } });
    await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: BASE,
      key: 'k',
      fetchImpl: impl as never,
    });
    expect(vistas).toHaveLength(1);
  });

  it('401 NÃO repete — é credencial, e repetir gasta tentativa em provider com rate limit', async () => {
    const { impl, vistas } = fakeFetch({ [`${BASE}/models`]: { status: 401 } });
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: BASE,
      key: 'k',
      fetchImpl: impl as never,
    });
    expect(slugs).toEqual([]);
    expect(vistas).toHaveLength(1);
  });

  it('5xx NÃO repete — é falha do servidor, não de forma da URL', async () => {
    const { impl, vistas } = fakeFetch({ [`${BASE}/models`]: { status: 503 } });
    await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: BASE,
      key: 'k',
      fetchImpl: impl as never,
    });
    expect(vistas).toHaveLength(1);
  });

  it('as duas falhando ⇒ lista vazia, sem lançar (fail-open preservado)', async () => {
    const { impl } = fakeFetch({
      [`${BASE}/models`]: { status: 400 },
      [`${BASE}/models?`]: { status: 400 },
    });
    await expect(
      fetchModelsSlugs({
        wireFormat: 'openai-compat',
        baseUrl: BASE,
        key: 'k',
        fetchImpl: impl as never,
      }),
    ).resolves.toEqual([]);
  });
});

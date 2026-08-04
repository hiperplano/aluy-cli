// F-WIN (descoberta) — I/O da descoberta automática da janela de contexto BYO,
// testado ISOLADO (sem bootar a TUI/run.tsx — mesmo padrão do
// `test-then-register.test.ts`). O que esta bateria protege:
//   - o CAMINHO FELIZ: `/models` informa `context_length` ⇒ descobre + persiste;
//   - o FAIL-OPEN em TODAS as formas de falha (provider que não informa a janela, 401,
//     404, rede fora, timeout, corpo não-JSON, redirect bloqueado pelo anti-SSRF,
//     credencial ausente): NADA lança, resultado = "não descoberto" ⇒ o chamador
//     degrada p/ o comportamento de hoje (janela 0/inerte);
//   - as travas anti-runaway (1 chamada de rede por sessão, memo por slug, teto);
//   - a disciplina de credencial/HTTP (GET sem body, `Bearer` só quando há chave,
//     `auth:'none'` sem header, wireFormat não-OpenAI nem sai da máquina).

import { describe, expect, it, vi } from 'vitest';
import {
  createDiscoverContextWindowPort,
  fetchModelsContexts,
  fetchModelsSlugs,
  createListModelNamesPort,
  MAX_CONTEXT_DISCOVERIES_PER_SESSION,
  MAX_MODELS_BODY_CHARS,
} from '../../../src/model/local/context-window-discovery.js';
import type { ConnectivityFetch } from '../../../src/model/local/connectivity-check.js';

/** `fetchImpl` fake que devolve um corpo fixo e registra url/headers/método de cada chamada. */
function fakeFetch(opts: {
  readonly body?: unknown;
  readonly text?: string;
  readonly ok?: boolean;
  readonly status?: number;
  readonly throws?: Error;
}): {
  fetchImpl: ConnectivityFetch;
  calls: { url: string; method: string; headers: Record<string, string>; hasBody: boolean }[];
} {
  const calls: {
    url: string;
    method: string;
    headers: Record<string, string>;
    hasBody: boolean;
  }[] = [];
  const fetchImpl: ConnectivityFetch = async (input, init) => {
    calls.push({
      url: input,
      method: init.method,
      headers: init.headers,
      hasBody: init.body !== undefined,
    });
    if (opts.throws) throw opts.throws;
    return {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      text: async () => opts.text ?? JSON.stringify(opts.body ?? {}),
    };
  };
  return { fetchImpl, calls };
}

const LIST_BODY = {
  object: 'list',
  data: [
    { id: 'zai/glm-4.6', context_length: 200000 },
    { id: 'outro/modelo', context_length: 32768 },
  ],
};

function port(overrides: {
  readonly fetchImpl?: ConnectivityFetch;
  readonly getKey?: () => Promise<string>;
  readonly persistContextWindow?: (slug: string, tokens: number) => boolean;
  readonly wireFormat?: string;
  readonly baseUrl?: string;
  readonly maxDiscoveriesPerSession?: number;
}) {
  return createDiscoverContextWindowPort({
    wireFormat: overrides.wireFormat ?? 'openai-compat',
    baseUrl: overrides.baseUrl ?? 'https://gateway.test/v1',
    fetchImpl: overrides.fetchImpl ?? fakeFetch({ body: LIST_BODY }).fetchImpl,
    getKey: overrides.getKey ?? (async () => 'sk-test'),
    ...(overrides.persistContextWindow !== undefined
      ? { persistContextWindow: overrides.persistContextWindow }
      : {}),
    ...(overrides.maxDiscoveriesPerSession !== undefined
      ? { maxDiscoveriesPerSession: overrides.maxDiscoveriesPerSession }
      : {}),
  });
}

describe('caminho feliz — o provider informa a janela', () => {
  it('descobre o slug ativo e PERSISTE (append idempotente no config)', async () => {
    const persisted: [string, number][] = [];
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    const p = port({
      fetchImpl,
      persistContextWindow: (slug, tokens) => {
        persisted.push([slug, tokens]);
        return true;
      },
    });
    expect(await p('zai/glm-4.6')).toEqual({ window: 200000, persisted: true });
    expect(persisted).toEqual([['zai/glm-4.6', 200000]]);
    // Pergunta ao endpoint do PRÓPRIO provider, GET, sem body (GET com body faz o
    // fetch do Node lançar antes da rede), com a credencial só no header.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gateway.test/v1/models');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.hasBody).toBe(false);
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
  });

  it('persistência que FALHA (built-in sem entrada no config) ⇒ janela vale p/ a sessão', async () => {
    const p = port({ persistContextWindow: () => false });
    expect(await p('zai/glm-4.6')).toEqual({ window: 200000, persisted: false });
  });

  it('persistência que LANÇA (disco cheio/read-only) NÃO invalida a descoberta', async () => {
    const p = port({
      persistContextWindow: () => {
        throw new Error('EROFS');
      },
    });
    expect(await p('zai/glm-4.6')).toEqual({ window: 200000, persisted: false });
  });

  it('`auth:none` (Ollama, chave vazia) ⇒ SEM header `authorization`', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    const p = port({ fetchImpl, getKey: async () => '' });
    await p('zai/glm-4.6');
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });
});

describe('FAIL-OPEN — nada quebra quando a descoberta não é possível', () => {
  it('provider que NÃO informa `context_length` (a spec da OpenAI não obriga) ⇒ inerte', async () => {
    const p = port({
      fetchImpl: fakeFetch({ body: { data: [{ id: 'zai/glm-4.6', object: 'model' }] } }).fetchImpl,
    });
    expect(await p('zai/glm-4.6')).toEqual({ window: 0, persisted: false });
  });

  it('slug ativo AUSENTE da lista ⇒ inerte (nunca herda a janela de um vizinho)', async () => {
    const p = port({});
    expect(await p('modelo/que-nao-esta-na-lista')).toEqual({ window: 0, persisted: false });
  });

  it('janela IMPLAUSÍVEL informada pelo provider ⇒ inerte (não persiste lixo)', async () => {
    const persist = vi.fn(() => true);
    const p = port({
      fetchImpl: fakeFetch({ body: { data: [{ id: 'x/y', context_length: 1 }] } }).fetchImpl,
      persistContextWindow: persist,
    });
    expect(await p('x/y')).toEqual({ window: 0, persisted: false });
    expect(persist).not.toHaveBeenCalled();
  });

  it('401/403 (chave inválida) ⇒ inerte, sem erro e sem throw', async () => {
    const p = port({ fetchImpl: fakeFetch({ ok: false, status: 401 }).fetchImpl });
    await expect(p('zai/glm-4.6')).resolves.toEqual({ window: 0, persisted: false });
  });

  it('404 (provider sem `/models`) ⇒ inerte', async () => {
    const p = port({ fetchImpl: fakeFetch({ ok: false, status: 404 }).fetchImpl });
    await expect(p('zai/glm-4.6')).resolves.toEqual({ window: 0, persisted: false });
  });

  it('rede fora / timeout / redirect BLOQUEADO pelo anti-SSRF ⇒ inerte, NUNCA rejeita', async () => {
    for (const err of [
      new Error('ECONNREFUSED'),
      Object.assign(new Error('cancelado'), { name: 'AbortError' }),
      new Error('backend local: redirect (302 → http://169.254.169.254/) BLOQUEADO'),
    ]) {
      const p = port({ fetchImpl: fakeFetch({ throws: err }).fetchImpl });
      await expect(p('zai/glm-4.6')).resolves.toEqual({ window: 0, persisted: false });
    }
  });

  it('corpo NÃO-JSON (HTML de portal cativo/proxy) ⇒ inerte', async () => {
    const p = port({ fetchImpl: fakeFetch({ text: '<html>login</html>' }).fetchImpl });
    await expect(p('zai/glm-4.6')).resolves.toEqual({ window: 0, persisted: false });
  });

  it('corpo ABSURDAMENTE grande ⇒ inerte (nem tenta o JSON.parse)', async () => {
    const huge = `[${'"x",'.repeat(MAX_MODELS_BODY_CHARS / 4)}"x"]`;
    const p = port({ fetchImpl: fakeFetch({ text: huge }).fetchImpl });
    await expect(p('zai/glm-4.6')).resolves.toEqual({ window: 0, persisted: false });
  });

  it('credencial AUSENTE (`getKey` lança) ⇒ inerte, sem derrubar a sessão', async () => {
    const p = port({
      getKey: async () => {
        throw new Error('MissingLocalCredentialError');
      },
    });
    await expect(p('zai/glm-4.6')).resolves.toEqual({ window: 0, persisted: false });
  });

  it('slug vazio ⇒ inerte SEM tocar a rede', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    const p = port({ fetchImpl });
    expect(await p('   ')).toEqual({ window: 0, persisted: false });
    expect(calls).toHaveLength(0);
  });
});

describe('wireFormat — só o dialeto OpenAI-compat expõe janela no /models', () => {
  it('`anthropic` (o /v1/models dele não traz janela) ⇒ nem sai da máquina', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    const p = port({ fetchImpl, wireFormat: 'anthropic' });
    expect(await p('claude-x')).toEqual({ window: 0, persisted: false });
    expect(calls).toHaveLength(0);
  });

  it('`baseUrl` vazio ⇒ nem sai da máquina', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    const p = port({ fetchImpl, baseUrl: '' });
    expect(await p('x/y')).toEqual({ window: 0, persisted: false });
    expect(calls).toHaveLength(0);
  });
});

describe('anti-runaway (COND-S3, espelhando o ADR-0153)', () => {
  it('a lista `/models` é buscada UMA vez por sessão, mesmo com N slugs', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    const p = port({ fetchImpl });
    await Promise.all([p('zai/glm-4.6'), p('outro/modelo'), p('nao/existe')]);
    expect(calls).toHaveLength(1);
  });

  it('o MESMO slug é memoizado (inclusive o "não descoberto")', async () => {
    const { fetchImpl, calls } = fakeFetch({ ok: false, status: 500 });
    const p = port({ fetchImpl });
    await p('zai/glm-4.6');
    await p('ZAI/GLM-4.6'); // memo case-insensitive
    expect(calls).toHaveLength(1);
  });

  it('a persistência não repete p/ o mesmo slug (descobre uma vez, nunca mais)', async () => {
    const persist = vi.fn(() => true);
    const p = port({ persistContextWindow: persist });
    await p('zai/glm-4.6');
    await p('zai/glm-4.6');
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('teto de slugs distintos: além dele responde "não descoberto" sem consultar', async () => {
    const p = port({ maxDiscoveriesPerSession: 2 });
    expect((await p('zai/glm-4.6')).window).toBe(200000);
    expect((await p('outro/modelo')).window).toBe(32768);
    // 3º slug distinto: barrado pelo teto — e o teto NÃO afrouxa depois.
    expect(await p('zai/glm-4.6-turbo')).toEqual({ window: 0, persisted: false });
    expect(await p('mais/um')).toEqual({ window: 0, persisted: false });
    // Os já memoizados continuam respondendo (não foram invalidados pelo teto).
    expect((await p('zai/glm-4.6')).window).toBe(200000);
  });

  it('o default do teto é o exportado (contrato estável)', () => {
    expect(MAX_CONTEXT_DISCOVERIES_PER_SESSION).toBeGreaterThan(0);
  });
});

describe('fetchModelsContexts — a camada crua', () => {
  it('normaliza a barra final do baseUrl', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: LIST_BODY });
    await fetchModelsContexts({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1///',
      key: 'sk',
      fetchImpl,
    });
    expect(calls[0]!.url).toBe('https://gateway.test/v1/models');
  });

  it('devolve [] (nunca lança) em qualquer falha', async () => {
    const r = await fetchModelsContexts({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      key: 'sk',
      fetchImpl: fakeFetch({ throws: new Error('boom') }).fetchImpl,
    });
    expect(r).toEqual([]);
  });
});

// F-MODEL-LIVE — a lista VIVA de NOMES p/ o `<LocalModelPicker>` (`/model` sob backend
// LOCAL). O achado: o TokenRouter (provider REAL do dono) responde 19 modelos no
// `/models` SEM NENHUM campo de janela — `fetchModelsContexts`/`parseModelsListContexts`
// devolveriam `[]` (corretamente, pro CASO DELAS: descoberta de janela). Um picker de
// NOMES que reusasse aquele parse listaria ZERO modelos pra esse provider — o MESMO
// buraco, só que pro nome em vez do número. `fetchModelsSlugs`/`parseModelsListSlugs`
// existem por isto: extraem só o `id`, sem exigir janela nenhuma.
const NAMES_ONLY_BODY = {
  object: 'list',
  data: [
    { id: 'deepseek/deepseek-v4-pro', object: 'model' }, // SEM context_length (TokenRouter)
    { id: 'moonshotai/kimi-k3', object: 'model' },
    { id: 'xiaomi/mimo-v2.5-pro', context_length: 1000000 },
  ],
};

describe('fetchModelsSlugs — camada crua de NOMES (não exige janela)', () => {
  it('lista TODO slug, inclusive os sem `context_length` nenhum (caso TokenRouter)', async () => {
    const { fetchImpl } = fakeFetch({ body: NAMES_ONLY_BODY });
    const r = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://api.tokenrouter.test/v1',
      key: 'sk',
      fetchImpl,
    });
    expect(r).toEqual(['deepseek/deepseek-v4-pro', 'moonshotai/kimi-k3', 'xiaomi/mimo-v2.5-pro']);
  });

  it('MESMO fetch pinado/teto/timeout de fetchModelsContexts (via o mesmo `fetchImpl` injetado)', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: NAMES_ONLY_BODY });
    await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1///',
      key: 'sk',
      fetchImpl,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://gateway.test/v1/models');
  });

  it('devolve [] (nunca lança) em qualquer falha — MESMA disciplina fail-open', async () => {
    const r = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      key: 'sk',
      fetchImpl: fakeFetch({ ok: false, status: 401 }).fetchImpl,
    });
    expect(r).toEqual([]);
  });

  it('wireFormat não-openai-compat ⇒ nem sai da máquina', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: NAMES_ONLY_BODY });
    const r = await fetchModelsSlugs({
      wireFormat: 'anthropic',
      baseUrl: 'https://gateway.test/v1',
      key: 'sk',
      fetchImpl,
    });
    expect(r).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('createListModelNamesPort — porta memoizada p/ o picker (F-MODEL-LIVE)', () => {
  it('caminho feliz: busca a lista e devolve `ok:true`', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: NAMES_ONLY_BODY });
    const port = createListModelNamesPort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl,
      getKey: async () => 'sk-test',
    });
    const r = await port();
    expect(r.ok).toBe(true);
    expect(r.names).toEqual([
      'deepseek/deepseek-v4-pro',
      'moonshotai/kimi-k3',
      'xiaomi/mimo-v2.5-pro',
    ]);
    expect(calls[0]!.headers.authorization).toBe('Bearer sk-test');
  });

  it('memoiza — N chamadas na MESMA sessão resolvem 1 requisição de rede', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: NAMES_ONLY_BODY });
    const port = createListModelNamesPort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl,
      getKey: async () => 'sk',
    });
    await Promise.all([port(), port(), port()]);
    expect(calls).toHaveLength(1);
  });

  it('falha (401/rede/timeout) ⇒ `{names:[], ok:false}`, NUNCA lança — fallback honesto', async () => {
    const port = createListModelNamesPort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl: fakeFetch({ ok: false, status: 401 }).fetchImpl,
      getKey: async () => 'sk',
    });
    await expect(port()).resolves.toEqual({ names: [], ok: false });
  });

  it('provider responde 200 com lista VAZIA ⇒ `ok:true` (a rede respondeu; não é o mesmo caso de fallback)', async () => {
    const port = createListModelNamesPort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl: fakeFetch({ body: { object: 'list', data: [] } }).fetchImpl,
      getKey: async () => 'sk',
    });
    await expect(port()).resolves.toEqual({ names: [], ok: true });
  });

  it('credencial ausente (`getKey` lança) ⇒ fallback honesto, sem derrubar a sessão', async () => {
    const port = createListModelNamesPort({
      wireFormat: 'openai-compat',
      baseUrl: 'https://gateway.test/v1',
      fetchImpl: fakeFetch({ body: NAMES_ONLY_BODY }).fetchImpl,
      getKey: async () => {
        throw new Error('MissingLocalCredentialError');
      },
    });
    await expect(port()).resolves.toEqual({ names: [], ok: false });
  });
});

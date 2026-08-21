// BUG (relato do dono) — "na instalação, ao selecionar o provedor, não deveria ter a
// opção de já vir os modelos? isso é um pau no instalador".
//
// MEDIDO antes do conserto: `onboard.tsx` fazia ZERO chamada de rede — o passo `model`
// era um campo de texto pré-preenchido com o `defaultModel` ESTÁTICO do catálogo
// embutido, e as "sugestões" eram os poucos slugs FIXOS de `providers[].models`. Quem
// instalava digitava no escuro (o OpenRouter sozinho tem 400+ modelos reais).
//
// Este arquivo cobre a DECISÃO pura (a UI/Ink em si se verifica no TTY, mesma disciplina
// de `mcpCatalog`/`resolveOnboardLocalModel`/`digitarNoCampo`, todos do mesmo módulo):
//   1. lista veio (não-vazia) ⇒ modo picker;
//   2. lista vazia/erro/401/timeout ⇒ fallback honesto pro campo de texto de hoje —
//      testado via `fetchModelsSlugs` DE VERDADE (não reinventamos o parse de rede
//      aqui), só o `fetchImpl` é fake;
//   3. filtro por digitação (substring, case-insensitive);
//   4. cursor sempre dentro da lista FILTRADA;
//   5. janela de rolagem — nunca despeja a lista inteira na tela;
//   6. o slug ESCOLHIDO no picker é exatamente o que `resolveOnboardLocalModel` grava
//      (mesmo caminho de escrita de hoje — nenhum 2º caminho inventado).
import { describe, expect, it } from 'vitest';
import {
  decideOnboardModelListMode,
  filterModelSlugs,
  clampModelCursor,
  modelPickerWindow,
  MODEL_PICKER_WINDOW,
  resolveOnboardLocalModel,
} from '../../src/session/onboard.js';
import { fetchModelsSlugs } from '../../src/model/local/context-window-discovery.js';
import type { ConnectivityFetch } from '../../src/model/local/connectivity-check.js';

function fetchWithBody(body: unknown): ConnectivityFetch {
  return async () => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
}

function fetchWithStatus(status: number): ConnectivityFetch {
  return async () => ({ ok: false, status, text: async () => '' });
}

function fetchThatThrows(): ConnectivityFetch {
  return async () => {
    throw new Error('rede fora (baseURL/DNS/conexão recusada)');
  };
}

/** Simula um provider que nunca responde — só resolve/rejeita quando o AbortController
 * INTERNO de `fetchModelsBody` dispara o timeout (é ele quem chama `.abort()`). */
function fetchThatNeverResponds(): ConnectivityFetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
}

describe('decisão pura — lista veio vs. fallback', () => {
  it('lista não-vazia ⇒ picker', () => {
    expect(decideOnboardModelListMode(['openai/gpt-4o'])).toBe('picker');
  });

  it('lista vazia ⇒ text (fallback)', () => {
    expect(decideOnboardModelListMode([])).toBe('text');
  });
});

describe('degradação honesta — composta com o fetchModelsSlugs de verdade', () => {
  it('provider respondeu com modelos ⇒ picker', async () => {
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://example.test/v1',
      key: 'sk-teste',
      fetchImpl: fetchWithBody({
        data: [{ id: 'openai/gpt-4o' }, { id: 'anthropic/claude-3.5-sonnet' }],
      }),
    });
    expect(decideOnboardModelListMode(slugs)).toBe('picker');
    expect(slugs).toEqual(['openai/gpt-4o', 'anthropic/claude-3.5-sonnet']);
  });

  it('401 (chave inválida) ⇒ fallback, NUNCA trava nem finge lista', async () => {
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://example.test/v1',
      key: 'sk-errada',
      fetchImpl: fetchWithStatus(401),
    });
    expect(decideOnboardModelListMode(slugs)).toBe('text');
    expect(slugs).toEqual([]);
  });

  it('rede fora (fetch lança) ⇒ fallback', async () => {
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://example.test/v1',
      key: 'sk-teste',
      fetchImpl: fetchThatThrows(),
    });
    expect(decideOnboardModelListMode(slugs)).toBe('text');
  });

  it('timeout (provider nunca responde) ⇒ fallback, sem travar a instalação', async () => {
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://example.test/v1',
      key: 'sk-teste',
      fetchImpl: fetchThatNeverResponds(),
      timeoutMs: 20, // curto de propósito — só prova que o timeout de fato corta, não espera 8s
    });
    expect(decideOnboardModelListMode(slugs)).toBe('text');
  });

  it('provider respondeu 200 mas com lista genuinamente vazia ⇒ fallback', async () => {
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'https://example.test/v1',
      key: 'sk-teste',
      fetchImpl: fetchWithBody({ data: [] }),
    });
    expect(decideOnboardModelListMode(slugs)).toBe('text');
  });

  it('provider keyless (auth:none, ex.: Ollama) também consulta — chave vazia não impede', async () => {
    const slugs = await fetchModelsSlugs({
      wireFormat: 'openai-compat',
      baseUrl: 'http://localhost:11434/v1',
      key: '', // Ollama: sem credencial
      fetchImpl: fetchWithBody({ data: [{ id: 'llama3' }, { id: 'qwen2.5' }] }),
    });
    expect(decideOnboardModelListMode(slugs)).toBe('picker');
    expect(slugs).toEqual(['llama3', 'qwen2.5']);
  });
});

describe('filtro por digitação — substring, case-insensitive', () => {
  const slugs = [
    'openai/gpt-4o',
    'anthropic/claude-3.5-sonnet',
    'meta-llama/llama-3-70b',
    'OpenRouter/Auto',
  ];

  it('filtro vazio devolve a lista inteira', () => {
    expect(filterModelSlugs(slugs, '')).toEqual(slugs);
  });

  it('bate case-insensitive', () => {
    expect(filterModelSlugs(slugs, 'CLAUDE')).toEqual(['anthropic/claude-3.5-sonnet']);
  });

  it('bate em qualquer parte do slug, não só no prefixo', () => {
    expect(filterModelSlugs(slugs, 'llama')).toEqual(['meta-llama/llama-3-70b']);
  });

  it('sem nenhum match devolve lista vazia (não lança)', () => {
    expect(filterModelSlugs(slugs, 'zzz-inexistente')).toEqual([]);
  });

  it('espaço nas pontas do filtro é ignorado', () => {
    expect(filterModelSlugs(slugs, '  gpt-4o  ')).toEqual(['openai/gpt-4o']);
  });
});

describe('cursor do picker sempre dentro da lista filtrada', () => {
  it('lista vazia (filtro sem match) ⇒ 0 — nunca aponta pra fora', () => {
    expect(clampModelCursor(5, 0)).toBe(0);
  });

  it('cursor negativo ⇒ 0', () => {
    expect(clampModelCursor(-3, 10)).toBe(0);
  });

  it('cursor além do fim ⇒ último índice válido', () => {
    expect(clampModelCursor(99, 10)).toBe(9);
  });

  it('cursor já dentro do range não muda', () => {
    expect(clampModelCursor(4, 10)).toBe(4);
  });
});

describe('janela de rolagem — nunca despeja a lista inteira na tela', () => {
  it('lista menor que a janela mostra tudo, sem deslizar', () => {
    expect(modelPickerWindow(5, 2, MODEL_PICKER_WINDOW)).toEqual({ start: 0, end: 5 });
  });

  it('OpenRouter (400+) com cursor no topo mantém a janela no início', () => {
    expect(modelPickerWindow(420, 0, MODEL_PICKER_WINDOW)).toEqual({ start: 0, end: 10 });
  });

  it('cursor no fim mantém a janela colada no fim (nunca passa do total)', () => {
    expect(modelPickerWindow(420, 419, MODEL_PICKER_WINDOW)).toEqual({ start: 410, end: 420 });
  });

  it('cursor no meio desliza a janela junto, sempre do tamanho pedido', () => {
    const { start, end } = modelPickerWindow(420, 200, MODEL_PICKER_WINDOW);
    expect(start).toBeLessThanOrEqual(200);
    expect(end).toBeGreaterThan(200);
    expect(end - start).toBe(MODEL_PICKER_WINDOW);
  });
});

describe('o slug ESCOLHIDO no picker é o que vai para o config', () => {
  it('composição filtro → seleção → resolveOnboardLocalModel (mesmo caminho de escrita de hoje)', () => {
    const slugs = ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3-70b'];
    const filtered = filterModelSlugs(slugs, 'llama');
    const cursor = clampModelCursor(0, filtered.length);
    const chosen = filtered[cursor];
    expect(chosen).toBe('meta-llama/llama-3-70b');
    expect(
      resolveOnboardLocalModel({ providerId: 'openrouter', model: chosen ?? '', customModel: '' }),
    ).toBe('meta-llama/llama-3-70b');
  });

  it('ENTER sobre filtro sem match nenhum não tem o que escolher (undefined, nunca grava lixo)', () => {
    const slugs = ['openai/gpt-4o'];
    const filtered = filterModelSlugs(slugs, 'zzz-inexistente');
    const cursor = clampModelCursor(0, filtered.length);
    expect(filtered[cursor]).toBeUndefined();
  });
});

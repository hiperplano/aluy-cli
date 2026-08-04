// F-WIN (descoberta) — PARSE do `GET {baseUrl}/models` de um provider BYO. Bateria:
//   - normalização de tokens (número, `"128k"`, `"1M"`, lixo);
//   - os DIALETOS de campo em campo (`context_length`, `context_window`,
//     `max_context_length`, `max_model_len`, `context`, `top_provider.context_length`);
//   - plausibilidade (piso/teto) — o gatekeeper entre a REDE e o denominador real;
//   - tolerância a DADO_NÃO_CONFIÁVEL (corpo torto NUNCA lança, nunca inventa janela);
//   - o caso que motiva o FAIL-OPEN: provider que NÃO informa janela (spec da OpenAI).

import { describe, expect, it } from 'vitest';
import {
  parseContextTokens,
  contextFromEntry,
  parseModelsListContexts,
  parseModelsListSlugs,
  findModelContext,
  isPlausibleContextWindow,
  MIN_PLAUSIBLE_CONTEXT_TOKENS,
  MAX_PLAUSIBLE_CONTEXT_TOKENS,
  MAX_MODELS_PARSED,
} from '../../../src/model/local/context-discovery.js';

describe('parseContextTokens — normaliza o valor cru p/ TOKENS', () => {
  it('número inteiro/float ⇒ inteiro (float truncado)', () => {
    expect(parseContextTokens(131072)).toBe(131072);
    expect(parseContextTokens(131072.9)).toBe(131072);
  });

  it('string numérica e sufixos `k`/`M` (mesma gramática do catálogo)', () => {
    expect(parseContextTokens('200000')).toBe(200000);
    expect(parseContextTokens('128k')).toBe(128000);
    expect(parseContextTokens(' 256K ')).toBe(256000);
    expect(parseContextTokens('1M')).toBe(1_000_000);
    expect(parseContextTokens('1.5m')).toBe(1_500_000);
  });

  it('lixo/ausente ⇒ 0 (não informado), NUNCA lança', () => {
    for (const v of [
      undefined,
      null,
      '',
      '   ',
      'unknown',
      '128kk',
      -1,
      0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      true,
      { context_length: 10 },
      ['128k'],
    ]) {
      expect(parseContextTokens(v)).toBe(0);
    }
  });
});

describe('isPlausibleContextWindow — gatekeeper entre a REDE e o denominador', () => {
  it('aceita o intervalo plausível (inclusivo nas pontas)', () => {
    expect(isPlausibleContextWindow(MIN_PLAUSIBLE_CONTEXT_TOKENS)).toBe(true);
    expect(isPlausibleContextWindow(128_000)).toBe(true);
    expect(isPlausibleContextWindow(MAX_PLAUSIBLE_CONTEXT_TOKENS)).toBe(true);
  });

  it('recusa o minúsculo (loop de compactação) e o absurdo (compactação desligada)', () => {
    expect(isPlausibleContextWindow(1)).toBe(false);
    expect(isPlausibleContextWindow(MIN_PLAUSIBLE_CONTEXT_TOKENS - 1)).toBe(false);
    expect(isPlausibleContextWindow(MAX_PLAUSIBLE_CONTEXT_TOKENS + 1)).toBe(false);
    expect(isPlausibleContextWindow(1e18)).toBe(false);
    expect(isPlausibleContextWindow(128_000.5)).toBe(false);
  });
});

describe('contextFromEntry — os DIALETOS de campo dos agregadores', () => {
  it('lê cada campo conhecido', () => {
    expect(contextFromEntry({ context_length: 131072 })).toBe(131072);
    expect(contextFromEntry({ context_window: 32768 })).toBe(32768);
    expect(contextFromEntry({ max_context_length: 8192 })).toBe(8192);
    expect(contextFromEntry({ max_model_len: 65536 })).toBe(65536);
    expect(contextFromEntry({ context: '200k' })).toBe(200000);
  });

  it('precedência: `context_length` manda sobre os demais', () => {
    expect(contextFromEntry({ context: '8k', context_length: 200000 })).toBe(200000);
  });

  it('`top_provider.context_length` MENOR REBAIXA a nominal (janela real do roteado)', () => {
    expect(
      contextFromEntry({ context_length: 1_000_000, top_provider: { context_length: 131072 } }),
    ).toBe(131072);
  });

  it('`top_provider` MAIOR NÃO sobe a janela (conservador por construção)', () => {
    expect(
      contextFromEntry({ context_length: 32768, top_provider: { context_length: 200000 } }),
    ).toBe(32768);
  });

  it('entrada SEM nenhum campo de janela ⇒ 0 (o caso que a spec da OpenAI permite)', () => {
    expect(contextFromEntry({ id: 'gpt-x', object: 'model', owned_by: 'org' })).toBe(0);
    expect(contextFromEntry(null)).toBe(0);
    expect(contextFromEntry('nada')).toBe(0);
  });
});

describe('parseModelsListContexts — corpo do /models ⇒ pares {slug, context}', () => {
  it('envelope OpenAI-compat `{data:[…]}` (estilo OpenRouter)', () => {
    const body = {
      object: 'list',
      data: [
        { id: 'zai/glm-4.6', context_length: 200000 },
        {
          id: 'anthropic/claude',
          context_length: 200000,
          top_provider: { context_length: 128000 },
        },
      ],
    };
    expect(parseModelsListContexts(body)).toEqual([
      { slug: 'zai/glm-4.6', context: 200000 },
      { slug: 'anthropic/claude', context: 128000 },
    ]);
  });

  it('ARRAY cru no topo (servers locais) também é aceito', () => {
    expect(parseModelsListContexts([{ id: 'llama-3', max_model_len: 8192 }])).toEqual([
      { slug: 'llama-3', context: 8192 },
    ]);
  });

  it('OMITE entradas sem `id`, sem janela ou com janela implausível (nunca chuta)', () => {
    const body = {
      data: [
        { context_length: 128000 }, // sem id ⇒ inútil como chave
        { id: '   ', context_length: 128000 }, // id vazio
        { id: 'sem-janela', object: 'model' }, // o caso da spec da OpenAI
        { id: 'minusculo', context_length: 1 }, // implausível (loop de compactação)
        { id: 'absurdo', context_length: 1e18 }, // implausível (compactação inerte)
        { id: 'bom/modelo', context_length: 128000 },
      ],
    };
    expect(parseModelsListContexts(body)).toEqual([{ slug: 'bom/modelo', context: 128000 }]);
  });

  it('DESCARTA todo campo extra — nada além de `id`+janela atravessa (HG-2)', () => {
    const parsed = parseModelsListContexts({
      data: [
        { id: 'x/y', context_length: 128000, api_key_ref: 'sk-vazado', base_url: 'http://evil' },
      ],
    });
    expect(parsed).toEqual([{ slug: 'x/y', context: 128000 }]);
    expect(JSON.stringify(parsed)).not.toContain('sk-vazado');
    expect(JSON.stringify(parsed)).not.toContain('evil');
  });

  it('dedup por slug (case-insensitive) — a 1ª ocorrência vence', () => {
    const parsed = parseModelsListContexts({
      data: [
        { id: 'X/Y', context_length: 128000 },
        { id: 'x/y', context_length: 999999 },
      ],
    });
    expect(parsed).toEqual([{ slug: 'X/Y', context: 128000 }]);
  });

  it('corpo TORTO ⇒ [] e NUNCA lança (DADO_NÃO_CONFIÁVEL)', () => {
    for (const body of [
      undefined,
      null,
      42,
      'texto',
      {},
      { data: 'x' },
      { data: [null, 1, 'a'] },
    ]) {
      expect(parseModelsListContexts(body)).toEqual([]);
    }
  });

  it('teto de entradas lidas (anti-runaway) — para de acumular no MAX_MODELS_PARSED', () => {
    const data = Array.from({ length: MAX_MODELS_PARSED + 50 }, (_v, i) => ({
      id: `m-${i}`,
      context_length: 128000,
    }));
    expect(parseModelsListContexts({ data })).toHaveLength(MAX_MODELS_PARSED);
  });
});

describe('parseModelsListSlugs — corpo do /models ⇒ SÓ slugs (sem exigir janela)', () => {
  it('lê o `id` de cada entrada, INCLUSIVE as sem nenhum campo de janela (o caso do TokenRouter)', () => {
    // O achado de campo que motiva esta função: um provider pode responder 200 no
    // `/models` sem NENHUM campo de janela conhecido — `parseModelsListContexts`
    // omitiria essas entradas por completo; o picker de nomes não pode.
    const body = {
      object: 'list',
      data: [
        { id: 'deepseek/deepseek-v4-pro', object: 'model', owned_by: 'deepseek' },
        { id: 'moonshotai/kimi-k3', object: 'model' },
        { id: 'xiaomi/mimo-v2.5-pro', context_length: 1000000 },
      ],
    };
    expect(parseModelsListSlugs(body)).toEqual([
      'deepseek/deepseek-v4-pro',
      'moonshotai/kimi-k3',
      'xiaomi/mimo-v2.5-pro',
    ]);
  });

  it('ARRAY cru no topo também é aceito', () => {
    expect(parseModelsListSlugs([{ id: 'llama-3' }])).toEqual(['llama-3']);
  });

  it('OMITE entradas sem `id`/`id` vazio, mas NUNCA por falta de janela', () => {
    const body = {
      data: [
        { object: 'model' }, // sem id ⇒ inútil
        { id: '   ' }, // id vazio
        { id: 'sem-janela-nenhuma' }, // SEM context_length e ainda assim entra
      ],
    };
    expect(parseModelsListSlugs(body)).toEqual(['sem-janela-nenhuma']);
  });

  it('dedup por slug (case-insensitive) — a 1ª grafia vence', () => {
    expect(parseModelsListSlugs({ data: [{ id: 'X/Y' }, { id: 'x/y' }] })).toEqual(['X/Y']);
  });

  it('DESCARTA todo campo extra — só o `id` atravessa (HG-2)', () => {
    const parsed = parseModelsListSlugs({
      data: [{ id: 'x/y', api_key_ref: 'sk-vazado', base_url: 'http://evil' }],
    });
    expect(parsed).toEqual(['x/y']);
    expect(JSON.stringify(parsed)).not.toContain('sk-vazado');
    expect(JSON.stringify(parsed)).not.toContain('evil');
  });

  it('corpo TORTO ⇒ [] e NUNCA lança (DADO_NÃO_CONFIÁVEL)', () => {
    for (const body of [
      undefined,
      null,
      42,
      'texto',
      {},
      { data: 'x' },
      { data: [null, 1, 'a'] },
    ]) {
      expect(parseModelsListSlugs(body)).toEqual([]);
    }
  });

  it('teto de entradas lidas (anti-runaway) — para de acumular no MAX_MODELS_PARSED', () => {
    const data = Array.from({ length: MAX_MODELS_PARSED + 50 }, (_v, i) => ({ id: `m-${i}` }));
    expect(parseModelsListSlugs({ data })).toHaveLength(MAX_MODELS_PARSED);
  });
});

describe('findModelContext — casamento do slug ativo', () => {
  const list = [
    { slug: 'Zai/GLM-4.6', context: 200000 },
    { slug: 'outro/modelo', context: 32768 },
  ];

  it('casa case-insensitive e com espaço nas pontas (como o modelWindowFromConfig)', () => {
    expect(findModelContext(list, 'zai/glm-4.6')).toBe(200000);
    expect(findModelContext(list, '  ZAI/GLM-4.6 ')).toBe(200000);
  });

  it('sem casamento EXATO ⇒ undefined (nunca um vizinho parecido)', () => {
    expect(findModelContext(list, 'zai/glm-4')).toBeUndefined();
    expect(findModelContext(list, '')).toBeUndefined();
    expect(findModelContext([], 'zai/glm-4.6')).toBeUndefined();
  });
});

// Auditoria — evento `progress` (tool_args) dos adapters: é o que alimenta o contador "↓ tokens"
// da linha de trabalho enquanto o modelo escreve os argumentos de uma tool (sem texto visível).
// Antes os testes só FILTRAVAM o `progress` para comparar a ordem dos outros eventos; nada
// provava que ele sai, com o tamanho certo, nem que fragmento vazio não gera ruído.
// Também o `tokens_reasoning` do trailer de uso do OpenAI-compat.

import { describe, expect, it } from 'vitest';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { AnthropicAdapter } from '../../../src/model/local/anthropic-adapter.js';
import { newSseAccumulator } from '../../../src/model/local/adapter.js';
import type { ModelStreamEvent } from '../../../src/model/types.js';

const progresso = (ev: readonly ModelStreamEvent[]): number[] =>
  ev.flatMap((e) => (e.type === 'progress' ? [e.chars] : []));

describe('OpenAI-compat · progress dos argumentos da tool', () => {
  const adapter = (): OpenAiCompatAdapter =>
    new OpenAiCompatAdapter({ provider: 'compat', defaultBaseUrl: 'https://p.exemplo/v1' });
  const rodar = (chunks: readonly unknown[]): ModelStreamEvent[] => {
    const a = adapter();
    const acc = newSseAccumulator();
    return chunks.flatMap((c) => [...a.mapSse('', JSON.stringify(c), acc)]);
  };
  const delta = (tool_calls: unknown[]) => ({ choices: [{ delta: { tool_calls } }] });

  it('cada fragmento de `arguments` vira um progress com o seu tamanho', () => {
    const ev = rodar([
      delta([{ index: 0, id: 'c1', function: { name: 'edit_file' } }]),
      delta([{ index: 0, function: { arguments: '{"path":' } }]),
      delta([{ index: 0, function: { arguments: '"a.txt"}' } }]),
    ]);
    expect(progresso(ev)).toEqual([8, 8]);
  });

  it('várias tool-calls no MESMO delta somam os tamanhos', () => {
    const ev = rodar([
      delta([
        { index: 0, id: 'c1', function: { name: 'f', arguments: 'aaaa' } },
        { index: 1, id: 'c2', function: { name: 'g', arguments: 'bb' } },
      ]),
    ]);
    expect(progresso(ev)).toEqual([6]);
  });

  it('delta só com o nome (sem argumentos) ou com argumentos vazios NÃO gera progress', () => {
    const ev = rodar([
      delta([{ index: 0, id: 'c1', function: { name: 'edit_file' } }]),
      delta([{ index: 0, function: { arguments: '' } }]),
    ]);
    expect(progresso(ev)).toEqual([]);
  });

  it('o trailer de uso leva os tokens de raciocínio (completion_tokens_details)', () => {
    const ev = rodar([
      {
        id: 'x',
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 40,
          completion_tokens_details: { reasoning_tokens: 25 },
        },
      },
    ]);
    const uso = ev.find((e) => e.type === 'usage');
    expect(uso).toBeDefined();
    expect((uso as { usage: { tokens_reasoning?: number } }).usage.tokens_reasoning).toBe(25);
  });

  it('sem completion_tokens_details não inventa tokens_reasoning', () => {
    const ev = rodar([
      { id: 'x', choices: [], usage: { prompt_tokens: 10, completion_tokens: 40 } },
    ]);
    const uso = ev.find((e) => e.type === 'usage') as
      | { usage: { tokens_reasoning?: number } }
      | undefined;
    expect(uso?.usage.tokens_reasoning).toBeUndefined();
  });
});

describe('Anthropic · progress dos argumentos da tool (input_json_delta)', () => {
  const rodar = (partials: readonly string[]): ModelStreamEvent[] => {
    const a = new AnthropicAdapter();
    const acc = newSseAccumulator();
    const out: ModelStreamEvent[] = [];
    out.push(
      ...a.mapSse(
        'content_block_start',
        JSON.stringify({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't1', name: 'edit_file' },
        }),
        acc,
      ),
    );
    for (const p of partials) {
      out.push(
        ...a.mapSse(
          'content_block_delta',
          JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: p },
          }),
          acc,
        ),
      );
    }
    return out;
  };

  it('cada pedaço de JSON parcial vira um progress com o seu tamanho', () => {
    expect(progresso(rodar(['{"q":', '"foo"}']))).toEqual([5, 6]);
  });

  it('pedaço vazio não gera progress', () => {
    expect(progresso(rodar(['', '{"a":1}', '']))).toEqual([7]);
  });
});

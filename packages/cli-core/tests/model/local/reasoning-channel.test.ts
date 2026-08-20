// F-RAC — o RACIOCÍNIO do modelo tem canal PRÓPRIO, separado da fala.
//
// A ORIGEM: num modelo de raciocínio o `content` fica NULO enquanto ele pensa. Medido
// num `deepseek-v4-pro` real (dois provedores diferentes): 15-18 chunks só de
// raciocínio antes do PRIMEIRO token de fala. Quem lê só `content` fica sem nada para
// mostrar durante todo o trabalho — e sem NADA, para sempre, quando o turno acaba
// dentro do raciocínio (`finish_reason: 'length'`), que foi o `Λ aluy` mudo relatado.
//
// NÃO existe padrão para o nome do campo, e é por isso que aceitamos três grafias:
//   `reasoning_content`  convenção da DeepSeek (e dos relays que servem o upstream cru)
//   `reasoning`          como o OpenRouter normaliza — MEDIDO, não suposto
//   `thinking_delta`     Anthropic (extended thinking)
import { describe, expect, it } from 'vitest';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import { AnthropicAdapter } from '../../../src/model/local/anthropic-adapter.js';
import { newSseAccumulator } from '../../../src/model/local/adapter.js';
import type { ModelStreamEvent } from '../../../src/model/types.js';

function mapa(adapter: OpenAiCompatAdapter, chunks: readonly unknown[]): ModelStreamEvent[] {
  const acc = newSseAccumulator();
  const out: ModelStreamEvent[] = [];
  for (const c of chunks) out.push(...adapter.mapSse('', JSON.stringify(c), acc));
  return out;
}
const oa = (): OpenAiCompatAdapter =>
  new OpenAiCompatAdapter({ provider: 'openrouter', defaultBaseUrl: 'https://x/v1' });

const fala = (evs: readonly ModelStreamEvent[]): string =>
  evs
    .filter((e) => e.type === 'delta')
    .map((e) => (e as { content: string }).content)
    .join('');
const pensamento = (evs: readonly ModelStreamEvent[]): string =>
  evs
    .filter((e) => e.type === 'reasoning')
    .map((e) => (e as { content: string }).content)
    .join('');

describe('openai-compat — as duas grafias do raciocínio', () => {
  it('`reasoning_content` (DeepSeek) vira evento de raciocínio, não de fala', () => {
    const evs = mapa(oa(), [
      { choices: [{ delta: { content: null, reasoning_content: 'penso, ' } }] },
      { choices: [{ delta: { content: null, reasoning_content: 'logo existo' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
    ]);
    expect(pensamento(evs)).toBe('penso, logo existo');
    expect(fala(evs)).toBe('ok');
  });

  it('`reasoning` (OpenRouter) idem — MEDIDO num stream real, não suposto', () => {
    const evs = mapa(oa(), [
      { choices: [{ delta: { content: null, reasoning: 'hmm' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
    ]);
    expect(pensamento(evs)).toBe('hmm');
    expect(fala(evs)).toBe('ok');
  });

  it('REGRESSÃO — raciocínio NUNCA entra na fala (seria o rascunho virando resposta)', () => {
    const evs = mapa(oa(), [{ choices: [{ delta: { reasoning_content: 'rascunho' } }] }]);
    expect(fala(evs)).toBe('');
    expect(pensamento(evs)).toBe('rascunho');
  });

  it('turno que acaba DENTRO do raciocínio ainda entrega o pensamento (o bug de origem)', () => {
    // `finish_reason: 'length'` com `content` vazio: sem este canal o turno inteiro
    // não produzia UMA palavra para a tela.
    const evs = mapa(oa(), [
      { choices: [{ delta: { content: null, reasoning_content: 'pensando muito' } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]);
    expect(fala(evs)).toBe('');
    expect(pensamento(evs)).toBe('pensando muito');
  });

  it('sem campo de raciocínio, nada muda (não-regressão de modelo comum)', () => {
    const evs = mapa(oa(), [{ choices: [{ delta: { content: 'oi' } }] }]);
    expect(evs.filter((e) => e.type === 'reasoning')).toHaveLength(0);
    expect(fala(evs)).toBe('oi');
  });
});

describe('anthropic — thinking_delta deixa de ser descartado', () => {
  it('vira evento de raciocínio (antes: `return []` silencioso)', () => {
    const a = new AnthropicAdapter();
    const acc = newSseAccumulator();
    const evs = [
      ...a.mapSse(
        'content_block_delta',
        JSON.stringify({ index: 0, delta: { type: 'thinking_delta', thinking: 'penso' } }),
        acc,
      ),
      ...a.mapSse(
        'content_block_delta',
        JSON.stringify({ index: 0, delta: { type: 'text_delta', text: 'ok' } }),
        acc,
      ),
    ];
    expect(pensamento(evs)).toBe('penso');
    expect(fala(evs)).toBe('ok');
  });

  it('signature_delta segue descartado (é assinatura, não texto)', () => {
    const a = new AnthropicAdapter();
    const evs = a.mapSse(
      'content_block_delta',
      JSON.stringify({ index: 0, delta: { type: 'signature_delta', signature: 'abc' } }),
      newSseAccumulator(),
    );
    expect(evs).toHaveLength(0);
  });
});

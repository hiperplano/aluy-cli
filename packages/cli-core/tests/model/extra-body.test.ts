import { describe, expect, it } from 'vitest';
import { OpenAiCompatAdapter } from '../../src/model/local/openai-adapter.js';

/**
 * ROTEAMENTO DE UPSTREAM — "quero o modelo servido pela gmicloud, não por outro
 * revendedor do OpenRouter". Não há padrão: cada agregador tem seu dialeto. O aluy
 * repassa o fragmento cru e NÃO interpreta.
 */
describe('openai-adapter — fragmento de corpo cru (extraBody)', () => {
  const base = {
    model: 'qwen/qwen3-27b',
    messages: [{ role: 'user' as const, content: 'oi' }],
    maxTokens: 100,
  };
  const monta = (extra?: Record<string, unknown>) => {
    const a = new OpenAiCompatAdapter({ provider: 'openrouter' });
    const { body } = a.buildRequest({
      request: { ...base, ...(extra ? { extraBody: extra } : {}) },
      baseUrl: 'https://x/v1',
      credential: { kind: 'apikey', secret: 's' },
    });
    return JSON.parse(body) as Record<string, unknown>;
  };

  it('sem extraBody, o corpo não muda', () => {
    expect(monta()).not.toHaveProperty('provider');
  });

  it('repassa o dialeto do OpenRouter INTACTO — não interpreta nem normaliza', () => {
    const b = monta({ provider: { only: ['gmicloud'], allow_fallbacks: false } });
    expect(b.provider).toEqual({ only: ['gmicloud'], allow_fallbacks: false });
  });

  it('serve QUALQUER agregador — o aluy não conhece o vocabulário de nenhum', () => {
    const b = monta({ routing: { upstream: 'x' }, campo_inventado: 42 });
    expect(b.routing).toEqual({ upstream: 'x' });
    expect(b.campo_inventado).toBe(42);
  });

  it('NUNCA sobrescreve messages/model/stream — isso quebraria o protocolo', () => {
    const b = monta({ model: 'outro', stream: false, messages: [], provider: { only: ['g'] } });
    expect(b.model).toBe('qwen/qwen3-27b');
    expect(b.stream).toBe(true);
    expect(Array.isArray(b.messages) && (b.messages as unknown[]).length).toBe(1);
    expect(b.provider).toEqual({ only: ['g'] }); // o resto passa
  });
});

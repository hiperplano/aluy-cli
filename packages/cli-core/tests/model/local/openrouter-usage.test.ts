// A CONTABILIDADE DETALHADA do OpenRouter — sem ela o `% cache` nunca aparece.
//
// Relato do dono (10/09/2026): "no windows não está aparecendo o cache", já na rc.177 (a
// versão em que a exibição funciona) e falando com o OpenRouter.
//
// A causa: mandávamos só `stream_options:{include_usage:true}`, a convenção da OpenAI. Isso
// traz o trailer com os DOIS TOTAIS e nada mais — o `prompt_tokens_details.cached_tokens`,
// de onde sai o número do rodapé, exige pedir o detalhamento.
//
// O gate é por PROVIDER, e de propósito: campo desconhecido no corpo é ignorado pela maioria
// dos compatíveis, mas alguns respondem 400 — uma troca de provider não pode virar erro de
// requisição por causa de um extra de observabilidade.

import { describe, expect, it } from 'vitest';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';

const REQ = {
  model: 'anthropic/claude-sonnet-5',
  messages: [{ role: 'user' as const, content: 'oi' }],
  maxTokens: 100,
  system: 'sistema',
};

function corpo(provider: string, baseUrl: string): Record<string, unknown> {
  const a = new OpenAiCompatAdapter({ provider: provider as never, defaultBaseUrl: baseUrl });
  const built = a.buildRequest({
    request: REQ as never,
    baseUrl,
    credential: { secret: 'k', kind: 'apikey' } as never,
  });
  return JSON.parse(built.body) as Record<string, unknown>;
}

describe('OpenRouter recebe o pedido de contabilidade detalhada', () => {
  it('pelo ID do catálogo', () => {
    expect(corpo('openrouter', 'https://openrouter.ai/api/v1').usage).toEqual({ include: true });
  });

  it('pela baseURL — provider CUSTOM apontando para lá também conta', () => {
    // O dono já rodou um `tokenrouter` custom; gate só por id perderia esse caso, e é
    // justamente quem usa provider custom que ficaria sem o número sem entender por quê.
    expect(corpo('tokenrouter', 'https://openrouter.ai/api/v1').usage).toEqual({ include: true });
  });

  it('subdomínio de openrouter.ai também', () => {
    expect(corpo('x', 'https://api.openrouter.ai/v1').usage).toEqual({ include: true });
  });
});

describe('os demais NÃO recebem — campo desconhecido pode virar 400', () => {
  it('OpenAI direto não recebe', () => {
    expect(corpo('openai', 'https://api.openai.com/v1').usage).toBeUndefined();
  });

  it('DeepSeek, Groq e um gateway qualquer não recebem', () => {
    for (const [p, u] of [
      ['deepseek', 'https://api.deepseek.com/v1'],
      ['groq', 'https://api.groq.com/openai/v1'],
      ['custom', 'https://meu-gateway.example.com/v1'],
    ] as const) {
      expect(corpo(p, u).usage, p).toBeUndefined();
    }
  });

  it('baseURL inválida não quebra nem liga por engano', () => {
    expect(corpo('x', 'não é url').usage).toBeUndefined();
  });

  it('não casa domínio que só CONTÉM o nome (anti-falso-positivo)', () => {
    // `openrouter.ai.evil.com` não é openrouter — o casamento é por SUFIXO de hostname.
    expect(corpo('x', 'https://openrouter.ai.evil.com/v1').usage).toBeUndefined();
  });
});

describe('o que já existia segue igual', () => {
  it('o trailer de usage do stream continua sendo pedido para todos', () => {
    for (const [p, u] of [
      ['openrouter', 'https://openrouter.ai/api/v1'],
      ['openai', 'https://api.openai.com/v1'],
    ] as const) {
      expect(corpo(p, u).stream_options, p).toEqual({ include_usage: true });
    }
  });
});

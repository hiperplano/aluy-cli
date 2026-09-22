// F-TETO-DE-SAÍDA — o `max_tokens` que vai no fio quando o dono NÃO configurou nada.
//
// O defeito medido (21/09/2026, glm-5.3 na z.ai): o client local mandava `max_tokens:
// 8192` — um default escolhido porque a Anthropic exige o campo — e um modelo de raciocínio
// conta o pensamento DENTRO desse teto. Resultado: 8189 dos 8192 gastos pensando,
// `finish_reason: 'length'`, e nenhuma resposta. O teto CONHECIDO da família (dado
// público, docs.z.ai) passa a valer quando não há configuração explícita.
import { describe, expect, it } from 'vitest';
import { LocalModelClient } from '../../../src/model/local/local-client.js';
import { OpenAiCompatAdapter } from '../../../src/model/local/openai-adapter.js';
import {
  builtinMaxOutputForSlug,
  KNOWN_MODEL_MAX_OUTPUT,
} from '../../../src/model/local/known-context-windows.js';
import type { ModelCallRequest, ModelStreamEvent } from '../../../src/model/types.js';
import type { ResolvedCredential } from '../../../src/model/local/types.js';
import { makeBrokerFetch } from '../helpers.js';

const cred = async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'sk' });
const SSE =
  'data: ' +
  JSON.stringify({ id: 'c', choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) +
  '\n\ndata: [DONE]\n\n';

async function corpoEnviado(model: string, over: Partial<ModelCallRequest> = {}) {
  const { fetch, calls } = makeBrokerFetch({ status: 200, sse: SSE });
  const client = new LocalModelClient({
    adapter: new OpenAiCompatAdapter({ provider: 'compat', defaultBaseUrl: 'https://p.exemplo/v1' }),
    config: { provider: 'compat', model },
    baseUrl: 'https://p.exemplo/v1',
    getCredential: cred,
    fetch,
  });
  const gen = client.stream({
    request: { tier: 'aluy-flux', messages: [{ role: 'user', content: 'oi' }], ...over },
  });
  const it = gen as AsyncGenerator<ModelStreamEvent>;
  while (!(await it.next()).done) {
    /* drena */
  }
  return calls[0]?.body as Record<string, unknown>;
}

describe('teto de saída conhecido por família', () => {
  it('glm-5.3 sem configuração ⇒ o teto publicado pela z.ai, não 8192', async () => {
    expect((await corpoEnviado('glm-5.3')).max_tokens).toBe(131_072);
  });

  it('o que o dono configurou VENCE o teto conhecido', async () => {
    expect((await corpoEnviado('glm-5.3', { max_tokens: 4096 })).max_tokens).toBe(4096);
  });

  it('família desconhecida ⇒ o default de sempre (não-regressão)', async () => {
    expect((await corpoEnviado('modelo-sem-teto-catalogado')).max_tokens).toBe(8192);
  });

  it('casa o slug com vendor na frente (via agregador)', () => {
    expect(builtinMaxOutputForSlug('z-ai/glm-4.6')).toBe(131_072);
    expect(builtinMaxOutputForSlug('glm-4.5-air')).toBe(98_304);
    expect(builtinMaxOutputForSlug('gpt-4o')).toBeUndefined();
  });

  // Um número errado é PIOR que não ter número: nada entra sem fonte. A lista é curta de
  // propósito — se crescer, cada entrada nova tem de citar a fonte no comentário do módulo.
  it('a tabela só tem a família GLM (a única com fonte conferida)', () => {
    for (const k of Object.keys(KNOWN_MODEL_MAX_OUTPUT)) expect(k.startsWith('glm-')).toBe(true);
  });
});

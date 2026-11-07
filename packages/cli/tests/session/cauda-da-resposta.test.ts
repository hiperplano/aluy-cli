// INVESTIGAÇÃO (dono): a última resposta de uma sessão real terminava em `...\n\nZ` — a palavra
// ZIMBRO (exigida por um fato de memória) chegou só como `Z`. Hipótese: o redator de STREAM
// (retém sufixo que pode ser começo de segredo) engolia o fim, ou o adapter/SSE descartava o
// último delta. Estes testes mandam `Z` | `IMBRO` como ÚLTIMOS deltas, pelo caminho inteiro
// (SSE → adapter OpenAI-compat → StreamingModelCaller → controller), COM e SEM segredo no cofre,
// e conferem o texto persistido no bloco final. Provam que a cauda NÃO se perde por nós.

import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalModelClient,
  OpenAiCompatAdapter,
  secretVault,
  type ResolvedCredential,
  type StreamFetch,
  type StreamResponse,
} from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

function sseClient(chunks: string[], withDoneSentinel: boolean): LocalModelClient {
  const fetch: StreamFetch = async () => {
    const ev = (d: Record<string, unknown>): string => `data: ${JSON.stringify(d)}\n\n`;
    const frames: string[] = chunks.map((c, i) =>
      ev({
        id: 'c',
        choices: [
          {
            delta: { content: c },
            // o ÚLTIMO delta vem NO MESMO chunk do finish_reason (OpenRouter faz isto)
            finish_reason: i === chunks.length - 1 ? 'stop' : null,
          },
        ],
      }),
    );
    frames.push(ev({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    if (withDoneSentinel) frames.push('data: [DONE]\n\n');
    const bytes = frames.map((f) => new TextEncoder().encode(f));
    const res: StreamResponse = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: (async function* (): AsyncGenerator<Uint8Array> {
        for (const b of bytes) yield b;
      })(),
      json: async () => ({}),
      text: async () => '',
    };
    return res;
  };
  return new LocalModelClient({
    adapter: new OpenAiCompatAdapter({
      provider: 'openrouter',
      defaultBaseUrl: 'https://o.test/v1',
    }),
    config: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash', auth: 'apikey' },
    baseUrl: 'https://o.test/v1',
    getCredential: async (): Promise<ResolvedCredential> => ({ kind: 'apikey', secret: 'k' }),
    fetch,
  });
}

async function textoFinal(client: LocalModelClient): Promise<string> {
  const s = buildSession({ env: {}, brokerClient: client, mode: 'unsafe' });
  s.controller.setTier('custom', 'z-ai/glm-5.3-flash');
  await s.controller.submit('diga oi');
  const aluy = s.controller.current.blocks.filter((b) => b.kind === 'aluy');
  s.controller.dispose();
  return aluy.map((b) => (b as { text: string }).text).join('\n---\n');
}

afterEach(() => secretVault.clear());

describe('a cauda da resposta não se perde (Z | IMBRO como últimos deltas)', () => {
  for (const done of [true, false]) {
    it(`SEM segredo no cofre (${done ? 'com' : 'sem'} [DONE])`, async () => {
      const t = await textoFinal(sseClient(['Pronto!\n\n', 'Z', 'IMBRO'], done));
      expect(t).toContain('Pronto!');
      expect(t.trimEnd().endsWith('ZIMBRO')).toBe(true);
    });
    it(`COM segredo que COMEÇA com Z no cofre (${done ? 'com' : 'sem'} [DONE])`, async () => {
      secretVault.set('API_KEY', 'ZETA-segredo-bem-longo-123');
      const t = await textoFinal(sseClient(['Pronto!\n\n', 'Z', 'IMBRO'], done));
      expect(t.trimEnd().endsWith('ZIMBRO')).toBe(true);
    });
    it(`COM segredo e o stream terminando em prefixo dele: o retido é solto no fim (${done ? 'com' : 'sem'} [DONE])`, async () => {
      secretVault.set('API_KEY', 'ZETA-segredo-bem-longo-123');
      const t = await textoFinal(sseClient(['Pronto!\n\n', 'Z'], done));
      expect(t.trimEnd().endsWith('Z')).toBe(true);
    });
  }
});

// BUG (achado com provider real): o modelo respondeu que viu o rótulo "Resultado da ferramenta
// run_command (!comando)" mas que "o conteúdo real do comando não veio junto". O teste com stub
// passava porque olhava o histórico/`messages` ANTES do adapter; este olha o CORPO HTTP que sai
// pelo adapter OpenAI-compat real (`LocalModelClient`), nos dois modos de tool-calling.
//
// Prova: o corpo cru contém a saída do `!`, dentro do envelope não-confiável, sob um cabeçalho
// que diz que é a saída do terminal do dono — e a saída do `!!` NÃO sai.

import { describe, expect, it } from 'vitest';
import {
  LocalModelClient,
  OpenAiCompatAdapter,
  type ResolvedCredential,
  type StreamFetch,
  type StreamResponse,
} from '@hiperplano/aluy-cli-core';
import { buildSession } from '../../src/session/wiring.js';

const ZIMBRO = 'PALAVRA-ZIMBRO-42';
const SEGREDO = 'SEGREDO-LOCAL-77';

function client(bodies: string[]): LocalModelClient {
  const fetch: StreamFetch = async (_url, init) => {
    bodies.push(String(init.body));
    const sse =
      'data: ' +
      JSON.stringify({ id: 'c', choices: [{ delta: { content: 'ok.' }, finish_reason: 'stop' }] }) +
      '\n\ndata: [DONE]\n\n';
    const bytes = new TextEncoder().encode(sse);
    const res: StreamResponse = {
      status: 200,
      ok: true,
      headers: { get: () => null },
      body: (async function* (): AsyncGenerator<Uint8Array> {
        yield bytes;
      })(),
      json: async () => ({}),
      text: async () => sse,
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

async function rodar(env: NodeJS.ProcessEnv): Promise<{ wire: string; native: boolean }> {
  const bodies: string[] = [];
  const s = buildSession({ env, brokerClient: client(bodies), mode: 'unsafe' });
  s.controller.setTier('custom', 'z-ai/glm-5.3-flash');
  // a SAÍDA só existe se o comando RODAR (o texto do comando traz `$((40+2))`, não o 42)
  await s.controller.runBang('echo PALAVRA-ZIMBRO-$((40+2))');
  await s.controller.runBang('echo SEGREDO-LOCAL-$((70+7))', undefined, { localOnly: true });
  await s.controller.submit('sem usar ferramentas: quais palavras apareceram nas saidas do !?');
  s.controller.dispose();
  const wire = bodies.find((b) => b.includes('sem usar ferramentas')) ?? '';
  return { wire, native: (JSON.parse(wire) as { tools?: unknown }).tools !== undefined };
}

describe('`!` chega ao modelo no corpo HTTP do adapter real', () => {
  it('modo NATIVO (tools no corpo): a saída do `!` está no corpo; `!!` não', async () => {
    const { wire, native } = await rodar({});
    expect(native).toBe(true);
    const messages = (JSON.parse(wire) as { messages: { role: string; content: unknown }[] })
      .messages;
    const msg = messages.find((m) => JSON.stringify(m.content).includes(ZIMBRO));
    expect(msg?.role).toBe('user');
    const texto = JSON.stringify(msg?.content);
    expect(texto).toContain('DADO_NAO_CONFIAVEL');
    expect(texto).toMatch(/DONO rodou no terminal/);
    expect(texto).not.toMatch(/Resultado da ferramenta run_command/);
    expect(wire).not.toContain(SEGREDO);
  });

  it('modo TEXTO (sem tools): idem', async () => {
    const { wire, native } = await rodar({ ALUY_NATIVE_TOOLS_OFF: '1' });
    expect(native).toBe(false);
    expect(wire).toContain(ZIMBRO);
    expect(wire).toMatch(/DONO rodou no terminal/);
    expect(wire).not.toContain(SEGREDO);
  });
});

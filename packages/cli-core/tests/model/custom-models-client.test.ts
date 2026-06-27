// EST-0962 — testes do CustomModelClient (CLI→broker `GET /v1/models/custom`).
//
// Cobre: parse do contrato REAL (testado ao vivo) `{object,data:[{id,name,family,
// context}]}`, auth (MESMO Bearer PAT headless do chat, mesmo endpoint DEDICADO),
// tolerância (DADO_NÃO_CONFIÁVEL: id ausente ⇒ ignora; campo faltando ⇒ ''; nunca
// lança no parse), HG-2 (descarta qualquer campo sensível), e a falha estruturada
// (não-2xx ⇒ BrokerError p/ a degradação do chamador; transporte ⇒ BrokerTransportError).

import { describe, it, expect } from 'vitest';
import { CustomModelClient, parseCustomModels } from '../../src/model/custom-models-client.js';
import { BrokerError, BrokerTransportError } from '../../src/model/errors.js';
import { makeBrokerFetch } from './helpers.js';

// Recorte do contrato REAL (testado ao vivo) — a forma `{object:'list', data:[…]}`.
// EST-0962 (browser): inclui `context` (display) e `supports_tools` (EST-0996, bool).
const CUSTOM = {
  object: 'list',
  data: [
    {
      id: 'ai21/jamba-large-1.7',
      name: 'Jamba Large 1 7',
      family: 'Ai21',
      context: '256k',
      supports_tools: true,
    },
    {
      id: 'meta-llama/llama-3.1-8b-instruct',
      name: 'Llama 3.1 8B Instruct',
      family: 'Meta',
      context: '128k',
      supports_tools: false,
    },
  ],
};

function clientWith(handler: Parameters<typeof makeBrokerFetch>[0], token = 'pat-123') {
  const { fetch, calls } = makeBrokerFetch(handler);
  const client = new CustomModelClient({
    baseUrl: 'https://broker.test',
    getAccessToken: async () => token,
    fetch,
  });
  return { client, calls };
}

describe('CustomModelClient', () => {
  it('lê a lista custom e projeta {id,name,family,context,supportsTools} (o id é o slug que se envia)', async () => {
    const { client } = clientWith({ status: 200, json: CUSTOM });
    const models = await client.list();
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({
      id: 'ai21/jamba-large-1.7',
      name: 'Jamba Large 1 7',
      family: 'Ai21',
      context: '256k',
      supportsTools: true,
    });
    expect(models[1]!.id).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(models[1]!.context).toBe('128k');
    expect(models[1]!.supportsTools).toBe(false);
  });

  it('autentica com o MESMO Bearer PAT headless do chat, no GET /v1/models/custom', async () => {
    const { client, calls } = clientWith({ status: 200, json: CUSTOM }, 'pat-xyz');
    await client.list();
    // O endpoint é o DEDICADO (não o /v1/tiers/catalog), MESMO host do broker.
    expect(calls[0]!.url).toBe('https://broker.test/v1/models/custom');
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers['authorization']).toBe('Bearer pat-xyz');
  });

  it('GET SEM body (EST-0962) — Node lança se GET tem body; o catálogo custom carrega de verdade', async () => {
    // ANTES: `body: ''` ⇒ o fetch do Node LANÇAVA antes da rede ⇒ o browser de
    // modelos NUNCA recebia dado (degradava p/ texto-livre em silêncio). O fake
    // agora espelha o Node: se o body voltasse, `.list()` rejeitaria aqui.
    const { client, calls } = clientWith({ status: 200, json: CUSTOM });
    await expect(client.list()).resolves.toHaveLength(2);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.body).toBeUndefined();
  });

  it('não-2xx (401 sem scope/login) ⇒ BrokerError (chamador DEGRADA p/ texto-livre)', async () => {
    const { client } = clientWith({ status: 401, json: { detail: 'unauthorized' } });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerError);
  });

  it('falha de transporte ⇒ BrokerTransportError (degradação do chamador)', async () => {
    const client = new CustomModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'pat',
      fetch: async () => {
        throw new Error('network down');
      },
    });
    await expect(client.list()).rejects.toBeInstanceOf(BrokerTransportError);
  });

  // ── EST-1015: 4 caminhos de erro do list() ──────────────────────────────

  it('(A) !res.ok (403) ⇒ BrokerError com status e code do problem-details', async () => {
    const problemBody = { code: 'PERMISSION_DENIED', detail: 'sem permissão para este tier' };
    const { client } = clientWith({ status: 403, json: problemBody });
    let err: unknown;
    try {
      await client.list();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BrokerError);
    expect((err as BrokerError).status).toBe(403);
    expect((err as BrokerError).code).toBe('PERMISSION_DENIED');
  });

  it('(B) TRANSPORTE: fetch lança (socket) ⇒ BrokerTransportError', async () => {
    const client = new CustomModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'pat',
      fetch: async () => {
        throw new Error('socket hang up');
      },
    });
    await expect(client.list()).rejects.toThrow(BrokerTransportError);
  });

  it('(C) CORPO INVÁLIDO: res.ok=true mas res.json() lança ⇒ BrokerTransportError', async () => {
    const invalidJsonFetch: import('../../src/model/broker-client.js').StreamFetch = async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error('bad json');
        },
        text: async () => '',
        headers: { get: () => null },
        body: null,
      } as unknown as import('../../src/model/broker-client.js').StreamResponse);
    const client = new CustomModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 'pat',
      fetch: invalidJsonFetch,
    });
    await expect(client.list()).rejects.toThrow(BrokerTransportError);
  });

  it('(D) SUCESSO: fetch ok + JSON válido ⇒ resolve com a lista parseada', async () => {
    const { client } = clientWith({ status: 200, json: CUSTOM });
    const models = await client.list();
    expect(models).toHaveLength(2);
    expect(models[0]!.id).toBe('ai21/jamba-large-1.7');
    expect(models[1]!.id).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(models[0]!.supportsTools).toBe(true);
  });
});

describe('parseCustomModels — tolerante (DADO_NÃO_CONFIÁVEL) + guarda HG-2', () => {
  it('campo faltando ⇒ ignora/usa vazio; NUNCA lança', () => {
    const models = parseCustomModels({
      data: [
        { id: 'a/b' }, // sem name/family/context ⇒ '' nos três
        { name: 'sem id' }, // sem id ⇒ ignorado (id é o que se envia)
        { id: 'c/d', name: 'C D' }, // sem family/context ⇒ ''
        'nope', // não-objeto ⇒ ignorado
      ],
    });
    // sem `supports_tools` ⇒ campo OMITIDO (badge neutro), não `false`.
    expect(models).toEqual([
      { id: 'a/b', name: '', family: '', context: '' },
      { id: 'c/d', name: 'C D', family: '', context: '' },
    ]);
    expect(models[0]).not.toHaveProperty('supportsTools');
  });

  it('supports_tools só atravessa se for BOOLEANO de verdade (EST-0996) — senão neutro', () => {
    const models = parseCustomModels({
      data: [
        { id: 'a/tools', name: 'A', supports_tools: true, context: '128k' },
        { id: 'b/notools', name: 'B', supports_tools: false },
        { id: 'c/string', name: 'C', supports_tools: 'true' }, // string ⇒ neutro (omite)
        { id: 'd/num', name: 'D', supports_tools: 1 }, // número ⇒ neutro (omite)
        { id: 'e/absent', name: 'E' }, // ausente ⇒ neutro (omite)
      ],
    });
    expect(models[0]!.supportsTools).toBe(true);
    expect(models[0]!.context).toBe('128k');
    expect(models[1]!.supportsTools).toBe(false);
    expect(models[2]).not.toHaveProperty('supportsTools');
    expect(models[3]).not.toHaveProperty('supportsTools');
    expect(models[4]).not.toHaveProperty('supportsTools');
  });

  it('corpo malformado (sem data) ⇒ lista vazia honesta (não lança)', () => {
    expect(parseCustomModels({})).toEqual([]);
    expect(parseCustomModels(null)).toEqual([]);
    expect(parseCustomModels({ data: 'nope' })).toEqual([]);
    expect(parseCustomModels(undefined)).toEqual([]);
  });

  it('dedup por id (o broker pode repetir) — preserva a 1ª ocorrência/ordem', () => {
    const models = parseCustomModels({
      data: [
        { id: 'x/y', name: 'primeiro' },
        { id: 'x/y', name: 'duplicado' },
        { id: 'z/w', name: 'outro' },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['x/y', 'z/w']);
    expect(models[0]!.name).toBe('primeiro');
  });

  it('DESCARTA qualquer campo sensível que o broker não devesse mandar (HG-2)', () => {
    const tampered = {
      object: 'list',
      data: [
        {
          id: 'openai/gpt-4o',
          name: 'GPT-4o',
          family: 'OpenAI',
          // campos que o broker NUNCA serializa — se vazassem, não podem atravessar:
          api_key_ref: 'vault:openai-prod',
          base_url: 'https://api.openai.com',
          kind: 'openai',
        },
      ],
    };
    const models = parseCustomModels(tampered);
    const flat = JSON.stringify(models);
    expect(flat).not.toContain('api_key_ref');
    expect(flat).not.toContain('base_url');
    expect(flat).not.toContain('vault');
    expect(flat).not.toContain('api.openai.com');
    expect(models[0]).toEqual({
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      family: 'OpenAI',
      context: '',
    });
  });
});

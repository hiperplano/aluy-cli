// EST-1116 — `aluy models` / `aluy providers` (shell): monta a metadata LOCAL (DADO
// público) + consulta o catálogo VIVO do broker FAIL-SOFT, formata e imprime. Bateria:
//  - broker UP (fetch mockado) ⇒ tiers/providers/custom na saída; exit 0.
//  - broker FORA (fetch lança) ⇒ avisos "indisponível", seção local intacta; exit 0.
//  - sem login (401) ⇒ "faça aluy login"; exit 0 (degrada, não quebra).
//  - scope local ⇒ NÃO consulta o broker (fetch nunca chamado).
//  - --json ⇒ objeto estruturado (DADO público), exit 0.
//  - CLI-SEC-7: a saída NUNCA contém credencial/base_url/Bearer.
//
// Sem keychain/rede REAL: store em memória vazio + `ALUY_TOKEN` no env (envToken
// fallback do LoginService) + `brokerFetch` mockado por path.

import { describe, expect, it, vi } from 'vitest';
import { runModels } from '../../src/commands/models.js';
import { InMemoryStore, makeMockFetch } from '../auth/helpers.js';
import { defaultLocalCatalog, buildLocalCatalog } from '@aluy/cli-core';
import type { StreamFetch } from '@aluy/cli-core';

const BROKER = 'http://broker.test';
// PAT de FORMATO válido (`pat_<32hex>_<secret>`) — o LoginService.getAccessToken só
// aceita o env-token se passar `isPat`. Valor sintético; nunca um segredo real.
const FAKE_PAT = 'pat_deadbeefdeadbeefdeadbeefdeadbeef_envSecret';
const ENV: NodeJS.ProcessEnv = { ALUY_BROKER_URL: BROKER, ALUY_TOKEN: FAKE_PAT };

const CATALOG_BODY = {
  object: 'list',
  data: [
    {
      key: 'aluy-deep',
      display_name: 'Deep',
      cost_signal: 'premium',
      composition: [
        { name: 'Claude Opus 4.8', family: 'Anthropic', role: 'principal', context: '1M' },
      ],
    },
  ],
};
const PROVIDERS_BODY = { object: 'list', data: [{ name: 'openrouter', adapter: 'openrouter' }] };
const CUSTOM_BODY = {
  object: 'list',
  data: [{ id: 'deepseek/deepseek-chat', name: 'DeepSeek', family: 'DeepSeek', context: '128k' }],
};

function brokerUpFetch(): StreamFetch {
  return makeMockFetch({
    '/v1/tiers/catalog': { status: 200, body: CATALOG_BODY },
    '/v1/providers': { status: 200, body: PROVIDERS_BODY },
    '/v1/models/custom': { status: 200, body: CUSTOM_BODY },
  }) as unknown as StreamFetch;
}

async function run(
  opts: Parameters<typeof runModels>[0] = {},
): Promise<{ code: number; out: string }> {
  const out: string[] = [];
  const code = await runModels({
    env: ENV,
    store: new InMemoryStore(),
    out: (l) => out.push(l),
    // hermético: injeta o catálogo embutido (não lê o ~/.aluy/providers.json real).
    localCatalog: defaultLocalCatalog(),
    ...opts,
  });
  return { code, out: out.join('\n') };
}

describe('EST-1116 · aluy models (shell)', () => {
  it('broker UP: lista LOCAL + tiers/providers/custom do catálogo vivo; exit 0', async () => {
    const { code, out } = await run({ brokerFetch: brokerUpFetch() });
    expect(code).toBe(0);
    // local
    expect(out).toContain('backend LOCAL');
    expect(out).toContain('claude-opus-4-8');
    // broker
    expect(out).toContain('aluy-deep');
    expect(out).toContain('Claude Opus 4.8 · 1M');
    expect(out).toContain('openrouter');
    expect(out).toContain('deepseek/deepseek-chat');
  });

  // ADR-0118 — a seção LOCAL agora vem do CATÁLOGO (default embutido + override).
  it('seção LOCAL lê do catálogo embutido: mostra os providers pré-carregados (deepseek/groq/ollama)', async () => {
    const { code, out } = await run({ scope: 'local' });
    expect(code).toBe(0);
    expect(out).toContain('backend LOCAL');
    // providers de onda-2/3 do catálogo embutido aparecem (antes eram hardcoded só os 3)
    expect(out).toContain('deepseek');
    expect(out).toContain('groq');
    expect(out).toContain('ollama');
    expect(out).toContain('deepseek-chat'); // modelo default do deepseek
  });

  it('seção LOCAL respeita o override do usuário (catálogo injetado mostra provider novo)', async () => {
    const localCatalog = buildLocalCatalog([
      {
        id: 'myvendor',
        label: 'My Vendor',
        wireFormat: 'openai-compat',
        baseUrl: 'https://my.vendor/v1',
        auth: 'apikey',
        defaultModel: 'my-default-model',
      },
    ]);
    const { code, out } = await run({ scope: 'local', localCatalog });
    expect(code).toBe(0);
    expect(out).toContain('myvendor');
    expect(out).toContain('my-default-model');
    // CLI-SEC-7: o base_url do provider NÃO vaza na listagem
    expect(out).not.toContain('https://my.vendor/v1');
  });

  it('broker FORA (fetch lança): avisa indisponível, seção local intacta; exit 0', async () => {
    const throwing: StreamFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as StreamFetch;
    const { code, out } = await run({ brokerFetch: throwing });
    expect(code).toBe(0);
    expect(out).toContain('backend LOCAL');
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('tiers: indisponível —');
    expect(out).toContain('providers: indisponível —');
    expect(out).toContain('modelos custom: indisponível —');
  });

  it('sem login (401): degrada com "faça aluy login"; exit 0', async () => {
    const unauthorized = makeMockFetch({
      '/v1/tiers/catalog': { status: 401, body: { detail: 'no' } },
      '/v1/providers': { status: 401, body: { detail: 'no' } },
      '/v1/models/custom': { status: 401, body: { detail: 'no' } },
    }) as unknown as StreamFetch;
    const { code, out } = await run({ brokerFetch: unauthorized });
    expect(code).toBe(0);
    // 401 do broker ⇒ BrokerError (não SessionExpiredError) ⇒ mensagem neutra de broker.
    expect(out).toContain('indisponível —');
  });

  it('scope=local NÃO consulta o broker (fetch nunca chamado)', async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error('não deveria chamar o broker');
    });
    const { code, out } = await run({
      scope: 'local',
      brokerFetch: fetchSpy as unknown as StreamFetch,
    });
    expect(code).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(out).toContain('backend LOCAL');
    expect(out).not.toContain('backend BROKER');
  });

  it('--json: objeto estruturado com local + broker; exit 0', async () => {
    const out: string[] = [];
    const code = await runModels({
      env: ENV,
      store: new InMemoryStore(),
      out: (l) => out.push(l),
      json: true,
      brokerFetch: brokerUpFetch(),
    });
    expect(code).toBe(0);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.scope).toBe('both');
    expect(Array.isArray(parsed.local)).toBe(true);
    expect(parsed.local.some((p: { provider: string }) => p.provider === 'anthropic')).toBe(true);
    expect(parsed.broker.tiers.ok).toBe(true);
    expect(parsed.broker.tiers.data[0].key).toBe('aluy-deep');
  });

  it('view=providers: foca nos providers (omite o detalhe dos custom)', async () => {
    const { code, out } = await run({ view: 'providers', brokerFetch: brokerUpFetch() });
    expect(code).toBe(0);
    expect(out).toContain('aluy providers —');
    expect(out).toContain('providers (1)');
    expect(out).not.toContain('modelos custom');
  });

  it('CLI-SEC-7: a saída NUNCA contém credencial/base_url/Bearer', async () => {
    const { out } = await run({ brokerFetch: brokerUpFetch() });
    expect(out).not.toContain(FAKE_PAT);
    expect(out).not.toMatch(/pat_[0-9a-f]{32}_/);
    expect(out).not.toMatch(/Bearer\s/i);
    expect(out).not.toMatch(/api[_-]?key/i);
    expect(out).not.toMatch(/sk-[A-Za-z0-9]/);
  });
});

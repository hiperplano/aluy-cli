// EST-1116 · CLI-SEC-7 — `aluy models`/`aluy providers`: FORMATADOR PURO (`buildModelsNote`).
//
// Bateria: seção LOCAL (3 providers, auth, default, hint do OpenRouter); seção BROKER
// (tiers c/ principal + sinal de custo, providers registrados, modelos custom resumidos);
// FAIL-SOFT (fonte do broker ausente ⇒ aviso "indisponível", nunca quebra); scope
// (local/broker/both); view providers (omite o detalhe dos modelos custom); truncamento
// do resumo de custom (+N mais); CLI-SEC-7 (saída nunca tem credencial/base_url). PURO.

import { describe, expect, it } from 'vitest';
import {
  buildModelsNote,
  type ModelsListInput,
  type LocalProviderListing,
  type BrokerListing,
} from '../../src/index.js';

const LOCAL: readonly LocalProviderListing[] = [
  { provider: 'anthropic', authModes: ['apikey', 'oauth'], defaultModel: 'claude-opus-4-8' },
  {
    provider: 'openrouter',
    authModes: ['apikey'],
    defaultModel: 'anthropic/claude-3.5-sonnet',
    catalogHint: 'centenas via OpenRouter',
  },
  { provider: 'openai', authModes: ['apikey'], defaultModel: 'gpt-4o' },
];

const BROKER_OK: BrokerListing = {
  tiers: {
    ok: true,
    data: [
      {
        key: 'aluy-deep',
        displayName: 'Deep',
        costSignal: 'premium',
        composition: [
          { name: 'Claude Opus 4.8', family: 'Anthropic', role: 'principal', context: '1M' },
        ],
      },
      {
        key: 'aluy-granito',
        displayName: 'Granito',
        costSignal: 'economical',
        composition: [{ name: 'MiMo 7B', family: 'Xiaomi', role: 'principal', context: '128k' }],
      },
    ],
  },
  providers: {
    ok: true,
    data: [
      { name: 'openrouter', adapter: 'openrouter' },
      { name: 'deepseek', adapter: 'deepseek' },
    ],
  },
  custom: {
    ok: true,
    data: [
      { id: 'deepseek/deepseek-chat', name: 'DeepSeek Chat', family: 'DeepSeek', context: '128k' },
      { id: 'meta/llama-3.3-70b', name: 'Llama', family: 'Meta', context: '128k' },
    ],
  },
};

function joined(input: ModelsListInput): string {
  return buildModelsNote(input).lines.join('\n');
}

describe('EST-1116 · buildModelsNote — seção LOCAL', () => {
  it('lista os 3 providers com auth e modelo default', () => {
    const text = joined({ scope: 'local', local: LOCAL });
    expect(text).toContain('anthropic');
    expect(text).toContain('openai');
    expect(text).toContain('openrouter');
    expect(text).toContain('claude-opus-4-8');
    expect(text).toContain('gpt-4o');
    // anthropic tem API key E OAuth.
    expect(text).toMatch(/anthropic.*API key.*OAuth/s);
  });

  it('para o OpenRouter mostra a pista do catálogo vivo (não chumba centenas)', () => {
    const text = joined({ scope: 'local', local: LOCAL });
    expect(text).toContain('centenas via OpenRouter');
  });

  it('ordena os providers determinÍsticamente por nome', () => {
    const lines = buildModelsNote({ scope: 'local', local: LOCAL }).lines;
    const idxA = lines.findIndex((l) => l.includes('anthropic'));
    const idxO = lines.findIndex((l) => l.trimStart().startsWith('openai'));
    const idxR = lines.findIndex((l) => l.trimStart().startsWith('openrouter'));
    expect(idxA).toBeLessThan(idxO);
    expect(idxO).toBeLessThan(idxR);
  });
});

describe('EST-1116 · buildModelsNote — seção BROKER (catálogo vivo)', () => {
  it('lista tiers com principal resolvido + sinal de custo humanizado', () => {
    const text = joined({ scope: 'broker', local: [], broker: BROKER_OK });
    expect(text).toContain('aluy-deep');
    expect(text).toContain('Claude Opus 4.8 · 1M');
    expect(text).toContain('premium');
    expect(text).toContain('aluy-granito');
    expect(text).toContain('econômico'); // economical → humanizado
  });

  it('lista providers registrados e modelos custom', () => {
    const text = joined({ scope: 'broker', local: [], broker: BROKER_OK });
    expect(text).toContain('providers (2)');
    expect(text).toContain('openrouter (openrouter)');
    expect(text).toContain('modelos custom (2)');
    expect(text).toContain('deepseek/deepseek-chat');
  });

  it('trunca o resumo de modelos custom (+N mais) acima do teto', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: `prov/model-${String(i).padStart(2, '0')}`,
      name: `M${i}`,
      family: 'Fam',
      context: '128k',
    }));
    const broker: BrokerListing = { ...BROKER_OK, custom: { ok: true, data: many } };
    const text = joined({ scope: 'broker', local: [], broker });
    expect(text).toContain('modelos custom (20)');
    expect(text).toMatch(/\+8 mais/); // 20 - 12 (teto) = 8
  });
});

describe('EST-1116 · buildModelsNote — FAIL-SOFT do broker', () => {
  it('fonte indisponível vira AVISO, não quebra (a nota ainda é montada)', () => {
    const broker: BrokerListing = {
      tiers: { ok: false, reason: 'broker fora ou sem conexão (cheque a ALUY_BROKER_URL).' },
      providers: { ok: false, reason: 'faça `aluy login` (sem sessão).' },
      custom: { ok: false, reason: 'broker fora ou sem conexão (cheque a ALUY_BROKER_URL).' },
    };
    const text = joined({ scope: 'broker', local: [], broker });
    expect(text).toContain('tiers: indisponível —');
    expect(text).toContain('providers: indisponível —');
    expect(text).toContain('modelos custom: indisponível —');
    // mistura ok/falha não quebra: tiers ok + providers fora.
    const mixed: BrokerListing = { ...BROKER_OK, providers: { ok: false, reason: 'x' } };
    const t2 = joined({ scope: 'broker', local: [], broker: mixed });
    expect(t2).toContain('aluy-deep'); // tiers ainda listados
    expect(t2).toContain('providers: indisponível — x');
  });
});

describe('EST-1116 · buildModelsNote — estados VAZIOS / borda', () => {
  it('listas vazias do broker dão mensagens "(nenhum)" / "(catálogo vazio)"', () => {
    const empty: BrokerListing = {
      tiers: { ok: true, data: [] },
      providers: { ok: true, data: [] },
      custom: { ok: true, data: [] },
    };
    const text = joined({ scope: 'broker', local: [], broker: empty });
    expect(text).toContain('tiers: (catálogo vazio)');
    expect(text).toContain('providers: (nenhum registrado)');
    expect(text).toContain('modelos custom: (nenhum)');
  });

  it('seção local vazia avisa "(nenhum provider local conhecido)"', () => {
    const text = joined({ scope: 'local', local: [] });
    expect(text).toContain('(nenhum provider local conhecido)');
  });

  it('tier sem composição mostra "(sem composição)"', () => {
    const broker: BrokerListing = {
      ...BROKER_OK,
      tiers: {
        ok: true,
        data: [{ key: 'aluy-x', displayName: 'X', costSignal: 'standard', composition: [] }],
      },
    };
    const text = joined({ scope: 'broker', local: [], broker });
    expect(text).toContain('(sem composição)');
    expect(text).toContain('padrão'); // standard → humanizado
  });

  it('scope=both sem o DADO do broker mostra "não consultado"', () => {
    const text = joined({ scope: 'both', local: LOCAL });
    expect(text).toContain('backend LOCAL');
    expect(text).toContain('backend BROKER — não consultado.');
  });
});

describe('EST-1116 · buildModelsNote — scope e view', () => {
  it('scope=local não inclui a seção broker; scope=broker não inclui a local', () => {
    const local = joined({ scope: 'local', local: LOCAL, broker: BROKER_OK });
    expect(local).toContain('backend LOCAL');
    expect(local).not.toContain('backend BROKER');

    const broker = joined({ scope: 'broker', local: LOCAL, broker: BROKER_OK });
    expect(broker).toContain('backend BROKER');
    expect(broker).not.toContain('backend LOCAL');
  });

  it('view=providers omite o detalhe dos modelos custom (foco em providers)', () => {
    const text = joined({ scope: 'broker', view: 'providers', local: [], broker: BROKER_OK });
    expect(text).toContain('providers (2)');
    expect(text).not.toContain('modelos custom');
    expect(
      buildModelsNote({ scope: 'broker', view: 'providers', local: [], broker: BROKER_OK }).title,
    ).toBe('providers');
  });

  it('sem separador em branco duplicado entre cabeçalho e seção', () => {
    const lines = buildModelsNote({
      scope: 'broker',
      activeBackend: 'broker',
      local: [],
      broker: BROKER_OK,
    }).lines;
    // não há duas linhas em branco consecutivas.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i] === '' && lines[i - 1] === '').toBe(false);
    }
  });
});

describe('EST-1116 · CLI-SEC-7 — a saída só tem nomes/slugs públicos', () => {
  it('nenhuma credencial / base_url / api_key_ref atravessa para a saída', () => {
    // Mesmo que (hipoteticamente) o DADO de entrada tivesse campos sensíveis, o builder
    // só consome os campos PÚBLICOS tipados — a saída não pode conter segredo.
    const text = joined({
      scope: 'both',
      activeBackend: 'broker',
      local: LOCAL,
      broker: BROKER_OK,
    });
    expect(text).not.toMatch(/api[_-]?key/i);
    expect(text).not.toMatch(/base[_-]?url/i);
    expect(text).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(text).not.toMatch(/Bearer\s/i);
  });
});

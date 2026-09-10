// O MARCADOR de cache (`cache_control`) — nos DOIS adaptadores, não só no Anthropic.
//
// O dono corrigiu o meu enquadramento em 10/09/2026: "só vai funcionar pra anthropic?
// estou usando o openrouter". A divisão real não é por vendor, é entre cache IMPLÍCITO (o
// provider casa o prefixo sozinho — DeepSeek, OpenAI, GLM) e EXPLÍCITO (só acontece se você
// marcar — Anthropic, Gemini). E o OpenRouter aceita `cache_control` DENTRO do formato
// OpenAI-compat, repassando ao provider de baixo: então o `anthropic/claude-*` roteado por
// lá é exatamente o caso que não cacheava nada, no adaptador que ele já usa.
//
// Depois: "isso deveria funcionar para todos adapters". O inventário do COMPORTAMENTO (não
// do arquivo): `grep "implements ProviderAdapter"` devolve DOIS — openai-compat e
// anthropic. O `gemini` do catálogo cai no compat (factory.ts). Os dois estão cobertos, e
// o teste de fronteira abaixo é o que impede um terceiro nascer sem cache.

import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  valeCachear,
  systemOpenAiComCache,
  systemAnthropicComCache,
  MIN_TOKENS_P_CACHE,
} from '../../../src/model/local/cache-breakpoint.js';

const GRANDE = 'x'.repeat(MIN_TOKENS_P_CACHE * 4);
const PEQUENO = 'só um oi';

describe('valeCachear — o piso existe porque marcar tem custo', () => {
  it('system GRANDE vale o breakpoint', () => {
    expect(valeCachear(GRANDE)).toBe(true);
  });

  it('system pequeno NÃO — abaixo do mínimo o provider ignora o marcador', () => {
    // Pior que não ganhar: no dialeto explícito a ESCRITA no cache é cobrada com ágio.
    expect(valeCachear(PEQUENO)).toBe(false);
  });

  it('vazio/ausente nunca marca', () => {
    expect(valeCachear('')).toBe(false);
    expect(valeCachear(undefined)).toBe(false);
  });
});

describe('systemOpenAiComCache — o caminho do OpenRouter', () => {
  it('promove a ARRAY com cache_control quando vale', () => {
    const r = systemOpenAiComCache(GRANDE);
    expect(Array.isArray(r)).toBe(true);
    const partes = r as readonly Record<string, unknown>[];
    expect(partes[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(partes[0]?.text).toBe(GRANDE);
  });

  it('mantém STRING PURA quando não vale — é a forma que TODO compat entende', () => {
    // Promover sempre mudaria o payload de quem nunca ouviu falar de cache_control, sem
    // nenhum ganho em troca.
    expect(systemOpenAiComCache(PEQUENO)).toBe(PEQUENO);
  });
});

describe('systemAnthropicComCache — dialeto nativo', () => {
  it('promove a array de blocos com cache_control', () => {
    const r = systemAnthropicComCache(GRANDE);
    expect(Array.isArray(r)).toBe(true);
    expect((r as readonly Record<string, unknown>[])[0]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral' },
    });
  });

  it('string pura quando não vale', () => {
    expect(systemAnthropicComCache(PEQUENO)).toBe(PEQUENO);
  });
});

// ── GUARDA DE FRONTEIRA ────────────────────────────────────────────────────────────────
//
// "isso deveria funcionar para todos adapters" (dono, 10/09). Hoje são dois. O risco não é
// o que existe — é o TERCEIRO adaptador nascer sem cache e ninguém notar, porque nada
// falha: o payload sai válido, o provider responde, e a conta chega mais cara em silêncio.
//
// Mesma família do `telegram-portas-fiadas.test.ts`: a guarda lê o FONTE e falha NOMEANDO
// quem esqueceu.

const DIR = new URL('../../../src/model/local/', import.meta.url);

function adaptadores(): { arquivo: string; fonte: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ arquivo: f, fonte: readFileSync(new URL(f, DIR), 'utf8') }))
    .filter(({ fonte }) => fonte.includes('implements ProviderAdapter'));
}

describe('TODO adaptador participa do cache de prompt', () => {
  it('a varredura ACHA adaptadores — senão passaria por vacuidade', () => {
    // Varredura que não acha nada passa verde sem provar nada.
    const nomes = adaptadores()
      .map((a) => a.arquivo)
      .sort();
    expect(nomes).toEqual(['anthropic-adapter.ts', 'openai-adapter.ts']);
  });

  it('cada um MARCA o system (manda cache_control quando vale)', () => {
    const sem = adaptadores()
      .filter(({ fonte }) => !fonte.includes('ComCache('))
      .map(({ arquivo }) => `${arquivo}: monta o system sem passar por cache-breakpoint`);
    expect(sem).toEqual([]);
  });

  it('cada um LÊ o cache do usage — sem isso não dá para provar que funcionou', () => {
    const sem = adaptadores()
      .filter(({ fonte }) => !fonte.includes('lerUsoDeCache('))
      .map(({ arquivo }) => `${arquivo}: não lê os tokens reaproveitados do usage`);
    expect(sem).toEqual([]);
  });
});

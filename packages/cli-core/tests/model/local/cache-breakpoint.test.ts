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
  pisoDeCachePara,
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

describe('PISO POR MODELO — medido na doc do OpenRouter (11/09/2026)', () => {
  it('o default segue 1024 (OpenAI e parte da linha Anthropic)', () => {
    expect(pisoDeCachePara('gpt-4o')).toBe(1024);
    expect(pisoDeCachePara('anthropic/claude-sonnet-5')).toBe(1024);
    expect(pisoDeCachePara(undefined)).toBe(1024);
  });

  it('Opus e Haiku 4.5 exigem 4096 — abaixo disso o marcador é IGNORADO', () => {
    // A primeira versão cravou 1024 para todos. Nestes o efeito era o pior possível: o
    // payload mudava (virava array de partes), nada era cacheado, e nada avisava.
    for (const m of ['claude-opus-4-8', 'anthropic/claude-opus-4-5', 'claude-haiku-4-5']) {
      expect(pisoDeCachePara(m), m).toBe(4096);
    }
  });

  it('Gemini 2.5 Pro exige 4096; o Flash fica no default', () => {
    expect(pisoDeCachePara('google/gemini-2.5-pro')).toBe(4096);
    expect(pisoDeCachePara('google/gemini-2.5-flash')).toBe(1024);
  });

  it('Haiku 3.5 exige 2048', () => {
    expect(pisoDeCachePara('anthropic/claude-3-5-haiku')).toBe(2048);
  });

  it('casa por FRAGMENTO — o mesmo modelo chega com prefixo e sufixo diferentes', () => {
    // `claude-opus-4-8`, `anthropic/claude-opus-4-8` e `...:batch` são o mesmo modelo;
    // igualdade exata perderia os dois últimos.
    for (const m of [
      'claude-opus-4-8',
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4-8:batch',
      'ANTHROPIC/Claude-Opus-4-8',
    ]) {
      expect(pisoDeCachePara(m), m).toBe(4096);
    }
  });

  it('o piso MAIOR vence quando dois casam', () => {
    // Um slug exótico de agregador pode casar duas famílias; respeitar a exigência mais
    // estrita é o único desfecho seguro.
    expect(pisoDeCachePara('claude-3-5-haiku-e-claude-opus-4-8')).toBe(4096);
  });

  it('valeCachear RESPEITA o piso do modelo', () => {
    const doisMil = 'x'.repeat(2048 * 4);
    expect(valeCachear(doisMil, 'gpt-4o'), 'acima do piso de 1024').toBe(true);
    expect(valeCachear(doisMil, 'claude-opus-4-8'), 'abaixo do piso de 4096').toBe(false);
  });

  it('e o marcador SÓ sai quando vale — nos dois adaptadores', () => {
    const doisMil = 'y'.repeat(2048 * 4);
    expect(typeof systemOpenAiComCache(doisMil, 'claude-opus-4-8')).toBe('string');
    expect(Array.isArray(systemOpenAiComCache(doisMil, 'gpt-4o'))).toBe(true);
    expect(typeof systemAnthropicComCache(doisMil, 'claude-opus-4-8')).toBe('string');
  });
});

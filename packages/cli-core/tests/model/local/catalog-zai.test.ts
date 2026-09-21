// Z.AI como provider EMBUTIDO (21/09/2026, pedido do dono).
//
// A particularidade que estes testes guardam: a z.ai são DOIS produtos com credenciais que
// não se misturam. Medido em campo — a chave do GLM Coding Plan, apontada para o endpoint
// geral, fez 16 requisições sem resposta. Por isso são duas entradas, e o risco de
// regressão é alguém "simplificar" para uma só, ou trocar os endpoints entre si.
import { describe, expect, it } from 'vitest';
import { defaultLocalCatalog } from '../../../src/model/local/catalog.js';
import { builtinContextWindowForSlug } from '../../../src/model/local/known-context-windows.js';

const cat = defaultLocalCatalog();
const byId = (id: string) => cat.entries.find((e) => e.id === id);

describe('catálogo embutido · Z.AI', () => {
  it('a API geral e o Coding Plan são entradas DISTINTAS, cada uma no seu endpoint', () => {
    expect(byId('zai')?.baseUrl).toBe('https://api.z.ai/api/paas/v4');
    expect(byId('zai-coding')?.baseUrl).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('as duas falam o dialeto OpenAI-compat com API key', () => {
    for (const id of ['zai', 'zai-coding']) {
      expect(byId(id)).toMatchObject({ wireFormat: 'openai-compat', auth: ['apikey'] });
    }
  });

  // O defeito que motivou cuidar disto: o provider custom do dono declarava
  // `defaultModel: "Z.AI"` — o RÓTULO do provider no lugar do id do modelo — e o `/model`
  // oferecia isso como se fosse modelo. Embutido, o default tem de ser um id real.
  it('o modelo default é um id REAL de modelo, e está na própria lista', () => {
    for (const id of ['zai', 'zai-coding']) {
      const e = byId(id)!;
      expect(e.defaultModel).toMatch(/^glm-\d/);
      expect(e.models).toContain(e.defaultModel);
    }
  });

  // Ids distintos ⇒ contas distintas no cofre (`<id>:apikey`) ⇒ as duas chaves convivem.
  it('os ids não colidem entre si nem com o resto do catálogo', () => {
    const ids = cat.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a nota de cada entrada aponta para a OUTRA — é o que desfaz o engano de endpoint', () => {
    expect(byId('zai')?.notes).toContain('zai-coding');
    expect(byId('zai-coding')?.notes).toContain('`zai`');
  });
});

describe('janela de contexto conhecida · GLM', () => {
  // A z.ai não anuncia a janela em `/models`: sem isto a auto-compactação fica INERTE.
  it('todo modelo listado no catálogo da z.ai tem janela conhecida', () => {
    for (const m of byId('zai-coding')!.models) {
      expect(builtinContextWindowForSlug(m), `sem janela p/ ${m}`).toBeGreaterThan(0);
    }
  });

  it('os números são os publicados pela z.ai', () => {
    expect(builtinContextWindowForSlug('glm-5.3')).toBe(1_000_000);
    expect(builtinContextWindowForSlug('glm-5.1')).toBe(200_000);
    expect(builtinContextWindowForSlug('glm-4.6')).toBe(200_000);
    expect(builtinContextWindowForSlug('glm-4.5-air')).toBe(128_000);
  });

  // O mesmo modelo chega com prefixo de vendor quando vem por agregador (OpenRouter).
  it('casa também o slug com vendor na frente', () => {
    expect(builtinContextWindowForSlug('z-ai/glm-5.3')).toBe(1_000_000);
  });
});

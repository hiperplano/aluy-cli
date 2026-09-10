// O catálogo de providers é uma FOTO, e foto envelhece.
//
// Medido em 08/09/2026 contra a listagem viva do OpenRouter (431 modelos): o
// `defaultModel` que estava aqui — `anthropic/claude-3.5-sonnet` — não constava mais, e
// nem `google/gemini-2.0-flash`, outro dos cinco slugs curados. Dois de cinco mortos.
//
// A troca de provider JÁ PROVAVA isso (comparava o default com a listagem, para decidir se
// persistia) e mesmo assim devolvia o slug morto para virar o modelo ATIVO da sessão. Quem
// fechasse o picker de modelo que abre em seguida ficava num provider certo com um modelo
// inexistente — e só descobria no turno seguinte, longe da causa.
//
// A distinção que este arquivo trava é a do `doCatalogo`: um substituto escolhido por nós é
// palpite, e palpite não vira preferência gravada.

import { describe, expect, it } from 'vitest';
import { escolherModeloVivo, defaultLocalCatalog, findProvider } from '../../../src/index.js';

const ENTRY = {
  defaultModel: 'anthropic/claude-3.5-sonnet',
  models: [
    'anthropic/claude-3.5-sonnet',
    'openai/gpt-4o',
    'google/gemini-2.0-flash',
    'meta-llama/llama-3.3-70b-instruct',
  ],
} as const;

describe('escolherModeloVivo', () => {
  it('o default do catálogo vence quando o provider ainda o anuncia', () => {
    expect(escolherModeloVivo(ENTRY, ['anthropic/claude-3.5-sonnet', 'openai/gpt-4o'])).toEqual({
      model: 'anthropic/claude-3.5-sonnet',
      doCatalogo: true,
    });
  });

  it('default MORTO ⇒ o primeiro curado que o provider anuncia (o caso real de 08/09)', () => {
    expect(
      escolherModeloVivo(ENTRY, ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct']),
    ).toEqual({ model: 'openai/gpt-4o', doCatalogo: false });
  });

  it('o substituto NÃO conta como default do catálogo — palpite não vira padrão gravado', () => {
    expect(escolherModeloVivo(ENTRY, ['openai/gpt-4o']).doCatalogo).toBe(false);
  });

  it('respeita a ORDEM da curadoria, não a do provider', () => {
    const r = escolherModeloVivo(ENTRY, ['meta-llama/llama-3.3-70b-instruct', 'openai/gpt-4o']);
    expect(r.model).toBe('openai/gpt-4o');
  });

  it('listagem VAZIA não muda nada — não se troca um slug bom por uma listagem ausente', () => {
    // Provider que não expõe `/models` (dialeto anthropic), rede fora, chave recusada:
    // "não deu para saber" é diferente de "está morto".
    expect(escolherModeloVivo(ENTRY, [])).toEqual({
      model: 'anthropic/claude-3.5-sonnet',
      doCatalogo: true,
    });
  });

  it('nenhum curado vivo ⇒ devolve o default mesmo, mas marcado como NÃO-catálogo', () => {
    // Não há alternativa melhor; quem chama usa o `doCatalogo:false` para não persistir e
    // a nota manda escolher na lista.
    expect(escolherModeloVivo(ENTRY, ['coisa/nenhuma'])).toEqual({
      model: 'anthropic/claude-3.5-sonnet',
      doCatalogo: false,
    });
  });

  it('casa sem diferenciar caixa nem espaço em volta', () => {
    expect(escolherModeloVivo(ENTRY, ['  ANTHROPIC/Claude-3.5-Sonnet '])).toEqual({
      model: 'anthropic/claude-3.5-sonnet',
      doCatalogo: true,
    });
  });

  it('entrada sem lista curada não quebra', () => {
    expect(escolherModeloVivo({ defaultModel: 'x/y' }, ['a/b'])).toEqual({
      model: 'x/y',
      doCatalogo: false,
    });
  });
});

describe('o catálogo embutido não pode carregar o slug que já medimos MORTO', () => {
  it('o OpenRouter não aponta mais para `anthropic/claude-3.5-sonnet`', () => {
    // 08/09/2026: consultei `GET https://openrouter.ai/api/v1/models` (431 modelos) e o
    // slug não estava lá — nem parecido. Enquanto ele foi o default, TODA troca para o
    // OpenRouter caía no ramo "não persiste" e ativava um modelo inexistente.
    const entry = findProvider(defaultLocalCatalog(), 'openrouter');
    expect(entry).toBeDefined();
    expect(entry?.defaultModel).not.toBe('anthropic/claude-3.5-sonnet');
    expect(entry?.models ?? []).not.toContain('anthropic/claude-3.5-sonnet');
    expect(entry?.models ?? []).not.toContain('google/gemini-2.0-flash');
  });

  it('o default do OpenRouter está na própria lista curada dele (par coerente)', () => {
    const entry = findProvider(defaultLocalCatalog(), 'openrouter');
    expect(entry?.models ?? []).toContain(entry?.defaultModel);
  });

  it('TODO provider embutido tem o default dentro da própria lista curada', () => {
    // Sem isto, `escolherModeloVivo` nunca reencontraria o default como substituto: um
    // provider cujo default não está em `models` fica sem rede de segurança.
    const fora = defaultLocalCatalog()
      .entries.filter((e) => (e.models ?? []).length > 0)
      .filter((e) => !(e.models ?? []).some((m) => m === e.defaultModel))
      .map((e) => `${e.id}: ${e.defaultModel}`);
    expect(fora).toEqual([]);
  });
});

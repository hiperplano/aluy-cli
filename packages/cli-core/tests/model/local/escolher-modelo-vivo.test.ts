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

  it('default MORTO + HÁ lista ⇒ NÃO ativa nada (quem escolhe é o dono, no picker)', () => {
    // Emenda de 10/09 — o dono: "esses modelos default estão todos furados, não vamos
    // usá-los". A versão anterior caía no primeiro CURADO que ainda existisse; mas a lista
    // curada é a MESMA foto que envelheceu (2 dos 5 do OpenRouter já estavam mortos). Se o
    // provider sabe dizer o que tem, o catálogo não opina.
    expect(
      escolherModeloVivo(ENTRY, ['openai/gpt-4o', 'meta-llama/llama-3.3-70b-instruct']),
    ).toEqual({ model: undefined, doCatalogo: false });
  });

  it('nem um curado VIVO é ativado no lugar do default — é palpite igual', () => {
    expect(escolherModeloVivo(ENTRY, ['openai/gpt-4o']).model).toBeUndefined();
  });

  it('listagem VAZIA não muda nada — não se troca um slug bom por uma listagem ausente', () => {
    // Provider que não expõe `/models` (dialeto anthropic), rede fora, chave recusada:
    // "não deu para saber" é diferente de "está morto".
    expect(escolherModeloVivo(ENTRY, [])).toEqual({
      model: 'anthropic/claude-3.5-sonnet',
      doCatalogo: true,
    });
  });

  it('lista sem nada nosso dentro ⇒ tampouco ativa — a lista existe para ser usada', () => {
    expect(escolherModeloVivo(ENTRY, ['coisa/nenhuma'])).toEqual({
      model: undefined,
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
      model: undefined,
      doCatalogo: false,
    });
  });

  it('o default CONFIRMADO pela lista passa — e conta como catálogo (pode virar padrão)', () => {
    // A exceção deliberada: não é que confiemos no catálogo, é que o provider acabou de
    // confirmá-lo. Poupar um passo a quem só quer entrar e usar vale mais que a pureza.
    expect(escolherModeloVivo({ defaultModel: 'a/b' }, ['a/b', 'c/d'])).toEqual({
      model: 'a/b',
      doCatalogo: true,
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

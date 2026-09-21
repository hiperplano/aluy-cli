// F197-LLM — a sugestão de próximo prompt vinda do MODELO.
//
// O RISCO que estes testes guardam: o texto sugerido vai para o COMPOSER do dono. Com o
// menu fechado de sete frases isso era inerte; com texto livre, o que o modelo devolver
// chega ao campo de digitação. `sanitizeSuggestion` é o ponto único que dobra qualquer
// resposta numa linha usável — se ele afrouxar, um modelo tagarela despeja markdown,
// várias linhas e preâmbulo dentro do composer.
//
// Ele NÃO julga a intenção do texto (não temos classificador para isso, e fingir que temos
// seria pior). A garantia é outra e está verificada na TUI: a sugestão só aparece com o
// composer e a fila de type-ahead VAZIOS, e o Tab apenas preenche — o Enter é do dono.
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_SUGESTAO_CHARS,
  buildSuggestMessages,
  createSuggestEngine,
  sanitizeSuggestion,
  type SuggestCaller,
} from '../../src/agent/suggest-engine.js';
import type { ModelCallResult } from '../../src/model/types.js';

function callerQueResponde(content: string): SuggestCaller {
  return {
    call: vi.fn(async () => ({ request_id: 'r', content, finish_reason: 'stop' }) as ModelCallResult),
  };
}

describe('sanitizeSuggestion — o texto do modelo dobrado numa linha de composer', () => {
  it('frase limpa passa intacta', () => {
    expect(sanitizeSuggestion('rode a suíte e me mostre as falhas')).toBe(
      'rode a suíte e me mostre as falhas',
    );
  });

  it('MÚLTIPLAS linhas ⇒ fica só a primeira (modelo que lista alternativas)', () => {
    const r = sanitizeSuggestion('corrija o teste que falhou\ndepois rode o build\nou revise o PR');
    expect(r).toBe('corrija o teste que falhou');
    expect(r).not.toContain('\n');
  });

  it('cerca de código é removida — nunca vai crase para o composer', () => {
    expect(sanitizeSuggestion('```\nrode npm test\n```')).toBe('rode npm test');
    expect(sanitizeSuggestion('```bash\nrode npm test\n```')).toBe('rode npm test');
  });

  it('marcador de lista e aspas envolventes saem', () => {
    expect(sanitizeSuggestion('- rode os testes')).toBe('rode os testes');
    expect(sanitizeSuggestion('1. rode os testes')).toBe('rode os testes');
    expect(sanitizeSuggestion('"rode os testes"')).toBe('rode os testes');
    expect(sanitizeSuggestion('`rode os testes`')).toBe('rode os testes');
  });

  it('"NADA" (o combinado do prompt p/ sem próximo passo) ⇒ undefined, não a palavra', () => {
    for (const v of ['NADA', 'nada', 'Nada.', 'NADA!']) expect(sanitizeSuggestion(v)).toBeUndefined();
  });

  it('vazio, só espaço ou undefined ⇒ undefined', () => {
    expect(sanitizeSuggestion('')).toBeUndefined();
    expect(sanitizeSuggestion('   \n  ')).toBeUndefined();
    expect(sanitizeSuggestion(undefined)).toBeUndefined();
  });

  it('resposta longa é CAPADA — o composer tem uma linha, não um parágrafo', () => {
    const r = sanitizeSuggestion('x'.repeat(500));
    expect(r!.length).toBe(MAX_SUGESTAO_CHARS);
    expect(r!.endsWith('…')).toBe(true);
  });

  // O caso que motivou o teto: um modelo que responde com um parágrafo explicativo.
  it('preâmbulo tagarela de várias linhas não vaza para o campo de digitação', () => {
    const r = sanitizeSuggestion(
      'Claro! Aqui está uma boa sugestão de próximo passo:\n\n```\nrode npm test\n```\n\nIsso vai validar as mudanças.',
    );
    expect(r).toBe('Claro! Aqui está uma boa sugestão de próximo passo:');
    expect(r).not.toContain('\n');
  });
});

describe('buildSuggestMessages — barato de propósito', () => {
  it('sem contexto nenhum ⇒ NÃO monta mensagem (não gasta token à toa)', () => {
    expect(buildSuggestMessages({ lang: 'pt-BR' })).toEqual([]);
  });

  it('leva o recap e o objetivo — e NADA de histórico', () => {
    const m = buildSuggestMessages({
      lang: 'pt-BR',
      lastGoal: 'avalie o projeto',
      recap: 'editou Card.tsx · rodou npm test · 1 falhou',
    });
    expect(m).toHaveLength(2);
    const user = String(m[1]!.content);
    expect(user).toContain('avalie o projeto');
    expect(user).toContain('1 falhou');
    // O tamanho é o ponto: a chamada roda a CADA turno.
    expect(user.length).toBeLessThan(400);
  });

  it('idioma en muda a instrução (texto livre não passa pelo i18n)', () => {
    const pt = String(buildSuggestMessages({ lang: 'pt-BR', lastGoal: 'x' })[0]!.content);
    const en = String(buildSuggestMessages({ lang: 'en', lastGoal: 'x' })[0]!.content);
    expect(pt).not.toBe(en);
    expect(en).toContain('imperative');
  });
});

describe('createSuggestEngine — ornamento nunca derruba o turno', () => {
  it('resposta boa ⇒ sugestão saneada', async () => {
    const engine = createSuggestEngine(callerQueResponde('  corrija o teste que falhou  '));
    await expect(engine.suggest({ lang: 'pt-BR', lastGoal: 'rode os testes' })).resolves.toBe(
      'corrija o teste que falhou',
    );
  });

  it('caller que LANÇA ⇒ undefined (o chamador cai no fallback), sem propagar', async () => {
    const engine = createSuggestEngine({
      call: vi.fn(async () => {
        throw new Error('provider fora do ar');
      }),
    });
    await expect(
      engine.suggest({ lang: 'pt-BR', lastGoal: 'x', recap: 'y' }),
    ).resolves.toBeUndefined();
  });

  it('sem contexto ⇒ NÃO chama o modelo', async () => {
    const caller = callerQueResponde('qualquer coisa');
    const engine = createSuggestEngine(caller);
    await engine.suggest({ lang: 'pt-BR' });
    expect(caller.call).not.toHaveBeenCalled();
  });
});

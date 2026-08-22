// SPAWN-ENVELOPE — o input do `spawn_agent` chegando EMBRULHADO numa string.
//
// Medido em campo (dono, com um modelo barato): ele montou o JSON CERTO e a camada de
// tool-call entregou tudo dentro de uma chave `input`, como texto:
//
//   spawn_agent requer "agents": um array de { … }.
//   Recebi: input=string "{\"agents\": [{\"label\": \"agente-aleatorio-"
//
// A tolerância que já existia cobria o CAMPO stringificado (`{"agents": "[…]"}`), não o
// input INTEIRO. Do lado do modelo não havia o que corrigir — ele já tinha acertado a
// estrutura —, então a segunda tentativa repetiu a mesma coisa e o turno morreu.
//
// Este arquivo trava o desembrulho E o não-embrulhado (a regressão que importa: input
// normal não pode mudar de comportamento).

import { describe, expect, it } from 'vitest';
import { desembrulhaInput } from '../../../src/agent/tools/input-shape.js';

const ALVO = { agents: [{ label: 'a', goal: 'fazer algo' }] };

describe('desembrulhaInput — input empacotado por camada de tool-call', () => {
  it('`{input: "<json>"}` ⇒ devolve o objeto de dentro (o caso REAL medido)', () => {
    expect(desembrulhaInput({ input: JSON.stringify(ALVO) })).toEqual(ALVO);
  });

  it('cobre os apelidos que os provedores usam', () => {
    for (const k of ['arguments', 'args', 'params', 'parameters', 'body', 'payload']) {
      expect(desembrulhaInput({ [k]: JSON.stringify(ALVO) })).toEqual(ALVO);
    }
  });

  it('embrulhado como OBJETO (sem stringificar) também desembrulha', () => {
    expect(desembrulhaInput({ input: ALVO })).toEqual(ALVO);
  });

  // A NÃO-REGRESSÃO que mais importa: input normal atravessa intacto.
  it('input JÁ correto passa inalterado', () => {
    expect(desembrulhaInput(ALVO)).toEqual(ALVO);
  });

  it('uma tool que TEM um campo `input` legítimo não é desembrulhada por engano', () => {
    const normal = { input: 'texto qualquer do usuário', outro: 1 };
    expect(desembrulhaInput(normal)).toEqual(normal);
  });

  // JSON truncado (o caso do relato: a string vinha cortada) devolve o ORIGINAL, p/ o
  // erro de validação citar o que chegou em vez de dizer que faltou o campo.
  it('JSON truncado ⇒ devolve o original (erro honesto, não mentiroso)', () => {
    const truncado = { input: '{"agents": [{"label": "agente-alea' };
    expect(desembrulhaInput(truncado)).toEqual(truncado);
  });

  it('string que decodifica p/ ARRAY ou número NÃO vira input', () => {
    expect(desembrulhaInput({ input: '[1,2,3]' })).toEqual({ input: '[1,2,3]' });
    expect(desembrulhaInput({ input: '42' })).toEqual({ input: '42' });
  });
});

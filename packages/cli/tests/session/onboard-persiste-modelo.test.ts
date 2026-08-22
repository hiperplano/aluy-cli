// ONBOARD-PERSIST — reinstalar escolhendo OUTRO modelo tem de valer.
//
// Relato do dono, repetido por meses: "mesmo instalando por cima do aluy e selecionando
// outro modelo, a informação do instalador não está sendo persistida (já falei 300x)".
//
// A causa: o config tem DOIS campos de modelo, escritos por fluxos diferentes e lidos por
// caminhos diferentes — `localModel` (cliente BYO) e `model`+`tier` (slug ATIVO no boot,
// via `resolvePreferredModel` sob `tier:'custom'`). O onboarding gravava só o primeiro.
// Como `save` é MERGE, numa REINSTALAÇÃO o `model` velho sobrevivia e o boot voltava ao
// slug ANTIGO. Em máquina limpa não havia valor velho — por isso o defeito só aparecia
// reinstalando, e por isso o conserto anterior (que tratou só `localModel`) não bastou.
//
// O que este arquivo trava: os três campos saem COERENTES. Um conserto que arrume um e
// esqueça o outro volta a produzir exatamente o mesmo sintoma.

import { describe, expect, it } from 'vitest';
import { onboardLocalModelPatch } from '../../src/session/onboard.js';

describe('onboarding — o modelo escolhido persiste na REINSTALAÇÃO', () => {
  it('modelo digitado ⇒ `localModel` E `model` recebem o MESMO valor', () => {
    const p = onboardLocalModelPatch({
      providerId: 'openrouter',
      model: 'minimax/minimax-m3',
      customModel: '',
    });
    expect(p.localModel).toBe('minimax/minimax-m3');
    expect(p.model).toBe('minimax/minimax-m3');
  });

  // O degrau que estava faltando: sem `tier:'custom'`, o boot não lê o `model` como slug
  // ativo e a escolha do instalador some de novo, por outro caminho.
  it('o tier sai `custom` — é o que faz o boot LER o slug do `model`', () => {
    expect(
      onboardLocalModelPatch({ providerId: 'openrouter', model: 'x/y', customModel: '' }).tier,
    ).toBe('custom');
  });

  it('provider CUSTOM usa o modelo do formulário, nos dois campos', () => {
    const p = onboardLocalModelPatch({
      providerId: '__custom__',
      model: '',
      customModel: 'deepseek/deepseek-v4-pro',
    });
    expect(p.localModel).toBe('deepseek/deepseek-v4-pro');
    expect(p.model).toBe(p.localModel);
  });

  // A INVARIANTE, dita de uma vez: os dois campos NUNCA divergem. É a divergência — não
  // um valor específico — que produz "escolhi um modelo e abriu noutro".
  it('em qualquer combinação, `model` e `localModel` são iguais', () => {
    const casos = [
      { providerId: 'openrouter', model: 'a/b', customModel: '' },
      { providerId: 'anthropic', model: '', customModel: '' },
      { providerId: '__custom__', model: '', customModel: 'c/d' },
      { providerId: '__custom__', model: 'e/f', customModel: 'c/d' },
    ];
    for (const c of casos) {
      const p = onboardLocalModelPatch(c);
      expect(p.model).toBe(p.localModel);
      expect(p.tier).toBe('custom');
    }
  });
});

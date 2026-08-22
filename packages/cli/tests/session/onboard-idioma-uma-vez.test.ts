// ONBOARD-LANG-2X — o idioma é perguntado UMA vez, não duas.
//
// Relato do dono, instalando: "so que ele ta perguntando duas vezes o idioma". O
// instalador do site abre com "idioma / language?", exporta a resposta em `ALUY_LANG` e
// chama `aluy onboard` — que começava no passo 'lang' INCONDICIONALMENTE e repetia a
// pergunta. Duas perguntas idênticas em sequência fazem quem instala duvidar se a
// primeira funcionou, e é a mesma família de defeito do resto desta semana: a tela não
// corresponde ao que o sistema já sabe.

import { describe, expect, it } from 'vitest';
import { idiomaExplicitoDoAmbiente } from '../../src/session/onboard.js';

describe('onboarding — idioma vindo do instalador', () => {
  it('ALUY_LANG=pt-BR ⇒ o passo é pulado (o instalador já perguntou)', () => {
    expect(idiomaExplicitoDoAmbiente({ ALUY_LANG: 'pt-BR' })).toBe('pt-BR');
  });

  it('aceita as formas que o instalador pode exportar', () => {
    for (const v of ['pt', 'pt-BR', 'PT-BR', 'Pt-br']) {
      expect(idiomaExplicitoDoAmbiente({ ALUY_LANG: v })).toBe('pt-BR');
    }
    expect(idiomaExplicitoDoAmbiente({ ALUY_LANG: 'en' })).toBe('en');
  });

  // O ramo que NÃO deve pular — sem ele, o onboarding perderia o passo de idioma para
  // todo mundo, e trocar de idioma viraria uma tela inalcançável.
  it('SEM ALUY_LANG ⇒ pergunta (comportamento de sempre, intacto)', () => {
    expect(idiomaExplicitoDoAmbiente({})).toBeUndefined();
    expect(idiomaExplicitoDoAmbiente({ LANG: 'pt_BR.UTF-8' })).toBeUndefined();
  });

  it('ALUY_LANG vazia ou com LIXO ⇒ pergunta (fronteira com DADO externo)', () => {
    expect(idiomaExplicitoDoAmbiente({ ALUY_LANG: '' })).toBeUndefined();
    expect(idiomaExplicitoDoAmbiente({ ALUY_LANG: '   ' })).toBeUndefined();
    expect(idiomaExplicitoDoAmbiente({ ALUY_LANG: 'klingon' })).toBeUndefined();
  });

  // O `LANG` do sistema NÃO pula: ele é palpite, não resposta. Pular por ele tiraria o
  // passo de idioma de toda máquina do mundo — ninguém escolheu nada ali.
  it('o LANG do SISTEMA não vale como resposta explícita', () => {
    expect(idiomaExplicitoDoAmbiente({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' })).toBeUndefined();
  });
});

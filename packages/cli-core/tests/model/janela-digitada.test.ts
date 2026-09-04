// F-WIN (emenda) — o parser da janela DIGITADA.
//
// Origem: com `z-ai/glm-5.3-flash` no tokenrouter, a descoberta por `/models` funciona e
// não acha nada — verificado na conta do dono: 131 modelos e o catálogo inteiro só traz
// `id`/`object`/`created`/`owned_by`/`supported_endpoint_types`/`tags`. Não há campo de
// janela para achar, e GLM não está na tabela embutida. Até aqui o aviso mandava editar
// `~/.aluy/config.json` à mão; o dono pediu "dar a opção de digitar".
//
// O caso que mais importa aqui é a RECUSA do separador ambíguo: "128.000" vale 128000 em
// pt-BR e 128 em en-US. Adivinhar errado grava um denominador podre no config, e ele é
// lido ANTES de qualquer chance de re-descoberta — envenenaria toda sessão futura.

import { describe, expect, it } from 'vitest';
import { parseJanelaDigitada, explicaRecusa } from '../../src/model/local/janela-digitada.js';

describe('parseJanelaDigitada — o que o dono quis dizer', () => {
  it('número cru', () => {
    expect(parseJanelaDigitada('131072').tokens).toBe(131072);
    expect(parseJanelaDigitada('200000').tokens).toBe(200000);
  });

  it('sufixo k/m, como o número é publicado e conversado', () => {
    expect(parseJanelaDigitada('128k').tokens).toBe(131072);
    expect(parseJanelaDigitada('128K').tokens).toBe(131072);
    expect(parseJanelaDigitada('1m').tokens).toBe(1048576);
  });

  it('espaço e caixa não atrapalham', () => {
    expect(parseJanelaDigitada('  128 k  ').tokens).toBe(131072);
  });

  it('`_` é separador legível e aceito', () => {
    expect(parseJanelaDigitada('131_072').tokens).toBe(131072);
  });

  it('RECUSA `.` e `,` — ambíguos entre locales', () => {
    for (const t of ['128.000', '128,000', '1.024']) {
      const r = parseJanelaDigitada(t);
      expect(r.tokens, `não pode aceitar ${t}`).toBeUndefined();
      expect(r.recusa).toBe('separador-ambiguo');
    }
  });

  it('recusa o que não é número', () => {
    for (const t of ['abc', '12x', 'k', '--', '128kk']) {
      expect(parseJanelaDigitada(t).tokens, `não pode aceitar ${t}`).toBeUndefined();
    }
  });

  it('recusa vazio com motivo próprio', () => {
    expect(parseJanelaDigitada('').recusa).toBe('vazio');
    expect(parseJanelaDigitada('   ').recusa).toBe('vazio');
  });

  it('recusa zero (denominador zero desliga a compactação em silêncio)', () => {
    expect(parseJanelaDigitada('0').tokens).toBeUndefined();
  });

  it('recusa número grande demais p/ ser janela', () => {
    expect(parseJanelaDigitada('99999999999999999999').recusa).toBe('fora-de-faixa');
  });

  it('não aceita negativo (o `-` não casa o padrão)', () => {
    expect(parseJanelaDigitada('-100').tokens).toBeUndefined();
  });
});

describe('explicaRecusa — cada recusa vira instrução, não só reclamação', () => {
  it('toda recusa tem frase e ensina a forma certa', () => {
    for (const m of ['vazio', 'separador-ambiguo', 'nao-numero', 'fora-de-faixa'] as const) {
      const s = explicaRecusa(m);
      expect(s.length, `frase vazia p/ ${m}`).toBeGreaterThan(10);
    }
  });

  it('a do separador EXPLICA a ambiguidade (é a recusa que mais surpreende)', () => {
    const s = explicaRecusa('separador-ambiguo');
    expect(s).toContain('128.000');
    expect(s).toContain('128k');
  });
});

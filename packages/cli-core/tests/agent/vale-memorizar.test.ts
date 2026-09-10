// F-MEM (emenda) — o filtro de trivialidade da memória automática.
//
// Origem, medida na máquina do dono em 31/08: o scope deste projeto tinha ~100
// memórias e CINCO consultas sem relação entre si ("telegram", "mcp picker",
// "flicker", "publicar versao", "ollama") devolviam 10 resultados cada com UM único
// valor distinto — `"Objetivo: segue\nResultado: feito."`. Ele digitou "segue", o
// agente respondeu "feito.", e o `storeMemory` gravou isso como fato permanente
// dezenas de vezes (a única condição era `kind === 'final'`).
//
// A assimetria que estes testes travam: o filtro tem de ser AGRESSIVO com continuação
// pura e CONSERVADOR com todo o resto. Um filtro frouxo devolve o entulho; um filtro
// zeloso descarta fato real, e fato descartado não volta nunca.

import { describe, expect, it } from 'vitest';
import {
  ehContinuacaoPura,
  valeMemorizar,
} from '../../src/agent/memory/vale-memorizar.js';

describe('ehContinuacaoPura — o que só destrava o turno seguinte', () => {
  it('reconhece o caso REAL que entupiu a memória do dono', () => {
    expect(ehContinuacaoPura('segue')).toBe(true);
  });

  it('reconhece as continuações comuns, com e sem pontuação', () => {
    for (const t of ['ok', 'ok.', 'OK!', 'beleza', 'pode seguir', 'vamos', 'sim', 'aprovado', 'continua', 'próximo', 'blz', 'isso']) {
      expect(ehContinuacaoPura(t), `deveria ser continuação: ${t}`).toBe(true);
    }
  });

  it('texto vazio ou só pontuação conta como continuação', () => {
    expect(ehContinuacaoPura('')).toBe(true);
    expect(ehContinuacaoPura('   ')).toBe(true);
    expect(ehContinuacaoPura('...')).toBe(true);
  });

  it('NÃO confunde pedido real com continuação, mesmo curto', () => {
    for (const t of [
      'corrige o telegram',
      'publica',
      'roda os testes',
      'ok, corrige o telegram', // tem "corrige" fora do vocabulário
      'pode publicar a rc.158',
      'segue o token npm',      // "token"/"npm" carregam informação
    ]) {
      expect(ehContinuacaoPura(t), `NÃO deveria ser continuação: ${t}`).toBe(false);
    }
  });

  it('frase longa nunca é continuação, mesmo começando com "ok"', () => {
    expect(
      ehContinuacaoPura('ok entao vamos agora ver o que falta no picker de mcp'),
    ).toBe(false);
  });
});

describe('valeMemorizar — que turno vira fato permanente', () => {
  it('NÃO memoriza o turno que criou o entulho', () => {
    expect(valeMemorizar('segue', 'feito.')).toBe(false);
  });

  it('NÃO memoriza continuação NEM quando a resposta é longa', () => {
    // O critério é o OBJETIVO: é ele que torna a memória localizável depois. Uma
    // resposta rica sob o objetivo "ok" continua irrecuperável por busca.
    expect(valeMemorizar('ok', 'Publiquei a rc.158 com o picker de MCP e o cofre.')).toBe(false);
  });

  it('MEMORIZA trabalho de verdade', () => {
    expect(
      valeMemorizar(
        'corrige o recall da memoria que volta 500',
        'O pin do mem0ai era 0.1.76 e o script chamava a API 2.0.7.',
      ),
    ).toBe(true);
  });

  it('MEMORIZA objetivo curto porém informativo', () => {
    expect(valeMemorizar('publica a rc.158', 'Publicada.')).toBe(true);
  });

  it('não memoriza turno sem objetivo ou sem resposta', () => {
    expect(valeMemorizar('', 'qualquer coisa')).toBe(false);
    expect(valeMemorizar('corrige o telegram', '')).toBe(false);
  });

  it('na dúvida MEMORIZA — o filtro erra para o lado de guardar', () => {
    // Fato morno é barato (o piso de relevância do recall já o filtra); fato
    // descartado é perda definitiva. Este caso ambíguo tem de passar.
    expect(valeMemorizar('e agora?', 'Falta publicar e testar no Windows.')).toBe(true);
  });
});

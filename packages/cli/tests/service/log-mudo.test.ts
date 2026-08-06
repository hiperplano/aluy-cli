// LOG-MUDO (dogfooding real) — o dono olhou o `runner.log` de um pregão inteiro e
// encontrou 83 linhas: só fronteiras de atividade e subida de daemon. As 17 tools POR
// ATIVIDADE que fizeram o trabalho estavam na transcrição (`.state/sessions/*.json`) e
// em nenhum lugar legível. Palavras dele: "não consigo ver efetivamente o que aconteceu
// em cada atividade".
//
// A causa foi uma decisão minha, escrita no próprio código: "Só ERRO: sucesso continua
// fora do log, para não afogar o diagnóstico no ruído". Otimizei para DIAGNOSTICAR
// FALHA quando um serviço autônomo precisa de AUDITORIA — saber o que foi feito, não só
// o que quebrou. Num serviço que opera dinheiro, o passo bem-sucedido é exatamente o
// que se precisa poder reler depois.
//
// Este arquivo trava o clamp da fala do agente. O filtro em si (toda tool entra) vive no
// `blockTailTimer` do runner, que é I/O com timer.

import { describe, expect, it } from 'vitest';
import { clampLinhaDeLog } from '../../src/service/runner.js';

describe('clampLinhaDeLog — a fala do agente cabe em UMA linha', () => {
  it('junta quebras de linha: o log é lido com tail, não com paginador', () => {
    expect(clampLinhaDeLog('primeira\nsegunda\n\nterceira')).toBe('primeira segunda terceira');
  });

  it('colapsa espaço repetido', () => {
    expect(clampLinhaDeLog('a     b\t\tc')).toBe('a b c');
  });

  it('texto curto passa intacto — sem reticência decorativa', () => {
    expect(clampLinhaDeLog('turno concluído: 3 setups registrados')).toBe(
      'turno concluído: 3 setups registrados',
    );
    expect(clampLinhaDeLog('curto')).not.toContain('…');
  });

  it('texto longo é cortado com reticência, no teto declarado', () => {
    const r = clampLinhaDeLog('x'.repeat(500));
    expect(r.length).toBe(220);
    expect(r.endsWith('…')).toBe(true);
  });

  it('o teto é configurável (o default serve ao tail, não é lei)', () => {
    expect(clampLinhaDeLog('y'.repeat(100), 20)).toHaveLength(20);
  });

  it('vazio/só-espaço vira string vazia, não uma linha em branco no log', () => {
    expect(clampLinhaDeLog('')).toBe('');
    expect(clampLinhaDeLog('   \n \t ')).toBe('');
  });

  it('preserva o conteúdo do começo — é onde o agente diz o que fez', () => {
    // O corte é no FIM de propósito: a primeira frase de um turno costuma ser o
    // veredito ("registrei 2 setups, rejeitei 1"), e é ela que tem que sobreviver.
    const r = clampLinhaDeLog(`registrei 2 setups e rejeitei 1. ${'detalhe. '.repeat(60)}`);
    expect(r.startsWith('registrei 2 setups e rejeitei 1.')).toBe(true);
  });
});

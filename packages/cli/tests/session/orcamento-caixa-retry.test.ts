// A caixa de retry (`broker-error` em backoff) era orçada em 5 linhas FIXAS. A mensagem
// real — "não consegui falar com o provider local (falha de rede) — tentando de novo." —
// tem ~80 colunas, e o <BrokerError> a pinta com `paddingLeft={4}` + `┃ ` (2): em terminal
// de 80 ela quebra e a caixa fica com 6 linhas. Uma linha fora do orçamento é exatamente o
// que faz a região viva cruzar `rows-1` e o Ink redesenhar o frame inteiro (o "tremor").
// Achado ao medir o flicker sob erro de conexão (22/09/2026); não tremeu nas medições a
// 120/100/80 colunas porque sobrava folga, mas a conta estava errada.
import { describe, expect, it } from 'vitest';
import { liveOverheadLines } from '../../src/session/live-budget.js';
import type { SessionBlock } from '../../src/session/model.js';

const MENSAGEM = 'não consegui falar com o provider local (falha de rede) — tentando de novo.';

function caixaDeRetry(message = MENSAGEM): SessionBlock {
  return {
    kind: 'broker-error',
    message,
    backend: 'local',
    attempt: 3,
    maxAttempts: 20,
    retryInSeconds: 4,
    retrying: true,
  };
}

const altura = (columns: number, block = caixaDeRetry()) =>
  liveOverheadLines({ live: [block], phase: 'retrying', hasBlocks: true, columns, rows: 30 });

describe('orçamento da caixa de retry — conta o wrap da mensagem', () => {
  it('em 120 colunas a mensagem cabe numa linha: 5 (como antes)', () => {
    // O overhead inclui o resto da região viva na fase `retrying`; comparamos por DIFERENÇA
    // com uma caixa de mensagem curta, para isolar a altura da própria caixa.
    const curta = caixaDeRetry('x');
    expect(altura(120) - altura(120, curta)).toBe(0);
  });

  it('em 80 colunas a mensagem QUEBRA: a caixa custa 1 linha a mais', () => {
    const curta = caixaDeRetry('x');
    expect(altura(80) - altura(80, curta)).toBe(1);
  });

  it('mensagem longa em terminal estreito custa o número certo de linhas', () => {
    const longa = caixaDeRetry('a'.repeat(200)); // 200 / (60-6) = 3,7 ⇒ 4 linhas
    const curta = caixaDeRetry('x');
    expect(altura(60, longa) - altura(60, curta)).toBe(3);
  });

  it('caixa de erro FINAL (não-retrying) segue fora do orçamento vivo (não-regressão)', () => {
    const final: SessionBlock = { ...caixaDeRetry(), retrying: false };
    expect(
      liveOverheadLines({ live: [final], phase: 'error', hasBlocks: true, columns: 80, rows: 30 }),
    ).toBe(liveOverheadLines({ live: [], phase: 'error', hasBlocks: true, columns: 80, rows: 30 }));
  });
});

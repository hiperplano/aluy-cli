// MESA-MORRE-COM-O-SUPERVISOR (dogfooding real — custou meio pregão) — o runner
// derrubava os daemons no fim de TODO turno, embora a linha do log dissesse "fim do
// expediente". Não era só o texto que estava errado: era o comportamento.
//
// O que aconteceu, com hora: uma vigília do serviço de execução estourou o teto de
// atividade às 14:21; o turno encerrou em `limit`; o runner matou os 7 daemons que
// sustentavam a mesa — bridge MT5, 5 estratégias e o guarda de posição, todos
// SAUDÁVEIS. O pregão ia até 17:40. A mesa ficou fora 25 minutos até alguém olhar.
//
// O motor morreu porque o acessório adoeceu. Para um serviço que opera dinheiro isso é
// a inversão exata de prioridade: o supervisor é dispensável por alguns minutos; a
// execução, não.
//
// `until:` é o que define EXPEDIENTE. Enquanto a janela está aberta, o próximo turno
// vai acontecer e os daemons precisam estar de pé para ele. Sem `until:`, cada turno É
// o expediente e nada muda.
//
// Estes testes travam a REGRA de decisão. O laço do runner (I/O, timers, spawn) está
// coberto pelos testes de integração de serviço.

import { describe, expect, it } from 'vitest';
import { msUntilDeadline } from '@hiperplano/aluy-cli-core';

/**
 * A regra, isolada: os daemons sobrevivem ao fim de um turno enquanto o expediente
 * segue aberto. Espelha a condição do `runner.ts` — se uma mudar sem a outra, os
 * testes abaixo deixam de descrever o produto (e é para isso que a duplicação existe:
 * a condição real está enterrada num laço com spawn e timers).
 */
function daemonsSobrevivem(agora: Date, until: string | undefined): boolean {
  const restante = msUntilDeadline(agora, until);
  return restante !== undefined && restante > 0;
}

const ONTEM = (h: number, m = 0): Date => new Date(2026, 7, 6, h, m, 0);

describe('fim de turno × fim de expediente', () => {
  it('turno acaba às 14:21 com expediente até 17:40 ⇒ daemons FICAM (o caso real)', () => {
    expect(daemonsSobrevivem(ONTEM(14, 21), '17:40')).toBe(true);
  });

  it('turno acaba DEPOIS do until ⇒ derruba (o expediente acabou de verdade)', () => {
    expect(daemonsSobrevivem(ONTEM(18, 0), '17:40')).toBe(false);
  });

  it('exatamente no minuto do until ⇒ derruba (janela fechada é fechada)', () => {
    expect(daemonsSobrevivem(ONTEM(17, 40), '17:40')).toBe(false);
  });

  it('um minuto antes ⇒ ainda fica', () => {
    expect(daemonsSobrevivem(ONTEM(17, 39), '17:40')).toBe(true);
  });

  it('SEM `until:` declarado ⇒ derruba como sempre — zero regressão', () => {
    // Serviço sem expediente: cada turno é o expediente inteiro. É o comportamento
    // de todo serviço que existia antes desta mudança, e ele não pode mudar.
    expect(daemonsSobrevivem(ONTEM(14, 21), undefined)).toBe(false);
  });

  it('`until:` malformado ⇒ derruba (fail-safe: na dúvida, não deixa processo solto)', () => {
    expect(daemonsSobrevivem(ONTEM(14, 21), 'depois do almoço')).toBe(false);
    expect(daemonsSobrevivem(ONTEM(14, 21), '')).toBe(false);
  });

  it('a manhã inteira de um pregão longo mantém a mesa de pé', () => {
    for (const h of [9, 10, 11, 12, 13, 14, 15, 16, 17]) {
      expect(daemonsSobrevivem(ONTEM(h, 30), '17:40')).toBe(h < 17 || 30 < 40);
    }
  });
});

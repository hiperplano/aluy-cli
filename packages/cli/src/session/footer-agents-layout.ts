// FOOTER-AGENTES · LAYOUT — as contas de largura e ALTURA do rodapé com agentes, puras e
// sem JSX, para o RENDER e o ORÇAMENTO usarem as mesmas.
//
// Este módulo existe por uma razão específica: o `<FooterAgents>` muda a altura do rodapé
// (a coluna dos agentes tem altura fixa, e o painel de status encolhe de largura e por isso
// pode passar de duas colunas para uma, ganhando linhas). Altura de rodapé que o orçamento
// não conhece é a região viva cruzando `rows` — o Ink repinta a tela inteira a cada frame,
// que é o tremor que a rc.148 caçou. Medir num arquivo e desenhar noutro reabre isso.
//
// Sem JSX de propósito: o `live-budget.ts` importa daqui, e ele é puro.

import { LARGURA_MINIMA_2COL } from '../ui/components/StatusPanel.js';

/**
 * Altura FIXA da coluna de agentes quando ela aparece. Fixa porque um bloco que cresce a
 * cada filho que nasce mudaria a altura do frame o tempo todo; com teto, ela muda DUAS
 * vezes (quando entra e quando sai) e o resto é o "+K outros" absorvendo o excedente.
 */
// 6 (1 cabeçalho + 5 agentes). Quatro escondiam metade de um fan-out comum — o dono mandou
// um de OITO, seis deles com falha. É um número, não uma lei: subir custa altura de frame em
// toda sessão que dispara agente, e a conta disso está em `rodapeAgentesOverhead` abaixo.
export const LINHAS_RODAPE_AGENTES = 6;

/** Barra vertical (1) + o respiro dela (1). */
export const CALHA_RODAPE_AGENTES = 2;

/**
 * Largura da coluna de agentes. FRAÇÃO da tela, com piso e teto: fixa demais some num
 * terminal estreito, livre demais come o painel de status num terminal largo.
 */
export function larguraColunaAgentes(columns: number): number {
  return Math.max(18, Math.min(48, Math.floor((columns - 2) * 0.42)));
}

/** Quantas colunas sobram para o painel de status, com e sem a coluna de agentes. */
export function colunasDoPainel(columns: number, temAgentes: boolean): number {
  const gasto = temAgentes ? larguraColunaAgentes(columns) + CALHA_RODAPE_AGENTES : 0;
  return Math.max(20, columns - 2 - gasto);
}

/**
 * Quantas LINHAS o `<StatusPanel>` ocupa numa dada largura. Ele pareia os quatro itens em
 * duas colunas quando há espaço (2 linhas) e empilha quando não há (4). O banner do modo
 * `unsafe` NÃO entra aqui — o orçamento já o conta em `modeIndicatorOverhead`.
 */
export function linhasDoPainel(columns: number): number {
  return columns >= LARGURA_MINIMA_2COL ? 2 : 4;
}

/**
 * O EXCEDENTE de altura que a coluna de agentes traz ao rodapé, em linhas.
 *
 * Não é `LINHAS_RODAPE_AGENTES`: o rodapé já ocupava algumas linhas com o painel, e a
 * conta é a DIFERENÇA entre o que ele passa a ocupar e o que ocupava. Num terminal
 * estreito o painel já empilhava em 4 linhas e o excedente é ZERO — a coluna cabe ao lado
 * sem custo nenhum de altura.
 */
export function rodapeAgentesOverhead(temAgentes: boolean, columns: number): number {
  if (!temAgentes) return 0;
  const antes = linhasDoPainel(Math.max(20, columns - 2));
  const depois = Math.max(LINHAS_RODAPE_AGENTES, linhasDoPainel(colunasDoPainel(columns, true)));
  return Math.max(0, depois - antes);
}

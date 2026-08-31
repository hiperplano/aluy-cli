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


/**
 * Altura FIXA da coluna de agentes quando ela aparece. Fixa porque um bloco que cresce a
 * cada filho que nasce mudaria a altura do frame o tempo todo; com teto, ela muda DUAS
 * vezes (quando entra e quando sai) e o resto é o "+K outros" absorvendo o excedente.
 */
// 6 (1 cabeçalho + 5 agentes). Quatro escondiam metade de um fan-out comum — o dono mandou
// um de OITO, seis deles com falha. É um número, não uma lei: subir custa altura de frame em
// toda sessão que dispara agente, e a conta disso está em `rodapeAgentesOverhead` abaixo.
/**
 * Quantas linhas o rodapé pode gastar com a cópia fixada dos agentes, dada a ALTURA do
 * terminal.
 *
 * Era um 6 cravado, escolhido por mim sem olhar a tela — e o dono achou o buraco em um
 * teste: disparou 4, depois mais 4 (os oito entram no MESMO bloco quando o primeiro lote
 * ainda corre), e o rodapé mostrava três e um "+5 outros" para sempre, num terminal com
 * espaço de sobra. "mostrou 3 no rodape, mas depois nao mostrou mais no pe alem dos 3".
 *
 * Agora é uma FRAÇÃO da tela, com piso e teto. O piso garante algo útil em terminal baixo;
 * o teto impede que um fan-out grande coma a conversa inteira — o rodapé é socorro, não a
 * tela principal.
 */
export function linhasDoRodapeAgentes(rows?: number): number {
  const r = Number.isFinite(rows) && (rows ?? 0) > 0 ? (rows as number) : 24;
  return Math.max(4, Math.min(14, Math.floor(r / 3)));
}

/** Barra vertical (1) + o respiro dela (1). */
export const CALHA_RODAPE_AGENTES = 2;

export function rodapeAgentesOverhead(quantosAgentes: number, rows?: number): number {
  if (quantosAgentes <= 0) return 0;
  // A altura acompanha o LOTE, com o teto que a tela comporta. Não oscila durante a corrida
  // porque o lote não muda de tamanho — quem termina continua na lista, só muda de fase.
  return Math.min(quantosAgentes + 2, linhasDoRodapeAgentes(rows));
}

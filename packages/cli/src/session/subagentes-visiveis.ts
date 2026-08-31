// VISÍVEL-OU-FIXADO — o bloco de sub-agentes já saiu da tela?
//
// Pedido do dono, e é a regra que fecha a redundância que ele vinha apontando: "os agentes
// no footer deveriam aparecer embaixo somente quando os de cima sumirem". Nunca os dois ao
// mesmo tempo — a cópia no rodapé é um SOCORRO, não um segundo painel.
//
// Como se sabe se ele "sumiu": o histórico vive no `<Static>` do Ink, ou seja, já foi
// escrito no scrollback do terminal, e daí em diante quem decide o que aparece é o terminal.
// O que o CLI SABE é quanta coisa veio DEPOIS dele. Se a soma do que veio depois, mais a
// região viva, mais o próprio bloco, ainda cabe na altura do terminal, então ele continua
// na tela — e fixar uma cópia seria duplicar. Passou disso, ele rolou para cima e a cópia
// passa a valer.
//
// A altura por bloco NÃO pôde ser a do cockpit (`measureConversaBlock`): aquela é a altura
// CLIPADA de uma janela — devolve 22 para uma fala de 200 linhas —, e aqui o que importa é
// quanto o bloco EMPURROU no terminal. Ver `alturaNoScrollback` abaixo, e a justificativa
// de ela ser uma terceira régua.

import type { SessionBlock } from './model.js';
import { visualLines } from './visual-lines.js';

/**
 * Altura que um bloco CONCLUÍDO ocupou no SCROLLBACK, em linhas.
 *
 * É uma terceira régua de altura, e isso pede justificativa: as duas que já existem medem
 * outra coisa. O `liveOverheadLines` mede a região VIVA; o `measureConversaBlock` mede a
 * altura CLIPADA do cockpit — ele devolve 22 para uma fala de 200 linhas, porque lá existe
 * uma janela. No modo inline aquelas 200 linhas foram escritas de verdade no terminal, e é
 * disso que esta conta precisa: quanto empurrou.
 *
 * ESTIMATIVA, e assumida como tal. Erra para MENOS de propósito (não conta molduras nem
 * respiros): subestimar leva a "ainda está visível", que é o erro barato — o dono deixa de
 * ver a cópia por um instante. Superestimar poria as duas na tela, que é justamente o que
 * ele pediu para acabar.
 */
export function alturaNoScrollback(b: SessionBlock, columns: number): number {
  const cols = Math.max(1, columns - 4);
  switch (b.kind) {
    case 'aluy':
    case 'you':
      return visualLines(b.text, cols) + 2;
    case 'subagents':
      return b.children.length + 2;
    case 'tool':
      return 1 + (b.result === undefined || b.result === '' ? 0 : visualLines(b.result, cols));
    case 'bang':
      return 1 + (b.output === undefined || b.output === '' ? 0 : visualLines(b.output, cols));
    case 'note':
      return b.lines.length + 1;
    default:
      return 2;
  }
}

/** Índice do ÚLTIMO bloco de sub-agentes, ou -1. */
export function ultimoBlocoSubagentes(blocks: readonly SessionBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) if (blocks[i]?.kind === 'subagents') return i;
  return -1;
}

export interface VisibilidadeArgs {
  readonly blocks: readonly SessionBlock[];
  /** Altura do terminal. */
  readonly rows: number;
  /** Largura do terminal (entra na medição de cada bloco). */
  readonly columns: number;
  /** Quantas linhas a região viva + o chrome do rodapé já ocupam neste frame. */
  readonly linhasDoRodape: number;
}

/**
 * O bloco de sub-agentes AINDA está na tela?
 *
 * Conservador de propósito: na dúvida devolve `true` (ainda visível ⇒ NÃO fixa a cópia).
 * Errar para "ainda visível" custa o dono não ver o bloco por um instante ao rolar; errar
 * para "sumiu" põe duas cópias na tela, que é exatamente o que ele pediu para acabar.
 */
export function blocoSubagentesNaTela(args: VisibilidadeArgs): boolean {
  const i = ultimoBlocoSubagentes(args.blocks);
  if (i < 0) return true; // não há bloco: nada a fixar
  if (!Number.isFinite(args.rows) || args.rows <= 0) return true;
  let linhas = 0;
  for (let k = i; k < args.blocks.length; k += 1) {
    const b = args.blocks[k];
    if (b === undefined) continue;
    linhas += alturaNoScrollback(b, args.columns);
    if (linhas + args.linhasDoRodape > args.rows) return false; // já rolou p/ fora
  }
  return linhas + args.linhasDoRodape <= args.rows;
}

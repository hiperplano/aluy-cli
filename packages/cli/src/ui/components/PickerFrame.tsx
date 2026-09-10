// F-PICKER-PAINEL (pedido do dono: "não é possível o picker aparecer como popup, para ficar
// mais fácil selecionar, em vez de ficar preso embaixo?" e, depois, "revise todos os menus
// que têm picker e aplique o mesmo padrão") — a MOLDURA comum de todo seletor da TUI.
//
// Popup de verdade — uma caixa flutuando SOBRE o conteúdo — é impossível no modo inline: o
// Ink escreve linha a linha no scrollback do terminal, sem plano de sobreposição. Só o
// `/fullscreen`, que trata a tela como matriz, poderia fazê-lo.
//
// O que dá o efeito pretendido sem depender do fullscreen é a moldura. Sem ela, a lista se
// mistura à conversa logo acima e o olho não sabe onde o seletor começa; com ela, vira um
// painel próprio — que é o que "parecer popup" queria dizer na prática.
//
// Componente ÚNICO em vez de nove molduras iguais espalhadas: eram nove pickers, e um
// padrão replicado à mão é um padrão que diverge no primeiro ajuste.

import React from 'react';
import { Box, useStdout } from 'ink';
import { useTheme } from '../theme/index.js';

export interface PickerFrameProps {
  readonly children: React.ReactNode;
  /** Largura do terminal. Ausente ⇒ lê do stdout (produção). Injetável p/ teste. */
  readonly columns?: number;
}

/**
 * COLUNA DE FOLGA à direita.
 *
 * O dono, em 08-09/09: "por que não aparece a borda da direita do menu". Aqui a moldura
 * fecha dos dois lados em 200, 120, 100, 90 e 80 colunas — eu medi —, então a causa não é
 * o desenho em si: é a moldura ocupar EXATAMENTE `columns` e o terminal dele discordar da
 * nossa conta por uma coluna. Duas fontes conhecidas disso, ambas fora do nosso alcance:
 *
 *  - terminais que não deixam escrever na última coluna sem disparar o auto-wrap (o
 *    caractere vai para a linha seguinte e some sob o repaint);
 *  - glifo que medimos como 1 coluna e o terminal desenha com 2 (`⚠`, `◈`, setas) — comum
 *    no Windows Terminal/conhost. A linha estoura por um e a borda cai fora.
 *
 * Reservar uma coluna absorve as duas sem precisar saber qual delas é. O custo é uma coluna
 * que ninguém vê; o benefício é a moldura nunca encostar no limite.
 *
 * HONESTIDADE: isto é MITIGAÇÃO, não diagnóstico. Não reproduzi o defeito do dono em
 * nenhuma largura aqui; o que está provado é o invariante abaixo (a moldura nunca ocupa a
 * largura inteira), não que ele seja a causa do que ele vê.
 */
export const FOLGA_DIREITA = 1;

/** Largura da moldura para um terminal de `columns` colunas. PURA — é o que o teste trava. */
export function larguraDaMoldura(columns: number | undefined): number | undefined {
  if (columns === undefined || !Number.isFinite(columns)) return undefined;
  // Terminal minúsculo: melhor não impor largura nenhuma que impor uma inútil.
  if (columns < 20) return undefined;
  return columns - FOLGA_DIREITA;
}

export function PickerFrame(props: PickerFrameProps): React.ReactElement {
  const theme = useTheme();
  const { stdout } = useStdout();
  const largura = larguraDaMoldura(props.columns ?? stdout?.columns);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.role('accent').color}
      paddingX={1}
      {...(largura !== undefined ? { width: largura } : {})}
    >
      {props.children}
    </Box>
  );
}

/**
 * Quantas linhas de lista cabem, dada a altura do terminal.
 *
 * Derivada em vez de cravada porque os dois extremos doem: num terminal alto, mostrar 8 de
 * 418 itens obriga a filtrar às cegas; num terminal baixo, uma janela fixa empurra o
 * composer para fora da tela. O piso preserva o comportamento antigo em tela pequena e o
 * teto evita que uma tela muito alta vire uma parede de itens que ninguém lê.
 *
 * `reserva` é o que o resto da UI consome (header, conversa, composer, painel de status).
 */
export function alturaDeLista(rows: number | undefined, reserva = 20): number {
  return Math.max(8, Math.min(20, (rows ?? 24) - reserva));
}

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
import { Box } from 'ink';
import { useTheme } from '../theme/index.js';

export interface PickerFrameProps {
  readonly children: React.ReactNode;
}

export function PickerFrame(props: PickerFrameProps): React.ReactElement {
  const theme = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.role('accent').color}
      paddingX={1}
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

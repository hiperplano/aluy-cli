// EST-0985 · polish de TUI — <Divider>: régua horizontal de largura total p/ dar
// HIERARQUIA visual (emoldura o input). Chrome ESTÁTICO: NÃO anima, fica FORA da
// região viva animada (compatível com o <Static>/anti-flicker EST-0965).
//
// Glifo `horizontal` da tabela de box (`box.horizontal`): `─` em Unicode, `-` em
// ASCII — herda o ENDURECIMENTO de glifos da EST-0984 (TERM=linux / locale não-UTF-8
// / `--ascii` caem em `-` automaticamente, via theme.box). Papel DIM (`fgDim` por
// default, ou `depth`): discreta, NÃO compete com o conteúdo. Cor por TOKEN (papel),
// nunca cor crua — fallbacks NO_COLOR/16-cores intactos (palette.ts).
//
// Largura ESTÁVEL / sem jitter (EST-0956/0965): a linha é CONSTANTE — repete o
// mesmo glifo `columns` vezes, sem nada vivo dentro. Re-render do tick não a toca
// (fica fora da região viva). Piso de 1 célula p/ terminais minúsculos.

import React from 'react';
import { Role, useTheme } from '../theme/index.js';

export interface DividerProps {
  /** Largura do terminal (régua de largura total). Default 80 (não-TTY/teste). */
  readonly columns?: number;
  /**
   * Papel DIM da linha — discreto, não compete com o conteúdo. `fgDim` (default,
   * neutro/meta) ou `depth` (petrol, meta estrutural). Nunca um papel "vivo".
   */
  readonly role?: 'fgDim' | 'depth';
  /**
   * EST-0987 — `subtle`: divisória de RESPIRO entre turnos do histórico. Mais
   * DISCRETA que a régua de chrome: papel `fgDim` (o mais apagado) E largura
   * PARCIAL (um traço curto, não a régua cheia) — separa sem competir com o
   * conteúdo. `false`/ausente ⇒ régua de largura total (chrome, comportamento
   * antigo). Quando `subtle`, ignora-se `role` (é sempre o mais apagado).
   */
  readonly subtle?: boolean;
}

// EST-0987 — largura do traço SUTIL (entre turnos): curto e estável, NÃO a régua
// cheia. Limitado pela largura do terminal (piso 1) p/ não estourar em telas
// minúsculas. Valor pequeno e constante ⇒ sem jitter, anti-flicker intacto.
const SUBTLE_WIDTH = 12;

export function Divider(props: DividerProps): React.ReactElement {
  const theme = useTheme();
  // `box.horizontal`: `─` (UNICODE_BOX) ou `-` (ASCII_BOX) — já resolvido pela
  // capacidade do terminal (EST-0984). Régua = o glifo repetido `columns` vezes.
  const ch = theme.box.horizontal;
  const full = Math.max(1, props.columns ?? 80);
  // EST-0987 — `subtle`: traço CURTO (largura parcial) no papel mais apagado
  // (`fgDim`). A chrome usa a régua cheia; aqui um respiro discreto entre turnos.
  const width = props.subtle ? Math.min(SUBTLE_WIDTH, full) : full;
  const role = props.subtle ? 'fgDim' : (props.role ?? 'fgDim');
  const line = ch.repeat(width);
  return <Role name={role}>{line}</Role>;
}

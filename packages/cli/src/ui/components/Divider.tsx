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
import { Text } from 'ink';
import { useTheme } from '../theme/index.js';

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

export function Divider(props: DividerProps): React.ReactElement {
  const theme = useTheme();
  // `box.horizontal`: `─` (UNICODE_BOX) ou `-` (ASCII_BOX) — já resolvido pela
  // capacidade do terminal (EST-0984). Régua = o glifo repetido `columns` vezes.
  // F-SEM-REGUA (decisão do dono, olhando o opencode lado a lado: "as linhas no CLI
  // deixam uma cara muito ruim... em vez de linhas separando as seções, alguma outra
  // coisa") — a RÉGUA DE LARGURA TOTAL sai. Ela existia para "emoldurar o input", mas
  // uma linha de ponta a ponta compete com o conteúdo em vez de organizá-lo, e ficou
  // gritante quando o `box.horizontal` engrossou para `━` (moldura pesada das CAIXAS).
  //
  // A separação passa a ser ESPAÇO — o recurso que o opencode usa e que não disputa
  // atenção com nada. O peso fica reservado para onde CERCA algo de verdade (diálogos,
  // diff, composer): aí a borda é informação, não enfeite.
  //
  // A ALTURA é preservada de propósito (uma linha, agora vazia): o cockpit soma a altura
  // de cada região para fechar o grid sem tremer (ADR-0076 §5). Devolver zero linha aqui
  // faria o layout refluir e trazer de volta o jitter que aquele desenho existe p/ matar.
  //
  // `subtle` (o respiro CURTO entre turnos) sobrevive: ali o traço é pequeno, não corta a
  // tela, e é o que dá ritmo ao histórico — é régua de chrome que incomodava, não ele.
  // F-PROFUNDIDADE (relato do dono: "acho que um ____________ não está legal separando as
  // seções de conversa") — o traço CURTO entre turnos também sai. A separação de turno já
  // é dada pelo próprio rótulo (`▌ você` / `Λ aluy`) e pelo espaço; um traço solto no meio
  // da conversa é ruído com aparência de conteúdo.
  //
  // Continua devolvendo UMA linha (vazia) para não mexer no orçamento anti-flicker do
  // cockpit, que soma alturas de região para fechar o grid sem tremer.
  void theme;
  void props;
  return <Text> </Text>;
}

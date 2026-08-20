// EST-0982 · ADR-0063 (CONTABILIDADE) — <TurnFooter>: o resumo do TURNO do agente
// PRINCIPAL (tokens + duração), estilo Claude Code.
//
// O Tiago pediu a contabilidade "estilo Claude Code": tokens E tempo por agente E o
// total do turno/sessão. O bloco `[sub-agentes]` já mostra por filho (EST-0969 +
// tempo desta estória); este rodapé mostra o AGENTE PRINCIPAL — o que o Claude Code
// faz no fim do turno (`⏺ 12.3k tokens · 2 tools · 4.1s`).
//
// É LEITURA/DISPLAY puro (ADR-0063 §4 / GS-C: contabilidade não dispara efeito novo,
// não vaza segredo — são só contadores do budget/broker + o relógio). Apresentação
// pura (papéis do DS); a fonte do dado é o controller (`turnAccounting`).

import React from 'react';
import { Box, Text } from 'ink';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { displayWidth } from '../../session/visual-lines.js';
import { abbreviateCount, formatDuration, type TurnAccountingView } from '../../session/model.js';

export interface TurnFooterProps {
  readonly accounting: TurnAccountingView;
  /**
   * F-RECAP (pedido do dono: "um recap na linha inferior do que fez") — resumo do que o
   * turno FEZ (`buildTurnRecap`). O rodapé de hoje informa CUSTO (tokens/tools/duração),
   * que responde "quanto gastou" e não "o que aconteceu"; num turno com dez tools o dono
   * teria de reler o histórico para saber que arquivo foi tocado. Ausente ⇒ rodapé
   * idêntico ao de hoje (turno de conversa pura não inventa recap).
   */
  readonly recap?: string;
  /** Largura do terminal — necessária p/ o fundo alcançar o fim da linha (ver o render). */
  readonly columns?: number;
  /**
   * F-CONTA-NO-BLOCO — `false` remove o CUSTO (tokens · tools · tempo) desta linha, que
   * passou a viver no cabeçalho do `<AluyBlock>` do turno que o gastou. O que sobra aqui é
   * o RECAP — "o que foi feito" —, que continua pertencendo ao composer: ele fala do turno
   * que acabou para quem está compondo o próximo, e não é um atributo da resposta.
   */
  readonly showCost?: boolean;
}

export function TurnFooter(props: TurnFooterProps): React.ReactElement {
  const theme = useTheme();
  const a = props.accounting;
  const parts: string[] = [];
  if (props.showCost !== false) {
    parts.push(`${abbreviateCount(a.tokens)} tokens`);
    if (a.toolCalls > 0) parts.push(`${a.toolCalls} tools`);
    parts.push(formatDuration(a.durationMs));
  }
  // O recap vem DEPOIS do custo: quem varre o rodapé procura primeiro o número, e o
  // resumo é a leitura que se faz quando o número chama atenção.
  if (props.recap !== undefined && props.recap !== '') parts.push(props.recap);
  // F-TOKENS-NO-COMPOSER (pedido do dono: "a área dos tokens e do tempo deve ter o mesmo
  // fundo que a área do composer") — o rodapé de turno vive DENTRO do bloco do composer,
  // então tem de compartilhar a superfície dele. Sem isso ficava uma faixa clara no meio
  // do bloco cinza, lendo como buraco em vez de continuação.
  //
  // Preenche até o fim da linha pelo MESMO motivo do campo: no Ink o fundo só pinta onde
  // há caractere — `<Box backgroundColor>` não pinta nada (medido). Sem o preenchimento,
  // a faixa pararia no fim do texto e o bloco ficaria com uma mordida no canto.
  const texto = parts.join(' · ');
  // Sem custo E sem recap não há linha: uma faixa pintada vazia dentro do composer leria
  // como o "quadradinho cinza solto" que já custou uma rodada de conserto.
  if (texto === '') return <></>;
  const fundo = theme.composerBg;
  // A faixa vive DENTRO do bloco com borda esquerda: a borda come 1 coluna e o `paddingLeft`
  // do conteúdo come outra, então a área pintável é `columns - 2`. Pintar `columns - 1` (o
  // que se fazia aqui) estoura exatamente 1 coluna, o Ink joga esse espaço pintado para a
  // linha seguinte — e ele aparece como um quadradinho cinza solto embaixo do composer.
  const usado = 2 + 1 + 1 + displayWidth(texto);
  const sobra =
    fundo !== undefined && props.columns !== undefined && props.columns - 2 > usado
      ? props.columns - 2 - usado
      : 0;
  return (
    <Box>
      <Text {...(fundo !== undefined ? { backgroundColor: fundo } : {})}>
        {'  '}
        {/* `done` (concluído) ⇒ ✓; `live` (turno correndo) ⇒ ◷ relógio. */}
        {a.live ? <Glyph name="clock" role="depth" /> : <Glyph name="ok" role="success" />}
        <Text> </Text>
        <Role name="fgDim">{texto}</Role>
        {sobra > 0 && <Text>{' '.repeat(sobra)}</Text>}
      </Text>
    </Box>
  );
}

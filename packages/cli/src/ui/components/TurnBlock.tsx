// EST-0948 · spec §2.4/§3.6 — <TurnBlock>: bloco `▌ você` / `Λ aluy` + stream.
//
// Cada turno é um bloco com glifo de papel à esquerda (gutter de papel, §1). A
// fala fica indentada 2 colunas. CRONOLOGIA ESMAECIDA (§1/§3.1): o turno CORRENTE
// é o único em `fg` pleno; turnos passados (isCurrent=false) vão a `fgDim`. O
// texto do `aluy` faz stream token-a-token (EST-0943): enquanto `streaming`,
// mostra o CURSOR DE TRABALHO na ponta (EST-0965: glifo ● GROSSO/ARREDONDADO em
// AMARELO — papel `accent` do DS —, piscar CALMO; antes era a barra fina `▏` branca
// piscando frenética) e a MARCA Λ do Aluy "desenha + respira" (EST-0984, via
// <AluyLoader>) no lugar do antigo `◇`. PURO: o pulso/cursor derivam de `frame % n`
// por prop. É o ÚNICO cursor na tela enquanto trabalha — o `▏` do composer some
// (App suprime via `showCursor`), p/ nunca haver dois cursores ao mesmo tempo.

import React from 'react';
import { Box, Text } from 'ink';
import { cleanAluyForDisplay } from '@hiperplano/aluy-cli-core';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { Markdown } from '../markdown/index.js';
import { AluyLoader } from './AluyLoader.js';
import { windowTailVisual } from '../../session/visual-lines.js';
import { clampLiveOutputChars, MAX_LIVE_SPEECH_CHARS } from '../../session/live-budget.js';

export interface YouBlockProps {
  readonly text: string;
  /** `false` ⇒ cronologia esmaecida (turno passado em fgDim). Default true. */
  readonly isCurrent?: boolean;
}

export function YouBlock(props: YouBlockProps): React.ReactElement {
  const speech = props.isCurrent === false ? 'fgDim' : 'fg';
  return (
    <Box flexDirection="column">
      <Box>
        <Glyph name="you" role="fg" />
        <Role name="fg"> você</Role>
      </Box>
      <Box paddingLeft={2}>
        <Role name={speech}>{props.text}</Role>
      </Box>
    </Box>
  );
}

export interface AluyBlockProps {
  readonly text: string;
  readonly streaming: boolean;
  /** `false` ⇒ cronologia esmaecida (turno passado em fgDim). Default true. */
  readonly isCurrent?: boolean;
  /** Frame do tick central (pulso do ◇ + cursor). Puro; 0 = estático. */
  readonly frame?: number;
  /**
   * Anti-flicker — teto de altura da PRÉVIA enquanto faz STREAM. Se o texto vivo
   * passar deste nº de linhas, mostra só a JANELA das últimas linhas (cauda) + um
   * marcador `… (N linhas acima)`. Mantém a região dinâmica curta — o que permite ao
   * Ink preservar o histórico no `<Static>` no scrollback (sem isto, o Ink limpa a
   * tela inteira a cada frame quando a parte viva estoura o terminal → tremor). Ao
   * finalizar o turno, o bloco vai INTEIRO p/ o Static (nada é perdido). 0/ausente ⇒
   * sem teto (comportamento antigo). Só se aplica DURANTE o streaming.
   *
   * É um teto de linhas VISUAIS (não linhas-fonte): a janela de cauda mede a altura
   * REAL com WRAP (linhas largas quebram em várias) usando `columns` — ver windowTail.
   */
  readonly maxLines?: number;
  /**
   * Largura do terminal (colunas). Necessária p/ medir a altura VISUAL real da prévia
   * (linhas largas quebram em várias) ao janelar a cauda. Ausente/0 ⇒ sem wrap
   * conhecido: janela por linhas-FONTE (degradação graciosa, comportamento antigo).
   */
  readonly columns?: number;
}

/** Indentação (colunas) da FALA do aluy — `<Box paddingLeft={2}>`. */
const SPEECH_INDENT = 2;

/**
 * EST-0965 — cadência do PISCAR CALMO do cursor de trabalho (●). Com o tick central
 * ~120ms (DEFAULT_TICK_MS), um ciclo de 10 frames dura ~1.2s. ACESO nos primeiros
 * BLINK_ON frames, apagado no resto: duty-cycle alto ⇒ o cursor "respira" devagar em
 * vez de cintilar. (Mantido aqui — só o TurnBlock usa.)
 */
const BLINK_PERIOD = 10;
const BLINK_ON = 6;

export function AluyBlock(props: AluyBlockProps): React.ReactElement {
  const theme = useTheme();
  // EST-0965/EST-0944 — esconde os marcadores CRUS do protocolo, em QUALQUER
  // formato reconhecido (`<<<ALUY_TOOL_CALL …>>>` E `<tool_call> … </tool_call>`,
  // mais qualquer PREFIXO deles a meio-chegar no rabo do stream) — detalhe de
  // máquina, não fala. A linha `⏺ <tool>` (ToolLine) é quem mostra a ação; aqui
  // fica só a prosa limpa do assistente em volta. O `props.text` ARMAZENADO
  // continua CRU (o loop/parse precisa dele); só o que é PINTADO passa por este
  // filtro de display.
  // F61 (anti-flicker) — durante o STREAM, cortamos o RAW na CAUDA ANTES da limpeza
  // pesada (`cleanAluyForDisplay`: várias varreduras regex no texto inteiro) e da
  // janela (`windowTailVisual`: split + medição visual de cada linha). Sem isto, uma
  // resposta GRANDE era REPROCESSADA INTEIRA a cada tick (~120ms) ⇒ jank/flicker. A
  // região viva só pinta a CAUDA (a janela de `maxLines`), então o conteúdo VISÍVEL é
  // idêntico — só o custo por tick vira O(1). FINALIZADO (streaming=false) NÃO corta: o
  // bloco inteiro desce p/ o <Static> (nada se perde). É o mesmo padrão da saída ao
  // vivo de comandos (`clampLiveOutputChars` no <ToolLine>/<BangBlock>).
  const raw = props.streaming
    ? clampLiveOutputChars(props.text, MAX_LIVE_SPEECH_CHARS)
    : props.text;
  const full = cleanAluyForDisplay(raw);
  const speech = props.isCurrent === false ? 'fgDim' : 'fg';

  // Janela de cauda (só durante o stream): limita a altura VISUAL da prévia viva.
  // A fala é indentada 2 colunas (paddingLeft), então o wrap acontece em columns-2.
  const speechCols = props.columns && props.columns > 0 ? props.columns - SPEECH_INDENT : 0;
  const { text, hidden: hiddenAbove } = windowTailVisual(
    full,
    props.streaming ? props.maxLines : undefined,
    speechCols,
  );

  // EST-0965 — o cursor de TRABALHO pisca CALMO (não frenético). Sem animação fica
  // sempre visível (sem perda de sentido). ANTI-JITTER (EST-0956): o cursor tem
  // ALTURA/LARGURA CONSTANTES — quando "apagado" NÃO some (o que removia a linha/
  // célula inteira), vira um ESPAÇO. Sem isto, o cursor aparecendo/sumindo mudava a
  // altura da região VIVA ±1 linha a cada frame (e, perto da borda do terminal, ainda
  // forçava/desfazia o wrap da última linha) — então o composer / "esc interromper"
  // SUBIA e DESCIA. Visualmente o pisca continua (glifo ● ↔ espaço); a altura/largura
  // é estável. NÃO há `\x1b[2K` novo nem redesenho da região: é só o conteúdo da MESMA
  // célula alternando, dentro do frame já gerido (não regride #95/#118).
  //
  // CADÊNCIA CALMA (EST-0965): o tick central é ~120ms (DEFAULT_TICK_MS). O pisca
  // antigo (`frame % 2`) acendia/apagava a cada ~240ms — frenético. Aqui o ciclo é de
  // BLINK_PERIOD=10 frames (~1.2s): ACESO nos 6 primeiros, apagado nos 4 últimos
  // (duty alto ⇒ "calmo", quase estável, sem cintilar). Puro: deriva de `frame % n`.
  const blinkPhase = (props.frame ?? 0) % BLINK_PERIOD;
  const cursorOn = !theme.animate || blinkPhase < BLINK_ON;

  return (
    <Box flexDirection="column">
      <Box>
        {/* EST-0984 — a marca Λ "desenha + respira" enquanto faz stream; sólida
            (accent) quando o turno termina ou sem animação. Largura constante. */}
        {props.streaming ? (
          <AluyLoader frame={props.frame ?? 0} />
        ) : (
          <Glyph name="aluy" role="accent" />
        )}
        <Role name="accent"> aluy</Role>
      </Box>
      <Box paddingLeft={2} flexDirection="column">
        {/* marcador da janela de cauda: o que rolou p/ cima durante o stream (some no
            fim do turno, quando o bloco inteiro desce p/ o Static / scrollback). */}
        {hiddenAbove > 0 && <Role name="fgDim">… ({hiddenAbove} linhas acima)</Role>}
        {/* A FALA do aluy renderiza como MARKDOWN (negrito/listas/títulos/citações
            /links) + blocos ```lang realçados em papéis do DS. Aplica-se ao TEXTO
            ACUMULADO do turno (não token-a-token) — o stream segue fluido. A
            cronologia esmaecida propaga via baseRole (fg pleno vs fgDim). */}
        <Markdown
          text={text}
          baseRole={speech}
          {...(speechCols > 0 ? { columns: speechCols } : {})}
        />
        {/* Cursor de TRABALHO (EST-0965): ● GROSSO/ARREDONDADO em AMARELO (papel
            `accent` do DS — em NO_COLOR/mono degrada p/ o glifo SEM cor, só bold).
            Largura/altura CONSTANTE (EST-0956): durante o stream o nó é SEMPRE
            renderizado; só o conteúdo alterna entre o glifo (ligado) e um espaço
            (desligado), num pisca CALMO (~1.2s). A célula nunca colapsa p/ 0 ⇒ a
            altura da região viva não oscila ⇒ o composer não pula (sem `\x1b[2K`
            novo, sem redesenho de região — não regride #95/#118). */}
        {props.streaming &&
          (cursorOn ? <Role name="accent">{theme.glyph('thinkingCursor')}</Role> : <Text> </Text>)}
      </Box>
    </Box>
  );
}

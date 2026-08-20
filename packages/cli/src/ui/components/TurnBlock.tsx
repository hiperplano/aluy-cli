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
import wrapAnsi from 'wrap-ansi';
import { windowTailVisual, capSourceLineChars, displayWidth } from '../../session/visual-lines.js';
import { abbreviateCount, formatDuration, type TurnAccountingView } from '../../session/model.js';
import { clampLiveOutputChars, MAX_LIVE_SPEECH_CHARS } from '../../session/live-budget.js';

export interface YouBlockProps {
  readonly text: string;
  /** `false` ⇒ cronologia esmaecida (turno passado em fgDim). Default true. */
  readonly isCurrent?: boolean;
  /**
   * Largura do terminal. Necessária para PINTAR o bloco: sem ela não dá para saber até
   * onde preencher cada linha, e o fundo sairia só atrás dos caracteres — um retângulo
   * esfarrapado. Ausente ⇒ bloco sem fundo (degradação graciosa, o desenho antigo).
   */
  readonly columns?: number;
}

/**
 * F-ECO-PINTADO (pedido do dono: "toda a área que ficasse logada com o que eu enviei
 * tivesse o mesmo fundo e o acabamento lateral igual o composer") — o que VOCÊ mandou
 * ganha a MESMA moldura do composer: barra `┃` na cor de acento à esquerda e o mesmo
 * fundo preenchido até a borda.
 *
 * A razão de ser não é decoração: o composer e o eco são a MESMA voz separada pelo
 * tempo — o que você acabou de digitar e o que você digitou antes. Dar-lhes a mesma
 * moldura faz a coluna da esquerda virar um fio contínuo do seu lado da conversa, e a
 * resposta do agente (sem moldura) se distingue por AUSÊNCIA, sem precisar de régua
 * nenhuma entre as seções — que era exatamente o que o dono não queria ver.
 *
 * Pintar exige quebrar o texto AQUI em vez de deixar o Ink quebrar: `<Text backgroundColor>`
 * só pinta onde há caractere, então cada linha visual precisa ser emitida já preenchida
 * até a largura útil. O wrap usado é o MESMO do Ink (`wrap-ansi` com `trim:false,
 * hard:true`), senão as linhas pintadas e as linhas reais divergiriam.
 */
export function YouBlock(props: YouBlockProps): React.ReactElement {
  const theme = useTheme();
  const speech = props.isCurrent === false ? 'fgDim' : 'fg';
  const fundo = theme.composerBg;
  // `-2`: a borda esquerda come 1 coluna e o recuo da fala come outra. É a MESMA conta do
  // `<TurnFooter>`; errá-la por 1 joga um espaço pintado para a linha seguinte (o
  // "quadradinho cinza solto" que o dono viu embaixo do composer).
  // `-3`: borda (1) + o espaço de recuo que cada linha pintada já embute (1) + a coluna
  // que o Ink reserva à direita (1). Medido contra o composer no TTY: com `-4` o eco
  // pintava 138 colunas e o composer 139, e a diferença de UMA coluna aparecia como um
  // degrau na borda direita dos dois retângulos.
  const util = props.columns !== undefined ? Math.max(8, props.columns - 3) : undefined;

  if (fundo === undefined || util === undefined) {
    // Terminal sem truecolor (ou largura desconhecida): sem fundo, o desenho de sempre.
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

  const linhas = props.text
    .split('\n')
    .flatMap((ln) =>
      wrapAnsi(capSourceLineChars(ln), util, { trim: false, hard: true }).split('\n'),
    );

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.role('accent').color}
    >
      <Text backgroundColor={fundo}>
        {' '}
        <Text {...(theme.role('fg').color !== undefined ? { color: theme.role('fg').color } : {})}>você</Text>
        {' '.repeat(Math.max(0, util - 4))}
      </Text>
      {linhas.map((ln, i) => (
        <Text
          key={i}
          backgroundColor={fundo}
          {...(theme.role(speech).color !== undefined ? { color: theme.role(speech).color } : {})}
        >
          {` ${ln}${' '.repeat(Math.max(0, util - displayWidth(ln)))}`}
        </Text>
      ))}
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
  /**
   * F-CONTA-NO-BLOCO (pedido do dono: "ao invés dos tokens e do tempo ficar no composer,
   * ficar do lado do aluy quando a conversa finalizar") — o custo do turno no CABEÇALHO
   * do bloco que o produziu, e não flutuando no campo de entrada.
   *
   * A razão é de leitura: no composer o número falava do turno ANTERIOR enquanto você já
   * digitava o próximo — informação certa no lugar errado, sempre um passo atrasada em
   * relação ao que está sob o cursor. No cabeçalho do bloco ele fica preso à resposta que
   * de fato o gastou, e o histórico passa a carregar o próprio custo linha a linha.
   *
   * Só aparece com o turno FINALIZADO: durante o stream os números ainda estão subindo, e
   * um contador correndo ao lado do `Λ aluy` competiria com o cursor de trabalho.
   */
  readonly accounting?: TurnAccountingView;
  /**
   * F-RAC — RACIOCÍNIO do modelo neste turno (canal separado da fala). Renderiza
   * ESMAECIDO e acima da fala, nunca como resposta.
   *
   * Existe porque num modelo de raciocínio o `content` fica NULO enquanto ele pensa
   * (medido: 18 chunks só de raciocínio antes do 1º token de fala). Sem isto o bloco
   * ficava VAZIO durante todo o trabalho e — quando o turno acabava dentro do
   * raciocínio (`finish_reason: 'length'`) — vazio PARA SEMPRE, sem explicação.
   */
  readonly reasoning?: string;
}

/** Indentação (colunas) da FALA do aluy — `<Box paddingLeft={2}>`. */

/**
 * EST-0965 — cadência do PISCAR CALMO do cursor de trabalho (●). Com o tick central
 * ~120ms (DEFAULT_TICK_MS), um ciclo de 10 frames dura ~1.2s. ACESO nos primeiros
 * BLINK_ON frames, apagado no resto: duty-cycle alto ⇒ o cursor "respira" devagar em
 * vez de cintilar. (Mantido aqui — só o TurnBlock usa.)
 */
const BLINK_PERIOD = 10;
const BLINK_ON = 6;

/**
 * F-RAC — linhas VISÍVEIS da cauda do raciocínio. Ele é o canal mais verboso do
 * modelo e NÃO é a resposta: ocupa pouco espaço e mostra a CAUDA (onde o pensamento
 * chegou), no mesmo espírito da janela de cauda da fala ao vivo. Terminado o turno,
 * encolhe p/ uma linha-resumo — o histórico é para a resposta, não para o rascunho.
 */
const REASONING_LIVE_LINES = 6;

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
  // `-2` (borda + o `paddingLeft={1}` do corpo) em vez do recuo antigo de 2 sem borda:
  // é esta largura que o fundo preenche, e errá-la joga coluna pintada para a linha de
  // baixo — a mesma classe de defeito do quadradinho solto sob o composer.
  // Total da linha = borda (1) + conteúdo. O respiro de 1 coluna à esquerda agora é
  // PINTADO por dentro do conteúdo (o `paddingLeft` do `<Box>` não era pintado e deixava
  // uma faixa clara colada na borda), então ele já está contido em `columns - 2`.
  const speechCols = props.columns && props.columns > 0 ? props.columns - 2 : 0;
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

  // F-RAC — o que PINTAR do raciocínio, em três situações distintas:
  //   streaming        → cauda de REASONING_LIVE_LINES linhas (o modelo trabalhando)
  //   fim, com fala    → uma linha-resumo (o rascunho não polui o histórico)
  //   fim, SEM fala    → a cauda fica, porque é tudo que o turno produziu; sem isto o
  //                      bloco voltaria a ser um `Λ aluy` mudo, que é o bug de origem
  const reasoningView = ((): string[] | undefined => {
    const cru = (props.reasoning ?? '').trim();
    if (cru === '') return undefined;
    const semFala = full.trim() === '';
    // F-RAC-COLAPSA (relato do dono: "não deveria mostrar todo o pensamento, isso está
    // poluindo — pode só mostrar os tokens do final") — o texto do raciocínio NÃO vai
    // mais para a tela. Ele é o canal mais verboso desses modelos e empurra a conversa
    // inteira para cima; o dono quer o SINAL de que houve pensamento, não o rascunho.
    //
    // A primeira versão (rc.138) mostrava a cauda ao vivo. Resolveu o bloco mudo, mas
    // criou outro problema — poluição. O meio-termo é este: UMA linha, sempre.
    //
    // A ÚNICA exceção é o turno que NÃO falou: aí o pensamento é tudo o que existe, e
    // escondê-lo devolve exatamente o `Λ aluy` vazio que este conserto nasceu para matar.
    if (semFala && !props.streaming) {
      const linhas = windowTailVisual(cru, REASONING_LIVE_LINES, speechCols).text.split('\n');
      return ['⋯ o modelo só produziu raciocínio', ...linhas];
    }
    if (props.streaming) return ['⋯ pensando'];
    return [`⋯ pensou ${cru.length} caracteres`];
  })();

  // F-ECO-PINTADO (2/2) — a resposta ganha a MESMA moldura do eco, em cor PRÓPRIA: barra
  // à esquerda e cabeçalho pintado. O corpo NÃO é pintado, e isso é escolha, não limitação
  // de esforço: a fala do agente é markdown com realce de sintaxe, e um fundo atrás dele
  // brigaria com as cores do código — o bloco ficaria menos legível justamente onde a
  // legibilidade mais importa. A barra lateral sozinha já delimita a caixa em toda a
  // altura; o fundo entra só no cabeçalho, que é onde as duas vozes se alternam.
  const aluyFundo = theme.aluyBg;
  // `-3`: a borda come 1 coluna, o espaço de recuo do cabeçalho come outra, e a última o
  // Ink reserva. Mesma conta do `<YouBlock>` — errá-la joga um resto pintado para a linha
  // de baixo.
  const cabecalhoUtil = props.columns !== undefined ? Math.max(12, props.columns - 2) : undefined;
  // O custo só entra com o turno FECHADO (ver a doc da prop): durante o stream os números
  // ainda sobem e competiriam com o cursor de trabalho.
  const conta = ((): string | undefined => {
    const a = props.accounting;
    if (a === undefined || props.streaming) return undefined;
    const partes: string[] = [`${abbreviateCount(a.tokens)} tokens`];
    if (a.toolCalls > 0) partes.push(`${a.toolCalls} tools`);
    partes.push(formatDuration(a.durationMs));
    return `${theme.glyph('ok')} ${partes.join(' · ')}`;
  })();

  const cabecalho =
    aluyFundo !== undefined && cabecalhoUtil !== undefined ? (
      <Text backgroundColor={aluyFundo}>
        {' '}
        {props.streaming ? (
          <AluyLoader frame={props.frame ?? 0} />
        ) : (
          <Glyph name="aluy" role="accent" />
        )}
        <Role name="accent">luy</Role>
        {conta !== undefined && <Role name="fgDim">{`  ${conta}`}</Role>}
        {/* ` ` + `Λ` + `luy` = 5 colunas. A conta some com os 2 espaços que a separam.
            Errar esta soma para MAIS pinta além do bloco e o Ink joga o excedente na
            linha seguinte — foi assim que apareceu o `┃ ` pintado sob o cabeçalho. */}
        {' '.repeat(
          Math.max(0, cabecalhoUtil - 5 - (conta !== undefined ? displayWidth(conta) + 2 : 0)),
        )}
      </Text>
    ) : (
      <Box>
        {props.streaming ? (
          <AluyLoader frame={props.frame ?? 0} />
        ) : (
          <Glyph name="aluy" role="accent" />
        )}
        <Role name="accent">luy</Role>
        {conta !== undefined && <Role name="fgDim">{`  ${conta}`}</Role>}
      </Box>
    );

  return (
    <Box
      flexDirection="column"
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      // Cor FRIA na barra, contra o acento quente do lado do dono: as duas caixas se
      // distinguem pela temperatura mesmo em terminal onde o fundo não pinta.
      borderColor={theme.role('depth').color}
    >
      {cabecalho}
      <Box flexDirection="column">
        {/* marcador da janela de cauda: o que rolou p/ cima durante o stream (some no
            fim do turno, quando o bloco inteiro desce p/ o Static / scrollback). */}
        {hiddenAbove > 0 && <Role name="fgDim">… ({hiddenAbove} linhas acima)</Role>}
        {/* F-RAC — PENSAMENTO, esmaecido e acima da fala. Ao vivo mostra a cauda (o
            usuário vê o modelo trabalhando em vez de encarar um bloco vazio);
            terminado o turno vira UMA linha-resumo, salvo quando o modelo não falou
            nada — aí o pensamento é a única coisa que existe e some-lo devolveria
            exatamente o bloco em branco que este conserto existe p/ matar. */}
        {reasoningView !== undefined && (
          <Box flexDirection="column" paddingBottom={props.streaming ? 1 : 0}>
            {reasoningView.map((linha, i) =>
              aluyFundo !== undefined && speechCols > 0 ? (
                <Text key={i} backgroundColor={aluyFundo}>
                  <Role name="fgDim">
                    {linha + ' '.repeat(Math.max(0, speechCols - displayWidth(linha)))}
                  </Role>
                </Text>
              ) : (
                <Role key={i} name="fgDim">
                  {linha}
                </Role>
              ),
            )}
          </Box>
        )}
        {/* A FALA do aluy renderiza como MARKDOWN (negrito/listas/títulos/citações
            /links) + blocos ```lang realçados em papéis do DS. Aplica-se ao TEXTO
            ACUMULADO do turno (não token-a-token) — o stream segue fluido. A
            cronologia esmaecida propaga via baseRole (fg pleno vs fgDim). */}
        <Markdown
          text={text}
          baseRole={speech}
          {...(speechCols > 0 ? { columns: speechCols } : {})}
          {...(aluyFundo !== undefined ? { backgroundColor: aluyFundo } : {})}
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

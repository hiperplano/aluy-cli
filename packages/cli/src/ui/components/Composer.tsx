// EST-0948 · spec §4.2 — <Composer>: input + estados ativo/inativo.
//
// Prompt `›` em amber. Cursor `●` fg (EST-0965: GROSSO/arredondado — mesma grossura
// do thinkingCursor amarelo; só a COR difere: composer branco/fg, trabalho amarelo).
// Enquanto o agente gera, o composer fica
// INATIVO (dim) com a dica `esc interromper` (§4.2/§7). Apresentação pura — a
// captura de teclas/edição é do orquestrador (run.tsx via useInput), que passa o
// `value` e o estado aqui. Mantém o componente testável sem TTY.
//
// Placeholder FANTASMA (sombra): o hint esmaecido (papel `fgDim` do DS) aparece SÓ
// com o input vazio e ativo, com o cursor no ÍNDICE 0 (antes do fantasma) — não é
// parte do `value` e some no 1º caractere digitado, igual a um input moderno.

import React from 'react';
import { Box, Text } from 'ink';
import wrapAnsi from 'wrap-ansi';
import { Glyph, Role, useTheme } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import { windowComposerVisual } from '../../session/composer-edit.js';
import { composerIndentCols, visualLines, displayWidth } from '../../session/visual-lines.js';

export interface ComposerProps {
  readonly value: string;
  /** `false` enquanto o agente gera/ask pendente (composer inativo, dim). */
  readonly active: boolean;
  readonly placeholder?: string;
  /** Dica à direita quando inativo (ex.: `esc interromper`). */
  readonly hint?: string;
  /** Mostra o cursor piscante (§6: desligado em reduced-motion). */
  readonly showCursor?: boolean;
  /**
   * EST-0958 — `true` quando a linha entrou em MODO SHELL (`!` no início). Troca o
   * prompt `›` por um selo `! shell` (papel `danger` do DS — efeito que passa pela
   * catraca) p/ deixar EXPLÍCITO que Enter vai rodar um comando, não falar com o
   * modelo. a11y: a palavra `shell` acompanha o glifo (nunca só cor).
   */
  readonly shellMode?: boolean;
  /**
   * EST-0948 (composer/sessão) — POSIÇÃO do cursor (0..value.length). O composer
   * deixou de ser append-only: o cursor renderiza NA posição (entre os chars antes/
   * depois), não só no fim. Ausente ⇒ cursor no FIM (back-compat: o append-only de
   * antes). Sempre clampado p/ a faixa válida no render.
   */
  readonly cursorPos?: number;
  /**
   * EST-0972 — RÓTULO de identificação da sessão (`/rename`). Quando presente,
   * desenha um `● nome` discreto ANTES do prompt `›`, na MESMA linha (denso — não
   * rouba linha). Vazio/ausente ⇒ não desenha nada (não polui o composer sem rótulo).
   */
  readonly sessionLabel?: string;
  /**
   * EST-0972 — NOME da cor de identificação (paleta do DS: `ambar`/`verde`…). O `●` é
   * pintado com `theme.sessionColor(name)`; em NO_COLOR degrada p/ texto sem cor (o
   * ●+nome continuam visíveis — a cor não carrega o significado). Ausente ⇒ usa a cor
   * determinística do próprio nome (o resolver trata o fail-safe).
   */
  readonly sessionColor?: string;
  /**
   * F-COMPOSER-FUNDO (pedido do dono) — cor de FUNDO da linha do input.
   *
   * Aplicada AQUI, no `<Text wrap>` interno, porque é o único lugar que funciona: o Ink
   * não pinta `backgroundColor` em `<Box>` (medido), e envolver o Composer num `<Text>`
   * por fora LANÇA ("`<Box>` can't be nested inside `<Text>`") — foi assim que a primeira
   * tentativa derrubou o app do dono no boot.
   *
   * Ausente ⇒ sem fundo (terminal sem truecolor, onde o tom exato não existe).
   */
  readonly backgroundColor?: string;
  /**
   * BUG P2-C — TETO de linhas visíveis do composer (cockpit). No inline o composer cresce
   * sem teto (ausente ⇒ ilimitado, comportamento INALTERADO). No cockpit a região tem
   * altura cravada (soma == rows, §5): quando o input multi-linha (bracketed-paste/`\n`)
   * passa de `maxRows` linhas, a apresentação JANELA p/ a vizinhança do cursor (a linha
   * editada sempre visível) e marca `↑N`/`↓N` p/ as linhas escondidas — em vez de SUMIR
   * conteúdo silenciosamente. ≤ linhas que cabem ⇒ render idêntico (sem marcador).
   */
  readonly maxRows?: number;
  /**
   * BUG P2-C (task #14) — LARGURA (colunas) do terminal/região do composer. Necessária p/
   * o teto `maxRows` ser por linhas VISUAIS (com soft-wrap), não lógicas: uma ÚNICA linha
   * lógica longa (1300 chars sem `\n`) é 1 linha lógica mas QUEBRA em N linhas visuais que
   * comem o transcript. Com `columns`, o composer janela a vizinhança VISUAL do cursor e
   * marca o que escondeu. Ausente/≤0 ⇒ degrada p/ a janela LÓGICA (comportamento antigo).
   */
  readonly columns?: number;
}

/**
 * EST-0948 (composer/sessão) — renderiza `text` com o cursor NA posição `pos`, de
 * LARGURA CONSTANTE (anti-jitter EST-0956/0984). Duas situações:
 *  • cursor NO MEIO (pos < len): o char SOB o cursor é pintado em `inverse` (bloco) —
 *    NÃO insere coluna extra (o char permanece), então a largura do texto não muda
 *    quando o cursor anda pelo meio;
 *  • cursor NO FIM (pos === len): não há char p/ inverter, então um glifo-barra é
 *    desenhado depois do texto — sempre 1 coluna (constante).
 * `inactive` (composer dim) dispensa o cursor (o foco saiu). O texto é uma só `Role`,
 * partido só onde o cursor cai.
 */
function TextWithCursor(props: {
  readonly text: string;
  readonly pos: number;
  readonly showCursor: boolean;
  readonly active: boolean;
  readonly cursorGlyph: string;
}): React.ReactElement {
  const { text, showCursor, active, cursorGlyph } = props;
  const role = active ? 'fg' : 'fgDim';
  const pos = props.pos < 0 ? 0 : props.pos > text.length ? text.length : props.pos;
  // Sem cursor (inativo / reduced-motion): só o texto, sem barra nem realce.
  if (!showCursor) {
    return <Role name={role}>{text}</Role>;
  }
  // Cursor no FIM: texto + barra (1 coluna constante).
  if (pos >= text.length) {
    return (
      <>
        <Role name={role}>{text}</Role>
        <Role name="fg">{cursorGlyph}</Role>
      </>
    );
  }
  // Cursor NO MEIO: o char sob ele vai em `inverse` (sem coluna extra).
  // FIX (HUNT-RENDER) — pega o CODE POINT inteiro sob o cursor: se for um par surrogate
  // (emoji/astral), inverte as DUAS unidades juntas (senão pintaria só a metade alta = `�`
  // e a metade baixa vazaria pro `after`).
  const cp = text.codePointAt(pos)!;
  const underLen = cp > 0xffff ? 2 : 1;
  const before = text.slice(0, pos);
  const under = text.slice(pos, pos + underLen);
  const after = text.slice(pos + underLen);
  return (
    <>
      {before !== '' && <Role name={role}>{before}</Role>}
      <Text inverse>{under}</Text>
      {after !== '' && <Role name={role}>{after}</Role>}
    </>
  );
}

/**
 * EST-0972 — a TAG de identificação da sessão: `● nome ` (com um espaço de junção)
 * desenhada ANTES do prompt no composer. O `●` (glifo `sessionDot`) é pintado com a
 * cor da sessão (paleta do DS, resolvida p/ a capacidade do terminal); o NOME segue em
 * `fg` (legível). Sem rótulo (`label` vazio) ⇒ renderiza nada (composer limpo). Em
 * NO_COLOR a cor degrada p/ texto sem SGR de cor — o ●+nome ainda identificam (a11y:
 * o significado mora no glifo+nome, não na cor). Largura estável (conteúdo do frame).
 */
function SessionTag(props: {
  readonly label?: string;
  readonly color?: string;
}): React.ReactElement | null {
  const theme = useTheme();
  const label = (props.label ?? '').trim();
  if (label === '') return null;
  // F-LABEL-SEM-BOLINHA (relato do dono: "quando uso o rename ficam duas bolinhas no
  // composer") — `sessionDot` e o cursor do composer são o MESMO glifo (`●`), então uma
  // sessão nomeada exibia `● TESTE ❯ ●texto`: dois círculos idênticos lado a lado
  // significando coisas diferentes (identidade e posição do cursor).
  //
  // Em vez de inventar um terceiro glifo, a bolinha sai: quem carrega a cor da sessão passa
  // a ser o PRÓPRIO NOME. A informação é a mesma — o nome já estava ali, só pintado de
  // cinza — e some a ambiguidade. Em mono a cor degrada para bold, como antes.
  const style = theme.sessionColor(props.color ?? label);
  const labelProps: { color?: string; bold?: boolean } = {};
  if (style.color !== undefined) labelProps.color = style.color;
  if (style.bold !== undefined) labelProps.bold = style.bold;
  return (
    <>
      <Text> </Text>
      <Text {...labelProps}>{label}</Text>
      <Text> </Text>
    </>
  );
}

/**
 * F-COMPOSER-CAIXA (pedido do dono, olhando o opencode: "não sei se daria para deixar o
 * composer com cara de uma caixa de texto") — a MOLDURA do campo de entrada.
 *
 * O que havia antes eram duas RÉGUAS de largura total, uma acima e outra abaixo (o
 * comentário do App dizia, com todas as letras, "emoldura o input"). Elas cortavam a tela
 * inteira para cercar uma linha — e foi delas que veio o "as linhas no CLI deixam uma cara
 * muito ruim". Uma caixa cerca de verdade: as mesmas DUAS linhas de altura, mas fechando o
 * campo em vez de riscar a tela.
 *
 * ALTURA IDÊNTICA à das réguas (2 linhas: topo + base), de propósito — o orçamento de
 * linhas do inline e do cockpit é apertado e já custou caro estabilizar (o gap que o Ink
 * acumula quando o frame cruza `rows`). Trocar régua por borda é neutro nessa conta.
 *
 * Usa a moldura PESADA (`box.*`), a mesma dos diálogos: aqui ela cerca algo de verdade,
 * que é exatamente onde o peso é informação e não enfeite.
 */
export function ComposerBox(props: {
  readonly columns?: number;
  readonly children: React.ReactNode;
}): React.ReactElement {
  const theme = useTheme();
  const w = Math.max(4, props.columns ?? 80);
  const faixa = theme.composerBg;
  // BORDA LATERAL NATIVA do Ink (`borderLeft` só) — ela se repete por TODAS as linhas do
  // bloco sozinha, inclusive quando o conteúdo cresce (input multi-linha, rodapé de turno
  // dentro do bloco). A versão anterior desenhava a barra à mão, linha a linha: funcionava
  // com UM filho de UMA linha e quebrava assim que o bloco ganhou altura.
  return (
    <Box
      flexDirection="column"
      width={w}
      // F-ASCII-DE-VERDADE — a borda do Ink não passa pelo tema: em perfil ASCII o
      // `bold` desenha `┃`, que é justamente o que esse modo existe para evitar.
      borderStyle={theme.unicode ? 'bold' : 'classic'}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.role('accent').color}
    >
      {/* F-PROFUNDIDADE — uma linha de fundo ACIMA e outra ABAIXO do conteúdo: o campo
          deixa de ser uma régua de texto e vira um BLOCO com altura ("respirar um pouco
          mais"). Custa as mesmas 2 linhas que as réguas antigas gastavam.

          A de baixo chegou a ser removida quando um quadradinho cinza apareceu solto sob o
          composer — mas ela era inocente: o culpado era o `<TurnFooter>` pintando uma
          coluna a mais do que o bloco tem. Com aquilo corrigido a faixa volta, e com ela a
          altura que o bloco tinha.

          `w - 2`, não `w - 1`: a borda esquerda já consome uma coluna do `width={w}`, e
          pedir `w - 1` espaços de fundo em cima disso passa da largura do bloco. */}
      {faixa !== undefined && <Text backgroundColor={faixa}>{' '.repeat(Math.max(0, w - 2))}</Text>}
      {props.children}
      {faixa !== undefined && <Text backgroundColor={faixa}>{' '.repeat(Math.max(0, w - 2))}</Text>}
    </Box>
  );
}

/**
 * F-COMPOSER-SOMBRA (pedido do dono: "colocar uma sombra pra dar um efeito de saliência")
 * — a linha de SOMBRA sob o campo.
 *
 * Técnica que este DS já usa na marca 3D (`ShadowedWordmark`): meio-bloco superior (`▀`)
 * num tom ESCURO da paleta, DESLOCADO um caractere à direita. O olho lê o deslocamento
 * como profundidade — o campo "sai" da tela em vez de ficar rente a ela.
 *
 * Custa UMA linha, e ela vem do orçamento que a régua de baixo liberou (a antiga moldura
 * eram DUAS réguas; hoje é barra + sombra). Sem truecolor não há tom de sombra fiel ⇒ a
 * linha some inteira, em vez de virar um traço cinza sem sentido.
 */
export function ComposerShadow(props: { readonly columns?: number }): React.ReactElement | null {
  const theme = useTheme();
  if (theme.composerBg === undefined) return null;
  const w = Math.max(4, props.columns ?? 80);
  return (
    <Box>
      {/* o deslocamento de 1 col é o que cria a saliência: a sombra nasce à DIREITA do
          início do campo, como se a luz viesse de cima-à-esquerda. */}
      <Text> </Text>
      <Role name="shadowAmberDim">{'▀'.repeat(Math.max(0, w - 2))}</Role>
    </Box>
  );
}

export function Composer(props: ComposerProps): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  // EST-0989 (i18n) — placeholder/shell-hint vêm do catálogo no idioma ativo. O
  // `props.placeholder` (override explícito do caller) ainda vence quando passado.
  const placeholder = props.placeholder ?? t('composer.placeholder');
  const cursorGlyph = theme.glyph('cursor');
  // Posição efetiva do cursor: a passada (clampada no TextWithCursor) ou o FIM (back-compat).
  const pos = props.cursorPos ?? props.value.length;
  // EST-0958 — selo de modo shell: substitui o prompt `›` quando a linha é `!comando`.
  if (props.shellMode) {
    const showCursor = props.active && props.showCursor !== false;
    return (
      // FIX (cockpit multi-linha) — UM único <Text> (não um <Box> de <Text> IRMÃOS): o Ink
      // NÃO flui <Text> irmãos como texto contínuo — cada irmão embrulha por conta própria e
      // o CURSOR-irmão pousa na 1ª quebra de wrap (não no fim do texto), fragmentando o input
      // longo. Aninhado num só <Text wrap>, o wrap é contínuo e o cursor assenta certo.
      <Text wrap="wrap">
        <SessionTag
          {...(props.sessionLabel !== undefined ? { label: props.sessionLabel } : {})}
          {...(props.sessionColor !== undefined ? { color: props.sessionColor } : {})}
        />
        <Role name="danger">{theme.glyph('ask')} shell </Role>
        <TextWithCursor
          text={props.value}
          pos={pos}
          showCursor={showCursor}
          active={props.active}
          cursorGlyph={cursorGlyph}
        />
        <Text> </Text>
        <Role name="fgDim">{t('composer.shellHint')}</Role>
      </Text>
    );
  }
  // Placeholder FANTASMA (sombra/background): a dica esmaecida só aparece quando o
  // input está VAZIO e o composer está ativo. Ela NÃO é parte do `value` (não vai
  // no que é submetido) — é puro hint visual. O cursor fica no ÍNDICE 0 (ANTES do
  // fantasma), igual a um input moderno: você digita e o texto começa do começo,
  // empurrando o fantasma p/ fora — não DEPOIS dele. Assim que entra o 1º caractere,
  // `value !== ''` ⇒ o fantasma some e o cursor volta a seguir o texto digitado.
  const empty = props.value === '';
  const showGhost = empty && props.active;
  const showCursor = props.active && props.showCursor !== false;
  const cursor = <Role name="fg">{cursorGlyph}</Role>;
  // BUG P2-C (task #14) — JANELA por linhas VISUAIS. `maxRows` cravado ⇒ se o input ocupa
  // mais linhas VISUAIS (com soft-wrap) que cabem, janelamos p/ a vizinhança do cursor
  // reservando 1 linha p/ o marcador `↑N ⋯ ↓M` (o usuário SABE que há mais; nada SOME).
  // O cálculo passou de linhas LÓGICAS p/ VISUAIS: uma ÚNICA linha lógica longa (1300 chars
  // sem `\n`) é 1 linha lógica mas QUEBRA em N visuais — antes não janelava e crescia sem
  // teto comendo o transcript. Sem `maxRows` (caso ilimitado) ⇒ render IDÊNTICO ao de antes.
  // A largura efetiva desconta o indent REAL do prompt+tag (GAP-FIX): em sessão renomeada
  // a tag `● <nome> ` (EST-0972) empurra o texto ~nome+3 colunas além do `› ` — descontar
  // 2 fixo subestimava o wrap e o frame estourava `rows` (gap acumulando a cada tecla).
  // `composerIndentCols` é a MESMA conta do orçamento no App (uma fonte só). `columns`
  // ausente/≤0 ⇒ degrada p/ janela lógica (comportamento antigo) dentro de `windowComposerVisual`.
  const maxRows = props.maxRows;
  const indentCols = composerIndentCols(props.sessionLabel);
  const effCols =
    props.columns !== undefined && props.columns > indentCols
      ? props.columns - indentCols
      : (props.columns ?? 0);
  // Estoura SÓ se a altura VISUAL passa do teto CHEIO (`maxRows`). Igual ao gate antigo
  // (`lineCount > maxRows`), mas VISUAL: cobre a linha lógica única longa que faz soft-wrap.
  const overflowing =
    maxRows !== undefined && visualLines(props.value, effCols > 0 ? effCols : 0) > maxRows;
  // Quando estoura, reserva 1 linha p/ o marcador ⇒ janela de (maxRows-1) linhas visuais.
  const textRows = overflowing ? Math.max(1, (maxRows as number) - 1) : 0;
  const win = overflowing
    ? windowComposerVisual(props.value, pos, textRows, effCols)
    : { text: props.value, cursor: pos, hiddenAbove: 0, hiddenBelow: 0 };
  // F-COMPOSER-FUNDO — quantos espaços faltam p/ o fundo alcançar o fim da linha. Mede a
  // ÚLTIMA linha visual (é ela que fica "curta"); com wrap, as anteriores já estão cheias.
  const textoVisivel = win.text === '' ? placeholder : win.text;
  // A coluna extra é do CURSOR, então ela só existe quando o cursor é de fato desenhado —
  // e ele é suprimido enquanto o agente trabalha (para não haver dois cursores na tela ao
  // mesmo tempo). Contando por `active`, a conta reservava uma coluna que ninguém ocupava:
  // o preenchimento parava um caractere antes da borda e sobrava um quadradinho escuro no
  // fim da linha do composer — visível justamente DURANTE o processamento, e some quando
  // ele acaba e o cursor volta. Era esse o "quadradinho quando está pensando".
  const cursorVisivel = props.active && props.showCursor !== false;
  // A largura ÚTIL é a do bloco (`columns - 2`: uma coluna da barra `┃`, outra de folga),
  // a MESMA das faixas vazias de cima e de baixo. Usar `columns` aqui fazia a linha do
  // texto ficar UMA coluna mais larga que o bloco — e a sobra vazava como um quadradinho
  // de fundo solto no fim (o "espaçou no final um quadradinho cinza" do relato).
  const larguraUtil = props.columns !== undefined ? props.columns - 2 : undefined;
  // F-COMPOSER-WRAP (relato do dono: "preencha mais de uma linha e veja que a área do
  // composer não é respeitada") — a ÚLTIMA linha visual é a que o WRAP produz, não a que o
  // `\n` separa.
  //
  // O cálculo anterior fazia `split('\n').pop()`, e um texto longo sem quebra manual é UMA
  // linha-fonte só: media-se a string inteira, concluía-se que não sobrava espaço, e a
  // continuação do wrap ficava sem preenchimento — 67 colunas pintadas num bloco de 119, um
  // degrau enorme no meio da caixa. Aqui o texto é quebrado com o MESMO wrap do Ink
  // (`wrap-ansi`, `trim:false, hard:true`), então a última linha medida é a que de fato
  // aparece embaixo.
  const { ultimaLinha, houveQuebra } = ((): { ultimaLinha: string; houveQuebra: boolean } => {
    const primeiraFonte = textoVisivel.split('\n').pop() ?? '';
    const disponivel =
      larguraUtil !== undefined ? Math.max(1, larguraUtil - indentCols) : undefined;
    if (disponivel === undefined || primeiraFonte === '') {
      return { ultimaLinha: primeiraFonte, houveQuebra: false };
    }
    const quebrado = wrapAnsi(primeiraFonte, disponivel, { trim: false, hard: true }).split('\n');
    return {
      ultimaLinha: quebrado[quebrado.length - 1] ?? primeiraFonte,
      houveQuebra: quebrado.length > 1,
    };
  })();
  // O recuo do prompt (`❯ `) só existe na PRIMEIRA linha visual: quando o texto quebra, a
  // continuação começa na margem. Somá-lo sempre encurtava o preenchimento em duas colunas
  // exatas nas linhas de continuação.
  const usado =
    (houveQuebra ? 0 : indentCols) + displayWidth(ultimaLinha) + (cursorVisivel ? 1 : 0);
  const fillCols =
    larguraUtil !== undefined && larguraUtil > usado ? larguraUtil - usado : 0;
  return (
    <Box flexDirection="column">
      {/* FIX (cockpit multi-linha, achado do dono) — a linha do input é UM único <Text>
          (não um <Box> de <Text> IRMÃOS). O Ink NÃO flui <Text> irmãos como texto
          contínuo: cada irmão embrulha isolado e o CURSOR-irmão (`●`) pousava na 1ª
          quebra de wrap do texto — não no fim — jogando o miolo p/ a 2ª linha e o cursor
          no lugar errado (input longo no fullscreen "se desconstruía"). Aninhados num só
          <Text wrap>, o wrap flui e o cursor assenta certo. Prova: tests/.../composer. */}
      <Text
        wrap="wrap"
        {...(props.backgroundColor !== undefined
          ? { backgroundColor: props.backgroundColor }
          : {})}
      >
        <SessionTag
          {...(props.sessionLabel !== undefined ? { label: props.sessionLabel } : {})}
          {...(props.sessionColor !== undefined ? { color: props.sessionColor } : {})}
        />
        <Glyph name="prompt" role="accent" />
        <Text> </Text>
        {showGhost ? (
          // VAZIO: cursor no começo (pos 0), depois o fantasma esmaecido ATRÁS dele.
          <>
            {showCursor && cursor}
            <Role name="fgDim">{placeholder}</Role>
          </>
        ) : (
          // COM TEXTO (ou inativo): o texto (janelado no cockpit) com o cursor NA POSIÇÃO
          // (meio ou fim) — EST-0948. No meio, o char sob o cursor é realçado (sem coluna
          // extra); no fim, a barra segue o texto (1 coluna). Largura constante (anti-jitter).
          <TextWithCursor
            text={win.text}
            pos={win.cursor}
            showCursor={showCursor}
            active={props.active}
            cursorGlyph={cursorGlyph}
          />
        )}
        {!props.active && props.hint && (
          <>
            <Text> </Text>
            <Role name="fgDim">{props.hint}</Role>
          </>
        )}
        {/* F-COMPOSER-FUNDO — PREENCHIMENTO até o fim da linha (pedido do dono: "se o
            fundo ocupasse toda a área do composer ficaria melhor").
            No Ink o fundo só pinta ONDE HÁ CARACTERE — `<Box backgroundColor>` não pinta
            nada (medido). Para a faixa cobrir a linha inteira, ela precisa TER caractere:
            espaços até a largura.
            A conta usa `indentCols` (a MESMA fonte do wrap e do orçamento do App) mais a
            largura VISUAL do que está escrito. Só preenche quando o texto NÃO chegou ao
            fim — se já chegou, um espaço a mais forçaria wrap e criaria uma segunda linha
            de fundo, que é o jitter que este componente inteiro existe p/ evitar. */}
        {fillCols > 0 && <Text>{' '.repeat(fillCols)}</Text>}
      </Text>
      {/* Marcador de linhas escondidas (cockpit, input multi-linha que estoura a região).
          a11y: os números `↑N`/`↓M` carregam o sentido (há mais acima/abaixo) — nunca só
          cor. Só aparece quando de fato janelou (`overflowing`). */}
      {overflowing && (
        <Role name="fgDim">
          {win.hiddenAbove > 0 ? `↑${win.hiddenAbove}` : ''}
          {win.hiddenAbove > 0 && win.hiddenBelow > 0 ? ' · ' : ''}
          {win.hiddenBelow > 0 ? `↓${win.hiddenBelow}` : ''}
          {` ${t('composer.moreLines')}`}
        </Role>
      )}
    </Box>
  );
}

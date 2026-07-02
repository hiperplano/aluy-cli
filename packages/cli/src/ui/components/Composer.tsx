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
import { Glyph, Role, useTheme } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import { windowComposerVisual } from '../../session/composer-edit.js';
import { composerIndentCols, visualLines } from '../../session/visual-lines.js';

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
  const dot = theme.glyph('sessionDot');
  // resolve o estilo da cor da sessão pela paleta do DS (mono ⇒ sem cor, só bold).
  const style = theme.sessionColor(props.color ?? label);
  const dotProps: { color?: string; bold?: boolean } = {};
  if (style.color !== undefined) dotProps.color = style.color;
  if (style.bold !== undefined) dotProps.bold = style.bold;
  return (
    <>
      <Text {...dotProps}>{dot}</Text>
      <Text> </Text>
      <Role name="fg">{label}</Role>
      <Text> </Text>
    </>
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
      <Box>
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
      </Box>
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
  return (
    <Box flexDirection="column">
      <Box>
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
      </Box>
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

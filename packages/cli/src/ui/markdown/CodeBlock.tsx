// EST · acabamento TUI — <CodeBlock>: bloco ```lang realçado em PAPÉIS do DS.
//
// Borda/fundo SUTIL no estilo da TUI (`fgDim` p/ não competir com a fala). Cabeçalho
// com a linguagem (`depth`) à direita do canto. Cada linha de código vira segmentos
// `{text, role}` via highlightToSegments (lib só TOKENIZA; cor é nossa). Fallbacks:
//  - linguagem desconhecida ⇒ um segmento `fg` (texto cru legível).
//  - mono/NO_COLOR ⇒ os papéis não acendem cor (palette MONO) mas a MOLDURA e o
//    cabeçalho `lang` permanecem — o leitor ainda vê "isto é um bloco de código".
//  - ASCII (TERM=linux) ⇒ box vira `+/-/|`.
//
// F-GLYPH-PESO-2 — `theme.box` virou a moldura PESADA (esquema B, `┏┓┗┛━┃`) p/
// diálogo/chrome (ask, pergunta, gates). Um bloco de código é CONTEÚDO dentro da
// fala, não alerta — fica no box LEVE de sempre via `LIGHT_UNICODE_BOX` (import
// direto, não `theme.box`): a moldura grossa aqui competiria com o texto e
// quebraria o snapshot pinado (fora do escopo desta troca).

import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { Role, useTheme } from '../theme/index.js';
import { ASCII_BOX, LIGHT_UNICODE_BOX } from '../theme/glyphs.js';
import { highlightToSegments, resolveLanguage } from './highlight.js';

export interface CodeBlockProps {
  readonly code: string;
  readonly lang?: string | undefined;
  /** Cerca ainda aberta (stream no meio do bloco): rótulo "…". */
  readonly open?: boolean;
  /**
   * F-ECO-PINTADO (4/4) — fundo da caixa em que o bloco vive, quando há uma. O realce de
   * sintaxe é cor de TEXTO e não se perde; o que muda é a superfície atrás dele.
   *
   * Sem isto o bloco de código virava um retângulo escuro DENTRO da caixa pintada da
   * resposta — o "quadradinho preto" que o dono via: cada linha de código parava no último
   * caractere e o resto da largura ficava com o fundo do terminal.
   */
  readonly backgroundColor?: string;
  /** Largura útil da caixa — até onde preencher cada linha. */
  readonly columns?: number;
}

export function CodeBlock(props: CodeBlockProps): React.ReactElement {
  const theme = useTheme();
  // F-GLYPH-PESO-2 — LEVE de propósito (conteúdo, não chrome); ver header do arquivo.
  const box = theme.unicode ? LIGHT_UNICODE_BOX : ASCII_BOX;
  const resolved = resolveLanguage(props.lang);
  // rótulo do cabeçalho: a linguagem resolvida, ou o fence cru, ou "code".
  const label = (resolved ?? props.lang ?? 'code') + (props.open ? ' …' : '');
  const lines = props.code.split('\n');

  const bg = props.backgroundColor;
  const util = props.columns;
  /** Completa a linha até a borda da caixa — só quando há fundo a preencher. */
  const enche = (usado: number): React.ReactNode =>
    bg !== undefined && util !== undefined ? ' '.repeat(Math.max(0, util - usado)) : null;
  /** Envolve uma linha no fundo da caixa (ou a devolve crua, sem caixa). */
  const faixa = (conteudo: React.ReactNode, usado: number, chave?: number): React.ReactElement =>
    bg !== undefined && util !== undefined ? (
      <Text key={chave} backgroundColor={bg}>
        {conteudo}
        {enche(usado)}
      </Text>
    ) : (
      <Box key={chave}>{conteudo}</Box>
    );

  return (
    <Box flexDirection="column" paddingY={0}>
      {/* topo: ╭── lang ──╮ (em fgDim, moldura discreta) */}
      {faixa(
        <>
          <Role name="fgDim">
            {box.topLeft}
            {box.horizontal}{' '}
          </Role>
          <Role name="depth">{label}</Role>
          <Role name="fgDim"> {box.horizontal.repeat(2)}</Role>
        </>,
        3 + stringWidth(label) + 3,
      )}
      {lines.map((line, i) =>
        faixa(
          <>
            <Role name="fgDim">{box.vertical} </Role>
            <CodeLine line={line} lang={resolved ?? props.lang} />
          </>,
          2 + stringWidth(line),
          i,
        ),
      )}
      {faixa(
        <Role name="fgDim">
          {box.bottomLeft}
          {box.horizontal.repeat(3)}
        </Role>,
        4,
      )}
    </Box>
  );
}

/** Uma linha de código realçada em segmentos de papel. */
function CodeLine(props: {
  readonly line: string;
  readonly lang: string | undefined;
}): React.ReactElement {
  // linha vazia precisa de um espaço p/ a moldura não colapsar.
  if (props.line === '') return <Text> </Text>;
  const segs = highlightToSegments(props.line, props.lang);
  return (
    <Text>
      {segs.map((s, i) => (
        <Role key={i} name={s.role}>
          {s.text}
        </Role>
      ))}
    </Text>
  );
}

// EST · acabamento TUI — <Markdown>: render da fala do agente como markdown.
//
// Consome a AST de parse.ts e pinta em PAPÉIS do DS (nunca cor crua). Os blocos
// de código delegam ao <CodeBlock> (realce). A `baseRole` (fg / fgDim) propaga a
// CRONOLOGIA ESMAECIDA (turno passado): se o turno está em fgDim, todo o texto
// herda fgDim — exceto papéis que carregam SENTIDO próprio (código inline, link).
//
// FALLBACK NO_COLOR/mono (CA obrigatório): em `colorMode==='mono'` a cor não
// significa nada (a11y §3.1), então o REALCE estrutural migra p/ marcas VISÍVEIS:
//  - **negrito** continua bold; mas como bold pode não aparecer, cercamos em `*`.
//  - *itálico* idem com `_`.
//  - `código inline` aparece entre backticks LITERAIS.
//  - link vira `texto (url)` em texto cru.
// Com cor (truecolor/16): bold/dim/papel carregam o realce; sem marcas extras.

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import type { TermRole } from '../theme/palette.js';
import { CodeBlock } from './CodeBlock.js';
import { TableBlock } from './TableBlock.js';
import stringWidth from 'string-width';
import { parseMarkdown, type Inline, type MdBlock } from './parse.js';

export interface MarkdownProps {
  readonly text: string;
  /** Papel base do texto comum (fg pleno ou fgDim p/ turno passado). */
  readonly baseRole?: TermRole;
  /**
   * Largura útil (colunas) disponível p/ o conteúdo — usada pela TABELA p/ caber no
   * terminal (encolhe/trunca colunas largas). Ausente/0 ⇒ tabela usa a largura
   * NATURAL (sem truncar): degradação graciosa. O resto do markdown não depende disto.
   */
  readonly columns?: number;
  /**
   * F-ECO-PINTADO (3/3) — fundo da fala, quando ela vive dentro de uma caixa pintada
   * (`<AluyBlock>`). O realce de sintaxe NÃO se perde: no Ink o fundo e a cor do texto são
   * atributos independentes, então o código continua colorido, agora sobre a superfície da
   * caixa em vez do fundo do terminal.
   *
   * Preenchimento: `<Text backgroundColor>` só pinta onde há caractere, e o wrap do Ink
   * termina cada linha no fim da PALAVRA — sem completar a linha até a borda, o fundo sai
   * serrilhado à direita, uma linha parando num lugar diferente da outra. Por isso os
   * blocos de texto simples quebram aqui e emitem cada linha já preenchida (o mesmo
   * mecanismo do `<YouBlock>`).
   */
  readonly backgroundColor?: string;
}

export function Markdown(props: MarkdownProps): React.ReactElement {
  const base = props.baseRole ?? 'fg';
  const blocks = parseMarkdown(props.text);
  return (
    <Box flexDirection="column">
      {blocks.map((b, i) => (
        <BlockView
          key={i}
          block={b}
          base={base}
          {...(props.columns !== undefined ? { columns: props.columns } : {})}
          {...(props.backgroundColor !== undefined ? { backgroundColor: props.backgroundColor } : {})}
        />
      ))}
    </Box>
  );
}


/**
 * Um trecho de texto vestido com códigos ANSI de reset SELETIVO.
 *
 * Existe por causa de um detalhe do Ink: componentes de estilo aninhados (`<Text bold>`,
 * `<Role dimColor>`) fecham com reset TOTAL (`ESC[0m`), e reset total apaga o FUNDO junto
 * com a cor. Dentro de uma caixa pintada isso abria um vão sem fundo depois de cada trecho
 * estilizado — o "quadradinho branco a cada linha de bullet", que aparecia logo após o
 * marcador justamente porque o marcador é o pedaço colorido.
 *
 * Os fechamentos usados aqui são cirúrgicos: `ESC[39m` devolve só a cor de frente,
 * `ESC[22m` desliga só o peso. Nenhum deles toca no fundo, então a linha inteira pode ser
 * emitida como UMA string dentro de um único `<Text backgroundColor>` — sem aninhamento,
 * sem reset total, sem buraco.
 */
function vestir(
  texto: string,
  estilo: { readonly color?: string | undefined; readonly bold?: boolean; readonly dim?: boolean },
): string {
  if (texto === '') return '';
  let abre = '';
  let fecha = '';
  if (estilo.bold === true) {
    abre += '\u001B[1m';
    fecha = '\u001B[22m' + fecha;
  }
  if (estilo.dim === true) {
    abre += '\u001B[2m';
    fecha = '\u001B[22m' + fecha;
  }
  const rgb = hexParaRgb(estilo.color);
  if (rgb !== undefined) {
    abre += `\u001B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    fecha = '\u001B[39m' + fecha;
  }
  return abre + texto + fecha;
}

/** `#RRGGBB` ⇒ `[r,g,b]`. Qualquer outra coisa ⇒ `undefined` (sem cor, sem inventar). */
function hexParaRgb(hex: string | undefined): readonly [number, number, number] | undefined {
  if (hex === undefined || !/^#[0-9a-fA-F]{6}$/.test(hex)) return undefined;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Quebra spans em LINHAS visuais de no máximo `cols` colunas, preservando o tipo de cada
 * pedaço (negrito continua negrito depois da quebra).
 *
 * O wrap do Ink não serve quando há fundo: ele termina cada linha no fim da palavra e não
 * completa até a borda, então o fundo sai serrilhado — e como a quebra acontece dentro do
 * Ink, não há como saber onde ela caiu para corrigir depois. Quebrando aqui, cada linha é
 * emitida já com o preenchimento certo.
 *
 * PURO. Guloso por palavra, com corte duro para a palavra que sozinha não cabe (URL longa),
 * senão ela estouraria a caixa em vez de quebrar.
 */
function quebrarSpans(spans: readonly Inline[], cols: number): Inline[][] {
  const largura = Math.max(1, cols);
  const linhas: Inline[][] = [];
  let atual: Inline[] = [];
  let usado = 0;
  const fechar = (): void => {
    linhas.push(atual);
    atual = [];
    usado = 0;
  };
  for (const span of spans) {
    // Mantém os separadores no split para não perder os espaços entre palavras.
    for (const parte of span.text.split(/(\s+)/)) {
      if (parte === '') continue;
      const branco = /^\s+$/.test(parte);
      let resto = parte;
      while (resto !== '') {
        const w = stringWidth(resto);
        if (usado + w <= largura) {
          // Espaço que cairia no INÍCIO de uma linha nova é descartado: ele existe para
          // separar palavras, e no começo da linha viraria um recuo acidental.
          if (!(branco && usado === 0)) {
            atual.push({ ...span, text: resto } as Inline);
            usado += w;
          }
          break;
        }
        if (usado > 0) {
          fechar();
          if (branco) break;
          continue;
        }
        // A palavra não cabe nem numa linha vazia ⇒ corta no limite.
        const cabe = resto.slice(0, largura);
        atual.push({ ...span, text: cabe } as Inline);
        usado += stringWidth(cabe);
        resto = resto.slice(cabe.length);
        fechar();
      }
    }
  }
  if (atual.length > 0 || linhas.length === 0) fechar();
  return linhas;
}

function BlockView(props: {
  readonly block: MdBlock;
  readonly base: TermRole;
  readonly columns?: number;
  readonly backgroundColor?: string;
}): React.ReactElement {
  const theme = useTheme();
  const b = props.block;
  const mono = theme.colorMode === 'mono';

  switch (b.kind) {
    case 'code':
      return (
        <Box paddingY={0}>
          <CodeBlock
            code={b.code}
            lang={b.lang}
            open={!b.closed}
            {...(props.backgroundColor !== undefined
              ? { backgroundColor: props.backgroundColor }
              : {})}
            {...(props.columns !== undefined ? { columns: props.columns } : {})}
          />
        </Box>
      );
    case 'table':
      // tabela GFM alinhada, cabendo no terminal (EST-0965). Trunca colunas largas.
      return (
        <TableBlock
          header={b.header}
          align={b.align}
          rows={b.rows}
          base={props.base}
          {...(props.columns !== undefined ? { columns: props.columns } : {})}
        />
      );
    case 'heading':
      if (props.backgroundColor !== undefined && props.columns !== undefined) {
        return (
          <BlocoPintado
            spans={b.spans}
            base={"accent"}
            mono={mono}
            columns={props.columns}
            backgroundColor={props.backgroundColor}
          />
        );
      }
      // título: accent + bold (em mono, prefixo `#×n` visível p/ não sumir o nível).
      return (
        <Box>
          {mono && <Role name="accent">{'#'.repeat(b.level)} </Role>}
          <Role name="accent">
            <Inlines spans={b.spans} base="accent" mono={mono} />
          </Role>
        </Box>
      );
    case 'quote':
      if (props.backgroundColor !== undefined && props.columns !== undefined) {
        return (
          <BlocoPintado
            spans={b.spans}
            base={"fgDim"}
            mono={mono}
            columns={props.columns}
            backgroundColor={props.backgroundColor}
            prefixo={{ text: `${theme.glyph('you')} `, role: 'depth' }}
          />
        );
      }
      // citação: barra `▌`/`|` em depth + texto dim.
      return (
        <Box>
          <Role name="depth">{theme.glyph('you')} </Role>
          <Role name="fgDim">
            <Inlines spans={b.spans} base="fgDim" mono={mono} />
          </Role>
        </Box>
      );
    case 'list-item':
      if (props.backgroundColor !== undefined && props.columns !== undefined) {
        return (
          <BlocoPintado
            spans={b.spans}
            base={props.base}
            mono={mono}
            columns={props.columns}
            backgroundColor={props.backgroundColor}
            prefixo={{ text: `${b.ordered ? b.marker : theme.unicode ? '•' : '-'} `, role: 'accent' }}
            indent={b.indent * 2}
          />
        );
      }
      // bullet `•`/`-` ou número, indentado pelo nível; texto no papel base.
      return (
        <Box paddingLeft={b.indent * 2}>
          <Role name="accent">{b.ordered ? b.marker : theme.unicode ? '•' : '-'} </Role>
          <Text>
            <Inlines spans={b.spans} base={props.base} mono={mono} />
          </Text>
        </Box>
      );
    case 'paragraph':
      if (props.backgroundColor !== undefined && props.columns !== undefined) {
        return (
          <BlocoPintado
            spans={b.spans}
            base={props.base}
            mono={mono}
            columns={props.columns}
            backgroundColor={props.backgroundColor}
          />
        );
      }
      return (
        <Box>
          <Text>
            <Inlines spans={b.spans} base={props.base} mono={mono} />
          </Text>
        </Box>
      );
  }
}

/**
 * Um bloco de texto PINTADO: quebra na largura útil e emite cada linha completada até a
 * borda, para o fundo formar um retângulo em vez de uma serra.
 *
 * `prefixo` é o marcador do bloco (bullet da lista, barra da citação, `#` do título). Ele
 * ocupa colunas na PRIMEIRA linha e vira recuo nas seguintes — é o que alinha a continuação
 * de um item de lista sob o texto dele, e não sob o bullet.
 */
function BlocoPintado(props: {
  readonly spans: readonly Inline[];
  readonly base: TermRole;
  readonly mono: boolean;
  readonly columns: number;
  readonly backgroundColor: string;
  readonly prefixo?: { readonly text: string; readonly role: TermRole };
  readonly indent?: number;
}): React.ReactElement {
  const theme = useTheme();
  const recuo = props.indent ?? 0;
  const pref = props.prefixo?.text ?? '';
  const prefW = stringWidth(pref);
  // `+1` de respiro à esquerda, pintado: se viesse do `paddingLeft` de um `<Box>`, o Ink
  // não o pintaria e ele apareceria como faixa sem fundo colada à borda.
  const util = Math.max(1, props.columns - recuo - prefW - 1);
  const linhas = quebrarSpans(props.spans, util);

  /** Estilo ANSI de um span, no papel que ele teria como componente. */
  const estiloDe = (span: Inline): { color?: string | undefined; bold?: boolean; dim?: boolean } => {
    const papel: TermRole =
      span.kind === 'code' ? 'depth' : span.kind === 'link' ? 'accent' : props.base;
    const r = theme.role(papel);
    return {
      color: r.color,
      bold: r.bold === true || span.kind === 'bold',
      dim: r.dimColor === true,
    };
  };
  /** O texto que o span REALMENTE imprime (em mono as cercas são visíveis). */
  const textoDe = (span: Inline): string => {
    if (!props.mono) return span.text;
    if (span.kind === 'bold') return `*${span.text}*`;
    if (span.kind === 'italic') return `_${span.text}_`;
    if (span.kind === 'code') return `\`${span.text}\``;
    return span.text;
  };

  const estiloPrefixo = props.prefixo !== undefined ? theme.role(props.prefixo.role) : undefined;

  return (
    <Box flexDirection="column">
      {linhas.map((linha, i) => {
        const conteudo = linha.reduce((a, sp) => a + stringWidth(textoDe(sp)), 0);
        const falta = Math.max(0, util - conteudo);
        const marcador =
          prefW === 0
            ? ''
            : i === 0 && estiloPrefixo !== undefined
              ? vestir(pref, {
                  color: estiloPrefixo.color,
                  bold: estiloPrefixo.bold === true,
                  dim: estiloPrefixo.dimColor === true,
                })
              : ' '.repeat(prefW);
        const corpo = linha.map((sp) => vestir(textoDe(sp), estiloDe(sp))).join('');
        return (
          <Text key={i} backgroundColor={props.backgroundColor}>
            {' '.repeat(recuo + 1) + marcador + corpo + ' '.repeat(falta)}
          </Text>
        );
      })}
    </Box>
  );
}

/**
 * Renderiza spans inline (negrito/itálico/código/link/plano). Exportado p/ o
 * <TableBlock> reusar o mesmo realce inline DENTRO das células (sem duplicar o
 * mapeamento DS→estilo).
 */
export function Inlines(props: {
  readonly spans: readonly Inline[];
  readonly base: TermRole;
  readonly mono: boolean;
}): React.ReactElement {
  return (
    <Text>
      {props.spans.map((s, i) => (
        <InlineSpan key={i} span={s} base={props.base} mono={props.mono} />
      ))}
    </Text>
  );
}

function InlineSpan(props: {
  readonly span: Inline;
  readonly base: TermRole;
  readonly mono: boolean;
}): React.ReactElement {
  const { span, base, mono } = props;
  switch (span.kind) {
    case 'plain':
      return <Role name={base}>{span.text}</Role>;
    case 'bold':
      // com cor: bold real; mono: cercas `*` visíveis (o sentido não pode sumir).
      return mono ? (
        <Role name={base}>
          <Text bold>*{span.text}*</Text>
        </Role>
      ) : (
        <Role name={base}>
          <Text bold>{span.text}</Text>
        </Role>
      );
    case 'italic':
      return mono ? (
        <Role name={base}>
          <Text italic>_{span.text}_</Text>
        </Role>
      ) : (
        <Role name={base}>
          <Text italic>{span.text}</Text>
        </Role>
      );
    case 'code':
      // código inline: papel `depth`; em mono, backticks LITERAIS p/ delimitar.
      return mono ? <Role name="depth">`{span.text}`</Role> : <Role name="depth">{span.text}</Role>;
    case 'link':
      // texto do link em `accent`; URL dim ao lado (sem esconder o destino).
      return (
        <Text>
          <Role name="accent">{span.text}</Role>
          <Role name="fgDim"> ({span.url})</Role>
        </Text>
      );
  }
}

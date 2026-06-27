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
        />
      ))}
    </Box>
  );
}

function BlockView(props: {
  readonly block: MdBlock;
  readonly base: TermRole;
  readonly columns?: number;
}): React.ReactElement {
  const theme = useTheme();
  const b = props.block;
  const mono = theme.colorMode === 'mono';

  switch (b.kind) {
    case 'code':
      return (
        <Box paddingY={0}>
          <CodeBlock code={b.code} lang={b.lang} open={!b.closed} />
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

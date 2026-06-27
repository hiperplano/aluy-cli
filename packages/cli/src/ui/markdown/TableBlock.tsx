// EST-0965 — <TableBlock>: render de TABELA markdown (GFM) ALINHADA na TUI.
//
// O agente usa tabela o tempo todo (listagens, comparações) e antes saía como
// texto cru (`| Tipo | Nome | --- |`) que quebrava feio. Aqui renderizamos:
//  • largura de cada coluna calculada do conteúdo, RESPEITANDO `columns` (table-
//    layout.ts): se a tabela exceder o terminal, encolhe/trunca as colunas mais
//    largas (`…`) p/ NÃO estourar — anti-flicker: a tabela cabe em ≤ columns, então
//    nenhuma célula re-flui em várias linhas visuais (#69).
//  • CABEÇALHO em destaque (accent + bold; em mono o accent não acende, mas o bold
//    + a régua mantêm o "isto é cabeçalho").
//  • uma RÉGUA separadora sutil em `fgDim` (box-drawing `─┼─`, ASCII `-+-`).
//  • alinhamento L/C/R por coluna (do separador `:--:` / `--:`).
//  • células com markdown inline (negrito/código/link) realçadas via <Inlines>.
//
// Cor/glifo SEMPRE do tema (DS) — nada cru. PURO de I/O (Ink declarativo).

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import type { TermRole } from '../theme/palette.js';
import { Inlines } from './Markdown.js';
import { parseInline } from './parse.js';
import type { TableAlign } from './parse.js';
import { computeColumnWidths, padCell, truncateToWidth, COL_GUTTER } from './table-layout.js';

export interface TableBlockProps {
  readonly header: readonly string[];
  readonly align: readonly TableAlign[];
  readonly rows: readonly (readonly string[])[];
  /** Papel base do texto comum (fg pleno ou fgDim p/ turno passado). */
  readonly base?: TermRole;
  /** Largura útil (colunas). Ausente/0 ⇒ largura natural (sem truncar). */
  readonly columns?: number;
}

/**
 * Texto VISÍVEL de uma célula (markdown inline removido) — é o que conta p/ largura
 * e truncamento. Reusa o parser inline (sem duplicar regras): junta o `.text` de
 * todos os spans. Assim `**Nome**` mede 4, não 8, e alinha certo.
 */
function visibleText(cell: string): string {
  return parseInline(cell)
    .map((s) => s.text)
    .join('');
}

export function TableBlock(props: TableBlockProps): React.ReactElement {
  const theme = useTheme();
  const box = theme.box;
  const base: TermRole = props.base ?? 'fg';
  const mono = theme.colorMode === 'mono';

  const cols = props.header.length;
  // Versões VISÍVEIS (sem marcação) p/ medir/truncar/alinhar.
  const visHeader = props.header.map(visibleText);
  const visRows = props.rows.map((r) => {
    const out: string[] = [];
    for (let c = 0; c < cols; c++) out.push(visibleText(r[c] ?? ''));
    return out;
  });

  const widths = computeColumnWidths(visHeader, visRows, cols, props.columns ?? 0);

  // Régua separadora entre header e corpo: um traço por coluna (largura da coluna),
  // juntado por um "cruzamento" no lugar do gutter (`─┼─` em Unicode, `-+-` em
  // ASCII). Sutil (fgDim) p/ não competir com a fala. A largura da régua = largura
  // total da tabela (mesmas colunas + gutters) ⇒ cabe igual ao corpo.
  const cross = theme.unicode ? `${box.horizontal}┼${box.horizontal}` : '-+-';
  const rule = widths.map((w) => box.horizontal.repeat(w)).join(cross);

  const renderCell = (raw: string, width: number, align: TableAlign): React.ReactElement => {
    const vis = visibleText(raw);
    const truncated = truncateToWidth(vis, width);
    const padded = padCell(truncated, width, align);
    // Re-parseia o texto JÁ truncado p/ realce inline do que sobrou (p.ex. `código`
    // que ficou inteiro). O padding é texto plano — não entra no parse.
    const spans = parseInline(padded);
    return <Inlines spans={spans} base={base} mono={mono} />;
  };

  const gutter = ' '.repeat(COL_GUTTER);

  return (
    <Box flexDirection="column" paddingY={0}>
      {/* CABEÇALHO — accent + bold (em mono o accent é neutro, mas o bold marca). */}
      <Box>
        {props.header.map((h, c) => (
          <React.Fragment key={c}>
            {c > 0 && <Text>{gutter}</Text>}
            <Role name="accent">
              <Text bold>
                {padCell(
                  truncateToWidth(visibleText(h), widths[c] ?? 0),
                  widths[c] ?? 0,
                  props.align[c] ?? 'left',
                )}
              </Text>
            </Role>
          </React.Fragment>
        ))}
      </Box>
      {/* RÉGUA separadora sutil. */}
      <Box>
        <Role name="fgDim">{rule}</Role>
      </Box>
      {/* CORPO — cada célula alinhada e truncada; markdown inline realçado. */}
      {props.rows.map((row, r) => (
        <Box key={r}>
          {row.map((cell, c) => (
            <React.Fragment key={c}>
              {c > 0 && <Text>{gutter}</Text>}
              {renderCell(cell, widths[c] ?? 0, props.align[c] ?? 'left')}
            </React.Fragment>
          ))}
        </Box>
      ))}
    </Box>
  );
}

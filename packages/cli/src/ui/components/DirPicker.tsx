// <DirPicker>: seletor de pasta do `/add-dir` sobre a moldura comum (`<PickerFrame>`).
// Apresentação PURA: o estado e as regras vêm de `slash/dir-picker.ts`. Cada linha é cortada para
// caber numa linha só (largura do terminal), e a lista rola numa janela de `maxRows` — o total
// nunca passa do orçamento do `<MenuPicker>` (título + filtro + até 2 marcadores + itens).

import React from 'react';
import { Box, useStdout } from 'ink';
import { Role } from '../theme/index.js';
import { PickerFrame, larguraDaMoldura } from './PickerFrame.js';
import {
  fitLine,
  rowsOf,
  tildify,
  windowRows,
  type DirPickerState,
} from '../../slash/dir-picker.js';

export interface DirPickerProps {
  readonly state: DirPickerState;
  /** Mesmo valor que o `<MenuPicker>` recebe (linhas de item + 1 do filtro). */
  readonly maxRows: number;
  readonly columns?: number;
}

export const DIR_PICKER_HELP = '↑↓ move · →/enter entra · ←/⌫ sobe · esc fecha';

export function DirPicker(props: DirPickerProps): React.ReactElement {
  const { state } = props;
  const { stdout } = useStdout();
  const cols = props.columns ?? stdout?.columns ?? 80;
  // moldura (borda 2 + padding 2) + folga da direita; 1 coluna de segurança.
  const inner = Math.max(10, (larguraDaMoldura(cols) ?? cols) - 4 - 1);
  const rows = rowsOf(state);
  const [from, to] = windowRows(rows.length, state.selected, Math.max(1, props.maxRows - 1));
  return (
    <PickerFrame columns={cols}>
      <Box>
        <Role name="accent">
          {fitLine(`adicionar pasta · ${tildify(state.cwd, state.home)}`, inner)}
        </Role>
      </Box>
      <Box>
        <Role name="fgDim">
          {fitLine(
            state.notice !== undefined
              ? `${state.notice}`
              : `filtro: ${state.filter}▏ ${state.filter === '' ? DIR_PICKER_HELP : ''}`,
            inner,
          )}
        </Role>
      </Box>
      {from > 0 && (
        <Box>
          <Role name="fgDim">{fitLine(`  ↑ ${from} acima`, inner)}</Role>
        </Box>
      )}
      {rows.slice(from, to).map((r, k) => {
        const i = from + k;
        const sel = i === state.selected;
        const text = r.kind === 'dir' && r.hint !== undefined ? `${r.label} · ${r.hint}` : r.label;
        const line = fitLine(`${sel ? '› ' : '  '}${text}`, inner);
        return (
          <Box key={`${i}:${r.label}`}>
            <Role name={sel ? 'accent' : r.kind === 'info' ? 'fgDim' : 'fg'}>{line}</Role>
          </Box>
        );
      })}
      {to < rows.length && (
        <Box>
          <Role name="fgDim">{fitLine(`  ↓ ${rows.length - to} mais`, inner)}</Role>
        </Box>
      )}
    </PickerFrame>
  );
}

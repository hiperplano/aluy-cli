// <MenuPicker>: seletor genérico dos comandos (revisão de UX dos menus, §6.2) sobre a
// mesma moldura dos demais (`<PickerFrame>`, como EffortPicker/ThemePicker/LangPicker).
// `›` marca a seleção, `●` o valor em vigor (a11y: não só cor). Apresentação PURA.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { PickerFrame } from './PickerFrame.js';
import type { MenuStep } from '../../slash/menu-pickers.js';

export interface MenuPickerProps {
  readonly step: MenuStep;
  readonly selected: number;
  /** Quantas linhas de item cabem (janela em torno da seleção). Ausente ⇒ todas. */
  readonly maxRows?: number;
  /** Mostra "esc volta" (passo interno) em vez de "esc fecha". */
  readonly nested?: boolean;
}

export const MENU_PICKER_HELP = '↑↓ navega · enter escolhe · esc fecha';
export const MENU_PICKER_HELP_NESTED = '↑↓ navega · enter escolhe · esc volta';

/** Janela de `maxRows` itens em torno do selecionado. PURA. */
export function windowOf(
  total: number,
  selected: number,
  maxRows: number | undefined,
): [number, number] {
  if (maxRows === undefined || maxRows <= 0 || total <= maxRows) return [0, total];
  const start = Math.min(Math.max(0, selected - Math.floor(maxRows / 2)), total - maxRows);
  return [start, start + maxRows];
}

export function MenuPicker(props: MenuPickerProps): React.ReactElement {
  const { step, selected } = props;
  const [from, to] = windowOf(step.items.length, selected, props.maxRows);
  return (
    <PickerFrame>
      <Box>
        <Role name="accent">{step.title}</Role>
        <Role name="fgDim">
          {' '}
          · {props.nested === true ? MENU_PICKER_HELP_NESTED : MENU_PICKER_HELP}
        </Role>
      </Box>
      {step.items.length === 0 && (
        <Box>
          <Role name="fgDim"> {step.empty ?? 'nada por aqui'}</Role>
        </Box>
      )}
      {from > 0 && (
        <Box>
          <Role name="fgDim"> ↑ {from} acima</Role>
        </Box>
      )}
      {step.items.slice(from, to).map((it, k) => {
        const i = from + k;
        const isSel = i === selected;
        const isCur = it.current === true;
        return (
          <Box key={it.id}>
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isCur ? 'accent' : 'fgDim'}>{isCur ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>{it.label}</Role>
            {it.hint !== undefined && <Role name="fgDim"> · {it.hint}</Role>}
          </Box>
        );
      })}
      {to < step.items.length && (
        <Box>
          <Role name="fgDim"> ↓ {step.items.length - to} mais</Role>
        </Box>
      )}
    </PickerFrame>
  );
}

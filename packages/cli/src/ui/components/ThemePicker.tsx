// EST-0966 · /theme — <ThemePicker>: seletor de TEMA (paleta dark/light).
//
// `/theme` abre este picker (MESMA mecânica/teclas do <SlashMenu>/<FilePicker>/
// <ModelPicker>: ↑↓ navega; enter troca; esc fecha). Cada item = `rótulo · resumo`.
// O tema ATIVO ganha o marcador `●` (a11y: não só cor); o selecionado leva o
// prefixo `›` em accent. Tokens-only (papéis do DS) — ZERO cor crua. Apresentação
// PURA: a captura de teclas é da App; aqui só desenhamos a lista.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { ThemeEntry, ThemeName } from '../theme/themes.js';

export interface ThemePickerProps {
  readonly themes: readonly ThemeEntry[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Tema ATIVO da sessão (marcado com `●`). */
  readonly currentTheme: ThemeName;
}

// NB (F88/anti-flicker): NÃO janelamos aqui de propósito — `themes` é um conjunto
// FECHADO (a union `ThemeName`, 3 temas hoje), então nunca estoura `rows` nem na tela
// mais curta. Janelar seria código morto. Os pickers de lista ABERTA/crescente
// (History/Rewind/Provider) é que recebem `maxRows`.
export function ThemePicker(props: ThemePickerProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.theme.help')}</Role>
      </Box>
      {props.themes.map((theme, i) => {
        const isSel = i === props.selected;
        const isActive = theme.name === props.currentTheme;
        return (
          <Box key={theme.name}>
            {/* prefixo › no selecionado + ● no tema ativo (a11y: não só cor) */}
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>{theme.label}</Role>
            <Role name="fgDim"> · {theme.summary}</Role>
          </Box>
        );
      })}
    </Box>
  );
}

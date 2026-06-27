// EST-0989 · /lang — <LangPicker>: seletor de IDIOMA da TUI (pt-BR / en).
//
// `/lang` abre este picker (MESMA mecânica/teclas do <ThemePicker>/<SlashMenu>/
// <FilePicker>/<ModelPicker>: ↑↓ navega; enter troca; esc fecha). Cada item =
// `rótulo · resumo`. O idioma ATIVO ganha o marcador `●` (a11y: não só cor); o
// selecionado leva o prefixo `›` em accent. Tokens-only (papéis do DS) — ZERO cor
// crua. Apresentação PURA: a captura de teclas é da App; aqui só desenhamos a lista.
//
// O `label` de cada idioma é AUTO-GLOTA (no próprio idioma: "Português (Brasil)",
// "English") — sempre legível p/ quem fala aquele idioma, independente do idioma
// ativo. A linha de ajuda do topo segue o idioma ATIVO (`t('picker.lang.help')`).

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n, type LangEntry, type Lang } from '../../i18n/index.js';

export interface LangPickerProps {
  readonly langs: readonly LangEntry[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Idioma ATIVO da sessão (marcado com `●`). */
  readonly currentLang: Lang;
}

export function LangPicker(props: LangPickerProps): React.ReactElement {
  const { t } = useI18n();
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.lang.help')}</Role>
      </Box>
      {props.langs.map((lang, i) => {
        const isSel = i === props.selected;
        const isActive = lang.code === props.currentLang;
        return (
          <Box key={lang.code}>
            {/* prefixo › no selecionado + ● no idioma ativo (a11y: não só cor) */}
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>{lang.label}</Role>
            <Role name="fgDim"> · {lang.summary}</Role>
          </Box>
        );
      })}
    </Box>
  );
}

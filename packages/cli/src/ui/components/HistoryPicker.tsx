// EST-0972 · spec §2.13 — <HistoryPicker>: seletor de SESSÕES anteriores (`/history`).
//
// `/history` abre este picker (mesma MECÂNICA/teclas do <ModelPicker>/<ThemePicker>/
// <SlashMenu>: ↑↓ navega; enter RETOMA; esc cancela). Cada item:
//   - COM rótulo (/rename): `● <nome> · data · cwd` — o ● é COLORIDO pela cor de
//     identificação da sessão (paleta do DS); o nome é o ROSTO do item.
//   - SEM rótulo: o formato antigo `data · cwd · 1ª mensagem` (fallback intacto, #86).
// O selecionado leva o prefixo `›` em accent. Tokens-only (papéis do DS). Apresentação
// PURA — a captura de teclas é da App.
//
// SEGURANÇA (CLI-SEC-6): só METADADOS (rótulo, data, cwd abreviado, 1ª msg truncada).
// NUNCA o corpo da transcrição. Lista vazia ⇒ "nenhuma sessão anterior".

import React from 'react';
import { Box, Text } from 'ink';
import { Role, useTheme } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { SessionSummary } from '../../io/index.js';
import { formatHistoryEntry } from '../../session/history.js';
import { displayWidth } from '../../session/visual-lines.js';
import { windowAround } from '../window.js';

export interface HistoryPickerProps {
  readonly sessions: readonly SessionSummary[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Home p/ abreviar o cwd na listagem (injetável p/ teste). */
  readonly home?: string;
  /**
   * Máx. de SESSÕES visíveis (janela centrada no selecionado). Acima disto a lista é
   * JANELADA — sem isto, um usuário com dezenas de sessões salvas faria o `/history`
   * despejar a lista inteira no inline, estourando `rows` ⇒ o Ink cai no caminho
   * full-screen (`outputHeight>=rows`, clearTerminal por frame) ⇒ flicker no Windows.
   * MESMO padrão do <CommandPalette>/<SlashMenu>. Default 10 (auto-seguro mesmo sem o
   * cap do caller); a App passa o cap DINÂMICO (`slashMenuRowCap`) em telas altas.
   */
  readonly maxRows?: number;
  /**
   * F89 (wrap-aware) — largura do terminal. Quando presente, o janelamento conta LINHAS
   * VISUAIS (cada entrada longa QUEBRA em ≥2 linhas num terminal estreito) em vez de itens,
   * evitando o estouro de `rows` em cols < ~80. Ausente ⇒ janela por item (comportamento
   * largo, inalterado).
   */
  readonly columns?: number;
}

export function HistoryPicker(props: HistoryPickerProps): React.ReactElement {
  const theme = useTheme();
  const { t } = useI18n();
  const dot = theme.glyph('sessionDot');
  const maxRows = Math.max(1, props.maxRows ?? 10);
  // F89 — altura VISUAL de cada linha de sessão: prefixo `› `/`  ` (2) + `● ` quando há
  // rótulo (2) + a entrada formatada; quebra em `ceil(largura / columns)`. Sem `columns`,
  // cai no janelamento por item (telas largas).
  const cols = props.columns;
  const rowHeight =
    cols !== undefined && cols > 0
      ? (s: SessionSummary): number => {
          const w = 2 + (s.label?.trim() ? 2 : 0) + displayWidth(formatHistoryEntry(s, props.home));
          return Math.max(1, Math.ceil(w / cols));
        }
      : undefined;
  const { start, slice } = windowAround(props.sessions, props.selected, maxRows, rowHeight);
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.history.help')}</Role>
      </Box>
      {props.sessions.length === 0 ? (
        <Box>
          <Role name="fgDim"> {t('picker.history.empty')}</Role>
        </Box>
      ) : (
        slice.map((s, i) => {
          const idx = start + i;
          const isSel = idx === props.selected;
          const label = s.label?.trim();
          // EST-0972 — o ● colorido só aparece quando há rótulo. A cor sai da paleta do
          // DS (theme.sessionColor); em NO_COLOR degrada p/ texto sem cor (o ● ainda
          // aparece — a11y). Sem rótulo ⇒ nenhum ● (formato antigo intacto).
          const colorStyle = label ? theme.sessionColor(s.labelColor ?? label) : undefined;
          const dotProps: { color?: string; bold?: boolean } = {};
          if (colorStyle?.color !== undefined) dotProps.color = colorStyle.color;
          if (colorStyle?.bold !== undefined) dotProps.bold = colorStyle.bold;
          return (
            <Box key={s.id}>
              {/* prefixo › no selecionado (a11y: não só cor) */}
              <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
              {label && (
                <>
                  <Text {...dotProps}>{dot}</Text>
                  <Text> </Text>
                </>
              )}
              <Role name={isSel ? 'accent' : 'fg'}>{formatHistoryEntry(s, props.home)}</Role>
            </Box>
          );
        })
      )}
      {props.sessions.length > slice.length && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.history.more', { count: props.sessions.length - slice.length })}
          </Role>
        </Box>
      )}
    </Box>
  );
}

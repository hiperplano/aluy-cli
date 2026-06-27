// EST-0961 · inspirado no OpenCode — <CommandPalette>: índice fuzzy de TODOS os
// comandos/ações (Ctrl+P). MESMA mecânica/teclas do <SlashMenu>/<FilePicker>:
// digitar filtra; ↑↓ navega; enter executa; esc fecha. O trecho casado no LABEL
// realça em âmbar e o selecionado leva o prefixo `›` (a11y: não só cor). Mostra a
// descrição esmaecida ao lado. Tokens-only (papéis do DS) — sem cor/estilo cru.
//
// Apresentação PURA: a captura de teclas é do orquestrador (App); aqui só desenha
// o estado (query + hits + selecionado). Janela de `maxRows` itens centrada no
// selecionado (não despeja a lista inteira).

import React from 'react';
import { Box, Text } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { PaletteHit } from '../../slash/commands.js';

export interface CommandPaletteProps {
  /** Itens filtrados+ordenados (fuzzy) — já na ordem de exibição. */
  readonly hits: readonly PaletteHit[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Query corrente digitada na palette (p/ a dica e o estado vazio). */
  readonly query?: string;
  /** Máx. de linhas visíveis da lista (janela). Default 8. */
  readonly maxRows?: number;
}

/** Label com os índices `matched` realçados em âmbar (a11y: + a seleção `›`). */
function HighlightedLabel(props: {
  label: string;
  matched: readonly number[];
  sel: boolean;
}): React.ReactElement {
  const base = props.sel ? 'accent' : 'fg';
  const set = new Set(props.matched);
  if (set.size === 0) {
    return <Role name={base}>{props.label}</Role>;
  }
  // Agrupa runs contíguos casados/não-casados p/ render mínimo (igual FilePicker).
  const parts: React.ReactElement[] = [];
  let i = 0;
  while (i < props.label.length) {
    const on = set.has(i);
    let j = i;
    while (j < props.label.length && set.has(j) === on) j++;
    parts.push(
      <Role key={i} name={on ? 'accent' : base}>
        {props.label.slice(i, j)}
      </Role>,
    );
    i = j;
  }
  return <>{parts}</>;
}

/** Janela de `maxRows` itens centrada no selecionado (não despeja a lista toda). */
function windowOf(
  hits: readonly PaletteHit[],
  selected: number,
  maxRows: number,
): { readonly start: number; readonly slice: readonly PaletteHit[] } {
  if (hits.length <= maxRows) return { start: 0, slice: hits };
  let start = selected - Math.floor(maxRows / 2);
  if (start < 0) start = 0;
  if (start + maxRows > hits.length) start = hits.length - maxRows;
  return { start, slice: hits.slice(start, start + maxRows) };
}

export function CommandPalette(props: CommandPaletteProps): React.ReactElement {
  const { t } = useI18n();
  const maxRows = props.maxRows ?? 8;
  const query = props.query ?? '';
  const { start, slice } = windowOf(props.hits, props.selected, maxRows);
  // Largura do label p/ alinhar as descrições (o maior label visível + folga).
  const labelWidth = slice.reduce((w, h) => Math.max(w, h.label.length), 0);

  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.palette.help')}</Role>
      </Box>
      <Box>
        <Role name="accent">{'> '}</Role>
        {query === '' ? (
          <Role name="fgDim">{t('picker.palette.search')}</Role>
        ) : (
          <Role name="fg">{query}</Role>
        )}
      </Box>
      {props.hits.length === 0 ? (
        <Box>
          <Role name="fgDim"> {t('picker.palette.empty', { query })}</Role>
        </Box>
      ) : (
        slice.map((hit, i) => {
          const idx = start + i;
          const isSel = idx === props.selected;
          return (
            <Box key={hit.id}>
              <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
              <HighlightedLabel label={hit.label} matched={hit.matched} sel={isSel} />
              <Text>{' '.repeat(Math.max(1, labelWidth - hit.label.length + 2))}</Text>
              <Role name="fgDim">{hit.description}</Role>
            </Box>
          );
        })
      )}
      {props.hits.length > slice.length && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.palette.more', { count: props.hits.length - slice.length })}
          </Role>
        </Box>
      )}
    </Box>
  );
}

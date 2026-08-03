// F161-FIX — <LocalModelPicker>: fuzzy-pick de modelo do provider LOCAL ativo (BYO).
//
// `/model` (sem argumento) abre este picker quando `state.meta.backend === 'local'`
// (mesma MECÂNICA/teclas do <FilePicker>/<SlashMenu>: digitar filtra; ↑↓ navega;
// enter/tab confirma; esc fecha). Lista os SLUGS do catálogo local do provider ativo
// (`~/.aluy/providers.json` + built-ins, ADR-0118) com o trecho casado realçado em
// âmbar; o modelo ATIVO ganha `●` (a11y: não só cor). Apresentação PURA — a captura
// de teclas é do orquestrador (App). Espelha o <FilePicker> (EST-0957).

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { FuzzyHit } from '../../attach/index.js';

export interface LocalModelPickerProps {
  readonly hits: readonly FuzzyHit[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Query corrente — só p/ a dica/contagem do estado vazio. */
  readonly query?: string;
  /** Slug do modelo LOCAL ativo (marca a linha correspondente com ●). */
  readonly currentModel?: string;
  /** Largura do terminal (colunas) — reservado p/ paridade com os demais pickers. */
  readonly columns?: number;
  /** Máx. de linhas visíveis do picker (janela). Default 8. */
  readonly maxRows?: number;
}

/** Slug com os índices `matched` realçados em âmbar (a11y: + a seleção). Espelha o
 * `HighlightedPath` do <FilePicker> — mesma técnica, sobre um slug em vez de caminho. */
function HighlightedSlug(props: {
  slug: string;
  matched: readonly number[];
  sel: boolean;
}): React.ReactElement {
  const base = props.sel ? 'accent' : 'fg';
  const set = new Set(props.matched);
  if (set.size === 0) {
    return <Role name={base}>{props.slug}</Role>;
  }
  const parts: React.ReactElement[] = [];
  let i = 0;
  while (i < props.slug.length) {
    const on = set.has(i);
    let j = i;
    while (j < props.slug.length && set.has(j) === on) j++;
    const chunk = props.slug.slice(i, j);
    parts.push(
      <Role key={i} name={on ? 'accent' : base}>
        {chunk}
      </Role>,
    );
    i = j;
  }
  return <>{parts}</>;
}

/** Janela de `maxRows` itens centrada no selecionado (não despeja a lista toda). */
function windowOf(
  hits: readonly FuzzyHit[],
  selected: number,
  maxRows: number,
): {
  readonly start: number;
  readonly slice: readonly FuzzyHit[];
} {
  if (hits.length <= maxRows) return { start: 0, slice: hits };
  let start = selected - Math.floor(maxRows / 2);
  if (start < 0) start = 0;
  if (start + maxRows > hits.length) start = hits.length - maxRows;
  return { start, slice: hits.slice(start, start + maxRows) };
}

export function LocalModelPicker(props: LocalModelPickerProps): React.ReactElement {
  const { t } = useI18n();
  const maxRows = props.maxRows ?? 8;
  const { start, slice } = windowOf(props.hits, props.selected, maxRows);

  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.localModel.help')}</Role>
      </Box>
      {props.hits.length === 0 ? (
        <Box>
          <Role name="fgDim"> {t('picker.localModel.empty', { query: props.query ?? '' })}</Role>
        </Box>
      ) : (
        slice.map((hit, i) => {
          const idx = start + i;
          const isSel = idx === props.selected;
          const isActive = hit.path === props.currentModel;
          return (
            <Box key={hit.path}>
              <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
              <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
              <HighlightedSlug slug={hit.path} matched={hit.matched} sel={isSel} />
            </Box>
          );
        })
      )}
      {props.hits.length > slice.length && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.localModel.more', { count: props.hits.length - slice.length })}
          </Role>
        </Box>
      )}
    </Box>
  );
}

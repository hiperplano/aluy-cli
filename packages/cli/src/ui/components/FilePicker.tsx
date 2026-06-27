// EST-0957 · spec §2.13/§4.2 — <FilePicker>: fuzzy-pick de arquivo do projeto.
//
// `@` no composer abre este picker (mesma MECÂNICA/teclas do <SlashMenu>: digitar
// filtra; ↑↓ navega; enter/tab confirma; esc fecha). Lista CAMINHOS do workspace
// filtrados por fuzzy (`@auth/sess` → `…/auth/session.ts`), com o trecho casado
// REALÇADO em âmbar e o selecionado com prefixo `›` (a11y: não só cor). Tokens-only
// (papéis do DS). Apresentação PURA — a captura de teclas é do orquestrador (App).
//
// Responsivo (§5.1): em terminal estreito o caminho é elidido no MEIO p/ caber na
// largura, preservando o basename (o que o usuário mira). Mostra só uma JANELA dos
// resultados (não despeja 5000 linhas): até `maxRows`, ao redor do selecionado.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { FuzzyHit } from '../../attach/index.js';

export interface FilePickerProps {
  readonly hits: readonly FuzzyHit[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Query corrente (após o `@`) — só p/ a dica/contagem. */
  readonly query?: string;
  /** Largura do terminal (colunas) p/ elidir caminhos longos (§5.1). */
  readonly columns?: number;
  /** Máx. de linhas visíveis do picker (janela). Default 8. */
  readonly maxRows?: number;
}

/** Elide um caminho no MEIO p/ caber em `width`, preservando início e basename. */
export function elidePath(path: string, width: number): string {
  if (width <= 0 || path.length <= width) return path;
  if (width <= 1) return path.slice(0, width);
  const ell = '…';
  const keep = width - ell.length;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return path.slice(0, head) + ell + path.slice(path.length - tail);
}

// FU (não nesta entrega): este realce âmbar por-caractere é DUPLICADO entre o
// FilePicker (`HighlightedPath`) e o SlashMenu (`HighlightedName`) — extrair um
// componente/util compartilhado do DS (ex.: <FuzzyHighlight> tokens-only).
/** Caminho com os índices `matched` realçados em âmbar (a11y: + a seleção). */
function HighlightedPath(props: {
  path: string;
  matched: readonly number[];
  sel: boolean;
}): React.ReactElement {
  const base = props.sel ? 'accent' : 'fg';
  const set = new Set(props.matched);
  if (set.size === 0) {
    return <Role name={base}>{props.path}</Role>;
  }
  // Agrupa runs contíguos casados/não-casados p/ render mínimo.
  const parts: React.ReactElement[] = [];
  let i = 0;
  while (i < props.path.length) {
    const on = set.has(i);
    let j = i;
    while (j < props.path.length && set.has(j) === on) j++;
    const chunk = props.path.slice(i, j);
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

export function FilePicker(props: FilePickerProps): React.ReactElement {
  const { t } = useI18n();
  const columns = props.columns ?? 80;
  const maxRows = props.maxRows ?? 8;
  // largura útil p/ o caminho: tira o prefixo `› ` (2) e uma folga.
  const pathWidth = Math.max(8, columns - 4);
  const { start, slice } = windowOf(props.hits, props.selected, maxRows);

  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.file.help')}</Role>
      </Box>
      {props.hits.length === 0 ? (
        <Box>
          <Role name="fgDim"> {t('picker.file.empty', { query: props.query ?? '' })}</Role>
        </Box>
      ) : (
        slice.map((hit, i) => {
          const idx = start + i;
          const isSel = idx === props.selected;
          // Reindexa os matched p/ o caminho ELIDIDO seria complexo; em terminal
          // largo (sem elisão) o highlight é exato. Quando elide, mostramos o
          // caminho elidido SEM highlight (a seleção + o `›` ainda guiam — a11y).
          const elided = elidePath(hit.path, pathWidth);
          const showHighlight = elided === hit.path;
          return (
            <Box key={hit.path}>
              <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
              {showHighlight ? (
                <HighlightedPath path={hit.path} matched={hit.matched} sel={isSel} />
              ) : (
                <Role name={isSel ? 'accent' : 'fg'}>{elided}</Role>
              )}
            </Box>
          );
        })
      )}
      {props.hits.length > slice.length && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.file.more', { count: props.hits.length - slice.length })}
          </Role>
        </Box>
      )}
    </Box>
  );
}

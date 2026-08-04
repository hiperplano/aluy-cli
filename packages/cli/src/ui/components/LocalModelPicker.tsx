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
  /**
   * F-MODEL-LIVE — a busca AO VIVO no provider está em andamento. A lista DECLARADA já
   * aparece de imediato (isto é só um indicador "ainda buscando mais"); nunca esconde
   * a lista corrente.
   */
  readonly loading?: boolean;
  /**
   * F-MODEL-LIVE — a busca AO VIVO falhou (rede/401/timeout) ⇒ mostra o aviso honesto
   * de que a lista é só o catálogo conhecido. `null`/`undefined`/`false` ⇒ sem aviso.
   */
  readonly usingFallback?: boolean | null;
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
      {/* F-MODEL-LIVE — indicador de carga: a busca AO VIVO no provider (que pode ter
          centenas de modelos) ainda está em voo. A lista já mostrada (catálogo
          declarado + ativo) continua completa acima; isto só avisa que mais pode
          chegar — nunca trava a UI nem esconde o que já dá pra navegar/filtrar. */}
      {props.loading === true && (
        <Box>
          <Role name="fgDim"> {t('picker.localModel.loading')}</Role>
        </Box>
      )}
      {/* F-MODEL-LIVE — a busca ao vivo falhou (provider fora do ar/401/timeout): a
          lista acima é só o catálogo conhecido, e dizemos isso — nunca uma lista
          incompleta SILENCIOSA. */}
      {props.usingFallback === true && props.loading !== true && (
        <Box>
          <Role name="fgDim">
            {'  '}◍ {t('picker.localModel.fallback')}
          </Role>
        </Box>
      )}
      {/* F-MODEL-CUSTOM — a via "custom" (digitar um slug fora da lista) é o próprio
          texto-livre; nem sempre óbvio quando a lista tem centenas de itens. Sempre
          visível (não só no estado vazio) p/ o dono achar sem precisar já saber que
          existe. */}
      <Box>
        <Role name="fgDim"> {t('picker.localModel.customHint')}</Role>
      </Box>
    </Box>
  );
}

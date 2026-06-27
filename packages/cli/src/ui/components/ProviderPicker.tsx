// EST-0962 · /provider — <ProviderPicker>: seletor de PROVIDER (par do modelo Custom).
//
// `/provider` abre este picker (MESMA mecânica/teclas do <SlashMenu>/<ThemePicker>/
// <ModelPicker>: ↑↓ navega; enter seta; esc fecha). Cada item = `rótulo · resumo`. O
// provider ATIVO ganha o marcador `●` (a11y: não só cor); o selecionado leva o prefixo
// `›` em accent. Tokens-only (papéis do DS) — ZERO cor crua. Apresentação PURA: a
// captura de teclas é da App; aqui só desenhamos a lista. Espelha o <ThemePicker>.
//
// HG-2: o picker mostra só o NOME público do provider (catálogo) + um resumo neutro —
// NUNCA credencial/base_url. O broker resolve `(provider, model)` server-side.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { ProviderEntry } from '../../model/providers.js';
import { displayWidth } from '../../session/visual-lines.js';
import { windowAround } from '../window.js';

export interface ProviderPickerProps {
  readonly providers: readonly ProviderEntry[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Provider ATIVO da sessão (marcado com `●`). `undefined` = nenhum setado ainda. */
  readonly currentProvider?: string;
  /**
   * EST-0962 / ADR-0076 — a lista é o FALLBACK estático (broker fora / vazio), não a viva
   * do broker? ⇒ mostra a nota honesta "(não foi possível listar os cadastrados)". `false`
   * quando veio do broker; `null`/`undefined` antes de carregar (sem nota).
   */
  readonly usingFallback?: boolean | null;
  /**
   * Máx. de providers visíveis (janela centrada no selecionado). Belt-and-suspenders:
   * a lista costuma ser pequena (seed openrouter/deepseek), mas o broker pode trazer
   * mais e um terminal curto estouraria `rows` ⇒ full-screen do Ink ⇒ flicker no
   * Windows. MESMO padrão do <HistoryPicker>. Default 10 (auto-seguro).
   */
  readonly maxRows?: number;
  /** F89 (wrap-aware) — largura do terminal; janela por LINHAS VISUAIS em cols estreito. */
  readonly columns?: number;
}

export function ProviderPicker(props: ProviderPickerProps): React.ReactElement {
  const { t } = useI18n();
  const maxRows = Math.max(1, props.maxRows ?? 10);
  // F89 — altura visual por provider: prefixo (2) + `● ` (2) + `label · summary` (+ dica
  // "padrão"); quebra em `ceil(largura / columns)`. Sem `columns`, janela por item.
  const cols = props.columns;
  const rowHeight =
    cols !== undefined && cols > 0
      ? (p: ProviderEntry): number => {
          const w =
            4 +
            displayWidth(`${p.label} · ${p.summary}`) +
            (p.isDefault ? 2 + displayWidth(t('picker.provider.default')) : 0);
          return Math.max(1, Math.ceil(w / cols));
        }
      : undefined;
  const { start, slice } = windowAround(props.providers, props.selected, maxRows, rowHeight);
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.provider.help')}</Role>
      </Box>
      {props.usingFallback === true ? (
        <Box>
          <Role name="fgDim">{t('picker.provider.fallback')}</Role>
        </Box>
      ) : null}
      {slice.map((provider, i) => {
        const isSel = start + i === props.selected;
        const isActive = provider.name === props.currentProvider;
        return (
          <Box key={provider.name}>
            {/* prefixo › no selecionado + ● no provider ativo (a11y: não só cor) */}
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>{provider.label}</Role>
            <Role name="fgDim"> · {provider.summary}</Role>
            {provider.isDefault ? (
              <Role name="fgDim"> · {t('picker.provider.default')}</Role>
            ) : null}
          </Box>
        );
      })}
      {props.providers.length > slice.length && (
        <Box>
          <Role name="fgDim">
            {'  '}
            {t('picker.provider.more', { count: props.providers.length - slice.length })}
          </Role>
        </Box>
      )}
    </Box>
  );
}

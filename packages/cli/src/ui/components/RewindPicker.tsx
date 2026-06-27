// EST-XXXX — <RewindPicker>: seletor de CHECKPOINTS (`/rewind` · Esc Esc).
//
// DUAS etapas (mesmas teclas do <HistoryPicker>: ↑↓ navega; enter confirma; esc
// volta/cancela):
//   - `list`   — os PONTOS da sessão (`#N · HH:MM · prompt`), recente no topo;
//   - `action` — a AÇÃO sobre o ponto: código+conversa | só conversa | só código.
// O selecionado leva o prefixo `›` em accent (a11y: não só cor). Tokens-only (papéis
// do DS). Apresentação PURA — a captura de teclas é da App.
//
// SEGURANÇA (CLI-SEC-6): a label é o PROMPT do usuário (fala própria, já truncada no
// core), não o corpo da transcrição nem dado de ambiente. Sem segredo.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { useI18n } from '../../i18n/index.js';
import type { I18nKey } from '../../i18n/index.js';
import type { Checkpoint } from '@hiperplano/aluy-cli-core';
import { formatRewindEntry, type RewindAction } from '../../session/rewind.js';
import { displayWidth } from '../../session/visual-lines.js';
import { windowAround } from '../window.js';

export interface RewindPickerProps {
  /** Etapa corrente (`list` ou `action`). */
  readonly phase: 'list' | 'action';
  /** Checkpoints listados (recente-first). */
  readonly checkpoints: readonly Checkpoint[];
  /** Ações disponíveis (etapa `action`). */
  readonly actions: readonly RewindAction[];
  /** O ponto-alvo (etapa `action`) — exibido no cabeçalho. */
  readonly target?: Checkpoint | undefined;
  /** Índice selecionado na etapa corrente. */
  readonly selected: number;
  /**
   * Avisos de barreira (`run_command`) depois do ponto-alvo (etapa `action`).
   * Comandos REDIGIDOS (CLI-SEC-6). Vazio ⇒ nada exibido.
   */
  readonly barrierWarnings?: readonly string[];
  /**
   * Máx. de CHECKPOINTS visíveis na etapa `list` (janela centrada no selecionado).
   * Sem isto, uma sessão longa (1 ponto por prompt → dezenas) faria o `/rewind`
   * despejar a lista inteira no inline, estourando `rows` ⇒ o Ink cai no caminho
   * full-screen (clearTerminal por frame) ⇒ flicker no Windows. MESMO padrão do
   * <HistoryPicker>/<CommandPalette>. Default 10 (auto-seguro sem o cap do caller).
   */
  readonly maxRows?: number;
  /** F89 (wrap-aware) — largura do terminal; janela por LINHAS VISUAIS em cols estreito. */
  readonly columns?: number;
}

/** Rótulo i18n (tipado) de cada ação. */
function actionKey(action: RewindAction): I18nKey {
  switch (action) {
    case 'both':
      return 'picker.rewind.action.both';
    case 'conversation':
      return 'picker.rewind.action.conversation';
    case 'code':
      return 'picker.rewind.action.code';
  }
}

export function RewindPicker(props: RewindPickerProps): React.ReactElement {
  const { t } = useI18n();

  if (props.phase === 'list') {
    const maxRows = Math.max(1, props.maxRows ?? 10);
    // F89 — altura visual por checkpoint: prefixo (2) + a entrada formatada, quebrando em
    // `ceil(largura / columns)`. Sem `columns`, janela por item (tela larga, inalterado).
    const cols = props.columns;
    const rowHeight =
      cols !== undefined && cols > 0
        ? (cp: Checkpoint): number =>
            Math.max(1, Math.ceil((2 + displayWidth(formatRewindEntry(cp))) / cols))
        : undefined;
    const { start, slice } = windowAround(props.checkpoints, props.selected, maxRows, rowHeight);
    return (
      <Box flexDirection="column">
        <Box>
          <Role name="fgDim">{t('picker.rewind.help')}</Role>
        </Box>
        {props.checkpoints.length === 0 ? (
          <Box>
            <Role name="fgDim"> {t('picker.rewind.empty')}</Role>
          </Box>
        ) : (
          slice.map((cp, i) => {
            const isSel = start + i === props.selected;
            return (
              <Box key={cp.id}>
                <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
                <Role name={isSel ? 'accent' : 'fg'}>{formatRewindEntry(cp)}</Role>
              </Box>
            );
          })
        )}
        {props.checkpoints.length > slice.length && (
          <Box>
            <Role name="fgDim">
              {'  '}
              {t('picker.rewind.more', { count: props.checkpoints.length - slice.length })}
            </Role>
          </Box>
        )}
      </Box>
    );
  }

  // etapa `action`
  return (
    <Box flexDirection="column">
      <Box>
        <Role name="fgDim">{t('picker.rewind.action.help')}</Role>
      </Box>
      {props.target && (
        <Box>
          <Role name="fgDim">{`  → #${props.target.ordinal} · ${props.target.label}`}</Role>
        </Box>
      )}
      {props.actions.map((action, i) => {
        const isSel = i === props.selected;
        return (
          <Box key={action}>
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>{t(actionKey(action))}</Role>
          </Box>
        );
      })}
      {props.barrierWarnings && props.barrierWarnings.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box>
            <Role name="accent">{`⚠ ${t('picker.rewind.barrier.warn')}:`}</Role>
          </Box>
          {props.barrierWarnings.map((cmd, i) => (
            <Box key={i}>
              <Role name="fgDim">{`  · ${cmd}`}</Role>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}

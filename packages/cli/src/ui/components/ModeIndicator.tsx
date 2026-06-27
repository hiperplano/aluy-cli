// EST-0959 · ADR-0055 — INDICADOR DE MODO de sessão (sempre visível).
//
// O eixo de modo (`plan | normal | unsafe`) é estado de sessão da catraca; a TUI
// DEVE indicá-lo SEMPRE, de forma INEQUÍVOCA (ADR-0055 §4): GLIFO + PALAVRA, nunca
// só cor (a11y / NO_COLOR — o usuário não pode "achar que está em Plan e não
// estar"). Papéis do DS (nunca cor crua):
//   - plan   → `depth` (petrol/calmo) — read-only, seguro, sereno.
//   - normal → `fgDim` (neutro) — a catraca padrão.
//   - unsafe → `danger` (âmbar/vermelho, gritante) — aprovação DESLIGADA.
//
// Estende o papel do antigo `<UnsafeBanner>` (EST-0948): em `unsafe`, reusa o
// BANNER vermelho gritante e persistente; em `plan`/`normal`, mostra o indicador
// compacto (glifo+palavra). Assim o aviso loud de unsafe não regride.

import React from 'react';
import { Box } from 'ink';
import type { SessionMode } from '@aluy/cli-core';
import { Glyph, Role } from '../theme/index.js';
import { UnsafeBanner } from './UnsafeBanner.js';
import { useI18n } from '../../i18n/index.js';
import type { I18nKey } from '../../i18n/index.js';

export interface ModeIndicatorProps {
  readonly mode: SessionMode;
  /** Largura do terminal (responsivo). */
  readonly columns?: number;
}

/**
 * Glifo + papel + palavra por modo (a11y: a palavra carrega o sentido). A `word`
 * (`PLAN`/`NORMAL`/`YOLO`) é identificador de PRODUTO e NÃO se traduz; o `caption`
 * é uma CHAVE i18n (EST-0989) resolvida via `t()` no idioma ativo (fallback p/ pt-BR).
 */
const MODE_VIEW: Readonly<
  Record<
    SessionMode,
    {
      glyph: 'planMode' | 'normalMode' | 'ask';
      role: 'depth' | 'fgDim' | 'danger';
      word: string;
      caption: I18nKey;
    }
  >
> = {
  plan: {
    glyph: 'planMode',
    role: 'depth',
    word: 'PLAN',
    caption: 'mode.plan.caption',
  },
  normal: {
    glyph: 'normalMode',
    role: 'fgDim',
    word: 'NORMAL',
    caption: 'mode.normal.caption',
  },
  unsafe: {
    glyph: 'ask',
    role: 'danger',
    // EST-0959 — o nome de PRODUTO do modo é YOLO (`--yolo`); `unsafe` é só o
    // identificador interno (catraca/specs).
    word: 'YOLO',
    caption: 'mode.unsafe.caption',
  },
};

export function ModeIndicator(props: ModeIndicatorProps): React.ReactElement {
  const { t } = useI18n();
  // `unsafe` reusa o BANNER gritante (EST-0948) — não regride o aviso loud.
  if (props.mode === 'unsafe') {
    return <UnsafeBanner {...(props.columns !== undefined ? { columns: props.columns } : {})} />;
  }
  const v = MODE_VIEW[props.mode];
  const narrow = (props.columns ?? 80) < 60;
  return (
    <Box>
      <Glyph name={v.glyph} role={v.role} />
      <Role name={v.role}>
        {' '}
        {t('mode.label')} {v.word}
      </Role>
      {!narrow && <Role name="fgDim"> · {t(v.caption)}</Role>}
    </Box>
  );
}

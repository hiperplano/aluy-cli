// F161-FIX · /effort STANDALONE — <EffortPicker>: seletor de `reasoning_effort` fora
// do fluxo conjugado do `/model` (EST-1117). Mesma LISTA/mecânica do passo de effort
// do <ModelPicker> (manter/low/medium/high/custom · ↑↓ navega · enter aplica), mas
// como entrada PRÓPRIA a partir do `/effort` — aqui esc FECHA (não "volta", pois não
// há etapa anterior nesta entrada). Tokens-only (papéis do DS). Apresentação PURA.

import React from 'react';
import { Box } from 'ink';
import { Role } from '../theme/index.js';
import { PickerFrame } from './PickerFrame.js';
import { useI18n } from '../../i18n/index.js';
import type { EffortOption } from '@hiperplano/aluy-cli-core';
import type { I18nKey } from '../../i18n/index.js';

/** Rótulo i18n de cada opção de effort (id → chave do catálogo). Espelha o <ModelPicker>. */
const EFFORT_LABEL_KEY: Record<string, I18nKey> = {
  keep: 'picker.effort.keep',
  low: 'picker.effort.low',
  medium: 'picker.effort.medium',
  high: 'picker.effort.high',
  custom: 'picker.effort.custom',
};

export interface EffortPickerProps {
  readonly options: readonly EffortOption[];
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** O `reasoning_effort` ATIVO da sessão (marca o ● "atual"). `undefined` ⇒ default. */
  readonly currentEffort?: string;
  /** O modo CUSTOM (texto-livre passthrough) está aberto? */
  readonly customOpen?: boolean;
  /** O texto digitado no custom. */
  readonly customInput?: string;
  /** Aviso de custom inválido (`empty`/`too-long`) — ou `null` (válido). */
  readonly customWarn?: 'empty' | 'too-long' | null;
}

export function EffortPicker(props: EffortPickerProps): React.ReactElement {
  if (props.customOpen === true) {
    return <CustomInput {...props} />;
  }
  return <OptionsList {...props} />;
}

function OptionsList(props: EffortPickerProps): React.ReactElement {
  const { t } = useI18n();
  const current = props.currentEffort;
  return (
    <PickerFrame>
      <Box>
        <Role name="fgDim">{t('picker.effort.standaloneHelp')}</Role>
      </Box>
      {props.options.map((opt, i) => {
        const isSel = i === props.selected;
        // O effort ATIVO: o nível corrente da sessão (●). "manter" é ativo quando NENHUM
        // effort canônico está setado (default do provider). "custom" nunca marca ●.
        const isActive =
          (opt.kind === 'level' && opt.value === current) ||
          (opt.kind === 'keep' && (current === undefined || current === ''));
        return (
          <Box key={opt.id}>
            <Role name={isSel ? 'accent' : 'fgDim'}>{isSel ? '› ' : '  '}</Role>
            <Role name={isActive ? 'accent' : 'fgDim'}>{isActive ? '● ' : '  '}</Role>
            <Role name={isSel ? 'accent' : 'fg'}>
              {t(EFFORT_LABEL_KEY[opt.id] ?? 'picker.effort.keep')}
            </Role>
          </Box>
        );
      })}
    </PickerFrame>
  );
}

/** Effort CUSTOM (texto-livre passthrough): digita o valor; aviso se vazio/>32. */
function CustomInput(props: EffortPickerProps): React.ReactElement {
  const { t } = useI18n();
  const value = props.customInput ?? '';
  const warn = props.customWarn ?? null;
  return (
    <PickerFrame>
      <Box>
        <Role name="fgDim">{t('picker.effort.customHelp')}</Role>
      </Box>
      <Box>
        <Role name="accent">{'› '}</Role>
        <Role name="fg">{value}</Role>
        <Role name="accent">▏</Role>
      </Box>
      {warn !== null && (
        <Box>
          <Role name="accent">
            {'  '}
            {warn === 'empty' ? t('picker.effort.warnEmpty') : t('picker.effort.warnTooLong')}
          </Role>
        </Box>
      )}
    </PickerFrame>
  );
}

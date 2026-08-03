// F161-FIX · /effort STANDALONE — hook do seletor de `reasoning_effort` fora do
// fluxo CONJUGADO do `/model` (EST-1117). Antes desta entrega, `/effort` sem
// argumento só LIA o valor atual (nota estática); trocar exigia digitar o valor às
// cegas (`/effort high`) OU passar pelo `/model` inteiro só p/ chegar no passo de
// effort. Este hook abre a MESMA lista (manter/low/medium/high/custom) direto do
// `/effort`, reusando as funções PURAS do core (nenhuma regra nova).
//
// Mesma MECÂNICA dos demais pickers (↑↓ navega; enter aplica; esc fecha — AQUI esc
// FECHA de vez, não "volta" como no passo conjugado do /model, pois não há etapa
// anterior nesta entrada). Apresentação pura em `<EffortPicker>`.
//
// Confirmar NÃO faz I/O: devolve o `EffortChoice` (`{kind:'keep'}` ou
// `{kind:'set',value}`) do core — o chamador (App→run.tsx) aplica via
// `controller.setEffort(value)`, o MESMO efeito de hoje digitar `/effort <valor>`.

import { useCallback, useMemo, useState } from 'react';
import type { EffortChoice, EffortOption } from '@hiperplano/aluy-cli-core';
import {
  clampEffortIndex,
  effortChoiceAt,
  effortChoiceFromCustom,
  effortOptions,
  validateCustomEffort,
} from '@hiperplano/aluy-cli-core';

export interface UseEffortPickerArgs {
  /** O `reasoning_effort` ATIVO da sessão (marca o ● "atual"). `undefined` ⇒ default. */
  readonly currentEffort?: string;
}

export interface EffortPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** As opções (manter/low/medium/high/custom) — DADO puro do core. */
  readonly options: readonly EffortOption[];
  /** Índice selecionado (navegado por ↑↓), clampeado. */
  readonly selected: number;
  /** O effort ATIVO da sessão (p/ marcar o ●). */
  readonly currentEffort: string | undefined;
  /** O modo CUSTOM (texto-livre passthrough) está aberto? */
  readonly customOpen: boolean;
  /** O texto digitado no custom (passthrough; vazio/>32 não confirma). */
  readonly customInput: string;
  /** Aviso do custom inválido — `null` quando válido (ou custom fechado). */
  readonly customWarn: 'empty' | 'too-long' | null;
  /** Abre o picker (sempre re-ancora na 1ª opção — "manter"). */
  openPicker(): void;
  /** Fecha o picker (esc) sem aplicar. */
  closePicker(): void;
  /** Move a seleção (+1/-1) na lista, clampeada. Sem efeito no modo custom. */
  move(delta: number): void;
  /**
   * Confirma a etapa corrente: opção "custom" ⇒ ABRE o texto-livre (devolve `null`,
   * não fecha); nível/manter ⇒ devolve o `EffortChoice` e FECHA; custom com texto
   * válido ⇒ devolve `{kind:'set',...}` e FECHA; custom inválido ⇒ `null` (mantém
   * aberto + aviso).
   */
  confirm(): EffortChoice | null;
  /** Acrescenta caractere ao custom (digitação). */
  appendCustom(ch: string): void;
  /** Apaga o último caractere do custom (backspace). */
  backspaceCustom(): void;
  /** Sai do modo custom de volta pra lista (esc no custom). `false` se já na lista. */
  back(): boolean;
}

export function useEffortPicker(args: UseEffortPickerArgs): EffortPickerController {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [customOpen, setCustomOpen] = useState(false);
  const [customInput, setCustomInput] = useState('');
  const options = useMemo<readonly EffortOption[]>(() => effortOptions(), []);

  const openPicker = useCallback(() => {
    setOpen(true);
    setSelected(0);
    setCustomOpen(false);
    setCustomInput('');
  }, []);

  const closePicker = useCallback(() => {
    setOpen(false);
    setSelected(0);
    setCustomOpen(false);
    setCustomInput('');
  }, []);

  const move = useCallback(
    (delta: number) => {
      if (customOpen) return;
      setSelected((s) => clampEffortIndex(s + delta));
    },
    [customOpen],
  );

  const confirm = useCallback((): EffortChoice | null => {
    if (customOpen) {
      const choice = effortChoiceFromCustom(customInput);
      if (choice === null) return null; // inválido: mantém aberto + aviso (via customWarn)
      closePicker();
      return choice;
    }
    const opt = options[clampEffortIndex(selected)];
    if (opt?.kind === 'custom') {
      setCustomOpen(true);
      setCustomInput('');
      return null;
    }
    const choice = effortChoiceAt(clampEffortIndex(selected));
    if (choice === null) return null;
    closePicker();
    return choice;
  }, [customOpen, customInput, options, selected, closePicker]);

  const appendCustom = useCallback(
    (ch: string) => {
      if (!customOpen) return;
      const clean = ch.replace(/[\r\n\t]/g, '');
      if (clean === '') return;
      setCustomInput((s) => s + clean);
    },
    [customOpen],
  );

  const backspaceCustom = useCallback(() => {
    if (!customOpen) return;
    setCustomInput((s) => s.slice(0, -1));
  }, [customOpen]);

  const back = useCallback((): boolean => {
    if (customOpen) {
      setCustomOpen(false);
      setCustomInput('');
      return true;
    }
    return false;
  }, [customOpen]);

  const customWarn = useMemo<'empty' | 'too-long' | null>(() => {
    if (!customOpen) return null;
    const v = validateCustomEffort(customInput);
    return v.ok ? null : v.reason;
  }, [customOpen, customInput]);

  return {
    open,
    options,
    selected: clampEffortIndex(selected),
    currentEffort: args.currentEffort,
    customOpen,
    customInput,
    customWarn,
    openPicker,
    closePicker,
    move,
    confirm,
    appendCustom,
    backspaceCustom,
    back,
  };
}

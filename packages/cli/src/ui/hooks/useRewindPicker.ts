// EST-XXXX — hook do seletor de CHECKPOINTS (`/rewind` · Esc Esc). DUAS etapas:
//   1. `list`   — escolhe o PONTO (um prompt da sessão; recente no topo);
//   2. `action` — escolhe a AÇÃO sobre o ponto (código+conversa | só conversa | só
//                 código).
// MESMA mecânica de teclas dos outros pickers (a App captura ↑↓/enter/esc e chama
// estes métodos; a apresentação é pura). Diferenças:
//   - a lista vem do `CheckpointRegistry` (em memória, síncrono) — re-lida a cada
//     abertura (prompts novos surgem entre aberturas);
//   - `confirm` na etapa `list` AVANÇA p/ a etapa `action` (não restaura ainda);
//   - `confirm` na etapa `action` devolve `{ checkpointId, action }` (o caller —
//     run.tsx — aplica a restauração de código e/ou a rebobinada de conversa);
//   - `esc` na etapa `action` VOLTA p/ a lista; `esc` na `list` fecha.

import { useCallback, useState } from 'react';
import type { Checkpoint } from '@hiperplano/aluy-cli-core';
import {
  selectRewindCheckpoints,
  REWIND_ACTIONS,
  REWIND_LIST_LIMIT,
  type RewindAction,
} from '../../session/rewind.js';

/** A face mínima do registry que o picker consome (só leitura da lista). */
export interface RewindCheckpointSource {
  list(): readonly Checkpoint[];
}

export interface UseRewindPickerArgs {
  /** Registro de checkpoints da sessão (lido na abertura). */
  readonly source: RewindCheckpointSource;
  /** Teto de itens listados (default `REWIND_LIST_LIMIT`). */
  readonly limit?: number;
}

/** A escolha confirmada: ponto + ação (o caller aplica). */
export interface RewindChoice {
  readonly checkpointId: string;
  readonly action: RewindAction;
}

export interface RewindPickerController {
  /** Etapa corrente do picker (`closed` = fechado). */
  readonly phase: 'closed' | 'list' | 'action';
  /** `true` se o picker está aberto (qualquer etapa não-fechada). */
  readonly open: boolean;
  /** Índice selecionado na etapa corrente (lista de pontos OU de ações). */
  readonly selected: number;
  /** Os checkpoints listados (recente-first) — re-lidos a cada abertura. */
  readonly checkpoints: readonly Checkpoint[];
  /** As ações disponíveis (etapa `action`). */
  readonly actions: readonly RewindAction[];
  /** O checkpoint selecionado na etapa `action` (p/ exibir o cabeçalho). */
  readonly target: Checkpoint | undefined;
  /** Abre o picker na etapa `list` (RE-LÊ a fonte; seleção no 1º item). */
  openPicker(): void;
  /** Fecha o picker (esc na lista). */
  closePicker(): void;
  /** Move a seleção (+1/-1) na etapa corrente, clampeada. */
  move(delta: number): void;
  /**
   * Confirma a seleção da etapa corrente:
   *   - `list`   ⇒ avança p/ `action` (devolve null — nada a aplicar ainda);
   *   - `action` ⇒ fecha e devolve `{ checkpointId, action }` p/ o caller aplicar.
   * Lista vazia / sem alvo ⇒ no-op (devolve null).
   */
  confirm(): RewindChoice | null;
  /** Esc contextual: na `action` VOLTA p/ a lista; na `list` FECHA. */
  back(): void;
}

export function useRewindPicker(args: UseRewindPickerArgs): RewindPickerController {
  const [phase, setPhase] = useState<'closed' | 'list' | 'action'>('closed');
  const [selected, setSelected] = useState(0);
  const [checkpoints, setCheckpoints] = useState<readonly Checkpoint[]>([]);
  // índice do ponto escolhido na etapa `list` (alvo da etapa `action`).
  const [targetIndex, setTargetIndex] = useState(0);

  const openPicker = useCallback(() => {
    // RE-LÊ a fonte: pontos marcados depois da última abertura aparecem. Fail-safe:
    // uma fonte que lança ⇒ lista vazia (picker mostra "nenhum ponto", esc fecha).
    let list: readonly Checkpoint[] = [];
    try {
      list = selectRewindCheckpoints(args.source.list(), args.limit ?? REWIND_LIST_LIMIT);
    } catch {
      list = [];
    }
    setCheckpoints(list);
    setSelected(0);
    setTargetIndex(0);
    setPhase('list');
  }, [args.source, args.limit]);

  const closePicker = useCallback(() => {
    setPhase('closed');
  }, []);

  const move = useCallback(
    (delta: number) => {
      setSelected((s) => {
        const len = phase === 'action' ? REWIND_ACTIONS.length : checkpoints.length;
        const max = Math.max(0, len - 1);
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [phase, checkpoints.length],
  );

  const confirm = useCallback((): RewindChoice | null => {
    if (phase === 'list') {
      if (checkpoints.length === 0) return null; // nada a escolher.
      setTargetIndex(selected);
      setSelected(0); // a etapa `action` começa no `both` (topo).
      setPhase('action');
      return null;
    }
    if (phase === 'action') {
      const cp = checkpoints[targetIndex];
      const action = REWIND_ACTIONS[selected];
      setPhase('closed');
      if (!cp || !action) return null;
      return { checkpointId: cp.id, action };
    }
    return null;
  }, [phase, checkpoints, selected, targetIndex]);

  const back = useCallback(() => {
    if (phase === 'action') {
      // volta p/ a lista, re-selecionando o ponto que estava aberto.
      setSelected(targetIndex);
      setPhase('list');
      return;
    }
    setPhase('closed');
  }, [phase, targetIndex]);

  return {
    phase,
    open: phase !== 'closed',
    selected,
    checkpoints,
    actions: REWIND_ACTIONS,
    target: phase === 'action' ? checkpoints[targetIndex] : undefined,
    openPicker,
    closePicker,
    move,
    confirm,
    back,
  };
}

// EST-0972 — hook do seletor de HISTÓRICO (`/history`): estado do picker (abrir/
// navegar/confirmar/fechar). MESMA mecânica do `useThemePicker`/`useModelPicker`/
// `useFilePicker` — a App captura as teclas (↑↓/enter/esc) e chama estes métodos; a
// apresentação é pura. A DIFERENÇA: a lista vem do `SessionStore` LOCAL (síncrono,
// sem broker) e é RE-LIDA a cada abertura (sessões novas surgem entre aberturas).
//
// Confirmar NÃO faz I/O de modelo: devolve o `id` da sessão escolhida; o chamador
// (App → run.tsx) carrega o record e aplica `applyResumeRecord` (restoreBlocks +
// seedHistory) — o MESMO caminho do `--resume`. Lista vazia ⇒ o picker abre mostrando
// "nenhuma sessão anterior" e o enter é no-op (esc fecha).

import { useCallback, useState } from 'react';
import type { SessionStore, SessionSummary } from '../../io/index.js';
import { selectHistorySessions, HISTORY_LIST_LIMIT } from '../../session/history.js';

export interface UseHistoryPickerArgs {
  /** Store das sessões persistidas (`~/.aluy/sessions/`) — lido na abertura. */
  readonly store: Pick<SessionStore, 'list'>;
  /** Teto de itens listados (default `HISTORY_LIST_LIMIT`). */
  readonly limit?: number;
}

export interface HistoryPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** As sessões listadas (resumos, recente-first) — re-lidas a cada abertura. */
  readonly sessions: readonly SessionSummary[];
  /** Abre o picker (RE-LÊ o store e posiciona a seleção no 1º item). */
  openPicker(): void;
  /** Fecha o picker (esc) sem retomar. */
  closePicker(): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /** Confirma o item selecionado: devolve o `id` da sessão (ou null se vazio). */
  confirm(): string | null;
}

export function useHistoryPicker(args: UseHistoryPickerArgs): HistoryPickerController {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [sessions, setSessions] = useState<readonly SessionSummary[]>([]);

  const openPicker = useCallback(() => {
    // RE-LÊ o store a cada abertura: sessões salvas DEPOIS da última abertura aparecem
    // (o auto-save grava por-turno). Fail-safe dentro de `selectHistorySessions`
    // (store que lança ⇒ lista vazia ⇒ "nenhuma sessão anterior", nunca derruba a TUI).
    setSessions(selectHistorySessions(args.store, args.limit ?? HISTORY_LIST_LIMIT));
    setSelected(0);
    setOpen(true);
  }, [args.store, args.limit]);

  const closePicker = useCallback(() => {
    setOpen(false);
  }, []);

  const move = useCallback(
    (delta: number) => {
      setSelected((s) => {
        const max = Math.max(0, sessions.length - 1);
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [sessions.length],
  );

  const confirm = useCallback((): string | null => {
    const entry = sessions[selected];
    setOpen(false);
    return entry ? entry.id : null;
  }, [sessions, selected]);

  return { open, selected, sessions, openPicker, closePicker, move, confirm };
}

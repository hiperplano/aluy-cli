// EST-0966 — hook do seletor de TEMA (`/theme`): estado do picker (abrir/navegar/
// confirmar/fechar). MESMA mecânica do `useModelPicker`/`useFilePicker` — a App
// captura as teclas (↑↓/enter/esc) e chama estes métodos; a apresentação é pura.
//
// A DIFERENÇA p/ o `/model`: a lista é o catálogo ESTÁTICO de temas (THEMES) — não
// há I/O nem fallback (os temas vivem no binário, não no broker). Confirmar NÃO
// renderiza nada aqui: devolve o NOME do tema; o chamador (App→run.tsx) aplica a
// troca re-resolvendo o `Theme` e re-renderizando a árvore (persistência = FU).

import { useCallback, useState } from 'react';
import { THEMES, type ThemeEntry, type ThemeName } from '../theme/themes.js';

export interface UseThemePickerArgs {
  /** Tema ATIVO da sessão (p/ marcar o item ativo e pré-selecioná-lo). */
  readonly currentTheme: ThemeName;
}

export interface ThemePickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Entradas do catálogo de temas. */
  readonly themes: readonly ThemeEntry[];
  /** Abre o picker (pré-seleciona o tema ativo). */
  openPicker(): void;
  /** Fecha o picker (esc) sem trocar. */
  closePicker(): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /** Confirma o item selecionado: devolve o nome do tema (ou null se vazio). */
  confirm(): ThemeName | null;
}

/** Posição do tema corrente na lista (p/ pré-selecionar no item ativo). */
function indexOfCurrent(current: ThemeName): number {
  const i = THEMES.findIndex((t) => t.name === current);
  return i >= 0 ? i : 0;
}

export function useThemePicker(args: UseThemePickerArgs): ThemePickerController {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => indexOfCurrent(args.currentTheme));

  const openPicker = useCallback(() => {
    // Reabrir sempre re-ancora no tema ATIVO (consistente com o /model abrir no ativo).
    setSelected(indexOfCurrent(args.currentTheme));
    setOpen(true);
  }, [args.currentTheme]);

  const closePicker = useCallback(() => {
    setOpen(false);
  }, []);

  const move = useCallback((delta: number) => {
    setSelected((s) => {
      const max = Math.max(0, THEMES.length - 1);
      return Math.min(max, Math.max(0, s + delta));
    });
  }, []);

  const confirm = useCallback((): ThemeName | null => {
    const entry = THEMES[selected];
    setOpen(false);
    return entry ? entry.name : null;
  }, [selected]);

  return {
    open,
    selected,
    themes: THEMES,
    openPicker,
    closePicker,
    move,
    confirm,
  };
}

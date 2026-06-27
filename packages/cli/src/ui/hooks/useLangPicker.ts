// EST-0989 — hook do seletor de IDIOMA (`/lang`): estado do picker (abrir/navegar/
// confirmar/fechar). MESMA mecânica do `useThemePicker`/`useModelPicker`/
// `useFilePicker` — a App captura as teclas (↑↓/enter/esc) e chama estes métodos; a
// apresentação é pura.
//
// Como o `/theme`: a lista é o catálogo ESTÁTICO de idiomas (LANGS) — não há I/O nem
// fallback (os idiomas vivem no binário). Confirmar NÃO re-renderiza aqui: devolve o
// CÓDIGO do idioma; o chamador (App→run.tsx) aplica a troca re-injetando o `I18n` no
// contexto + persistindo (UserConfigStore.saveLang) e re-renderizando a árvore.

import { useCallback, useState } from 'react';
import { LANGS, type LangEntry, type Lang } from '../../i18n/index.js';

export interface UseLangPickerArgs {
  /** Idioma ATIVO da sessão (p/ marcar o item ativo e pré-selecioná-lo). */
  readonly currentLang: Lang;
}

export interface LangPickerController {
  /** Picker aberto? */
  readonly open: boolean;
  /** Índice selecionado (navegado por ↑↓). */
  readonly selected: number;
  /** Entradas do catálogo de idiomas. */
  readonly langs: readonly LangEntry[];
  /** Abre o picker (pré-seleciona o idioma ativo). */
  openPicker(): void;
  /** Fecha o picker (esc) sem trocar. */
  closePicker(): void;
  /** Move a seleção (+1/-1), clampeada. */
  move(delta: number): void;
  /** Confirma o item selecionado: devolve o código do idioma (ou null se vazio). */
  confirm(): Lang | null;
}

/** Posição do idioma corrente na lista (p/ pré-selecionar no item ativo). */
function indexOfCurrent(current: Lang): number {
  const i = LANGS.findIndex((l) => l.code === current);
  return i >= 0 ? i : 0;
}

export function useLangPicker(args: UseLangPickerArgs): LangPickerController {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => indexOfCurrent(args.currentLang));

  const openPicker = useCallback(() => {
    // Reabrir sempre re-ancora no idioma ATIVO (consistente com /theme abrir no ativo).
    setSelected(indexOfCurrent(args.currentLang));
    setOpen(true);
  }, [args.currentLang]);

  const closePicker = useCallback(() => {
    setOpen(false);
  }, []);

  const move = useCallback((delta: number) => {
    setSelected((s) => {
      const max = Math.max(0, LANGS.length - 1);
      return Math.min(max, Math.max(0, s + delta));
    });
  }, []);

  const confirm = useCallback((): Lang | null => {
    const entry = LANGS[selected];
    setOpen(false);
    return entry ? entry.code : null;
  }, [selected]);

  return {
    open,
    selected,
    langs: LANGS,
    openPicker,
    closePicker,
    move,
    confirm,
  };
}

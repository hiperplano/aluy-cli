// EST-0961 — hook da COMMAND PALETTE (Ctrl+P): estado do overlay (abrir/digitar/
// navegar/confirmar/fechar). MESMA mecânica do `useFilePicker`/`useThemePicker` —
// a App captura as teclas (↑↓/enter/esc + digitação) e chama estes métodos; a
// apresentação (<CommandPalette>) é pura. A query é PRÓPRIA do overlay (não vive
// no composer, ao contrário do `/` e do `@`): a palette é um modo modal que abre
// por atalho global, não por um caractere no input.
//
// FONTE ÚNICA (spec): os itens vêm de `filterPalette`, que lê os MESMOS
// `NATIVE_COMMANDS` + comandos do usuário do slash-menu (+ ações puras). Um
// comando novo no registro aparece aqui sem nenhuma mudança neste hook.

import { useCallback, useMemo, useState } from 'react';
import { filterPalette, type PaletteHit, type SlashCommand } from '../../slash/commands.js';

export interface UseCommandPaletteArgs {
  /** Comandos do usuário (DADO de ~/.aluy/commands/) — mesma fonte do slash-menu. */
  readonly userCommands?: readonly SlashCommand[];
  /**
   * EST-0989 (i18n) — os NATIVOS já LOCALIZADOS (idioma ativo) pela App
   * (`localizeCommands(NATIVE_COMMANDS, t)`). Ausente ⇒ `filterPalette` usa o default
   * pt-BR (back-compat). Passado pela App p/ a palette mostrar os summaries no idioma.
   */
  readonly natives?: readonly SlashCommand[];
}

export interface CommandPaletteController {
  /** Palette aberta? */
  readonly open: boolean;
  /** Texto de busca digitado dentro da palette. */
  readonly query: string;
  /** Itens filtrados+ordenados (fuzzy) pela query corrente. */
  readonly hits: readonly PaletteHit[];
  /** Índice selecionado (navegado por ↑↓), clampeado aos hits. */
  readonly selected: number;
  /** Abre a palette (zera query/seleção). */
  openPalette(): void;
  /** Fecha a palette (esc) sem executar. */
  closePalette(): void;
  /** Define a query de busca (re-filtra; re-ancora a seleção no topo). */
  setQuery(q: string): void;
  /** Move a seleção (+1/-1), clampeada aos hits visíveis. */
  move(delta: number): void;
  /** Confirma o item selecionado: devolve o hit (ou null se a lista está vazia). */
  confirm(): PaletteHit | null;
}

export function useCommandPalette(args: UseCommandPaletteArgs = {}): CommandPaletteController {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [selected, setSelected] = useState(0);

  const userCommands = args.userCommands ?? [];
  const natives = args.natives;
  // Memo estável p/ não re-filtrar a cada render quando query/comandos/idioma não mudam.
  const hits = useMemo(
    () => filterPalette(query, userCommands, natives),
    // userCommands/natives são DADO estável do wiring (natives = localizeCommands, que
    // só muda ref ao trocar de idioma); depender dos arrays crus evita memo "mentiroso".
    [query, userCommands, natives],
  );

  const openPalette = useCallback(() => {
    setQueryState('');
    setSelected(0);
    setOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
  }, []);

  const setQuery = useCallback((q: string) => {
    setQueryState(q);
    // Nova query ⇒ a seleção volta ao topo (o melhor match fica selecionável com
    // um Enter, como no file-picker).
    setSelected(0);
  }, []);

  const move = useCallback(
    (delta: number) => {
      setSelected((s) => {
        const max = Math.max(0, hits.length - 1);
        return Math.min(max, Math.max(0, s + delta));
      });
    },
    [hits.length],
  );

  const confirm = useCallback((): PaletteHit | null => {
    const hit = hits[selected] ?? null;
    setOpen(false);
    return hit;
  }, [hits, selected]);

  return {
    open,
    query,
    hits,
    selected,
    openPalette,
    closePalette,
    setQuery,
    move,
    confirm,
  };
}

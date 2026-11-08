// Hook do seletor genérico dos comandos (`/conversation`, `/notify`, `/task`, `/memory`…).
// Mesma mecânica dos outros pickers (↑↓ navega · enter escolhe · esc volta/fecha): a App
// captura as teclas e chama estes métodos; a apresentação é `<MenuPicker>`.
//
// Confirmar NÃO faz efeito aqui: devolve o que fazer (`run` args / `prefill` texto) e o
// chamador roda o MESMO `runCommand(comando, args)` que o usuário rodaria digitando.

import { useCallback, useRef, useState } from 'react';
import type { SlashCommand } from '../../slash/commands.js';
import { initialIndex, type MenuStep } from '../../slash/menu-pickers.js';

interface Frame {
  readonly step: MenuStep;
  readonly selected: number;
}

/** O que a App faz depois de `confirm()`. `null` ⇒ nada (abriu outro passo, ou lista vazia). */
export type MenuPick =
  | { readonly kind: 'run'; readonly command: SlashCommand; readonly args: readonly string[] }
  | { readonly kind: 'prefill'; readonly text: string }
  | { readonly kind: 'close' };

export interface MenuPickerController {
  readonly open: boolean;
  readonly loading: boolean;
  /** Passo corrente (`null` fechado). */
  readonly step: MenuStep | null;
  readonly selected: number;
  /** Profundidade (1 = primeiro passo; >1 ⇒ `esc` volta em vez de fechar). */
  readonly depth: number;
  /** Abre o seletor do `command` no passo dado (aceita Promise: mostra "carregando…"). */
  openFor(command: SlashCommand, step: MenuStep | Promise<MenuStep>): void;
  move(delta: number): void;
  /** Escolhe o item. Item→passo abre o passo (devolve `null`); folha devolve a ação e fecha. */
  confirm(): MenuPick | null;
  /** Esc: volta um passo; no primeiro, fecha. */
  back(): void;
  close(): void;
}

const LOADING: MenuStep = { title: 'carregando…', items: [] };

export function useMenuPicker(): MenuPickerController {
  const [command, setCommand] = useState<SlashCommand | null>(null);
  const [stack, setStack] = useState<readonly Frame[]>([]);
  const [loading, setLoading] = useState(false);
  // Token de abertura: uma Promise que volta depois de o usuário fechar/trocar é descartada.
  const token = useRef(0);

  const push = useCallback((stepOrP: MenuStep | Promise<MenuStep>, replace: boolean) => {
    const mine = ++token.current;
    const put = (step: MenuStep): void =>
      setStack((st) => {
        const frame = { step, selected: initialIndex(step) };
        return replace ? [frame] : [...st, frame];
      });
    if (stepOrP instanceof Promise) {
      setLoading(true);
      put(LOADING);
      void stepOrP.then(
        (step) => {
          if (token.current !== mine) return;
          setLoading(false);
          setStack((st) => [...st.slice(0, -1), { step, selected: initialIndex(step) }]);
        },
        () => {
          if (token.current !== mine) return;
          setLoading(false);
          setStack((st) => [
            ...st.slice(0, -1),
            { step: { title: 'não foi possível carregar a lista', items: [] }, selected: 0 },
          ]);
        },
      );
    } else {
      setLoading(false);
      put(stepOrP);
    }
  }, []);

  const close = useCallback(() => {
    token.current++;
    setStack([]);
    setCommand(null);
    setLoading(false);
  }, []);

  const openFor = useCallback(
    (cmd: SlashCommand, step: MenuStep | Promise<MenuStep>) => {
      setCommand(cmd);
      push(step, true);
    },
    [push],
  );

  const top = stack[stack.length - 1];

  const move = useCallback((delta: number) => {
    setStack((st) => {
      const f = st[st.length - 1];
      if (!f || f.step.items.length === 0) return st;
      const max = f.step.items.length - 1;
      const sel = Math.min(max, Math.max(0, f.selected + delta));
      return [...st.slice(0, -1), { ...f, selected: sel }];
    });
  }, []);

  const confirm = useCallback((): MenuPick | null => {
    if (!top || command === null || loading) return null;
    const item = top.step.items[top.selected];
    if (!item) {
      // lista vazia: Enter só fecha (a mensagem "vazio" já foi vista).
      close();
      return { kind: 'close' };
    }
    const o = item.outcome;
    if (o.kind === 'next') {
      push(o.step, false);
      return null;
    }
    const cmd = command;
    close();
    if (o.kind === 'run') return { kind: 'run', command: cmd, args: o.args };
    if (o.kind === 'prefill') return { kind: 'prefill', text: o.text };
    return { kind: 'close' };
  }, [top, command, loading, close, push]);

  const back = useCallback(() => {
    if (stack.length > 1) {
      token.current++;
      setLoading(false);
      setStack((st) => st.slice(0, -1));
    } else {
      close();
    }
  }, [stack.length, close]);

  return {
    open: stack.length > 0,
    loading,
    step: top?.step ?? null,
    selected: top?.selected ?? 0,
    depth: stack.length,
    openFor,
    move,
    confirm,
    back,
    close,
  };
}

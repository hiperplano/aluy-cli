// Hook do seletor de pasta do `/add-dir` (sem argumento). A App captura as teclas e chama estes
// métodos; a regra de navegação é `slash/dir-picker.ts` (pura) e a leitura de disco é injetada
// (`list`/`resolve`, assíncronas — nada bloqueia o render).
//
// Confirmar NÃO autoriza nada aqui: devolve `{command, path}` e a App roda o MESMO
// `runCommand(add-dir, path)` que o usuário digitaria.

import { useCallback, useRef, useState } from 'react';
import type { SlashCommand } from '../../slash/commands.js';
import {
  backspace as modelBackspace,
  enter as modelEnter,
  enterDir,
  goUp,
  move as modelMove,
  openState,
  resolveTyped,
  right as modelRight,
  startDir,
  typeText,
  withListing,
  type DirEffect,
  type DirPickerState,
} from '../../slash/dir-picker.js';
import type { DirListing } from '../../io/dir-listing.js';

export interface DirPickerPorts {
  readonly list: (dir: string) => Promise<DirListing>;
  /** Diretório canônico existente, ou `null`. */
  readonly resolve: (target: string) => Promise<string | null>;
}

export interface DirPick {
  readonly command: SlashCommand;
  readonly path: string;
}

export interface DirPickerController {
  readonly open: boolean;
  readonly state: DirPickerState | null;
  openFor(command: SlashCommand, roots: readonly string[], home?: string): void;
  type(text: string): void;
  backspace(): void;
  move(delta: number): void;
  left(): void;
  right(): void;
  /** Enter: devolve a pasta a adicionar, ou `null` (navegou/saltou/nada). */
  enter(): DirPick | null;
  close(): void;
}

export function useDirPicker(ports: DirPickerPorts): DirPickerController {
  const [state, setState] = useState<DirPickerState | null>(null);
  const ref = useRef<DirPickerState | null>(null);
  const cmd = useRef<SlashCommand | null>(null);
  const token = useRef(0);

  const put = useCallback((next: DirPickerState | null): void => {
    ref.current = next;
    setState(next);
  }, []);

  const load = useCallback(
    (path: string): void => {
      const mine = ++token.current;
      void ports.list(path).then(
        (l) => {
          if (token.current !== mine || ref.current === null) return;
          put(withListing(ref.current, l));
        },
        () => {
          if (token.current !== mine || ref.current === null) return;
          put(withListing(ref.current, { path, entries: [], overflow: 0, error: 'denied' }));
        },
      );
    },
    [ports, put],
  );

  const apply = useCallback(
    (effect: DirEffect): DirPick | null => {
      const s = ref.current;
      if (s === null) return null;
      if (effect.kind === 'cd') {
        put(enterDir(s, effect.path, effect.select));
        load(effect.path);
        return null;
      }
      if (effect.kind === 'jump') {
        const target = resolveTyped(effect.input, s.cwd, s.home);
        const mine = ++token.current;
        void ports.resolve(target).then((real) => {
          if (token.current !== mine || ref.current === null) return;
          if (real === null) {
            put({ ...ref.current, notice: `não existe: ${effect.input}` });
            return;
          }
          put(enterDir(ref.current, real));
          load(real);
        });
        return null;
      }
      if (effect.kind === 'add') {
        const command = cmd.current;
        token.current++;
        ref.current = null;
        cmd.current = null;
        setState(null);
        return command !== null ? { command, path: effect.path } : null;
      }
      return null;
    },
    [ports, put, load],
  );

  const openFor = useCallback(
    (command: SlashCommand, roots: readonly string[], home?: string): void => {
      cmd.current = command;
      const primary = roots[0] ?? process.cwd();
      const start = startDir(primary);
      const select =
        start === primary ? undefined : primary.slice(start.length).replace(/^[/\\]/, '');
      put(openState(start, roots, home, select));
      load(start);
    },
    [put, load],
  );

  const close = useCallback((): void => {
    token.current++;
    cmd.current = null;
    put(null);
  }, [put]);

  return {
    open: state !== null,
    state,
    openFor,
    type: (text) => {
      if (ref.current !== null) put(typeText(ref.current, text));
    },
    backspace: () => {
      if (ref.current === null) return;
      const r = modelBackspace(ref.current);
      put(r.state);
      apply(r.effect);
    },
    move: (delta) => {
      if (ref.current !== null) put(modelMove(ref.current, delta));
    },
    left: () => {
      if (ref.current !== null) apply(goUp(ref.current));
    },
    right: () => {
      if (ref.current !== null) apply(modelRight(ref.current));
    },
    enter: () => (ref.current === null ? null : apply(modelEnter(ref.current))),
    close,
  };
}

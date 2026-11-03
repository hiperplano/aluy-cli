// REDESENHO SEM SOBRA — DECAWM (`?7`), o auto-wrap do terminal.
//
// CAUSA-RAIZ (provada em tmux, 80×24, sessão retomada): o Ink/log-update apaga a região
// viva com `eraseLines(N)`, onde N vem da medição do Ink (`string-width`: emoji ZWJ, tom de
// pele, bandeira, keycap contam 2). O TERMINAL, porém, mede por conta própria — e os
// terminais DISCORDAM (tmux/xterm contam `👍🏽` = 4; wezterm = 2). Quando o terminal acha uma
// linha MAIS LARGA que o Ink, ele QUEBRA a linha (auto-wrap) numa linha física A MAIS: a
// região viva fica N+1 linhas na tela, o erase de N linhas deixa o TOPO (a linha de trabalho
// `Λ Alinhando… (preparando)`) para trás, e cada quadro seguinte empilha mais lixo (linhas
// em branco / `┃ Λluy` repetido no scrollback).
//
// FIX: desligar o auto-wrap (`\x1b[?7l`) enquanto a TUI está de pé. Sem wrap, uma linha que
// o terminal julga larga demais é TRUNCADA na última coluna em vez de ganhar uma linha
// física — o nº de linhas físicas passa a ser SEMPRE o nº de linhas que o Ink emitiu, por
// construção, não importa qual tabela de largura o terminal usa. O custo é visual e mínimo
// (a cauda de uma linha mal medida é cortada na borda; o Ink já quebra no limite dele).
// Restaurado (`?7h`) em TODO caminho de término. Escape-hatch: `ALUY_AUTOWRAP=1`.

import type { PasteModeStream } from './bracketed-paste.js';

/** `\x1b[?7l` — desliga o auto-wrap (linha longa trunca na borda em vez de quebrar). */
export const DISABLE_AUTOWRAP = '\x1b[?7l';
/** `\x1b[?7h` — religa o auto-wrap (restauração). */
export const ENABLE_AUTOWRAP = '\x1b[?7h';

/** Default ON; `ALUY_AUTOWRAP=1` mantém o auto-wrap do terminal (comportamento antigo). */
export function noAutowrapEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ALUY_AUTOWRAP !== '1';
}

export interface AutowrapController {
  /** Religa o auto-wrap UMA vez (idempotente). */
  restore(): void;
}

/** Desliga o auto-wrap e devolve o `restore()` idempotente. Best-effort: nunca lança. */
export function disableAutowrap(stream: PasteModeStream, enabled = true): AutowrapController {
  if (!enabled) return { restore: () => undefined };
  try {
    stream.write(DISABLE_AUTOWRAP);
  } catch {
    /* stream fechado — nada a fazer */
  }
  let done = false;
  return {
    restore(): void {
      if (done) return;
      done = true;
      try {
        stream.write(ENABLE_AUTOWRAP);
      } catch {
        /* saída já fechada no exit */
      }
    },
  };
}

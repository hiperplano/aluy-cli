// Instrumentação OPCIONAL do render (`ALUY_DEBUG_RENDER`) — p/ diagnosticar o flicker
// "milenar" relatado no Windows: "sessão cheia + `/` → carrega TUDO de novo". Não
// reproduzível no Linux, então logamos os GATILHOS do repaint num ARQUIVO (nunca no
// stdout — corromperia a TUI): remount do `<Static>` (clearScreen/staticKey), o effect
// de resize (mudança de dimensão — a hipótese do conhost reflowando ao escrever output)
// e o toggle do slash-menu (p/ correlacionar `/` com o repaint).
//
// OFF por default (`ALUY_DEBUG_RENDER` ausente ⇒ custo ZERO, nenhuma escrita). Liga com
// `ALUY_DEBUG_RENDER=1`; o log vai p/ `~/.aluy/render-debug.log`. O usuário roda 1 sessão,
// reproduz o `/`, e manda o arquivo — aí o gatilho real fica VISÍVEL (resize? remount?).

import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `ALUY_DEBUG_RENDER` setado e não-falsy. */
export function debugRenderEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.ALUY_DEBUG_RENDER;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

let cachedPath: string | undefined;

/** Append best-effort de uma linha ao log de debug (no-op quando desligado). NUNCA lança. */
export function debugRenderLog(msg: string): void {
  if (!debugRenderEnabled()) return;
  try {
    if (cachedPath === undefined) cachedPath = join(homedir(), '.aluy', 'render-debug.log');
    appendFileSync(cachedPath, `${new Date().toISOString()} ${msg}\n`);
  } catch {
    // best-effort: a instrumentação NUNCA pode quebrar o render.
  }
}

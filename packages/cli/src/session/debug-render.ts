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

// ── MÉTRICA POR QUADRO (`ALUY_DEBUG_RENDER`) — fantasma de quadro ───────────────────────────────
// O Ink apaga `previousLineCount` linhas antes de cada quadro. Se uma linha do quadro é MAIS LARGA
// que o terminal (o terminal a quebra em 2 linhas físicas e o Ink conta 1), o próximo apagamento
// fica 1 linha curto e o topo do quadro anterior vira "fantasma" no histórico (a frase de trabalho
// repetida). Aqui, por escrita do Ink: quantas linhas o Ink conta × quantas linhas FÍSICAS o
// terminal ocupa (largura por `string-width`, a mesma conta do Ink), o `eraseLines` que veio e a
// maior largura. Pura; o log grava só tamanhos e um trecho curto da linha suspeita.
import stringWidth from 'string-width';

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

export interface FrameMetrics {
  /** Linhas que o Ink conta no quadro (separadas por `\n`, sem a final vazia). */
  readonly inkLines: number;
  /** Linhas FÍSICAS no terminal de `columns` colunas (cada linha larga demais ocupa várias). */
  readonly physicalRows: number;
  readonly maxWidth: number;
  /** Linhas do quadro que passam de `columns` (índice + trecho), as que causam o fantasma. */
  readonly overwide: readonly {
    readonly index: number;
    readonly width: number;
    readonly text: string;
  }[];
}

export function frameMetrics(frame: string, columns: number): FrameMetrics {
  const lines = frame.replace(ANSI_RE, '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  let physical = 0;
  let maxWidth = 0;
  const overwide: { index: number; width: number; text: string }[] = [];
  lines.forEach((l, index) => {
    const w = stringWidth(l);
    maxWidth = Math.max(maxWidth, w);
    physical += Math.max(1, Math.ceil(w / Math.max(1, columns)));
    if (w > columns) overwide.push({ index, width: w, text: l.slice(0, 40) });
  });
  return { inkLines: lines.length, physicalRows: physical, maxWidth, overwide };
}

/** Uma linha de log por escrita do Ink no inline: `kind`, erase pedido, métricas e aviso de divergência. */
export function debugFrameWrite(
  kind: string,
  eraseLines: number | undefined,
  body: string,
  columns: number | undefined,
): void {
  if (!debugRenderEnabled()) return;
  const cols = columns ?? 80;
  const m = frameMetrics(body, cols);
  const diverge = m.physicalRows !== m.inkLines;
  debugRenderLog(
    `frame ${kind} erase=${eraseLines ?? '-'} ink=${m.inkLines} fisicas=${m.physicalRows} maxW=${m.maxWidth} cols=${cols}${diverge ? ' DIVERGE' : ''}${m.overwide.length > 0 ? ` largas=${JSON.stringify(m.overwide.slice(0, 3))}` : ''}`,
  );
}

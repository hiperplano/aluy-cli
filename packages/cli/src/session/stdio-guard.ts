// GUARDA DE STDIO ENQUANTO A TUI ESTÁ DE PÉ.
//
// O Ink apaga o quadro anterior com `cursor-up N-1` RELATIVO. Qualquer `process.stderr.write` /
// `console.log` / `process.stdout.write` de texto puro que caia no TTY por fora do Ink (o aviso de
// yolo de cada tarefa, `[headroom] …`, `aluy: MCP — …`, `console.warn` de uma lib) desloca a tela
// em 1 linha: o erase seguinte fica 1 curto e o topo do quadro (a frase de trabalho) vira
// fantasma no histórico, um por escrita. Aqui essas escritas viram NOTAS na transcrição (com
// dedup), em vez de tocar o TTY.
//
// O que NÃO é interceptado: escritas do próprio Ink (passam por um writer cru, capturado antes do
// patch — ver `run.tsx`) e escritas de stdout com sequências de controle (ESC): título, alt-screen,
// bracketed paste, autowrap… são do app. Restaurado no unmount/exit.

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');

let appDepth = 0;
/**
 * Escrita do PRÓPRIO app no TTY (o render do Ink, via `wrapStdoutWithSync`): passa direto pela guarda.
 * Tudo que não passa por aqui, enquanto a guarda está instalada, vira nota.
 */
export function appWrite(stream: NodeJS.WriteStream, ...args: unknown[]): boolean {
  appDepth += 1;
  try {
    return (stream.write as (...a: unknown[]) => boolean)(...args);
  } finally {
    appDepth -= 1;
  }
}

export interface StdioGuard {
  restore(): void;
}

type WriteFn = typeof process.stdout.write;

export function installStdioGuard(opts: {
  /** Recebe cada linha (sem ANSI, sem repetição) que ia direto ao TTY. */
  readonly onLine: (line: string) => void;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}): StdioGuard {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const origOut = out.write;
  const origErr = err.write;
  const vistas = new Set<string>();
  const emit = (text: string): void => {
    for (const raw of text.replace(ANSI_RE, '').split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || vistas.has(line)) continue;
      vistas.add(line);
      try {
        opts.onLine(line);
      } catch {
        /* a guarda nunca derruba o app */
      }
    }
  };
  const toText = (chunk: unknown): string =>
    typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
  const done = (enc: unknown, cb: unknown): void => {
    const f = typeof enc === 'function' ? enc : cb;
    if (typeof f === 'function') (f as () => void)();
  };
  const patched = (orig: WriteFn, stream: NodeJS.WriteStream, onlyPlain: boolean): WriteFn =>
    ((chunk: unknown, enc?: unknown, cb?: unknown): boolean => {
      if (appDepth > 0) return (orig as (...a: unknown[]) => boolean).call(stream, chunk, enc, cb);
      const text = toText(chunk);
      // stdout com sequência de controle = escrita do app (título, modos do terminal): passa.
      if (onlyPlain && text.includes(ESC)) {
        return (orig as (...a: unknown[]) => boolean).call(stream, chunk, enc, cb);
      }
      emit(text);
      done(enc, cb);
      return true;
    }) as WriteFn;
  out.write = patched(origOut, out, true);
  err.write = patched(origErr, err, false);
  let restored = false;
  return {
    restore(): void {
      if (restored) return;
      restored = true;
      out.write = origOut;
      err.write = origErr;
    },
  };
}

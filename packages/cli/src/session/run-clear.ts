// EST-0948 / EST-0989 — BOOT numa tela LIMPA (extraído de run.tsx p/ ser importável
// pelo splash-controller SEM ciclo: run.tsx importa o splash, o splash importa este).
//
// Emite o MESMO clear de TELA + SCROLLBACK que o `/clear` usa (`App.tsx`/`clearScreen`):
// `\x1b[2J` apaga a tela visível, `\x1b[3J` o scrollback e `\x1b[H` recoloca o cursor
// no topo. Chamado no STARTUP (antes de montar o Ink) E na TRANSIÇÃO splash→TUI (p/ não
// deixar o miolo do splash preso no scrollback — anti-fantasma EST-0965/#118).
//
// GATE: só emite no TTY interativo (`isTty`). Em piped/scripted/CI (não-TTY) é NO-OP —
// a saída linear fica limpa p/ pipe/CI e nada de ANSI vaza. NÃO usa o alternate-screen
// buffer (`\x1b[?1049h`): a tela fica limpa MAS a conversa persiste no scrollback normal
// após sair (como hoje).

export function emitBootClear(stdout: NodeJS.WriteStream, isTty: boolean): void {
  if (!isTty) return;
  stdout.write('\x1b[2J\x1b[3J\x1b[H');
}

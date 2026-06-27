// EST-1015 (🔴 fix do composer "morto") — REATA o stdin antes do Ink da App montar. PURO/
// testável (sem Ink, sem render).
//
// O Ink lê o teclado via `stdin.addListener('readable', …)` + `stdin.read()` e NUNCA chama
// `stdin.resume()`: confia que o evento `readable` re-arma o reader do libuv. Mas ao montar a
// App o stdin já passou por PAUSAS — em especial o cleanup do `queryTerminalBrightness` (osc11,
// auto-detecção de tema) faz `setRawMode(false)`+`pause()`, deixando o reader DORMENTE. Sem um
// `resume()` explícito, anexar o `readable` não dispara e NENHUMA tecla chega à App (composer
// não digita nada — repro real em Linux com um terminal que RESPONDE à osc11, ex.: tmux).
//
// O fix ORIGINAL chamava `resume()` SÓ em win32 (a suposição "Linux/Mac se recupera sozinho" é
// FALSA). Aqui reatamos em QUALQUER TTY. Idempotente e sem perda: roda no BOOT (ninguém digitou
// ainda) e o Ink, ao montar logo a seguir, troca p/ paused-mode ao anexar o `readable`.

/** O mínimo do stdin que precisamos (facilita o mock no teste). */
export interface RearmableStdin {
  readonly isTTY?: boolean;
  resume?: () => void;
}

/**
 * Reata (`resume`) o stdin se ele for um TTY — em TODA plataforma (NÃO só win32). Devolve
 * `true` se reatou. Não-TTY (pipe/redireção) ⇒ no-op (`false`): não há reader a reativar e o
 * caminho não-interativo (linear) não usa o teclado. `resume` ausente/lançando ⇒ best-effort.
 */
export function rearmStdinForInk(stdin: RearmableStdin): boolean {
  if (stdin.isTTY !== true || typeof stdin.resume !== 'function') return false;
  try {
    stdin.resume();
    return true;
  } catch {
    return false; // best-effort — em estado válido o Ink assume a partir daqui.
  }
}

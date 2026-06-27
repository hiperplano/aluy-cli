// EST-0948 · spec §3.6 / handoff §10.1 — useTick(): o ÚNICO tick central da TUI.
//
// O eixo 2 ("vivo") mora aqui. Em vez de espalhar `setInterval` por componente
// (não-testável, dessincronizado), a App monta UM hook que incrementa um contador
// de `frame` num intervalo fixo e re-renderiza. Cada componente animado recebe
// `frame` por PROP e é PURO (`frame % n`) — assim os testes passam um `frame`
// fixo, sem timers reais (handoff §10.1 regra 3 / DoD).
//
// Desligado quando `enabled === false` (deriva de `theme.animate` E `isTTY`):
//   - `ALUY_NO_ANIM`/`--no-anim`/`NO_COLOR`-reduced-motion ⇒ theme.animate=false;
//   - saída piped/CI (não-TTY) ⇒ sem animação (a App nem monta a TUI Ink).
// Quando desligado, o frame fica CONGELADO em 0 — os componentes caem no fallback
// estático (onda parada, braille→◷, cursor/◇ sólidos). NENHUM significado se perde
// (o verbo vivo ao lado carrega o sentido — a11y §6).

import { useEffect, useState } from 'react';

/** Cadência default do tick (ms). ~120ms ⇒ ~8fps, "suave" (spec §3.6). */
export const DEFAULT_TICK_MS = 120;

export interface UseTickOptions {
  /** Liga o tick. Default `true`. `false` ⇒ frame congela em 0 (fallback). */
  readonly enabled?: boolean;
  /** Intervalo entre frames (ms). Default `DEFAULT_TICK_MS`. */
  readonly intervalMs?: number;
}

/**
 * Devolve o `frame` corrente (inteiro crescente). Re-renderiza a cada `intervalMs`
 * enquanto `enabled`. Limpa o timer ao desmontar / quando desliga. Quando
 * `enabled=false`, retorna `0` estável e NÃO arma timer (custo zero, determinístico
 * em não-TTY/reduced-motion).
 */
export function useTick(opts: UseTickOptions = {}): number {
  const enabled = opts.enabled ?? true;
  const intervalMs = opts.intervalMs ?? DEFAULT_TICK_MS;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setFrame((f) => f + 1), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);

  return enabled ? frame : 0;
}

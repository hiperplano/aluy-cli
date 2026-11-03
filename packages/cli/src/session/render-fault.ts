// Falhas de RENDER/LAYOUT do Yoga-wasm (ver `ink-root-guard.tsx` p/ a causa-raiz): detecção
// restrita + barramento p/ a App voltar ao inline em vez de morrer. PURO, sem React.

type FaultListener = (err: unknown) => void;
const faultListeners = new Set<FaultListener>();

/** A App assina p/ voltar ao inline quando o render do Ink lança. Devolve o `unsubscribe`. */
export function onRenderFault(listener: FaultListener): () => void {
  faultListeners.add(listener);
  return () => {
    faultListeners.delete(listener);
  };
}

/**
 * Esta exceção é uma falha de RENDER/LAYOUT do Yoga-wasm (e não um bug de lógica nossa)?
 * Restrito de propósito: só `RuntimeError` do wasm (`memory access out of bounds`,
 * `unreachable`…) cuja pilha passa pelo Yoga/renderer do Ink. Qualquer outra coisa segue
 * crashando normalmente (não mascaramos erro de verdade).
 */
export function isYogaRenderFault(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const stack = err.stack ?? '';
  const wasm = err.name === 'RuntimeError' || /wasm:\/\//u.test(stack);
  return wasm && /yoga|ink[\\/]build[\\/](renderer|ink|render-node)/iu.test(stack);
}

/** Avisa os ouvintes (a App volta pro inline). Nunca lança. */
export function notifyRenderFault(err: unknown): void {
  for (const l of [...faultListeners]) {
    try {
      l(err);
    } catch {
      /* o ouvinte nunca derruba o render */
    }
  }
}

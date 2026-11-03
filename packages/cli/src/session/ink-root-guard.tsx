// CRASH `RuntimeError: memory access out of bounds` em `getComputedWidth` (achado do dono, ao
// entrar no /fullscreen e mandar uma mensagem numa sessão retomada).
//
// CAUSA-RAIZ — o Ink guarda o `<Static>` em `rootNode.staticNode` (reconciler.js,
// `finalizeInitialChildren`) e NUNCA limpa essa referência quando o `<Static>` sai da árvore
// (`removeChild*` só chama `cleanupYogaNode` ⇒ `freeRecursive()` no wasm). A App só tem
// `<Static>` no modo INLINE: ao entrar no cockpit (tela cheia, `return <Cockpit/>` sem Static)
// o Static é desmontado, o Yoga libera a memória dele (e de TODOS os blocos de histórico
// dentro) e `rootNode.staticNode` fica APONTANDO PARA MEMÓRIA LIBERADA. A cada frame, o
// `renderer.js:13` chama `staticNode.yogaNode.getComputedWidth()` nesse ponteiro morto
// (use-after-free no wasm). Normalmente lê lixo em silêncio; quando o alocador já reaproveitou
// aquela região (sessão retomada longa ⇒ muitos nós liberados + frame novo após enviar a
// mensagem) o acesso cai fora da memória e o processo morre. Daí a não reprodutibilidade em
// sessões curtas.
//
// CORREÇÃO — este guard troca `rootNode.staticNode` por um acessor que só devolve o nó se ele
// ainda está PENDURADO na árvore viva (cadeia de `parentNode` chega ao `ink-root`); senão
// devolve `undefined` e o Ink pula o bloco do Static. Defesa extra: o render imediato do Ink
// (que roda num timer, fora do alcance de qualquer error boundary do React) é envolvido num
// try/catch — se mesmo assim lançar, registramos no crash.log e avisamos a App (que volta pro
// inline com uma nota) em vez de matar o processo.
import React, { useEffect, useRef } from 'react';
import { Box, type DOMElement } from 'ink';
import { appendFatalLog } from '../bin/fatal-log.js';
import { isYogaRenderFault, notifyRenderFault } from './render-fault.js';

/** Subconjunto dos campos INTERNOS do nó raiz do Ink que o guard toca. */
interface InkRootInternals {
  nodeName?: string;
  parentNode?: unknown;
  staticNode?: unknown;
  onImmediateRender?: () => void;
  __aluyGuarded?: boolean;
}

/** Sobe a cadeia `parentNode` até o `ink-root` (ou `undefined` se o nó está solto). */
export function findInkRoot(node: unknown): InkRootInternals | undefined {
  let cur = node as InkRootInternals | undefined;
  let guard = 0;
  while (cur !== undefined && cur.parentNode !== undefined && guard++ < 10_000) {
    cur = cur.parentNode as InkRootInternals;
  }
  return cur?.nodeName === 'ink-root' ? cur : undefined;
}

/** O nó está pendurado na árvore viva do `root` (cadeia de pais chega a ele)? */
export function isAttachedTo(node: unknown, root: unknown): boolean {
  let cur = node as InkRootInternals | undefined;
  let guard = 0;
  while (cur !== undefined && guard++ < 10_000) {
    if (cur === root) return true;
    cur = cur.parentNode as InkRootInternals | undefined;
  }
  return false;
}

/**
 * Instala o guard no nó raiz (idempotente). Devolve `true` se instalou agora.
 * Exportada p/ teste.
 */
export function installInkRootGuard(root: InkRootInternals): boolean {
  if (root.__aluyGuarded === true) return false;
  root.__aluyGuarded = true;

  // 1) `staticNode` só vale se ainda está na árvore viva.
  let current: unknown = root.staticNode;
  Object.defineProperty(root, 'staticNode', {
    configurable: true,
    enumerable: true,
    get(): unknown {
      if (current !== undefined && !isAttachedTo(current, root)) return undefined;
      return current;
    },
    set(v: unknown) {
      current = v;
    },
  });

  // 2) render imediato do Ink: nunca deixa uma exceção do layout/render matar o processo.
  const original = root.onImmediateRender;
  if (typeof original === 'function') {
    root.onImmediateRender = function guardedRender(this: unknown): void {
      try {
        original.call(this);
      } catch (err) {
        if (!isYogaRenderFault(err)) throw err;
        appendFatalLog('render-recuperado', err);
        notifyRenderFault(err);
      }
    };
  }
  return true;
}

/**
 * Componente sentinela: monte UMA vez na raiz da árvore. Renderiza um `<Box display="none">`
 * (não ocupa linha — nada de Box de altura 0) só p/ obter o `ink-root` via `ref` e instalar o
 * guard acima.
 */
export function InkRootGuard(): React.ReactElement {
  const ref = useRef<DOMElement>(null);
  useEffect(() => {
    const root = findInkRoot(ref.current);
    if (root !== undefined) installInkRootGuard(root);
  }, []);
  return <Box ref={ref} display="none" />;
}

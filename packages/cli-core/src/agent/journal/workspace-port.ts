// EST-0960a · ADR-0056 §4/R8 — porta MÍNIMA de confinamento de workspace que a
// restauração do journal consome. É a MESMA forma do `WorkspacePort` concreto do
// @aluy/cli (EST-0948, `NodeWorkspace`): resolve+canonicaliza um path contra a
// raiz e LANÇA se escapa (`..`/symlink/absoluto-fora). Declaramos a interface
// AQUI (portável) p/ o core não depender do concreto — o @aluy/cli injeta o
// `NodeWorkspace`, que já a satisfaz estruturalmente.
//
// R8/TOCTOU: a restauração resolve o alvo por ESTA porta NO MOMENTO DA ESCRITA —
// não confia no path gravado na captura. Um symlink trocado entre snapshot e
// restauração é resolvido (e rejeitado) aqui, não desvia a escrita p/ fora.

/** Confinamento de workspace consumido pela restauração (subset de EST-0948). */
export interface WorkspacePort {
  /** Raiz canonicalizada do workspace. */
  readonly root: string;
  /**
   * Resolve+canonicaliza `requested` contra a raiz. LANÇA se escapa. Devolve o
   * path absoluto seguro p/ a escrita de restauração.
   */
  resolveInside(requested: string): string;
  /** `true` se `requested` resolve p/ dentro da raiz (não lança). */
  contains(requested: string): boolean;
}

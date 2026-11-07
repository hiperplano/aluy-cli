// AVISO HONESTO de memória semântica indisponível (mem0 fora do ar no boot).
//
// A leitura da memória é fail-open (CA-MA8): sem o mem0 a sessão segue — e o dono não via
// NADA, só um `✗` de um caractere no rodapé. Esta nota diz, UMA vez por processo, o que
// houve, que os dados estão a salvo e como religar. O boot roda ANTES da TUI existir, então
// o aviso fica retido num slot e é entregue quando a TUI se inscreve (ou imediatamente, se
// já havia inscrito). Sem spam: entrega única por processo.

export function semanticMemoryDownLines(reason: string): string[] {
  return [
    `memória semântica indisponível nesta sessão (${reason}).`,
    'seus dados NÃO foram tocados — continuam em ~/.aluy/memory; os fatos de `remember` seguem valendo.',
    'para religar: abra o Ollama e reabra o aluy, ou rode /doctor fix.',
  ];
}

let held: readonly string[] | undefined;
let delivered = false;
let listener: ((lines: readonly string[]) => void) | undefined;

/** Registra o aviso (idempotente: só o 1º vale; nada após a entrega). */
export function noticeSemanticMemoryDown(
  reason: string,
  opts: { readonly headless?: boolean } = {},
): void {
  if (delivered || held !== undefined) return;
  if (opts.headless === true) {
    // Sem TTY o stderr é o único canal (a TUI não existe para receber a nota).
    delivered = true;
    process.stderr.write(`aluy: ${semanticMemoryDownLines(reason)[0]}\n`);
    return;
  }
  held = semanticMemoryDownLines(reason);
  flush();
}

/** A TUI/linear se inscreve; recebe o aviso retido agora ou quando ele chegar. */
export function onSemanticMemoryNotice(cb: (lines: readonly string[]) => void): () => void {
  listener = cb;
  flush();
  return () => {
    if (listener === cb) listener = undefined;
  };
}

function flush(): void {
  if (held === undefined || listener === undefined || delivered) return;
  delivered = true;
  const lines = held;
  held = undefined;
  try {
    listener(lines);
  } catch {
    /* best-effort */
  }
}

/** Só p/ teste. */
export function __resetSemanticMemoryNotice(): void {
  held = undefined;
  delivered = false;
  listener = undefined;
}

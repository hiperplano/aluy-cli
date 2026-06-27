// ADR-0126(C — pedido do dono) — ESC durante o turno: REDIRECIONAR vs PARAR.
//
// Antes, ESC durante o trabalho = `interrupt()` + `clearQueue()` (aborta o turno E DESCARTA
// o que o usuário tinha no composer). O dono: "quando tenho uma msg pendente e aperto ESC,
// não deveria parar — deveria colocar minha msg na frente e processar". Então:
//
//   • ESC com TEXTO no composer  ⇒ REDIRECIONAR: ENCAIXA o texto no agente vivo (injeta —
//     o agente o vê na PRÓXIMA iteração e decide o rumo; NÃO aborta o turno à força). Um
//     `/ask <q>` vira a PERGUNTA `<q>` injetada como mensagem REAL (prioriza, não read-only).
//   • ESC com composer VAZIO     ⇒ PARAR (abort + clear), como antes (memória de músculo).
//
// PURO/testável: só a DECISÃO. O efeito (injectInput/interrupt/clearQueue) fica no handler
// da TUI (App.tsx). Sem Ink/IO.

/** A ação que o ESC deve tomar, dado o texto pendente no composer. */
export type EscAction =
  | { readonly kind: 'redirect'; readonly inject: string } // encaixa `inject` no agente vivo
  | { readonly kind: 'stop' }; // abort + clear (parada pura)

// `/ask` como COMANDO: o `/ask` seguido de espaço OU fim (não casa `/asking`/`/askfoo`).
const IS_ASK_RE = /^\/ask(?=\s|$)/i;
const ASK_STRIP_RE = /^\/ask\s*/i;

/**
 * Decide o que o ESC faz a partir do texto JÁ EXPANDIDO do composer (chips expandidos):
 *  - vazio/whitespace ⇒ `stop` (parada pura);
 *  - `/ask <q>` ⇒ `redirect` injetando `<q>` (a pergunta vira objetivo real, priorizada);
 *    `/ask` SOZINHO (sem pergunta) ⇒ `stop` (nada a injetar);
 *  - qualquer outro texto ⇒ `redirect` injetando o texto como está.
 * PURO.
 */
export function decideEscAction(composerText: string): EscAction {
  const text = composerText.trim();
  if (text === '') return { kind: 'stop' };
  if (IS_ASK_RE.test(text)) {
    const q = text.replace(ASK_STRIP_RE, '').trim();
    return q === '' ? { kind: 'stop' } : { kind: 'redirect', inject: q };
  }
  return { kind: 'redirect', inject: text };
}

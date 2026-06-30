// BUG-A (task #16) — VAZAMENTO de sequências de escape como TEXTO LITERAL no composer.
//
// O bug (QA): com um terminal que emite shift+enter via CSI-u (kitty, `\x1b[13;2u`) ou
// modifyOtherKeys (xterm, `\x1b[27;2;13~`) SEM o aluy ter negociado o protocolo, o ESC é
// engolido pelo Ink mas a CAUDA da sequência (`[13;2u` / `[27;2;13~`) ENTRA NO BUFFER como
// texto: `› AAA[13;2uBBB●`. Suja silenciosamente o objetivo enviado.
//
// CAUSA-RAIZ (medida no parse-keypress do Ink): o Ink lê o chunk inteiro via `stdin.read()`
// e o entrega ao `useInput` num evento só. O `parseKeypress` tenta casar a sequência com o
// seu `fnKeyRe`; quando NÃO reconhece (ex.: CSI-u terminador `u`, ou o duplo `;` do
// modifyOtherKeys), devolve a `sequence` CRUA e o `useInput` só TIRA o 1º `\x1b`
// (`input.slice(1)`) — restando o tail `[13;2u`, que o `applyTypedChunk` insere no composer.
//
// As sequências que o Ink RECONHECE (setas com modificador `\x1b[1;2A`, ctrl-seta
// `\x1b[1;5C`, `\x1b[3;5~`, SS3 `\x1bO2P`, F-keys) já viram `input=''` (não vazam). Os
// marcadores de bracketed-paste (`[200~`/`[201~` mangled) são tratados ANTES, pelo
// `gateInputPaste`. Sobram exatamente as sequências CSI/SS3 NÃO-reconhecidas — é o que
// este filtro engole.
//
// O FILTRO (escopo do bug): detecta, do lado do `useInput`, um `char` que é o CORPO
// COMPLETO de uma sequência CSI/SS3 com o `\x1b` já tirado pelo Ink — `[`/`O` + parâmetros
// + um byte FINAL ([A-Za-z~^$@]) — e SUPRIME (não insere no composer). Um `[` ou `O`
// DIGITADO sozinho chega como char de comprimento 1 SEM byte final ⇒ NÃO casa, NÃO é
// engolido (a digitação normal de `[` segue intacta). Em raw mode cada tecla digitada é um
// evento próprio; a única forma de um corpo de sequência inteiro chegar num char só é uma
// sequência de escape (paste real já vem envelopado por `?2004`).
//
// ALTERNATIVA AVALIADA (negociar o CSI-u no boot — `\x1b[>1u` no boot, `\x1b[<u` no
// cleanup): resolveria TAMBÉM o shift+enter→newline DIGITADO, mas mexe no estado do
// terminal (restauração em todo caminho de término, interação com paste/F8/HOME-END no
// canal cru) — maior e mais arriscado. Fica documentada como evolução (ADR); aqui só o
// filtro do vazamento, que é o escopo do bug.
//
// ESCOPO/SEGURANÇA: só descarta bytes de input do terminal (`@hiperplano/aluy-cli`). Não
// toca engine, catraca, egress, broker nem auth. Puro e determinístico — testável sem TTY.

/**
 * O `char` que o `useInput` recebe é o CORPO de uma sequência CSI/SS3 NÃO-reconhecida pelo
 * Ink (o `\x1b` inicial já foi tirado)? Casa:
 *   · CSI: `[` + parâmetros (`0-9 ; : < > ?`) + 1 byte FINAL (`A-Za-z ~ ^ $ @`).
 *   · SS3: `O` + (intermediário opcional) + 1 byte FINAL.
 * Exige comprimento ≥ 2 (introdutor + final) ⇒ um `[`/`O` DIGITADO sozinho (len 1) NÃO casa.
 *
 * Por que casa o VAZAMENTO e não a digitação:
 *   · `[13;2u`   → `[` + `13;2` + `u`        ⇒ true  (CSI-u shift+enter, kitty)
 *   · `[27;2;13~`→ `[` + `27;2;13` + `~`     ⇒ true  (modifyOtherKeys)
 *   · `[`        → só o introdutor, sem final ⇒ false (digitação normal de `[`)
 *   · `O`        → idem                       ⇒ false
 *   · `[200~`    → casaria, MAS o `gateInputPaste` trata o paste ANTES deste filtro.
 *
 * PURO. NÃO depende de estado — o `char` já carrega a sequência inteira (o Ink entrega o
 * chunk do `read()` de uma vez), então não há cauda a rastrear entre eventos.
 */
const CSI_SS3_BODY = /^(?:\[[0-9;:<>?]*|O[0-9;:<>?]*[ -/]*)[A-Za-z~^$@]$/;

export function isUnrecognizedEscapeTail(char: string): boolean {
  // Comprimento ≥ 2 (introdutor + 1 byte final): exclui o `[`/`O` digitado sozinho.
  if (char.length < 2) return false;
  if (char[0] !== '[' && char[0] !== 'O') return false;
  return CSI_SS3_BODY.test(char);
}

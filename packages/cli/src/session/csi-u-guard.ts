// task #18 (🔴 CRASH — DERRUBA o app) — sequência CSI-u de tecla FUNCIONAL do kitty
// keyboard protocol (ex.: `\x1b[57414u`) faz o Ink CRASHAR.
//
// O CRASH (achado pelo QA): com um terminal kitty-kbd (ou que emita CSI-u de tecla
// funcional) o byte `\x1b[57414u` chega ao Ink. O `parseKeypress` do Ink, p/ essa
// sequência, casa o `fnKeyRe` no ramo `(\d+)?([a-zA-Z])` ⇒ `code='[u'`, `name=undefined`
// e, como `modifier = 57414-1 = 57413` tem o bit 2, `ctrl=true`. Então o `use-input.js`:
//   `let input = keypress.ctrl ? keypress.name : keypress.sequence;`  → input = undefined
//   `if (input.startsWith('')) …`                              → CRASH (TypeError)
// O processo cai com `Cannot read properties of undefined (reading 'startsWith')` —
// `use-input.js:73`. O swallow benigno do rc.48 (alt-screen onCrash + isBenignNetworkAbort)
// NÃO pega isto: é TypeError de LÓGICA, não socket abortado.
//
// O FIX (escopo MÍNIMO, NÃO mascara — abordagem (a) do brief): a sequência precisa NÃO
// chegar ao `parseKeypress` do Ink. O Ink lê o teclado via `stdin.read()` num laço sobre
// `'readable'`; ANTES de o chunk chegar ao `parseKeypress`, FILTRAMOS dele toda sequência
// CSI-u (`\x1b[` + params + terminador `u`) — a família INTEIRA do kitty-kbd protocol, que
// o Ink não sabe tratar (todas ou crasham, ou vazariam cauda). O `\x1b[57414u` então some
// do byte stream e o Ink nunca o vê. Determinístico e PURO por chunk (a função de strip é
// testável sem TTY); o interpositor de `read()` é a casca fina de I/O.
//
// POR QUE no canal RAW (e não no `useInput`): o crash acontece DENTRO do Ink
// (`handleData`, no listener do `internal_eventEmitter`), ANTES de o callback do `useInput`
// rodar. Um filtro no `useInput` (como o `isUnrecognizedEscapeTail` do task #16) roda TARDE
// DEMAIS — o Ink já crashou. O `isUnrecognizedEscapeTail` segue como defesa-em-profundidade
// p/ caudas que cheguem por outro caminho; este guard mata a sequência ANTES do parse.
//
// SHIFT+ENTER (`\x1b[13;2u`, kitty): hoje é apenas SUPRIMIDO (o `escape-leak` engole a
// cauda; o app NÃO negocia o protocolo ⇒ NÃO vira newline). Removê-lo no canal cru é
// EQUIVALENTE (sem newline antes, sem newline depois) — sem regressão.
//
// ALTERNATIVA (b), documentada como evolução (ADR): NEGOCIAR o CSI-u no boot (`\x1b[>1u`
// liga / `\x1b[<u` no cleanup em TODO caminho de término). Aí o terminal/Ink lidariam bem
// e o shift+enter→newline DIGITADO passaria a funcionar. É MAIOR (mexe no estado do
// terminal, restauração robusta em sinal/unmount/crash/exit, interação com paste/HOME-END
// no canal cru). Fica como follow-up; aqui o filtro raw, escopo do crash, que não mascara.
//
// ESCOPO/SEGURANÇA: só DESCARTA bytes de input do terminal (`@hiperplano/aluy-cli`). Não
// toca engine, catraca, egress, broker nem auth. O interpositor é best-effort: se o stdin
// não suportar o wrap, NÃO derruba o boot (degrada p/ o comportamento atual).

/**
 * Casa UMA sequência CSI-u (kitty keyboard protocol) COMPLETA no MEIO de um chunk:
 *   `\x1b` `[` (params: `0-9 ; :`) `u`
 * O terminador `u` é o que distingue o kitty-kbd das CSI comuns (setas `A`, `~`, etc.).
 * Os params podem incluir o codepoint (`57414`), modificadores (`;2`) e o sufixo de
 * evento (`:1`). Global p/ varrer todas as ocorrências do chunk.
 */
// Construído via `RegExp` a partir de string (com `` literal) p/ evitar um control
// char CRU dentro de um regex-literal (`no-control-regex`) — o byte é o MESMO ESC.
const ESC = '';
const CSI_U_SEQ = new RegExp(`${ESC}\\[[0-9;:]*u`, 'g');

/**
 * O maior SUFIXO de `s` que é PREFIXO PRÓPRIO de uma CSI-u em construção — i.e. um
 * `\x1b[…` SEM o terminador `u` ainda (a sequência pode ter sido cortada no boundary do
 * chunk). Devolve o comprimento desse sufixo pendente (0 se não houver). Usado p/ SEGURAR
 * a cauda parcial até o próximo chunk, evitando que um `\x1b[5741` num chunk e `4u` no
 * outro escapem do filtro.
 *
 * Um sufixo é "CSI-u em construção" quando: começa com `\x1b`, o 2º char (se houver) é `[`,
 * e os chars seguintes (se houver) são só params (`0-9 ; :`) — ou seja, AINDA poderia
 * terminar em `u`. Não casa um `\x1b` seguido de algo que NUNCA seria CSI-u (ex.: `\x1bO`,
 * `\x1b[A`) — esses não são nossa família e devem passar intactos.
 */
export function pendingCsiULen(s: string): number {
  // Procura o ÚLTIMO `\x1b` do chunk; só o sufixo a partir dele pode ser parcial.
  const esc = s.lastIndexOf('\x1b');
  if (esc === -1) return 0;
  const tail = s.slice(esc);
  // `\x1b` sozinho no fim: pode iniciar uma CSI-u (ou qualquer escape) ⇒ segura 1 byte.
  if (tail === '\x1b') return 1;
  // Precisa ser `\x1b[` + (só params) e SEM o `u` (senão já teria casado o regex completo).
  if (tail[1] !== '[') return 0; // `\x1bO…` etc. — não é nossa família; passa.
  // De `tail[2]` em diante só pode haver params (0-9 ; :). Se já há um `u`, NÃO é parcial
  // (o regex completo o teria pego antes desta função rodar sobre o resíduo).
  for (let i = 2; i < tail.length; i += 1) {
    const c = tail[i]!;
    if (c >= '0' && c <= '9') continue;
    if (c === ';' || c === ':') continue;
    return 0; // um char fora de params (ex.: `u` já tratado, ou um final de outra CSI) ⇒ não parcial.
  }
  return tail.length; // `\x1b[` + params, sem terminador ⇒ parcial; segura tudo.
}

/**
 * Cria um filtro com ESTADO (1 por stream) que strippa as sequências CSI-u de um fluxo de
 * chunks, segurando uma cauda parcial entre chunks (a sequência pode vir cortada no
 * boundary). PURO por chunk (estado encapsulado). Use `feed(chunk)` p/ cada chunk lido.
 */
export interface CsiUFilter {
  /** Strippa as CSI-u COMPLETAS do chunk (reanexando a cauda parcial do chunk anterior). */
  feed(chunk: string): string;
  /** Há cauda parcial retida aguardando o resto da sequência? (p/ o flush por timeout) */
  hasPending(): boolean;
  /** Devolve E LIMPA a cauda retida (flush F159 — o resto da sequência não veio). */
  takePending(): string;
}

export function createCsiUFilter(): CsiUFilter {
  let pending = '';
  const feed = (chunk: string): string => {
    let s = pending + chunk;
    pending = '';
    // Remove todas as CSI-u COMPLETAS.
    s = s.replace(CSI_U_SEQ, '');
    // Segura uma CSI-u PARCIAL no fim (cortada no boundary) p/ o próximo chunk.
    const hold = pendingCsiULen(s);
    if (hold > 0) {
      pending = s.slice(s.length - hold);
      s = s.slice(0, s.length - hold);
    }
    return s;
  };
  return {
    feed,
    hasPending: () => pending !== '',
    takePending: () => {
      const p = pending;
      pending = '';
      return p;
    },
  };
}

/** O mínimo do stdin que o interpositor precisa (facilita o mock no teste). */
export interface ReadableStdin {
  read?: (size?: number) => unknown;
  /** Best-effort: usado p/ ACORDAR o laço de leitura do Ink no flush F159. */
  emit?: (event: string) => unknown;
}

/**
 * F159 — prazo p/ a CONTINUAÇÃO de uma sequência retida chegar. Um terminal emite a
 * sequência CSI-u ATOMICAMENTE (ou os chunks chegam no mesmo tick de I/O); se em
 * `ESC_FLUSH_MS` não veio o resto, NÃO era sequência — era um **Esc humano** (ou Esc
 * seguido de digitação). Sem este flush, o `\x1b` solitário retido pelo filtro ficava
 * PRESO PARA SEMPRE: Esc virava TECLA MORTA (não fechava picker/dialog) até a PRÓXIMA
 * tecla chegar e empurrá-lo — o "só Esc duplo fecha o /model" do F159.
 */
export const ESC_FLUSH_MS = 75;

/**
 * INTERPÕE no `stdin.read()` o filtro de CSI-u: o Ink lê o teclado via `stdin.read()` num
 * laço sobre `'readable'`; envolvemos o `read` p/ que TODO chunk devolvido já venha SEM as
 * sequências CSI-u (o crash some na origem). Comportamento:
 *  · `read()` original devolve `null`/`undefined` ⇒ repassa (fim de stream REAL).
 *  · devolve um chunk ⇒ filtra e devolve o filtrado (mesmo que VAZIO).
 *  · se o chunk vira VAZIO após o strip (era SÓ CSI-u, ou ficou só a cauda parcial retida)
 *    ⇒ devolve a STRING VAZIA `''` — NUNCA `null` sintético. O Ink parseia `''` como
 *    `input=''` (no-op, não crasha) e, na próxima iteração do laço, o `read()` original
 *    devolve o `null` REAL (stream drenado) e o laço encerra. CUIDADO MEDIDO: devolver
 *    `null` SINTÉTICO (com o chunk JÁ consumido) faz o Node tratar como EOF de stdin em
 *    alguns caminhos — a TUI SAÍA limpa ao receber a seq (race sensível ao timing). A
 *    string vazia evita o EOF sintético e é igualmente inócua p/ o parse.
 *
 * Idempotente: marca o stream p/ não re-envolver 2×. Best-effort: sem `read` ⇒ no-op
 * (devolve uma função de restauração inócua). Devolve um `restore()` p/ desfazer o wrap.
 *
 * NOTA: o Ink consome via `read()` SEM size; preservamos a assinatura e o `this`. Quando o
 * `read` original for chamado com `size` (incomum no caminho do Ink), repassamos — o filtro
 * roda sobre o que voltar de qualquer forma.
 */
const WRAP_FLAG = Symbol.for('aluy.csiUGuard.wrapped');

export function installCsiUGuard(stdin: ReadableStdin): () => void {
  const target = stdin as ReadableStdin & {
    [WRAP_FLAG]?: boolean;
    read?: (size?: number) => unknown;
  };
  if (typeof target.read !== 'function') return () => {};
  if (target[WRAP_FLAG]) return () => {}; // já envolvido nesta sessão — não duplica.

  // Guarda a referência ORIGINAL (não-bound) p/ um restore IDÊNTICO; chamamos com o `this`
  // do call-site (o stream) p/ preservar a semântica do `read` do stream.
  const original = target.read as (this: unknown, size?: number) => unknown;
  const filter = createCsiUFilter();

  // F159 — bytes LIBERADOS pelo flush (a continuação não veio ⇒ era Esc humano). São
  // entregues CRUS na próxima leitura (NÃO repassam pelo filtro — já foram retidos 1×;
  // re-filtrar os re-prenderia p/ sempre).
  let flushed = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const scheduleFlush = (): void => {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    if (!filter.hasPending()) return;
    flushTimer = setTimeout(() => {
      flushTimer = undefined;
      flushed += filter.takePending();
      // ACORDA o laço de leitura do Ink (`'readable'` → `read()` até `null`): sem isto o
      // `\x1b` liberado só sairia na PRÓXIMA tecla — o Esc continuaria morto até lá.
      target.emit?.('readable');
    }, ESC_FLUSH_MS);
    // Não segura o processo vivo só pelo flush (headless/`-p` sai limpo).
    (flushTimer as { unref?: () => void }).unref?.();
  };

  const wrapped = function (this: unknown, size?: number): unknown {
    const chunk = size === undefined ? original.call(this) : original.call(this, size);
    // F159 — entrega primeiro o que o flush liberou (bytes crus, sem re-filtrar).
    const head = flushed;
    flushed = '';
    // SÓ repassa o sentinela de FIM-DE-STREAM real (`null`/`undefined`) — NUNCA o
    // sintetizamos. Sintetizar `null` quando o chunk foi consumido faz o Node tratar como
    // EOF de stdin em alguns caminhos (medido: a TUI SAÍA limpa ao receber a seq), além de
    // ser um race sensível ao timing. Por isso, quando o chunk vira VAZIO após o strip,
    // devolvemos a STRING VAZIA: o Ink a parseia como `input=''` (no-op, NÃO crasha) e, na
    // próxima iteração do laço, o `read()` original devolve o `null` REAL (stream drenado),
    // encerrando o laço normalmente — sem EOF sintético.
    if (chunk === null || chunk === undefined) {
      return head !== '' ? head : chunk;
    }
    const asStr = typeof chunk === 'string' ? chunk : String(chunk);
    const out = head + filter.feed(asStr);
    // Re-arma o prazo da cauda retida (se sobrou uma) a cada chunk novo.
    scheduleFlush();
    return out;
  };

  target.read = wrapped;
  target[WRAP_FLAG] = true;

  return (): void => {
    // Restaura SÓ se ainda for o nosso wrap (não pisa num wrap posterior de terceiros).
    if (target.read === wrapped) {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
      }
      target.read = original as typeof target.read;
      target[WRAP_FLAG] = false;
    }
  };
}

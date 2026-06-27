// EST-0948 (composer/sessão) — BRACKETED PASTE MODE (`?2004`): colar texto MULTI-LINHA.
//
// O BUG (dogfood): colar um bloco multi-linha no composer NÃO funcionava — o `\n` do
// paste era tratado como Enter e SUBMETIA na 1ª quebra, descartando o resto. Causa-raiz:
// o terminal não estava em BRACKETED PASTE MODE, então o conteúdo colado chegava CRU,
// indistinguível de digitação — e o detector de "Enter grudado em lote" (EST-0948,
// xrdp/SSH) submetia a 1ª linha. Multi-linha só existia via shift+enter manual.
//
// O FIX é em duas pontas (o byte de modo vive no `run.tsx`/`alt-screen`; a MÁQUINA de
// detecção vive aqui):
//   1) LIGAR o modo: emitir `\x1b[?2004h` ao iniciar a TUI e `\x1b[?2004l` ao sair. O
//      terminal então ENVELOPA todo conteúdo colado em `\x1b[200~` … `\x1b[201~`.
//   2) DETECTAR os marcadores no canal CRU do stdin (o MESMO canal `'data'` da detecção
//      do F8 — o Ink consome via 'readable'+read() e o Node re-emite o chunk pro 'data',
//      coexistindo). ENTRE os marcadores, TODO byte é TEXTO LITERAL: `\n`/`\r` viram
//      newline literal no composer (multi-linha), NÃO Enter/submit.
//
// POR QUE o canal CRU (e não o `useInput`): o `useInput` do Ink parseia o chunk via
// `parse-keypress`; um chunk `\x1b[200~…texto…\x1b[201~` vira um `char` MANGLED (o Ink
// corta o 1º `\x1b`) que o detector de lote interpretaria como Enter-grudado e
// SUBMETERIA. Então a máquina abaixo OWNS o paste no canal cru E o `useInput` consulta a
// MESMA detecção (`isInPaste`/marcador no char) p/ NÃO reprocessar os bytes do paste.
//
// CHUNK-CRUZANDO (o caso difícil, no DoD): o paste pode chegar PARTIDO em vários `read`s.
// Os marcadores podem vir cortados no meio (ex.: `…\x1b[20` num chunk, `0~…` no outro) e
// o conteúdo pode vir grudado com o marcador. A máquina BUFFERIZA: mantém uma cauda
// pendente que possa ser PREFIXO de um marcador, e só fecha o paste quando vê o `201~`
// inteiro. Determinística e PURA por chunk (estado encapsulado, ≠ função pura) — testável
// sem TTY, igual ao `createCockpitDiffer`.
//
// DEGRADAÇÃO: terminal que NÃO suporta `?2004` simplesmente não envelopa ⇒ nenhum
// marcador aparece ⇒ a máquina passa TUDO como `passthrough` e o comportamento atual
// (EST-0948, Enter-grudado de digitação real) permanece intacto — sem regressão.
//
// ESCOPO/SEGURANÇA: só PROCESSA bytes de input do terminal (`@hiperplano/aluy-cli`). Não toca engine,
// catraca, egress, broker nem auth. O conteúdo colado é TEXTO do usuário (vira o objetivo/
// edição do composer); não é executado — passa pela MESMA catraca de submit.

/** `\x1b[?2004h` — LIGA o bracketed paste mode (o terminal passa a envelopar o colado). */
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
/** `\x1b[?2004l` — DESLIGA o bracketed paste mode (restauração — junto dos outros resets). */
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

/** `\x1b[200~` — marcador de INÍCIO do paste (o terminal o emite antes do conteúdo). */
export const PASTE_START = '\x1b[200~';
/** `\x1b[201~` — marcador de FIM do paste (o terminal o emite depois do conteúdo). */
export const PASTE_END = '\x1b[201~';

/** Um stream mínimo p/ escrever os bytes de modo (process.stdout em prod, fake em teste). */
export interface PasteModeStream {
  write(chunk: string): boolean;
}

/**
 * Controlador do bracketed paste mode de UMA sessão TTY. LIGA o `?2004h` na construção e
 * expõe um `disable()` IDEMPOTENTE (`?2004l`) p/ ser chamado em TODO caminho de término
 * (sinal/unmount/crash/exit) — espelha a robustez do alt-screen (`registerRestoreHandlers`).
 * Best-effort: stream fechado ⇒ silêncio (nunca derruba boot/exit). NÃO registra handlers
 * de process aqui (o caller os encadeia, como faz com o `sync`/`bgController`).
 */
export interface PasteModeController {
  /** Desliga o `?2004l` UMA vez (idempotente). Chamar 2× é inócuo. */
  disable(): void;
}

/**
 * LIGA o bracketed paste mode (`?2004h`) no `stream` e devolve o controlador com o
 * `disable()` idempotente. Só deve ser chamado quando o caller confirmou TTY (run.tsx).
 */
export function enableBracketedPaste(stream: PasteModeStream): PasteModeController {
  try {
    stream.write(ENABLE_BRACKETED_PASTE);
  } catch {
    /* stream fechado — nada a fazer; nunca derruba o boot */
  }
  let off = false;
  const disable = (): void => {
    if (off) return; // IDEMPOTENTE: 2ª chamada (sinal + exit) é inócua.
    off = true;
    try {
      stream.write(DISABLE_BRACKETED_PASTE);
    } catch {
      /* saída já fechada no exit — nada a fazer */
    }
  };
  return { disable };
}

/**
 * Um evento emitido pela máquina ao consumir UM chunk cru do stdin:
 *  · `passthrough` — bytes FORA de qualquer paste; devem seguir o caminho normal de input
 *    (o `useInput`/detector de lote os trata como hoje). A máquina NÃO os reescreve.
 *  · `paste` — um paste COMPLETO (marcadores vistos): `text` é o conteúdo LITERAL já
 *    normalizado (`\r\n`→`\n`, control chars perigosos removidos, `\n`/`\t` preservados),
 *    pronto p/ INSERIR no cursor do composer de uma vez. NÃO submete.
 */
export type PasteEvent =
  | { readonly kind: 'passthrough'; readonly data: string }
  | { readonly kind: 'paste'; readonly text: string };

/**
 * Normaliza o conteúdo COLADO antes de inserir no composer:
 *  · `\r\n` e `\r` solto → `\n` (newline literal — multi-linha; nunca submit).
 *  · remove control chars C0 PERIGOSOS (que bagunçariam o terminal/edição) MAS PRESERVA
 *    `\n` (0x0a) e `\t` (0x09). Inclui o DEL (0x7f) — num paste ele NÃO é "backspace"
 *    (seria absurdo um byte de edição vir num bloco colado) e deixá-lo cru faria o
 *    `applyTypedChunk` apagar caractere do próprio paste.
 */
export function normalizePaste(raw: string): string {
  const lf = raw.replace(/\r\n?/g, '\n');
  let out = '';
  for (let i = 0; i < lf.length; i += 1) {
    const code = lf.charCodeAt(i);
    if (code === 0x0a || code === 0x09) {
      out += lf[i]; // preserva newline e tab (conteúdo legítimo do paste).
      continue;
    }
    // remove C0 (0x00–0x1f) e o DEL (0x7f) — não imprimíveis/edição que não cabem no texto.
    if (code <= 0x1f || code === 0x7f) continue;
    out += lf[i];
  }
  return out;
}

// ── O LADO DO `useInput` (Ink) ──────────────────────────────────────────────────────
// O Ink ENTREGA o MESMO chunk ao `useInput` (via parse-keypress), mas MANGLED: corta o
// 1º `\x1b` do `sequence`. Então um chunk `\x1b[200~…\x1b[201~` chega ao `useInput` como
// `char = "[200~…\x1b[201~"` — o `\x1b` do `200~` some, o do `201~` permanece (não é o 1º).
// O `useInput` NÃO deve reprocessar bytes de paste (o canal cru/`bracketed-paste` já os
// inseriu); senão o detector de lote (EST-0948) submeteria a 1ª linha do paste. Este
// detector roda do LADO do `useInput`, rastreando o paste pelos VESTÍGIOS dos marcadores
// no `char` MANGLED — funciona em qualquer ordem de evento ('data' vs 'readable'), porque
// os marcadores estão NO PRÓPRIO char que o `useInput` recebe.

/** O `\x1b[200~` como o `useInput` o vê (Ink cortou o 1º `\x1b`). */
const MANGLED_START = PASTE_START.slice(1); // "[200~"
/** O `\x1b[201~` como o `useInput` o vê quando NÃO é o 1º byte (ESC preservado). */
const RAW_END = PASTE_END; // "\x1b[201~"
/** O `\x1b[201~` MANGLED (quando o chunk do FIM começa com ele ⇒ Ink corta o `\x1b`). */
const MANGLED_END = PASTE_END.slice(1); // "[201~"

/** Estado mínimo de rastreio do paste do lado do `useInput` (1 booleano, por ref). */
export interface InputPasteGate {
  /** `true` enquanto um paste está ABERTO (já vimos o `200~`, ainda não o `201~`). */
  open: boolean;
}

/**
 * Decide, do lado do `useInput`, se o `char` MANGLED do Ink é (parte de) um PASTE — caso
 * em que o `useInput` deve SUPRIMIR (não inserir/submeter): o canal cru já cuida do paste.
 * Atualiza `gate.open` conforme vê o início/fim do paste no char. Retorna `true` se o char
 * deve ser SUPRIMIDO pelo `useInput`.
 *
 * Casos:
 *  · char contém o `200~` (mangled) ⇒ paste ABRE; suprime. Se também contém o `201~` no
 *    MESMO char (paste de 1 chunk), FECHA já — mas ainda suprime (o canal cru inseriu).
 *  · gate JÁ aberto ⇒ suprime tudo até ver o `201~` (que FECHA); o char do fim também é
 *    suprimido (é a cauda do paste + marcador).
 *  · fora de paste e sem marcador ⇒ NÃO suprime (digitação normal segue o caminho de hoje).
 */
export function gateInputPaste(gate: InputPasteGate, char: string): boolean {
  // Já estamos num paste aberto: suprime tudo; fecha ao ver o fim (raw ou mangled).
  if (gate.open) {
    if (char.includes(RAW_END) || char.startsWith(MANGLED_END)) gate.open = false;
    return true;
  }
  // Fora de paste: abre se o char traz o início (mangled).
  if (char.includes(MANGLED_START)) {
    // Paste de 1 chunk: o fim veio no MESMO char ⇒ já fecha; senão fica aberto.
    gate.open = !(char.includes(RAW_END) || char.includes(MANGLED_END));
    return true;
  }
  return false; // sem vestígio de paste ⇒ digitação normal.
}

/** A máquina de bracketed paste de UMA sessão (estado: dentro/fora do paste + cauda pendente). */
export interface BracketedPasteMachine {
  /**
   * Consome UM chunk cru do stdin e devolve a lista ORDENADA de eventos. Pode devolver
   * vários (ex.: `passthrough` antes do `\x1b[200~`, depois `paste` quando o `201~`
   * fecha). Se o paste ainda não fechou (chunk parcial), NÃO emite `paste` ainda —
   * acumula e espera o próximo chunk. Determinística por chunk; o estado carrega entre
   * chamadas (paste cruzando chunks).
   */
  feed(chunk: string): PasteEvent[];
  /** Está ATUALMENTE dentro de um paste (entre `200~` e `201~`)? Usado pelo gate do `useInput`. */
  isInPaste(): boolean;
}

/** O maior sufixo de `s` que é PREFIXO PRÓPRIO de `marker` (p/ um marcador cortado no fim do chunk). */
function pendingPrefixLen(s: string, marker: string): number {
  // Procura o maior k (1..len-1) tal que os últimos k bytes de `s` == os 1ºs k de `marker`.
  // Esse sufixo PODE ser o começo do marcador chegando partido — segura-o p/ o próximo chunk.
  const max = Math.min(s.length, marker.length - 1);
  for (let k = max; k > 0; k -= 1) {
    if (s.slice(s.length - k) === marker.slice(0, k)) return k;
  }
  return 0;
}

/**
 * Cria a máquina de bracketed paste (1 por sessão). Estado encapsulado:
 *  · `inPaste`   — `true` entre `\x1b[200~` e `\x1b[201~`.
 *  · `buf`       — conteúdo do paste acumulado (enquanto `inPaste`), até ver o `201~`.
 *  · `pending`   — cauda do chunk anterior que PODE ser prefixo de um marcador (cortado no
 *                  boundary); é reanexada ao começo do próximo chunk antes de varrer.
 */
export function createBracketedPasteMachine(): BracketedPasteMachine {
  let inPaste = false;
  let buf = '';
  let pending = '';

  const feed = (chunk: string): PasteEvent[] => {
    const events: PasteEvent[] = [];
    // Reanexa a cauda pendente do chunk anterior (marcador possivelmente cortado).
    let s = pending + chunk;
    pending = '';
    // Acumula bytes de passthrough p/ COALESCER num único evento (preserva a ordem e a
    // semântica de "1 chunk de digitação" que o detector de lote espera).
    let pass = '';
    const flushPass = (): void => {
      if (pass.length > 0) {
        events.push({ kind: 'passthrough', data: pass });
        pass = '';
      }
    };

    while (s.length > 0) {
      if (!inPaste) {
        const startAt = s.indexOf(PASTE_START);
        if (startAt === -1) {
          // Sem início de paste no que sobrou. MAS o fim do `s` pode ser um `\x1b[200~`
          // CORTADO (chunk boundary) — segura essa cauda p/ o próximo chunk; o resto é
          // passthrough. Sem isso, um marcador partido viraria texto literal no composer.
          const hold = pendingPrefixLen(s, PASTE_START);
          if (hold > 0) {
            pass += s.slice(0, s.length - hold);
            pending = s.slice(s.length - hold);
          } else {
            pass += s;
          }
          s = '';
          break;
        }
        // Tudo ANTES do `200~` é passthrough; entra no paste e continua a varrer o resto.
        pass += s.slice(0, startAt);
        inPaste = true;
        buf = '';
        s = s.slice(startAt + PASTE_START.length);
        continue;
      }
      // Dentro do paste: procura o `201~` (fim). Tudo até ele é conteúdo LITERAL.
      const endAt = s.indexOf(PASTE_END);
      if (endAt === -1) {
        // Fim ainda não chegou. A cauda pode ser um `\x1b[201~` CORTADO — segura-a; o
        // resto vira conteúdo do paste. (Importante: sem o hold, um `201~` partido seria
        // acumulado como texto e o paste nunca fecharia direito.)
        const hold = pendingPrefixLen(s, PASTE_END);
        if (hold > 0) {
          buf += s.slice(0, s.length - hold);
          pending = s.slice(s.length - hold);
        } else {
          buf += s;
        }
        s = '';
        break;
      }
      // Fim do paste: o conteúdo é tudo até o `201~`. Fecha, normaliza e emite.
      buf += s.slice(0, endAt);
      // Emite o passthrough acumulado ANTES do paste (mantém a ordem byte-real).
      flushPass();
      events.push({ kind: 'paste', text: normalizePaste(buf) });
      inPaste = false;
      buf = '';
      s = s.slice(endAt + PASTE_END.length);
      // continua: pode haver mais conteúdo (passthrough ou outro paste) no mesmo chunk.
    }

    flushPass();
    return events;
  };

  const isInPaste = (): boolean => inPaste;

  return { feed, isInPaste };
}

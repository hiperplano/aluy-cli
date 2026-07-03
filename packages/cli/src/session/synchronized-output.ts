// EST-0965 — RENDER da TUI sem flicker. Duas camadas COMPLEMENTARES sobre o repintar
// do Ink (que o Static + throttle do PR #15 só reduziram em VOLUME):
//
//   1) SYNCHRONIZED OUTPUT (Mode 2026 / `?2026`) — envolve cada frame em BSU…ESU p/ o
//      terminal pintar o frame ATÔMICO. Funciona SÓ onde o terminal honra o `?2026`.
//   2) OVERWRITE-IN-PLACE (esta camada, a definitiva) — transforma os BYTES do frame
//      de "apaga-tudo-depois-escreve" em "SOBRESCREVE-no-lugar". Funciona em QUALQUER
//      terminal, com ou sem suporte a sync. É o que MATA o flicker de verdade.
//
// CAUSA-RAIZ PROVADA (bytes capturados de 1 tecla): o anti-flicker do Ink usa
// `log-update`, que a cada frame faz UM `stdout.write(eraseLines(N) + frame)`. E
// `eraseLines(N)` (ansi-escapes) é, byte a byte:
//
//     (\x1b[2K \x1b[1A){N-1}  \x1b[2K  \x1b[G
//      └ apaga linha └ sobe    └ apaga  └ col 1
//
// Ou seja: APAGA (branqueia) as N linhas da região viva, sobe o cursor ao topo e SÓ
// ENTÃO escreve o conteúdo novo. Num terminal que NÃO honra o `?2026` (ex.: Terminator/
// Konsole sem Mode 2026), o estado BRANCO entre o apagar e o reescrever fica VISÍVEL =
// FLICKER. O `?2026` envolve tudo, mas se o terminal ignora, não adianta.
//
// O FIX — transformar "apaga-depois-escreve" em "sobrescreve-no-lugar":
//   · Troca a corrida de erase `(\x1b[2K\x1b[1A)…\x1b[2K\x1b[G` por SÓ MOVIMENTO:
//     `\x1b[1A`×(N-1) + `\x1b[G` — sobe o cursor ao topo da região SEM branquear nada.
//   · O conteúdo novo SOBRESCREVE o velho byte a byte. Pra não sobrar CAUDA de linha
//     mais curta, acrescenta `\x1b[K` (limpa do cursor ATÉ O FIM da linha — NÃO
//     branqueia a linha toda) ao FIM de cada linha do conteúdo.
//   · Pra remover linhas ÓRFÃS quando o frame novo tem MENOS linhas que o anterior,
//     acrescenta `\x1b[J` (limpa do cursor ATÉ O FIM DA TELA, só pra BAIXO) no FIM.
//   `\x1b[K` e `\x1b[J` limpam só do cursor PRA FRENTE ⇒ o que já foi escrito NÃO
//   pisca, e o `\x1b[J` (pra baixo) NUNCA toca o scrollback ACIMA do cursor (o
//   `<Static>`). Resultado: cursor sobe → escreve por cima → limpa só a sobra ⇒ ZERO
//   branco intermediário ⇒ ZERO flicker, com ou sem suporte a sync.
//
// ESCOPO/SEGURANÇA: a transformação é PURA sobre os bytes do frame — NÃO toca o
// conteúdo/redação (o texto já vem redigido a montante; CLI-SEC-6 intacta) e NÃO
// reordena nada. Os writes do `<Static>` são APPENDS ao scrollback (sem prefixo de
// erase) ⇒ não casam o padrão ⇒ passam CRUS. Só a camada Ink de `@hiperplano/aluy-cli`; NÃO toca
// engine, catraca, egress, broker nem auth.

/** BSU — Begin Synchronized Update (DECSET 2026). Abre o frame atômico. */
export const BEGIN_SYNC = '\x1b[?2026h';
/** ESU — End Synchronized Update (DECRST 2026). Fecha/pinta o frame atômico. */
export const END_SYNC = '\x1b[?2026l';

import { displayWidth } from './visual-lines.js';

const ESC = '\x1b[';
/** `\x1b[2K` — apaga a LINHA INTEIRA (o que branqueia e causa o flicker). */
const ERASE_LINE = `${ESC}2K`;
/** `\x1b[1A` — sobe o cursor UMA linha (sem apagar). */
const CURSOR_UP_1 = `${ESC}1A`;
/** `\x1b[G` — cursor p/ a coluna 1 (sem apagar). */
const CURSOR_COL1 = `${ESC}G`;
/** `\x1b[K` — apaga do cursor até o FIM DA LINHA (não branqueia a linha toda). */
const ERASE_TO_EOL = `${ESC}K`;
/** `\x1b[J` — apaga do cursor até o FIM DA TELA (só pra BAIXO; nunca o scrollback). */
const ERASE_TO_EOS = `${ESC}J`;

// EST-0965 · ADR-0076 §5 — O FLICKER DO COCKPIT é por OUTRO byte que o inline. No
// alt-screen o frame do cockpit ENCHE `rows` (invariante §3), então o Ink NÃO usa o
// `log-update`/`eraseLines` (`\x1b[2K…`, o do inline) — usa o caminho `outputHeight>=rows`,
// que escreve `ansiEscapes.clearTerminal` + frame a CADA render. `clearTerminal` é, byte
// a byte:  `\x1b[2J`(apaga TELA TODA) `\x1b[3J`(apaga scrollback) `\x1b[H`(cursor ao topo).
// O `\x1b[2J` BRANQUEIA a tela inteira ANTES de o frame novo pintar — num terminal que
// NÃO honra o `?2026` (xterm/Terminator de muitas builds), esse branco intermediário
// FICA VISÍVEL = FLICKER (a mesma classe do `\x1b[2K` no inline, mas em tela cheia).
/** `\x1b[2J` — apaga a TELA INTEIRA (branqueia ⇒ flicker no alt-screen). */
const ERASE_SCREEN = `${ESC}2J`;
/** `\x1b[3J` — apaga o SCROLLBACK (inócuo no alt-screen — não há scrollback lá). */
const ERASE_SCROLLBACK = `${ESC}3J`;
/** `\x1b[H` — cursor p/ o TOPO-ESQUERDA (home) — sem branquear nada. */
const CURSOR_HOME = `${ESC}H`;
/** O `ansiEscapes.clearTerminal` do Ink, byte a byte: apaga tela + scrollback + home. */
const CLEAR_TERMINAL = `${ERASE_SCREEN}${ERASE_SCROLLBACK}${CURSOR_HOME}`;

/** `\x1b[<row>;1H` — CUP: posiciona o cursor na LINHA `row` (1-based), coluna 1. */
function cursorTo(row: number): string {
  return `${ESC}${row};1H`;
}

/** `\x1b[<row>;<col>H` — CUP: posiciona o cursor na LINHA `row` e COLUNA `col` (1-based). */
function cursorToRC(row: number, col: number): string {
  return `${ESC}${row};${col}H`;
}

/**
 * EST-0965 · ADR-0076 §5 (FIX #151) — calcula ONDE o cursor ASSENTA depois que o Ink
 * escreve o frame INTEIRO a partir do home (`\x1b[H` + body). É EXATAMENTE a posição que
 * o full-paint deixa o cursor — e que o Ink/composer ESPERA (o caret do input mora no
 * fim do frame, não no topo). O renderer diferencial NÃO escreve o body inteiro, então
 * tem que RE-EMITIR essa posição ao fim (senão o cursor fica onde ele acabou de pintar a
 * última linha mudada, ou no home — deslocando o caret e quebrando QUALQUER write
 * seguinte de posicionamento RELATIVO, ex.: o `log-update` do Ink num frame que caia no
 * caminho `outputHeight<rows`).
 *
 * Simula o avanço do cursor SÓ pelo que move posição no terminal: `\n` desce uma linha e
 * volta à coluna 1; `\r` volta à coluna 1; QUALQUER outro caractere imprimível avança uma
 * coluna. As sequências CSI (`\x1b[…`) têm LARGURA ZERO no terminal (movem/colorem, não
 * imprimem) ⇒ são puladas sem avançar coluna — é por isso que o `\x1b[?25h` (mostra
 * cursor) no fim do frame do Ink NÃO conta como coluna. Devolve {row,col} 1-based — a
 * MESMA posição em que o terminal real deixaria o cursor após o full-paint.
 */
function frameEndCursor(body: string): { row: number; col: number } {
  let row = 1; // 1-based: o body começa no home (linha 1).
  let col = 1; // 1-based: coluna 1.
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\x1b' && body[i + 1] === '[') {
      // CSI: `\x1b[` + params `[0-9;?]*` + 1 byte final `[ -/]*[@-~]`. Largura ZERO no
      // terminal (não imprime) ⇒ pula a sequência inteira SEM mexer em row/col. Salta até
      // (e incluindo) o byte final do CSI.
      let j = i + 2;
      while (j < body.length && body[j] >= '0' && body[j] <= '?') j += 1; // params + '?'/';'
      while (j < body.length && body[j] >= ' ' && body[j] <= '/') j += 1; // bytes intermediários
      // body[j] é o byte final do CSI (@..~); o laço pula i até j inclusive.
      i = j;
      continue;
    }
    if (ch === '\n') {
      row += 1;
      col = 1;
    } else if (ch === '\r') {
      col = 1;
    } else {
      // FIX (HUNT-RENDER) — avança pela LARGURA DE EXIBIÇÃO do code point, não 1 por
      // unidade UTF-16. Antes era `col += 1` por unidade: um CJK/fullwidth (`你`, 1 unidade
      // UTF-16, mas 2 COLUNAS no terminal) era contado como 1 ⇒ o caret do composer no
      // cockpit ASSENTAVA À ESQUERDA do real; uma combinante/ZWJ (largura 0) era contada
      // como 1 ⇒ assentava à DIREITA. (Um emoji astral acertava por ACASO: 2 unidades
      // UTF-16 × 1 ≈ 2 colunas.) `displayWidth` do code point dá a coluna correta, e
      // iteramos por CODE POINT — pulamos a metade baixa do par surrogate (senão ela seria
      // contada de novo). CSI/`\n`/`\r` já tratados acima; o resto avança pela largura real.
      const cp = body.codePointAt(i)!;
      if (cp > 0xffff) i += 1; // par surrogate: pula a unidade baixa (já contabilizada).
      col += displayWidth(String.fromCodePoint(cp));
    }
  }
  return { row, col };
}

/** Toggle: `ALUY_SYNC_OUTPUT=0` (escape-hatch) desliga o `?2026` (BSU/ESU). Default ON. */
export function syncOutputEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ALUY_SYNC_OUTPUT !== '0';
}

/**
 * Toggle: `ALUY_OVERWRITE_RENDER=0` desliga o overwrite-in-place (debug). Default ON —
 * é o que MATA o flicker em terminal sem Mode 2026, então fica ligado mesmo com o
 * `?2026` desligado.
 */
export function overwriteRenderEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.ALUY_OVERWRITE_RENDER !== '0';
}

/**
 * Detecta a corrida de `eraseLines(N)` do Ink no INÍCIO do chunk e devolve quantas
 * linhas ela apaga (N) + o índice ONDE ela termina (início do conteúdo). Devolve
 * `undefined` se o chunk não começa com o padrão exato — aí degradamos pro cru.
 *
 * Padrão (ansi-escapes `eraseLines`):  `(\x1b[2K\x1b[1A){N-1}` + `\x1b[2K` + `\x1b[G`.
 * Casos de borda casados:
 *  · N=1 ⇒ só `\x1b[2K\x1b[G` (sem nenhum `\x1b[1A`).
 *  · 1º frame ⇒ N=0 ⇒ NÃO há erase ⇒ `undefined` (passa cru).
 */
function matchEraseLines(chunk: string): { lines: number; bodyStart: number } | undefined {
  let i = 0;
  let pairs = 0;
  // Corrida de `\x1b[2K\x1b[1A` (apaga linha + sobe) — os (N-1) primeiros.
  while (chunk.startsWith(`${ERASE_LINE}${CURSOR_UP_1}`, i)) {
    i += ERASE_LINE.length + CURSOR_UP_1.length;
    pairs += 1;
  }
  // O fechamento OBRIGATÓRIO: `\x1b[2K\x1b[G` (apaga a última + col 1).
  if (!chunk.startsWith(`${ERASE_LINE}${CURSOR_COL1}`, i)) return undefined;
  i += ERASE_LINE.length + CURSOR_COL1.length;
  // N = (N-1) pares + a última linha do fechamento.
  return { lines: pairs + 1, bodyStart: i };
}

/**
 * F198 (anti "BLOCO GIGANTE de linhas em branco na resposta longa") — CLASSIFICA um write do
 * Ink no INLINE quanto ao REGIME de repaint, p/ detectar a SAÍDA do caminho `outputHeight >=
 * rows` (clearTerminal). PURO.
 *  · 'clearterm' — o Ink pintou a tela via `clearTerminal` (a região viva > `rows`, `ink.js`:
 *                  `outputHeight >= rows` ⇒ escreve `clearTerminal + fullStaticOutput + output`
 *                  DIRETO, bypassando o `log-update`);
 *  · 'erase'     — frame normal `eraseLines` (a região viva CABE em `rows`; o `log-update` gere);
 *  · 'other'     — Static append / 1º frame / write parcial (não muda o regime).
 */
export function classifyInlineWrite(body: string): 'clearterm' | 'erase' | 'other' {
  if (body.startsWith(CLEAR_TERMINAL)) return 'clearterm';
  if (matchEraseLines(body)) return 'erase';
  return 'other';
}

/**
 * F198 — detector de SAÍDA do regime clearTerminal (região viva > `rows`) no INLINE.
 *
 * CAUSA-RAIZ do bug (medida): quando a região viva fica MAIOR que `rows` (resposta LONGA, ou
 * tool/sub-agentes inflando a viva além do orçado, ou terminal baixo), o Ink usa o caminho
 * `outputHeight >= rows` — escreve `clearTerminal`+frame DIRETO e NÃO chama o `log-update`,
 * então o `previousLineCount` do `log-update` CONGELA obsoleto (≈ a altura da tela, o último
 * valor do caminho `fits`). Quando a viva FINALIZA e encolhe abaixo de `rows` (a fala vira
 * bloco concluído no `<Static>`), o Ink volta ao caminho `fits` e chama `log.clear()` =
 * `eraseLines(previousLineCount_obsoleto)`: sobe ~1 TELA e apaga linhas JÁ COMMITADAS no
 * scrollback, deixando um BLOCO GIGANTE de linhas em branco entre a mensagem do usuário
 * (`▌ você`) e o cabeçalho da resposta (`Λ aluy`). (O `overwriteInPlace` acima traduz o
 * `eraseLines` obsoleto em `cursor-up(N-1) + eraseBelow` — mesmo efeito: branqueia o commit.)
 *
 * Não há como resetar o `previousLineCount` interno do Ink por fora. Então DETECTAMOS a
 * transição pelos BYTES (a fonte de verdade do regime, imune a erro de orçamento) e
 * SINALIZAMOS o caller p/ LIMPAR a tela + re-emitir o histórico (clearScreen) — o cursor vai
 * ao HOME e o `eraseLines` obsoleto seguinte fica INÓCUO (nada acima do topo p/ apagar), então
 * o scrollback re-emitido sai LIMPO. `feed(body)` devolve `true` na BORDA de saída (o 1º write
 * que NÃO é clearTerminal depois de um episódio clearTerminal).
 *
 * POR QUE "1º write não-clearterm" (e não "1º eraseLines"): DENTRO do regime o Ink escreve
 * EXCLUSIVAMENTE `clearTerminal`+frame e retorna cedo (`ink.js` — nunca emite `eraseLines` nem
 * append de `<Static>` ali). Então o PRIMEIRO write que não seja `clearTerminal` já É a saída.
 * Esperar um `eraseLines` NÃO basta: se a viva estourou desde o 1º frame, o `previousLineCount`
 * ficou 0 e o `log.clear()` da finalização emite `eraseLines(0)` = VAZIO (o wrapper nem alimenta
 * o tracker com write vazio) — a 1ª evidência de saída vira o append de `staticOutput` (a fala
 * virando bloco no `<Static>`), um write 'other'. Contá-lo é seguro: qualquer write não-clearterm
 * só chega aqui com `inClearTerm` (durante o regime não há esses writes) ⇒ é a saída real.
 *
 * Só INLINE: o cockpit (alt-screen) não tem scrollback e usa seu próprio differ. PURO/estável.
 */
export function createOverflowRegimeTracker(): { feed(body: string): boolean } {
  let inClearTerm = false;
  return {
    feed(body: string): boolean {
      if (classifyInlineWrite(body) === 'clearterm') {
        inClearTerm = true;
        return false;
      }
      // 1º write não-clearterm depois do regime = a BORDA de saída (a viva voltou a caber).
      if (inClearTerm) {
        inClearTerm = false;
        return true;
      }
      return false;
    },
  };
}

/**
 * Acrescenta `\x1b[K` (limpa-FIM-de-linha) ao fim de CADA linha do conteúdo, p/ tirar a
 * cauda de uma linha anterior mais comprida SEM branquear a linha inteira. Preserva os
 * `\n` (e os `\r\n`) byte a byte — só INSERE o `\x1b[K` ANTES de cada quebra (e no fim,
 * se o conteúdo não termina em quebra). O conteúdo em si fica intacto.
 */
function appendEolEraseToEachLine(body: string): string {
  let out = '';
  let line = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\n') {
      // `\r\n`: o `\r` já está em `line`; insere o `\x1b[K` ANTES do `\r` p/ a limpeza
      // valer na posição do conteúdo, não depois do retorno de carro.
      if (line.endsWith('\r')) {
        out += line.slice(0, -1) + ERASE_TO_EOL + '\r\n';
      } else {
        out += line + ERASE_TO_EOL + '\n';
      }
      line = '';
    } else {
      line += ch;
    }
  }
  // Última linha sem quebra final ⇒ ainda limpa a cauda dela.
  if (line.length > 0) out += line + ERASE_TO_EOL;
  return out;
}

/**
 * O TRANSFORM. Recebe os bytes de UM write do Ink e devolve a versão sobrescreve-no-
 * lugar. Idempotência de segurança: se o chunk NÃO começa com o `eraseLines` do Ink
 * (1º frame, Static append, versão diferente do ansi-escapes), devolve o chunk CRU —
 * NUNCA quebra o render.
 *
 * Dois sub-casos do padrão de erase:
 *  · ERASE + CONTEÚDO (frame normal): vira `\x1b[1A`×(N-1) + `\x1b[G` + conteúdo(cada
 *    linha com `\x1b[K`) + `\x1b[J`. Zero `\x1b[2K` ⇒ zero branqueamento ⇒ zero flicker.
 *  · ERASE PURO (sem conteúdo): é o `logUpdate.clear()` (`/clear`, boot-clear, unmount)
 *    — a região viva DEVE sumir. Vira `\x1b[1A`×(N-1) + `\x1b[G` + `\x1b[J`: sobe ao
 *    topo e limpa a região PRA BAIXO de uma vez (sem o branqueamento linha-a-linha,
 *    também sem flicker), preservando o efeito de apagar.
 */
export function overwriteInPlace(chunk: string): string {
  // EST-1015 (fix flicker de saída GRANDE no inline) — quando a região viva fica MAIOR
  // que a altura do terminal (ex.: um `bash` com saída enorme, ou muito streaming), o Ink
  // ABANDONA o `eraseLines` e usa o caminho `outputHeight>=rows`: emite `clearTerminal`
  // (`\x1b[2J\x1b[3J\x1b[H`) + frame a CADA render. O `\x1b[2J` BRANQUEIA a tela inteira
  // antes de pintar ⇒ flicker visível (o xterm não honra o `?2026`). Antes, este transform
  // só casava `eraseLines` e DEIXAVA o `clearTerminal` passar CRU ⇒ era a causa do flicker
  // reportado em saída grande. Aqui tratamos o `clearTerminal` IGUAL ao cockpit: troca o
  // "apaga-tela-depois-pinta" por "home + sobrescreve no lugar + varre a sobra abaixo"
  // (`\x1b[H` + body + `\x1b[J`). ZERO `\x1b[2J` ⇒ ZERO branqueamento ⇒ sem flicker, com ou
  // sem `?2026`. O estado final na tela é idêntico ao do clearTerminal, só sem o flash.
  if (chunk.startsWith(CLEAR_TERMINAL)) {
    const clearBody = chunk.slice(CLEAR_TERMINAL.length);
    // FIX (EST-1015, resíduo do #304) — antes era `${CURSOR_HOME}${clearBody}${ERASE_TO_EOS}`: o
    // `\x1b[J` só apaga ABAIXO, NÃO a CAUDA de cada linha. O `\x1b[2J` original apagava a TELA
    // toda, então trocá-lo por home+body cru reintroduziu a cauda órfã quando uma linha ENCOLHE
    // entre frames (saída grande em streaming: a linha de status/cauda muda de tamanho). Agora
    // apagamos POR-LINHA (`\x1b[K`) — IGUAL o caminho `eraseLines` abaixo. ZERO `\x1b[2J` mantido.
    return clearBody.length === 0
      ? `${CURSOR_HOME}${ERASE_TO_EOS}`
      : `${CURSOR_HOME}${appendEolEraseToEachLine(clearBody)}${ERASE_TO_EOS}`;
  }

  const m = matchEraseLines(chunk);
  if (!m) return chunk; // 1º frame / Static / padrão não casou ⇒ cru.

  const up = CURSOR_UP_1.repeat(m.lines - 1); // sobe (N-1); a Nª já é a linha atual.
  const moveToTop = `${up}${CURSOR_COL1}`;
  const body = chunk.slice(m.bodyStart);

  if (body.length === 0) {
    // ERASE PURO (clear): sobe ao topo + limpa a região viva PRA BAIXO de uma vez.
    return `${moveToTop}${ERASE_TO_EOS}`;
  }
  // Frame normal: sobrescreve no lugar; `\x1b[K` por linha tira a cauda; `\x1b[J` no
  // fim tira as linhas órfãs (frame que ENCOLHEU).
  return `${moveToTop}${appendEolEraseToEachLine(body)}${ERASE_TO_EOS}`;
}

/**
 * EST-0965 · ADR-0076 §5 — O TRANSFORM DO COCKPIT (alt-screen). Mesma IDEIA do
 * `overwriteInPlace` (sobrescreve-no-lugar, ZERO branqueamento intermediário), mas p/ o
 * OUTRO padrão de erase: no alt-screen o Ink emite `clearTerminal` (`\x1b[2J\x1b[3J\x1b[H`)
 * a cada frame, NÃO o `eraseLines` do inline. O `\x1b[2J` branqueia a TELA INTEIRA antes
 * de pintar ⇒ flicker onde o `?2026` não é honrado (o xterm do Tiago).
 *
 * O fix — trocar "apaga-tela-depois-escreve" por "home + sobrescreve no lugar":
 *  · `\x1b[2J\x1b[3J\x1b[H`  ⇒  só `\x1b[H` (cursor home — SEM branquear).
 *  · O frame novo SOBRESCREVE o velho byte a byte (o cockpit tem ALTURA FIXA == `rows`,
 *    §3 ⇒ cada linha do frame anterior é coberta).
 *  · `\x1b[J` (apaga do cursor até o FIM DA TELA, só pra BAIXO) é acrescentado AO FIM do
 *    conteúdo p/ varrer qualquer sobra ABAIXO da última linha (defesa; com altura fixa
 *    raramente há sobra). Como vem DEPOIS de pintar, NÃO há branco intermediário visível.
 *
 * Resultado: ZERO `\x1b[2J` ⇒ ZERO branqueamento de tela ⇒ ZERO flicker, com ou sem
 * `?2026`. NÃO usamos `\x1b[K` por linha aqui (≠ inline): o cockpit é um GRID de largura
 * fixa que repinta a linha INTEIRA — não há "cauda de linha anterior mais comprida" a
 * limpar, e inserir `\x1b[K` no meio de linhas com bordas/ANSI do grid arriscaria comer
 * byte de conteúdo. O `\x1b[J` final cobre o único caso real (frame mais CURTO).
 *
 * Idempotência de segurança: se o chunk NÃO começa EXATAMENTE com `clearTerminal`
 * (1º frame sem clear, write parcial, padrão diferente), devolve o chunk CRU — NUNCA
 * quebra o render do cockpit.
 */
export function cockpitOverwriteInPlace(chunk: string): string {
  if (!chunk.startsWith(CLEAR_TERMINAL)) return chunk; // não é o clearTerminal do Ink ⇒ cru.
  const body = chunk.slice(CLEAR_TERMINAL.length);
  if (body.length === 0) {
    // `clearTerminal` PURO (raro): home + limpa a tela PRA BAIXO de uma vez (sem `\x1b[2J`).
    return `${CURSOR_HOME}${ERASE_TO_EOS}`;
  }
  // Frame normal do cockpit: home, sobrescreve no lugar, varre a sobra ABAIXO no fim.
  return `${CURSOR_HOME}${body}${ERASE_TO_EOS}`;
}

/**
 * EST-0965 · ADR-0076 §5 — O RENDERER DIFERENCIAL do cockpit (cell-diff por LINHA). É a
 * EVOLUÇÃO do `cockpitOverwriteInPlace`: aquele já matava o `\x1b[2J` (branqueamento de
 * tela), mas ainda REESCREVIA O FRAME INTEIRO (`rows`×`cols`) a CADA render — `home` +
 * frame inteiro + `\x1b[J`. Num terminal que NÃO honra o `?2026` (o xterm do Tiago), o
 * repaint da TELA INTEIRA a cada tecla/atividade é uma VARREDURA visível = flicker
 * RESIDUAL. (Provado por bytes: 1 char no cockpit ⇒ ~`rows` `\x1b[H`/repaints de frame
 * cheio.) O inline não sofria porque repinta só a região VIVA (poucas linhas); o cockpit
 * repintava a tela toda.
 *
 * O FIX — emitir SÓ AS LINHAS QUE MUDARAM entre o frame anterior e o novo:
 *  · Mantém o FRAME ANTERIOR (buffer de linhas) por envelope (estado, ≠ função pura).
 *  · Compara linha-a-linha. Para cada linha `r` (1-based) que MUDOU, emite
 *    `\x1b[<r>;1H` (CUP: posiciona) + a linha nova + `\x1b[K` (limpa a CAUDA da linha,
 *    nunca a linha inteira ⇒ sem branco). Linhas IGUAIS NÃO são reescritas.
 *  · Se o frame novo tem MENOS linhas (encolheu), posiciona na 1ª linha órfã e emite
 *    `\x1b[J` (limpa do cursor até o FIM DA TELA, só pra BAIXO) p/ varrer as órfãs.
 *  · Ao fim, reposiciona o cursor EXATAMENTE onde o full-paint o deixaria — o FIM do
 *    frame (`frameEndCursor`), onde mora o caret do composer. NÃO no home: deixar no home
 *    deslocava o caret pro topo (composer "abaixo do cursor", #151-bug1) E quebrava o
 *    posicionamento RELATIVO do PRÓXIMO write (log no lugar errado sob atividade,
 *    #151-bug2). Com o cursor no fim do frame, o diff fica idêntico ao full-paint na
 *    posição final — só não repinta o que não mudou.
 *
 * Resultado: digitar 1 char ⇒ só a(s) linha(s) do composer são reescritas (1-2), NÃO as
 * `rows`. SEM varredura visível ⇒ SEM flicker, em QUALQUER terminal (não depende do
 * `?2026`). ZERO `\x1b[2J` (não regride o #150). O 1º frame (buffer vazio) PINTA TODAS as
 * linhas ⇒ pinta na entrada do alt-screen (não regride o #145).
 *
 * RESET (`reset()`): chamado quando o envelope ENTRA no cockpit (`setCockpit(true)`). O
 * alt-screen acabou de ser aberto (`?1049h`) e está VAZIO ⇒ o buffer anterior NÃO vale
 * mais; zerá-lo força o PRÓXIMO frame a pintar TUDO (pinta na entrada — #145). Sem reset,
 * o diff acharia "nada mudou" contra um frame de outra superfície e deixaria a tela preta.
 *
 * POR QUE `\x1b[K` por linha aqui (≠ o `cockpitOverwriteInPlace` antigo, que NÃO usava):
 * agora reposicionamos por CUP em linha específica e escrevemos SÓ aquela linha — sem o
 * `\x1b[K`, uma linha nova mais CURTA deixaria cauda da anterior. O `\x1b[K` limpa só do
 * cursor PRA FRENTE ⇒ não branqueia o que já está pintado ⇒ não pisca. Não fatiamos a
 * linha (cada linha do grid é uma unidade com suas bordas/ANSI) ⇒ não comemos byte de
 * conteúdo.
 *
 * Idempotência/segurança: se o chunk NÃO começa com `clearTerminal` (write parcial, Static
 * append, padrão diferente), devolve o chunk CRU e NÃO toca o buffer — nunca quebra o
 * render. Frame == anterior (re-render idêntico) ⇒ emite só o reposicionamento final (ou
 * nada de conteúdo) — nenhuma linha reescrita.
 */
export interface CockpitDiffer {
  /** Transforma UM write do Ink no diff por-linha contra o frame anterior. */
  transform(chunk: string): string;
  /** Zera o frame anterior ⇒ o próximo frame pinta TUDO (entrada do alt-screen, #145). */
  reset(): void;
}

/** Quebra o body do frame em linhas LÓGICAS por `\n`, preservando um `\r` final na linha. */
function splitFrameLines(body: string): string[] {
  // O frame do Ink termina tipicamente em `\n`; um split simples por `\n` casa as linhas
  // visuais (o Ink já fez o wrap em linhas físicas == `cols`). Mantemos o conteúdo de cada
  // linha EXATO (inclusive `\r` interno, se houver) — só o `\n` separador é consumido.
  // Um `\n` FINAL gera um '' à direita que NÃO é uma linha de conteúdo (o frame do Ink
  // termina em `\n`); descartá-lo evita uma "linha fantasma" no diff (alinhamento de índice).
  const parts = body.split('\n');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

/**
 * EST-0965 · ADR-0076 §5 (FIX EST-0965/ADR-0076 — corrupção sob streaming) — EXTRAI o BODY
 * do frame de UM write do Ink no cockpit, qualquer que seja o CAMINHO de render que o Ink
 * escolheu. CAUSA-RAIZ da corrupção: o cockpit ENCHE `rows` na maioria dos frames ⇒ o Ink
 * usa `clearTerminal`+frame (caminho `outputHeight>=rows`); MAS quando o frame ENCOLHE p/
 * `outputHeight<rows` (ex.: uma linha da conversa fica mais CURTA no streaming), o Ink cai
 * no `log-update` e emite OUTROS bytes — `eraseLines`(`\x1b[2K…`) OU conteúdo CRU (o 1º
 * `throttledLog` após um clearTerminal, com `previousLineCount=0`, escreve só o body). O
 * differ ANTIGO só casava `clearTerminal` e passava esses outros CRUS ⇒ eles eram escritos
 * a partir da posição em que o cursor PAROU (fim do frame anterior, no MEIO da tela) ⇒
 * sobrescreviam as linhas ERRADAS, deixando CAUDA da linha velha e MESCLANDO conteúdo
 * (ex.: "ajudar!ar você hoje?"; "A"→"●"). O fix: o differ OWNS os TRÊS formatos e SEMPRE
 * faz o diff POR-LINHA ABSOLUTO (CUP por linha + `\x1b[K`), independente do caminho do Ink.
 *
 * Devolve o BODY (o frame textual, sem o prefixo de erase) OU `undefined` se o chunk NÃO é
 * um frame (ex.: `\x1b[?25l`/`\x1b[?25h` puros — toggles de cursor que devem passar CRUS).
 */
function extractCockpitFrameBody(chunk: string): string | undefined {
  // 1) `clearTerminal` + frame (caminho `outputHeight>=rows` — o comum no cockpit cheio).
  if (chunk.startsWith(CLEAR_TERMINAL)) return chunk.slice(CLEAR_TERMINAL.length);
  // 2) `eraseLines(N)` + frame (caminho `log-update` quando o frame encolhe < `rows`).
  const erase = matchEraseLines(chunk);
  if (erase) return chunk.slice(erase.bodyStart);
  // 3) Conteúdo CRU sem prefixo de erase: o 1º `throttledLog` após um clearTerminal
  //    (`previousLineCount=0` ⇒ o log-update não emite eraseLines, só o body). Reconhecido
  //    por NÃO ser uma CSI pura: tem ao menos um caractere imprimível ou `\n` antes de
  //    qualquer coisa que pareça um toggle isolado. Um chunk que é SÓ escapes CSI (sem
  //    conteúdo de frame) NÃO é frame ⇒ passa cru.
  if (chunkIsFrameContent(chunk)) return chunk;
  return undefined; // toggle de cursor / escape isolado ⇒ não é frame ⇒ cru.
}

/**
 * Heurística: o chunk é CONTEÚDO DE FRAME do cockpit (≠ um escape isolado tipo `\x1b[?25l`)?
 * É frame se contém ao menos um caractere IMPRIMÍVEL (fora de sequências CSI) ou um `\n` —
 * o frame do cockpit é texto do grid. Um chunk feito SÓ de sequências CSI (sem texto nem
 * quebra) é um controle puro (mostrar/esconder cursor, sync) e NÃO deve entrar no diff.
 */
function chunkIsFrameContent(chunk: string): boolean {
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i];
    if (ch === '\x1b' && chunk[i + 1] === '[') {
      // pula a CSI inteira (params + intermediários + byte final).
      let j = i + 2;
      while (j < chunk.length && chunk[j]! >= '0' && chunk[j]! <= '?') j += 1;
      while (j < chunk.length && chunk[j]! >= ' ' && chunk[j]! <= '/') j += 1;
      i = j;
      continue;
    }
    if (ch === '\n' || ch === '\r') return true;
    // qualquer caractere fora de CSI conta como conteúdo (inclui espaço, que pinta no grid).
    return true;
  }
  return false;
}

/** Cria um renderer diferencial (1 por envelope). Estado: o buffer do frame anterior. */
export function createCockpitDiffer(): CockpitDiffer {
  let prevLines: string[] | undefined; // undefined ⇒ não há frame anterior (pinta tudo).

  const transform = (chunk: string): string => {
    // FIX (corrupção sob streaming) — o differ OWNS os TRÊS formatos de write do Ink no
    // cockpit (clearTerminal+frame, eraseLines+frame, conteúdo cru), não só o clearTerminal.
    // Antes, os outros dois passavam CRUS e eram escritos da posição em que o cursor parou
    // (meio da tela) ⇒ sobrescreviam linhas erradas, deixando cauda da velha e mesclando
    // conteúdo. Agora SEMPRE fazemos o diff por-linha ABSOLUTO (CUP+`\x1b[K`), qualquer que
    // seja o caminho do Ink. Escape isolado (toggle de cursor) ⇒ body `undefined` ⇒ cru.
    const body = extractCockpitFrameBody(chunk);
    if (body === undefined) return chunk; // não é frame (ex.: `\x1b[?25l`) ⇒ cru.

    if (body.length === 0) {
      // Erase PURO (clear de tela sem conteúdo): home + limpa PRA BAIXO. Zera o buffer —
      // a tela ficou vazia ⇒ o próximo frame pinta tudo.
      prevLines = undefined;
      return `${CURSOR_HOME}${ERASE_TO_EOS}`;
    }

    const nextLines = splitFrameLines(body);

    // 1º frame (sem anterior): PINTA TUDO no lugar. Usado na ENTRADA do alt-screen (#145, tela
    // já limpa pelo `?1049h`) E após `resetDiffer()` no RESIZE (tela COM conteúdo velho da
    // dimensão anterior).
    // FIX (EST-1015, resize-órfão) — antes era `${CURSOR_HOME}${body}${ERASE_TO_EOS}`: o
    // `\x1b[J` só apaga ABAIXO do frame, NÃO a CAUDA de cada linha. Em alt-screen fresco (entrada)
    // funciona (tela vazia); mas no RESIZE, uma linha que ENCOLHEU deixava a cauda velha na tela
    // (ex.: "◷ agentes" novo + "server(s)…" velho ⇒ "◷ agentesserver(s)"). Agora pintamos
    // LINHA-A-LINHA com `\x1b[K` (apaga a cauda de cada linha) + `\x1b[J` abaixo — idêntico ao
    // diff contra tela vazia. ZERO `\x1b[2J` ⇒ sem branqueamento/flicker (#150 intacto). Na
    // entrada (tela já limpa) o `\x1b[K` por linha é inócuo.
    if (prevLines === undefined) {
      prevLines = nextLines;
      // Pinta linha-a-linha com `\x1b[K` ENTRE as linhas (apaga a cauda de CADA uma) e `\x1b[J`
      // ao fim (varre as órfãs ABAIXO). O cursor termina no fim do frame, igual ao full-paint
      // antigo (sem CUP além da tela). Em tela fresca (entrada do alt-screen) os `\x1b[K` são
      // inócuos; no RESIZE eles limpam a cauda velha. ZERO `\x1b[2J` ⇒ sem branqueamento (#150).
      return `${CURSOR_HOME}${nextLines.join(`${ERASE_TO_EOL}\n`)}${ERASE_TO_EOS}`;
    }

    // DIFF por-linha: emite SÓ as linhas que mudaram, posicionando cada uma por CUP.
    let out = '';
    const maxLen = Math.max(prevLines.length, nextLines.length);
    for (let r = 0; r < nextLines.length; r += 1) {
      const next = nextLines[r] ?? '';
      const prev = prevLines[r];
      if (prev === next) continue; // linha igual ⇒ NÃO reescreve (é o que mata o flicker).
      // posiciona na linha r (1-based) + escreve a linha nova + limpa a cauda (não a linha toda).
      out += `${cursorTo(r + 1)}${next}${ERASE_TO_EOL}`;
    }
    // Frame ENCOLHEU: há linhas órfãs do frame anterior abaixo da última nova ⇒ varre PRA BAIXO.
    if (nextLines.length < prevLines.length) {
      out += `${cursorTo(nextLines.length + 1)}${ERASE_TO_EOS}`;
    }
    // (`maxLen` documenta a varredura: linhas [next..prev) são as órfãs cobertas pelo `\x1b[J`.)
    void maxLen;

    prevLines = nextLines;
    // FIX #151 — REPOSICIONA o cursor EXATAMENTE onde o full-paint o deixaria: no FIM do
    // frame (onde o caret do composer mora), NÃO no home. Antes daqui ficava `CURSOR_HOME`
    // ⇒ o caret aparecia no topo (composer "abaixo do cursor") E qualquer write seguinte de
    // posicionamento RELATIVO (ex.: o `log-update` do Ink num frame `outputHeight<rows`)
    // partia do home errado ⇒ log no lugar errado sob atividade. `frameEndCursor(body)`
    // devolve a MESMA {row,col} que escrever o body inteiro a partir do home deixaria — o
    // diff vira IDÊNTICO ao full-paint na posição final do cursor, só sem repintar o que
    // não mudou. Se NADA mudou, `out` é '' ⇒ só o reposicionamento final (sem repaint).
    const end = frameEndCursor(body);
    return `${out}${cursorToRC(end.row, end.col)}`;
  };

  const reset = (): void => {
    prevLines = undefined;
  };

  return { transform, reset };
}

/**
 * Um stdout ENVELOPADO no acabamento de render: cada `write(chunk)` do Ink passa pelo
 * `overwriteInPlace` (sobrescreve-no-lugar) e, opcionalmente, sai envolto em BSU…ESU
 * (`?2026`). O `cleanup()` emite o ESU FINAL (best-effort) p/ NUNCA deixar o terminal
 * preso em modo sync ao sair/cair — chame no unmount/exit/sinal.
 */
export interface SyncStdout {
  /** O stream a passar p/ `render(<App/>, { stdout })`. */
  readonly stdout: NodeJS.WriteStream;
  /** Emite o ESU final (idempotente). Garante que o terminal saia do modo sync. */
  cleanup(): void;
  /**
   * EST-0965 · ADR-0076 §5 — alterna o MODO COCKPIT do envelope. Ativo (`true`) troca o
   * transform de frame: usa `cockpitOverwriteInPlace` (para o `clearTerminal` do alt-screen)
   * em vez de `overwriteInPlace` (para o `eraseLines` do inline). Ambos são sobrescreve-no-
   * lugar (ZERO branqueamento), só casam padrões de erase DIFERENTES — porque o Ink emite
   * bytes diferentes em cada superfície (clearTerminal `\x1b[2J\x1b[3J\x1b[H` no alt-screen;
   * eraseLines `\x1b[2K…` no inline). É o que MATA o flicker do cockpit no xterm-sem-`?2026`.
   *
   * (HISTÓRIA: o #144 originalmente DESLIGAVA o overwrite no cockpit p/ matar a "tela preta";
   * mas a tela preta era a ORDEM do `?1049h` vir DEPOIS do 1º frame — corrigida em separado
   * pelo #145. Desligar o transform foi exagero e trouxe o flicker de volta. Agora o cockpit
   * tem seu PRÓPRIO transform flicker-free.)
   *
   * O `?2026` (sync atômico) PERMANECE nas duas superfícies. Inline (default) ⇒ `false`.
   */
  setCockpit(active: boolean): void;
  /**
   * EST-1000 · ADR-0076 §5 (P2-D) — RESETA o renderer diferencial do cockpit SEM tocar o
   * modo (`cockpitActive`) nem o alt-screen. Força o próximo frame a pintar TUDO. Usado no
   * RESIZE-em-tamanho (cockpit continua cabendo, mas `rows`/`columns` mudaram): o `prevLines`
   * do differ é de outra dimensão ⇒ o diff por-linha compararia frames incompatíveis (lixo).
   * No-op fora do cockpit (o transform do inline não usa o differ). Idempotente.
   */
  resetDiffer(): void;
}

/** Opções do wrapper — ambos os toggles default ON. Injetáveis p/ teste. */
export interface WrapOptions {
  /** Envolver cada frame em `?2026` (BSU…ESU). Default ON (`ALUY_SYNC_OUTPUT≠0`). */
  readonly sync?: boolean;
  /** Aplicar o overwrite-in-place. Default ON (`ALUY_OVERWRITE_RENDER≠0`). */
  readonly overwrite?: boolean;
  /**
   * F198 — chamado (deferido, 1×) na SAÍDA do regime clearTerminal do INLINE (região viva
   * VOLTA a caber em `rows`, ver `createOverflowRegimeTracker`). O caller (run.tsx) liga isto
   * ao `clearScreen` da App p/ LIMPAR a tela + re-emitir o histórico e neutralizar o desync do
   * `previousLineCount` do Ink (o BLOCO GIGANTE de linhas em branco). Ausente ⇒ sem detecção
   * (comportamento antigo). Só dispara quando o regime foi de fato ENTRADO — zero custo/efeito
   * em terminais onde a viva sempre cabe (o caso comum).
   */
  readonly onOverflowRegimeExit?: () => void;
}

/**
 * Envolve um `NodeJS.WriteStream` (tipicamente `process.stdout`) p/ o acabamento de
 * render: cada frame do Ink (1) é transformado em SOBRESCREVE-no-lugar (mata o flicker
 * em qualquer terminal) e (2) opcionalmente sai atômico (`?2026`). Implementado como
 * PROXY sobre o stream original: só o `write` de DADOS DE FRAME é interceptado; todo o
 * resto (`isTTY`, `columns`, `rows`, `on`, `cork`, …) é delegado intacto — o Ink
 * precisa dessas propriedades p/ calcular o layout.
 *
 * Robustez:
 *  · `write(chunk)` ⇒ `original.write([BSU] + overwriteInPlace(chunk) + [ESU])` — UMA
 *    chamada ao stream real (concatenado), pra não fatiar o frame em writes separados.
 *  · `overwriteInPlace` degrada pro cru se o padrão de erase não casar ⇒ nunca quebra.
 *  · `cleanup()` emite `ESU` uma única vez (flag idempotente): se o processo morrer no
 *    meio de um frame, o terminal não fica em sync e o cursor reaparece.
 *  · chunks vazios / `write` sem dados ⇒ delega cru (nada a transformar/envolver).
 */
export function wrapStdoutWithSync(
  original: NodeJS.WriteStream,
  options: WrapOptions = {},
): SyncStdout {
  const useSync = options.sync ?? true;
  const useOverwrite = options.overwrite ?? true;
  const onOverflowRegimeExit = options.onOverflowRegimeExit;
  // F198 — rastreia o regime clearTerminal (inline) pelos BYTES p/ sinalizar a borda de saída.
  const overflowRegime = createOverflowRegimeTracker();
  let cleanedUp = false;
  // EST-0965 · ADR-0076 §5 — MODO COCKPIT: enquanto ativo, usa o RENDERER DIFERENCIAL do
  // alt-screen (`cockpitDiffer`, diff por-linha contra o frame anterior) em vez do transform
  // do inline (`overwriteInPlace`, p/ o `eraseLines`). Ver `setCockpit`. Começa OFF (inline é
  // o default); o wiring liga/desliga no toggle do `/fullscreen` e no boot `--fullscreen`.
  // Mutável de propósito: o MESMO envelope serve as duas superfícies ao longo da sessão.
  let cockpitActive = false;
  // O renderer diferencial carrega o FRAME ANTERIOR (estado por envelope). Resetado ao
  // ENTRAR no cockpit (`setCockpit(true)`) ⇒ o 1º frame pinta tudo (pinta na entrada, #145).
  const cockpitDiffer = createCockpitDiffer();

  const wrappedWrite = ((
    chunk: string | Uint8Array,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    // Normaliza a assinatura sobrecarregada do Writable.write.
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    const encoding = typeof encodingOrCb === 'string' ? encodingOrCb : undefined;

    // Nada a transformar (frame vazio) ⇒ delega cru, preservando o contrato do callback.
    const isEmpty =
      chunk === undefined ||
      chunk === null ||
      (typeof chunk === 'string' ? chunk.length === 0 : chunk.byteLength === 0);
    if (isEmpty) {
      return original.write(chunk as string, encoding as BufferEncoding, callback as () => void);
    }

    const body = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    // F198 — no INLINE, detecta a SAÍDA do regime clearTerminal (`outputHeight >= rows`) pelos
    // BYTES e sinaliza o caller (deferido, fora do write reentrante) p/ limpar+re-emitir o
    // histórico — neutraliza o `previousLineCount` obsoleto do Ink (bloco gigante de branco na
    // resposta longa). Independe do `overwrite` (o regime é do Ink, não do transform). O cockpit
    // (alt-screen) não tem scrollback ⇒ fora do detector. Zero efeito quando a viva sempre cabe.
    if (onOverflowRegimeExit !== undefined && !cockpitActive && overflowRegime.feed(body)) {
      queueMicrotask(onOverflowRegimeExit);
    }
    // EST-0965 · ADR-0076 §5 — o anti-flicker tem padrão DIFERENTE em cada superfície
    // (o Ink emite bytes diferentes em cada uma):
    //  · COCKPIT (alt-screen): o Ink usa `clearTerminal` (`\x1b[2J\x1b[3J\x1b[H`) + frame
    //    INTEIRO a cada render ⇒ o `cockpitDiffer` faz DIFF POR-LINHA: emite só as linhas
    //    que mudaram (CUP+linha+`\x1b[K`), NÃO o frame cheio. Mata o `\x1b[2J` (#150) E o
    //    repaint de tela inteira (flicker RESIDUAL: 1 char repintava ~`rows` linhas).
    //  · INLINE (default): o Ink usa `eraseLines` (`\x1b[2K…`) ⇒ `overwriteInPlace` troca
    //    a corrida de `\x1b[2K` por cursor-up + sobrescreve (#95/#118 intactos).
    // (HISTÓRIA: #144 desligava o overwrite no cockpit (tela preta era a ORDEM do `?1049h`,
    //  #145); #150 deu ao cockpit um transform full-paint flicker-free do `\x1b[2J`; mas o
    //  full-paint repintava a tela TODA por frame ⇒ flicker residual no xterm-sem-2026. O
    //  diff por-linha repinta SÓ o que mudou ⇒ zera o flicker em QUALQUER terminal.)
    const transformed = !useOverwrite
      ? body
      : cockpitActive
        ? cockpitDiffer.transform(body)
        : overwriteInPlace(body);
    const framed = useSync ? `${BEGIN_SYNC}${transformed}${END_SYNC}` : transformed;
    // UM único write ao stream real: tudo concatenado e atômico.
    return original.write(framed, callback as () => void);
  }) as NodeJS.WriteStream['write'];

  // PROXY: delega tudo ao stream real; só `write` é o nosso. Mantém `this` ligado ao
  // original p/ os métodos delegados (on/once/cork/columns getters etc.).
  const proxy = new Proxy(original, {
    get(target, prop, receiver) {
      if (prop === 'write') return wrappedWrite;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as NodeJS.WriteStream;

  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    // ESU final CRU (não pelo proxy — senão re-transformaria). Best-effort.
    if (!useSync) return; // sem `?2026`, não há modo sync p/ desfazer.
    try {
      original.write(END_SYNC);
    } catch {
      // saída já fechada ⇒ nada a fazer; não derruba o exit.
    }
  };

  // EST-0965 · ADR-0076 §5 — liga/desliga o modo cockpit do envelope (troca o transform de
  // frame: renderer diferencial do alt-screen vs overwrite do inline). Não emite byte algum
  // — só muda a transformação dos PRÓXIMOS writes (a entrada/saída do alt-screen é do wiring).
  // Ao ENTRAR (true), RESETA o renderer diferencial: o alt-screen acabou de abrir (`?1049h`)
  // e está VAZIO ⇒ o frame anterior não vale mais ⇒ o próximo frame pinta TUDO (pinta na
  // entrada, #145). Sem o reset, o diff acharia "nada mudou" e a tela ficaria preta.
  // Idempotente nos PRÓXIMOS writes; o reset em true→true só re-arma o full-paint (inócuo:
  // o frame seguinte é idêntico ao que está na tela ⇒ repinta 1 vez, sem dano).
  const setCockpit = (active: boolean): void => {
    if (active) cockpitDiffer.reset();
    cockpitActive = active;
  };

  // EST-1000 · ADR-0076 §5 (P2-D) — reset DEFENSIVO do differ no resize-em-tamanho (sem
  // tocar `cockpitActive`/alt-screen). Inócuo fora do cockpit (o full-paint só vale quando
  // o transform do alt-screen está ativo). Ver `resetDiffer` em SyncStdout.
  const resetDiffer = (): void => {
    cockpitDiffer.reset();
  };

  return { stdout: proxy, cleanup, setCockpit, resetDiffer };
}

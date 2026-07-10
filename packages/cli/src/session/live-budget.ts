// EST-0965 — ANTI-FLICKER: orçamento de altura da REGIÃO VIVA (dinâmica).
//
// O bug ("refresh toda hora"): o Ink faz `clearTerminal + redesenha TUDO` (header
// no Static + histórico + região viva) quando a altura da região DINÂMICA viva
// estoura o terminal (`ink.js`: `outputHeight >= rows`). Esse redesenho é o tremor.
//
// A região viva NÃO é só a prévia de FALA (aluy streaming). Durante trabalho
// agêntico ela tem TAMBÉM, no MESMO frame:
//   • o(s) tool-line(s) `running` (1 linha cada, via <Working>);
//   • o bloco de sub-agentes (cabeçalho + 1 linha por filho);
//   • o indicador <Working> de `thinking` (1 linha, +1 de paddingTop se há blocos);
//   • o marcador `… (N linhas acima)` da janela de cauda (1 linha quando corta);
//   • o cursor do stream (1 linha, largura/altura constante — EST-0956);
//   • paddings de cada bloco e o `paddingY={1}` do contêiner da região viva.
//
// O orçamento ANTIGO (`rows - 13`) era passado INTEIRO ao teto da fala, como se só
// a fala ocupasse a viva. Com tool+working+…N o total virava `rows + N` ⇒ estouro
// ⇒ flicker a cada frame. O fix: o teto da FALA = `rows - chrome_fixo - linhas_dos_
// _outros_blocos_vivos_no_frame`, com FOLGA (mira `total ≤ rows - 1`, pois o gatilho
// do Ink é `>=`).
//
// PURO (sem React/Ink): conta as alturas pela MESMA composição do <App> (documentada
// linha-a-linha abaixo). Testável sem TUI — e um teste de integração confere a conta
// renderizando a região viva de verdade e contando as linhas do frame do Ink.
//
// EST-0965 (WRAP) — a ressalva que sobrou do #59/#64: TODA esta contagem era em
// linhas-FONTE (1 por `\n`). Uma linha mais larga que `columns` QUEBRA em VÁRIAS
// linhas VISUAIS no terminal (output real de agente: JSON, paths, logs). Então a
// altura REAL passava do orçado ⇒ estouro de `rows` ⇒ flicker. Agora o orçamento
// recebe `columns` e conta linhas VISUAIS (`visual-lines.ts`): o teto da fala, a
// saída ao vivo do comando, e a janela de cauda — tudo ciente de wrap. `columns`
// ausente/0 ⇒ cai p/ linhas-fonte (degradação graciosa, comportamento antigo).

import type { SessionBlock, SessionState } from './model.js';
import { displayWidth, visualLines } from './visual-lines.js';

/** Fase da sessão (do model) — o que distingue `thinking` (pré-stream) dos demais. */
type SessionPhase = SessionState['phase'];

/** Modo da catraca (do model) — `unsafe` infla o `<ModeIndicator>` (banner). */
type SessionMode = SessionState['mode'];

/**
 * CHROME FIXO da região viva = o rodapé sempre-presente DEPOIS dos blocos vivos,
 * mais os paddings do contêiner da região viva. Re-derivado da composição do <App>
 * PÓS-EST-0989 (o header e suas divisórias saíram p/ o `<Static>` no topo — NÃO
 * contam mais aqui). Conta linha-a-linha (durante um stream, com turnos na tela):
 *
 *   1  contêiner da viva `<Box paddingY={1}>` — padding de CIMA
 *   1  contêiner da viva `<Box paddingY={1}>` — padding de BAIXO
 *   1  <Divider> ACIMA do input (EST-0985; INCONDICIONAL — emoldura o composer
 *        SEMPRE, inclusive em sessão fresca/pós-`/clear`. Antes era gated por
 *        `hasTurns`, mas o orçamento já o contava como presente — no pior caso
 *        (stream) sempre há turno — então retirar o gate NÃO mexe nesta conta.)
 *   1  <Composer> (input — 1 linha no caso comum de objetivo de 1 linha)
 *   1  <Divider> ABAIXO do input (EST-0985)
 *   1  RESPIRO (EST-0989): 1 LINHA EM BRANCO entre o TurnFooter/quota e o <StatusBar>
 *        (`<Box height={1}>`). Variação B — separa o resumo do turno do rodapé vivo.
 *        CONDICIONAL: só RENDERIZA em telas ALTAS (`rows ≥ RESPIRO_MIN_ROWS`) e largas
 *        (`columns ≥ 60`); some em terminais BAIXOS/narrow (onde 1 linha decorativa
 *        comeria a fala e o anti-flicker apertaria). Por isso é contado À PARTE do
 *        chrome BASE (ver `respiroOverhead`), igual ao excedente do banner unsafe —
 *        NÃO inflando o orçamento quando ausente. O `LIVE_CHROME_ROWS` exportado JÁ é
 *        base+respiro (=9, o caso tela alta) p/ o teste de altura ancorar o frame real.
 *   1  <StatusBar> (rodapé: ◷ tier · cwd · ⛁ janela · ◔ sessão · ◔ quota)
 *   1  <ModeIndicator> (EST-0989: foi p/ o rodapé, DENTRO da viva) — BASE: 1 linha
 *        (`plan`/`normal`). Em `unsafe` ele vira o BANNER e ocupa MAIS — a folga
 *        NÃO basta; o excedente é orçado à parte (ver `modeIndicatorOverhead`).
 *   1  <FooterHints> (atalhos; presente quando `density !== 'compact'`)
 *   ───
 *   9  total (tela alta: base 8 + respiro 1)
 *
 * NÃO entram aqui (variáveis/condicionais, contados à parte ou ausentes no stream):
 *   • o RESPIRO (EST-0989) em telas BAIXAS/narrow — `respiroOverhead` o conta SÓ
 *     quando de fato renderiza (`rows ≥ RESPIRO_MIN_ROWS`), espelhando o render;
 *   • o(s) bloco(s) vivo(s) — fala/tool/subagents/working/…N (ver `liveOverheadLines`);
 *   • <TurnFooter> (só em `done`/`budget`, NUNCA durante o stream);
 *   • overlays modais (slash/palette/pickers) — capturam o foco e não coexistem
 *     com o stream vivo na prática;
 *   • o EXCEDENTE do banner UNSAFE — o `<ModeIndicator mode="unsafe">` reusa o
 *     <UnsafeBanner>, cuja frase longa QUEBRA p/ 2 linhas em larguras médias (60–80
 *     colunas). A base acima conta 1 linha (o caso `plan`/`normal`); o excedente
 *     (`UNSAFE_INDICATOR_ROWS − MODE_INDICATOR_BASE_ROWS`) é subtraído do teto da
 *     fala SÓ em `unsafe` (`modeIndicatorOverhead`). Era ESTE o furo da EST-0965:
 *     supor que a folga (`SAFETY_MARGIN=2`) "cobria" o banner — não cobria, e em
 *     `--unsafe` a região viva estourava `rows` ⇒ o Ink redesenhava tudo (flicker).
 */
export const LIVE_CHROME_ROWS = 9;

/**
 * Chrome fixo do rodapé SEM o respiro (EST-0989) — o caso tela BAIXA/narrow, onde a
 * linha em branco não renderiza. É o piso que o orçamento sempre reserva; o respiro é
 * somado À PARTE (`respiroOverhead`) só quando de fato aparece. Mantém o anti-flicker
 * EXATO: em telas apertadas a região viva cabe em `rows-1` sem a linha decorativa.
 */
export const LIVE_CHROME_BASE_ROWS = 8;

/** Altura (linhas) do RESPIRO (EST-0989): 1 linha em branco. `LIVE_CHROME_ROWS` − base. */
export const RESPIRO_ROWS = LIVE_CHROME_ROWS - LIVE_CHROME_BASE_ROWS;

/**
 * Piso de LINHAS p/ o RESPIRO renderizar (EST-0989). Abaixo disto o rodapé fica
 * apertado (banner unsafe + sub-agentes + tool + fala longa já lotam `rows-1`), então
 * a linha em branco SOME — anti-flicker antes de estética. Ancorado no PIOR caso do
 * orçamento: base(8) + respiro(1) + unsafe(1) + overhead típico(9) + piso da fala(4)
 * + marcador(1) = 24 ⇒ precisa de `rows ≥ 25` p/ caber em `rows-1`. Igual ao gate de
 * largura (`columns ≥ 60`) que vive no <App>.
 */
export const RESPIRO_MIN_ROWS = 25;

/**
 * Linhas do RESPIRO a descontar do teto da fala NESTE frame: `RESPIRO_ROWS` quando a
 * tela é alta o bastante p/ ele renderizar (`rows ≥ RESPIRO_MIN_ROWS`), senão 0 (o
 * respiro não aparece ⇒ não consome altura). Espelha o gate de render do <App>.
 */
export function respiroOverhead(rows: number): number {
  return rows >= RESPIRO_MIN_ROWS ? RESPIRO_ROWS : 0;
}

/**
 * Altura BASE (linhas) do `<ModeIndicator>` JÁ embutida em `LIVE_CHROME_ROWS`: 1
 * linha, o caso `plan`/`normal` (glifo + palavra + caption numa só `<Box>`).
 */
export const MODE_INDICATOR_BASE_ROWS = 1;

/**
 * Altura REAL (linhas) do `<ModeIndicator mode="unsafe">` no PIOR caso de largura.
 * Em `unsafe` o indicador é o <UnsafeBanner>: uma `<Box>` com a frase longa
 *   "⚠ MODO YOLO — aprovação DESLIGADA, o agente roda QUALQUER comando sem perguntar"
 * (~79 colunas visíveis; EST-0959 renomeou o nome de PRODUTO p/ YOLO). Em terminais
 * de largura MÉDIA (60–78 colunas) a frase QUEBRA p/ 2 linhas (acima de ~79 cabe em
 * 1; abaixo de 60 troca p/ a frase curta, que cabe em 1). Logo o MÁXIMO é 2 linhas.
 *
 * Ancorado por um teste de UNIDADE que RENDERIZA o `<ModeIndicator mode="unsafe">`
 * de verdade (Ink testing) na largura crítica e afirma 2 — se o banner mudar de
 * forma (mais texto, borda, multi-linha), o teste quebra e força revisar ESTA
 * constante. NÃO é um chute "cabe na folga": é a altura medida do componente real.
 */
export const UNSAFE_INDICATOR_ROWS = 2;

/**
 * Excedente (linhas) do `<ModeIndicator>` ALÉM da base já contada no chrome, por
 * modo. `plan`/`normal` = 0 (a base de 1 já cobre). `unsafe` = `UNSAFE_INDICATOR_
 * ROWS − MODE_INDICATOR_BASE_ROWS` (o banner que quebra p/ 2 linhas custa +1).
 * Subtraído do teto da fala SÓ quando há de fato esse excedente (anti-flicker).
 */
export function modeIndicatorOverhead(mode: SessionMode): number {
  return mode === 'unsafe' ? UNSAFE_INDICATOR_ROWS - MODE_INDICATOR_BASE_ROWS : 0;
}

/**
 * FOLGA de segurança: o gatilho do Ink é `outputHeight >= rows`, então mirar
 * `total === rows` AINDA dispara o redesenho. Reservamos +1 p/ garantir
 * `total ≤ rows - 1` (a spec pede 1-2 linhas de folga). Absorve também 1 linha
 * extra eventual (composer de 2 linhas, caption que quebra, etc.).
 */
export const SAFETY_MARGIN = 2;

/**
 * F163 — EXCEDENTE do chrome em TERMINAL ESTREITO. O chrome base conta 1 linha p/
 * <StatusBar> e 1 p/ <FooterHints>, mas ambos são linhas LARGAS (status: tier ·
 * provider/modelo · cwd · janela · sessão ≈ 70–120 colunas; hints ≈ 66–70) — em
 * colunas < 80 QUEBRAM (wrap) p/ 2 linhas visuais CADA, sem entrar no orçamento.
 * Em telas com sobra o SAFETY_MARGIN absorvia; em telas BAIXAS (≤ 22 linhas) o
 * frame cruzava `rows` e o Ink caía no caminho `clearTerminal + fullStaticOutput`
 * A CADA FRAME — numa sessão gigante isso reescreve o histórico INTEIRO por frame
 * (medido no stress do F163: 22x60 ⇒ 32 clears / 15 MB reescritos em ~3s; 24x60 e
 * 20x80 limpos — a fronteira é a LARGURA que dobra o chrome). Mesmo padrão do
 * excedente do banner unsafe: base no chrome, excedente por condição, medido e
 * ancorado por teste. `columns` ausente/0 ⇒ 0 (comportamento antigo).
 */
export const NARROW_CHROME_MAX_COLS = 80;
export function narrowChromeOverhead(columns?: number): number {
  if (columns === undefined || columns <= 0) return 0;
  // < 80 colunas: StatusBar +1 e FooterHints +1 (cada um quebra p/ 2 visuais).
  return columns < NARROW_CHROME_MAX_COLS ? 2 : 0;
}

/** Piso do teto da fala: nunca menos que isto, mesmo em terminais minúsculos. */
export const MIN_SPEECH_LINES = 4;

/**
 * EST-0982 — teto FIXO de linhas da SAÍDA AO VIVO de um `run_command`/`!comando`
 * em `running` (a prévia bounded sob a linha `◌ rodando…`). FIXO (não derivado do
 * `speechMaxLines`) p/ QUEBRAR a circularidade: o orçamento da fala subtrai esta
 * altura como overhead, e a altura não pode depender do orçamento da fala. Pequeno
 * de propósito — a janela de cauda mostra o progresso recente sem inflar a região
 * viva (anti-flicker: a região cabe em `rows-1`). O scrollback completo do comando
 * vai no resultado final (já no Static) — aqui é só a prévia viva.
 */
export const LIVE_SHELL_OUTPUT_MAX_LINES = 6;

/**
 * F163 — cap ADAPTATIVO da cauda viva de shell: `LIVE_SHELL_OUTPUT_MAX_LINES` era
 * FIXO (6), mas em tela BAIXA (≤ 22 linhas) + chrome estreito o frame não tem 6
 * linhas p/ dar — a cauda cheia cruzava `rows` e o Ink caía no `clearTerminal +
 * fullStaticOutput` a cada frame (medido no stress do F163: o frame vivo somava 23
 * linhas num terminal de 22). Reserva: chrome base + excedente estreito + folga +
 * `LIVE_SHELL_RESERVED_ROWS` (cabeçalho `◌ running` que quebra em até 3 + marcador
 * `…N acima` + os paddings do bloco — medidos no capture). Piso 1 (sempre mostra
 * progresso); teto `LIVE_SHELL_OUTPUT_MAX_LINES` (telas normais ficam IDÊNTICAS).
 * É o MESMO cap que o render usa (<ToolLine>/<BangBlock> via App) e que o orçamento
 * conta (`liveShellOutputLines`) — uma fonte só, a conta fecha por construção.
 */
export const LIVE_SHELL_RESERVED_ROWS = 6;
export function liveShellTailMaxLines(rows: number, columns?: number): number {
  if (!(rows > 0)) return LIVE_SHELL_OUTPUT_MAX_LINES;
  const available =
    rows -
    LIVE_CHROME_BASE_ROWS -
    narrowChromeOverhead(columns) -
    SAFETY_MARGIN -
    LIVE_SHELL_RESERVED_ROWS;
  return Math.max(1, Math.min(LIVE_SHELL_OUTPUT_MAX_LINES, available));
}

/**
 * HUNT-RENDER — teto de CARACTERES (não linhas) do raw string da saída ao vivo de
 * um comando em `running`. O `windowTailVisual` processa o texto INTEIRO a cada tick
 * (~120ms) — `.split('\\n')` + `visualLines()` em cada linha. Com output grande de
 * script Python (MBs de log), isso vira jank/flicker VISÍVEL mesmo que o resultado
 * final seja capado em 6 linhas visuais. Aqui cortamos o RAW string em NO MÁXIMO
 * este nº de CHARACTERS (da cauda) ANTES de alimentar o `windowTailVisual`. O custo
 * vira O(1) em vez de O(tamanho do output).
 *
 * 8192 chars (~1 tela de 80×100) é suficiente p/ a janela de 6 linhas visuais: no
 * pior caso (1 linha única sem `\\n`), a `clampLineToVisualTail` mantém `maxLines ×
 * columns` ≈ 6×80 = 480 chars. Com várias linhas-fonte, `windowTailVisual` seleciona
 * as últimas N linhas-fonte cuja soma visual ≤ 6 — e tipicamente cada uma é curta.
 * 8192 dá margem de 17× p/ o pior caso e ainda garante processamento <0.5ms.
 */
export const MAX_LIVE_OUTPUT_CHARS = 8192;

/**
 * F61 (anti-flicker) — teto de CARACTERES do raw string da PRÉVIA DE FALA (aluy
 * streaming) ANTES de `cleanAluyForDisplay` + `windowTailVisual` no <AluyBlock>.
 *
 * O furo que sobrava: o <AluyBlock> rodava `cleanAluyForDisplay(props.text)` (várias
 * varreduras regex no texto INTEIRO: strip-think, loop de tool-call, prefixo no rabo)
 * e DEPOIS `windowTailVisual(full, …)` (`.split('\n')` + `visualLines()` em cada linha)
 * — TUDO sobre o texto acumulado INTEIRO, a cada tick (~120ms, o pulso do cursor). Com
 * uma resposta GRANDE streamada (muitas linhas / MBs), esse reprocessamento por frame
 * O(tamanho-do-texto) vira jank/flicker VISÍVEL, mesmo que a janela só pinte as últimas
 * N linhas visuais. (Era o irmão NÃO-resolvido do mesmo problema já corrigido na saída
 * ao vivo de comandos via `clampLiveOutputChars`/`MAX_LIVE_OUTPUT_CHARS`.)
 *
 * O fix: durante o STREAM, cortamos o RAW na CAUDA p/ este nº de chars ANTES da
 * limpeza+janela. A região viva só MOSTRA a cauda (a janela de `maxLines` visuais),
 * então o conteúdo VISÍVEL é idêntico — só o custo por tick vira O(1) em vez de
 * O(tamanho). O turno FINALIZADO (streaming=false) NÃO é cortado: o bloco inteiro
 * desce p/ o <Static> (nada se perde no scrollback).
 *
 * 65536 chars (~64KB) dá folga ENORME p/ a maior janela possível de fala — mesmo num
 * terminal de 50 linhas × 200 colunas a janela visível cabe em ~10K chars; 64KB é ~6×
 * isso, então o corte NUNCA afeta o conteúdo pintado e ainda mantém o processamento por
 * tick limitado (independente de o stream ter 100KB ou 100MB).
 */
export const MAX_LIVE_SPEECH_CHARS = 65536;

/**
 * HUNT-RENDER — corta `text` nos ÚLTIMOS `maxChars` caracteres (code points), p/
 * limitar o custo de processamento a cada tick. Preserva a integridade de code
 * points (nunca parte um surrogate pair / emoji astral). Apara quebras de linha
 * iniciais (o marcador `… (N linhas acima)` do `windowTailVisual` já sinaliza o
 * corte). O caller (ToolLine/BangBlock) aplica isto ANTES de `windowTailVisual`.
 *
 * PURO.
 */
export function clampLiveOutputChars(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const tail = chars.slice(chars.length - maxChars).join('');
  return tail.replace(/^\n+/, '');
}

/**
 * Indentação (colunas) da SAÍDA AO VIVO de um comando em `running`: a tool/bang está
 * num `<Box paddingLeft={2}>` e a saída num `<Box paddingLeft={2}>` ANINHADO ⇒ 4
 * colunas. O wrap da saída acontece em `columns - 4` — usado p/ medir a altura
 * VISUAL real da prévia (espelha `LIVE_OUTPUT_INDENT` de ToolLine/BangBlock).
 */
export const LIVE_OUTPUT_INDENT = 4;

/**
 * Altura (linhas) de UM bloco vivo que NÃO é a prévia de fala (aluy streaming).
 * Espelha a composição do `BlockView` no <App> p/ cada tipo de bloco vivo:
 *
 *   • tool `running`  → <ToolLine> in-flight = <Working> numa `<Box paddingLeft={2}>`
 *                       = 1 linha (sem paddingBottom).
 *   • subagents       → <SubAgents>: cabeçalho (1) + 1 linha por filho + paddingBottom
 *                       (1) = `2 + nFilhos`.
 *   • aluy NÃO-stream  → não ocorre na região viva (só o streaming é vivo), mas se
 *                       aparecer conta como bloco concluído: cabeçalho + corpo +
 *                       paddingBottom. Tratado como 0 aqui (a fala viva é a do stream,
 *                       orçada à parte); blocos `aluy` concluídos já migraram p/ o Static.
 *
 * A prévia de FALA (aluy streaming) NÃO entra aqui — é o que ESTAMOS orçando.
 */
function nonSpeechBlockLines(
  block: SessionBlock,
  columns: number,
  tailMax: number = LIVE_SHELL_OUTPUT_MAX_LINES,
): number {
  if (block.kind === 'tool') {
    // Só a tool `running` é viva; a concluída já desceu p/ o Static.
    // EST-0982 — a tool `running` é a linha `◌ in-flight` + a SAÍDA AO VIVO bounded
    // (`run_command` streamando): até `LIVE_SHELL_OUTPUT_MAX_LINES` linhas VISUAIS + 1
    // do marcador `…N acima` quando corta. Orçar isso evita estouro ⇒ anti-flicker.
    // F163 — a linha `◌ <gerúndio> <alvo>` era contada como 1 FIXA, mas o alvo
    // (clampado a ~100 chars) QUEBRA p/ 2+ visuais em terminal estreito.
    return block.status === 'running'
      ? runningHeaderVisualLines(`${block.verbGerund ?? 'rodando'} ${block.target}`, columns) +
          liveShellOutputLines(block.liveOutput, columns, tailMax)
      : 0;
  }
  // EST-0982 — o `!comando` (bang) em `running` também streama: mesma conta.
  // F163 — idem: o cabeçalho `! <comando>` largo quebra em terminal estreito.
  if (block.kind === 'bang') {
    return block.status === 'running'
      ? runningHeaderVisualLines(block.command, columns) +
          liveShellOutputLines(block.liveOutput, columns, tailMax)
      : 0;
  }
  if (block.kind === 'subagents') {
    // cabeçalho (1) + paddingBottom (1) + as linhas VISUAIS de cada filho. F87 —
    // antes era `2 + children.length` (1 linha-FONTE por filho, NÃO wrap-aware): um
    // filho com label longo / terminal estreito (cmd 80-col) QUEBRA em ≥2 linhas
    // visuais ⇒ o bloco fica mais alto que o orçado ⇒ a região viva estoura `rows` ⇒
    // o Ink redesenha tudo (flicker). Agora conta linhas VISUAIS (espelha o WRAP do
    // bloco de tool em `liveShellOutputLines`). Over-contar é seguro (anti-flicker).
    let childVisualLines = 0;
    for (const c of block.children) childVisualLines += subAgentChildVisualLines(c, columns);
    return 2 + childVisualLines;
  }
  // EST-0948 (auto-retry) — o bloco `broker-error` em BACKOFF (`retrying`) é VIVO
  // (countdown re-renderiza a cada segundo): a caixa tem cabeçalho + mensagem +
  // status/countdown + afordância + régua de fundo ≈ 5 linhas. Orçá-lo evita que a
  // região viva estoure `rows-1` e dispare o redesenho de frame inteiro (anti-flicker).
  if (block.kind === 'broker-error') return block.retrying === true ? 5 : 0;
  // Qualquer outro bloco vivo (não esperado) — conservador: 1 linha.
  if (block.kind === 'aluy') return 0; // a fala viva é orçada à parte.
  return 1;
}

/**
 * EST-0982 / EST-0965 (wrap) — linhas VISUAIS ocupadas pela SAÍDA AO VIVO bounded de
 * um comando em `running`. A prévia renderiza, sob o `◌ rodando…`, a CAUDA da saída
 * cortada em `LIVE_SHELL_OUTPUT_MAX_LINES` linhas VISUAIS (ToolLine/BangBlock usam
 * `windowTailVisual` com a mesma indentação) + 1 do marcador `…N acima` se cortou.
 *
 * A saída é doblemente indentada (`LIVE_OUTPUT_INDENT=4`), então o wrap acontece em
 * `columns - 4`: uma linha de log larga quebra em várias VISUAIS — era o furo (5
 * linhas-fonte de 250 chars = 15+ visuais, mas a conta antiga via 5). Apara as
 * quebras finais (idêntico ao render). Zero quando não há saída ainda. `columns ≤ 0`
 * ⇒ conta linhas-fonte (degradação graciosa).
 */
/**
 * F163 — linhas VISUAIS do CABEÇALHO `◌ running` de um tool/bang vivo (a linha do
 * <Working>/<BangBlock> com o rótulo). Era contada como 1 FIXA, mas o rótulo é largo
 * (alvo clampado a ~100 chars; comando de bang arbitrário) e QUEBRA em terminal
 * estreito ⇒ o bloco ficava mais alto que o orçado ⇒ estouro ⇒ clearTerminal
 * reescrevendo o histórico INTEIRO (o flicker de sessão gigante). Reconstrói a
 * largura: paddingLeft(2) + glifo/onda/reticências (~12, o <Working> põe `◌` + a
 * onda `～～›` antes do rótulo) + o rótulo — over-contar é SEGURO (anti-flicker).
 * `columns ≤ 0` ⇒ 1 (linha-fonte, degradação graciosa).
 */
const RUNNING_HEADER_CHROME_COLS = 14;
function runningHeaderVisualLines(label: string, columns: number): number {
  if (!(columns > 0)) return 1;
  return Math.max(1, Math.ceil((displayWidth(label) + RUNNING_HEADER_CHROME_COLS) / columns));
}

function liveShellOutputLines(
  liveOutput: string | undefined,
  columns: number,
  tailMax: number = LIVE_SHELL_OUTPUT_MAX_LINES,
): number {
  const text = (liveOutput ?? '').replace(/\n+$/, '');
  if (text.length === 0) return 0;
  const cols = columns > 0 ? columns - LIVE_OUTPUT_INDENT : 0;
  const visual = visualLines(text, cols);
  if (visual <= tailMax) return visual;
  // cortado: teto VISUAL + 1 (marcador `…N acima`).
  return tailMax + 1;
}

/**
 * F87 / EST-0965 (wrap) — linhas VISUAIS de UMA linha de filho de sub-agente, como o
 * `<SubAgents>` a renderiza: `  [label] G word[ · model][ · summary]` (paddingLeft 2;
 * `G` = glifo de status, 1 coluna; `word` curta; ADR-0146 (D5) `model` — tier/modelo
 * RESOLVIDO, visível independente do status — ENTRA ANTES do `summary`; `summary`
 * `74.4k tokens · 13 tools · 2.1s` só quando concluído). Reconstrói a largura VISÍVEL
 * e conta o wrap em `columns` (mesmo espírito de `liveShellOutputLines`). Precisa
 * incluir o `model` aqui — senão esta conta SUBESTIMA a altura de um filho com
 * model+summary (o render real é mais longo) e a região viva estoura `columns` ⇒
 * dispara o bug de linhas mescladas do Ink (F87/EST-0965) que ENGOLE/CLIPA o texto do
 * modelo. `columns ≤ 0` ⇒ 1 (linha-fonte, degradação).
 */
function subAgentChildVisualLines(
  child: {
    readonly label: string;
    readonly status: string;
    readonly summary?: string;
    readonly model?: string;
  },
  columns: number,
): number {
  // `columns` ausente/0/negativo ⇒ 1 linha-fonte por filho (degradação graciosa,
  // comportamento antigo) — mesmo idioma `> 0` dos outros blocos wrap-aware.
  if (!(columns > 0)) return 1;
  // Palavra de status (espelha `statusWord` do <SubAgents>): curta; usamos um caso
  // longo p/ NÃO sub-contar (over-contar é seguro no anti-flicker).
  const word =
    child.status === 'running'
      ? 'rodando'
      : child.status === 'done'
        ? 'pronto'
        : child.status === 'cancelled'
          ? 'parado'
          : 'timeout';
  // ADR-0146 (D5) — mesma posição/condição do `<ChildLine>` real: o `model` entra
  // ANTES do `summary`, independente do status (não só quando concluído).
  const modelPart = child.model !== undefined ? ` · ${child.model}` : '';
  const summaryPart =
    child.summary !== undefined && child.status !== 'running' ? ` · ${child.summary}` : '';
  // `  [label] G word…` — `G` (glifo) ocupa 1 coluna; representado por 1 char.
  const line = `  [${child.label}] x ${word}${modelPart}${summaryPart}`;
  return Math.max(1, visualLines(line, columns));
}

/**
 * Sobrecusto (linhas) dos elementos vivos QUE NÃO SÃO a prévia de fala, no frame
 * corrente. Soma:
 *   • cada bloco vivo não-fala (`live`, exceto o aluy streaming) — ver acima;
 *   • o cabeçalho `Λ aluy` (1) + o cursor do stream (1) da PRÓPRIA prévia de fala,
 *     que existem ALÉM do corpo de texto orçado por `maxLines` (o `maxLines` limita
 *     SÓ o corpo de markdown);
 *   • +1 quando a janela de cauda vai cortar (`… (N linhas acima)`), pois o marcador
 *     é uma linha extra acima do corpo;
 *   • o paddingBottom (1) do bloco de fala;
 *   • o <Working> de `thinking` (1) + seu paddingTop (1, quando há blocos) — só na
 *     fase `thinking` (pré-1º-token), quando ainda não há fala.
 */
export interface LiveOverheadInput {
  /** Os blocos VIVOS (sufixo contíguo) — saída de `splitBlocks().live`. */
  readonly live: readonly SessionBlock[];
  /** Fase corrente (p/ contar o <Working> de `thinking`). */
  readonly phase: SessionPhase;
  /** Há blocos na sessão? (decide o paddingTop do <Working> de thinking). */
  readonly hasBlocks: boolean;
  /**
   * EST-0965 (wrap) — largura do terminal (colunas). Mede a altura VISUAL da SAÍDA
   * AO VIVO de comandos vivos (linhas largas quebram). Ausente/0 ⇒ linhas-fonte.
   */
  readonly columns?: number;
  /**
   * F163 — altura do terminal (linhas). Com ela, a cauda viva de shell é orçada pelo
   * cap ADAPTATIVO (`liveShellTailMaxLines` — o MESMO que o render usa): em tela
   * baixa a cauda encolhe. Ausente ⇒ cap cheio (comportamento antigo).
   */
  readonly rows?: number;
}

/** Linhas ocupadas pelos elementos vivos NÃO-fala no frame (ver doc do input). */
export function liveOverheadLines(input: LiveOverheadInput): number {
  const { live, phase, hasBlocks } = input;
  const columns = input.columns ?? 0;
  // F163 — com `rows` conhecido, a cauda viva de shell é orçada pelo cap ADAPTATIVO
  // (o MESMO do render); sem `rows`, cap cheio (comportamento antigo).
  const tailMax =
    input.rows !== undefined
      ? liveShellTailMaxLines(input.rows, input.columns)
      : LIVE_SHELL_OUTPUT_MAX_LINES;
  let lines = 0;

  // Há uma prévia de FALA viva (aluy streaming) neste frame?
  const speech = live.find((b) => b.kind === 'aluy' && b.streaming);

  for (const b of live) {
    if (b === speech) {
      // A própria fala: cabeçalho `Λ aluy` (1) + cursor (1) + paddingBottom (1).
      // O CORPO de texto é orçado à parte (o `maxLines` devolvido); aqui só o que
      // existe ALÉM do corpo. O marcador `…N acima` (quando corta) entra abaixo.
      lines += 3;
      continue;
    }
    lines += nonSpeechBlockLines(b, columns, tailMax);
  }

  // <Working> de `thinking` (pré-stream) e <ProgressBar> de `compacting` (EST-0973):
  // 1 linha + 1 de paddingTop (quando há blocos) — mesma geometria, mesmo orçamento.
  if (phase === 'thinking' || phase === 'compacting') {
    lines += 1 + (hasBlocks ? 1 : 0);
  }

  return lines;
}

/**
 * Teto de altura (linhas) da PRÉVIA de FALA (corpo do aluy streaming) p/ a região
 * viva caber INTEIRA em `rows - 1` (folga anti-flicker). Conta:
 *   rows
 *   − LIVE_CHROME_BASE_ROWS      (chrome fixo do rodapé SEM respiro + paddings)
 *   − respiroOverhead(rows)      (EST-0989: +1 só em tela alta, onde o respiro renderiza)
 *   − SAFETY_MARGIN              (folga: gatilho do Ink é `>=`)
 *   − overhead dos OUTROS vivos  (tool/subagents/working + cabeçalho/cursor/pad da fala)
 *   − modeIndicatorOverhead      (EXCEDENTE do banner UNSAFE além da base; 0 em plan/normal)
 *   − 1                          (o marcador `…N acima`, RESERVADO sempre que possa cortar)
 * com piso `MIN_SPEECH_LINES`.
 *
 * O `mode` ENTRA no orçamento (EST-0965, fix do `--unsafe`): o `<ModeIndicator>`
 * em `unsafe` é o banner que quebra p/ 2 linhas — a base de 1 (no chrome) NÃO basta;
 * o excedente é descontado AQUI. Antes, o teto ignorava o modo e a região viva
 * estourava `rows` em `--unsafe` ⇒ redesenho de frame inteiro (flicker).
 *
 * Reservar 1 p/ o `…N acima` é seguro: se a fala couber inteira (sem corte) o
 * marcador some e SOBRA 1 linha — nunca falta. Se cortar, a reserva já está paga.
 *
 * O TETO É EM LINHAS VISUAIS (EST-0965 wrap): é a unidade que o `windowTailVisual` do
 * <AluyBlock> consome — a janela de cauda mede a altura REAL com wrap em `columns-2`
 * (indent da fala) e mostra só o sufixo que cabe nestas `maxLines` VISUAIS. O overhead
 * subtraído (saída ao vivo de comandos) também é visual ⇒ a conta fecha em `rows-1`
 * MESMO com linhas largas. `columns` ausente/0 ⇒ tudo cai p/ linhas-fonte (antigo).
 *
 * PURO. O <App> chama isto a cada render com o `live`, o `mode` e o `columns` correntes.
 */
/**
 * F88 (anti-flicker) — TETO de altura do `<SlashMenu>` INLINE que COEXISTE com o stream.
 * O teto ANTIGO era `rows - 10` (FIXO), supondo só ~10 linhas de chrome embaixo. Mas
 * durante o STREAM a região viva (fala + sub-agentes + tool + working + chrome) já passa
 * de 10 ⇒ `menu(rows-10) + viva > rows` ⇒ o Ink entra no caminho full-screen
 * (clearTerminal a cada frame) ⇒ FLICKER enquanto o menu está aberto E FANTASMA/resíduo do
 * menu ao fechar (o scrollback empurrado pra fora não volta). Aqui o teto reserva o PISO
 * REAL da região viva (chrome + blocos vivos + fala-mínima + staged), espelhando os mesmos
 * componentes de `speechMaxLines`, p/ `menu + viva ≤ rows-1` SEMPRE. Piso 4: o menu JANELA
 * (↑N/↓N) em telas/streams lotados em vez de estourar.
 */
export function slashMenuMaxRows(args: {
  readonly rows: number;
  readonly live: readonly SessionBlock[];
  readonly phase: SessionPhase;
  readonly hasBlocks: boolean;
  readonly mode: SessionMode;
  readonly columns?: number;
  /** Altura (linhas) da fila/encaixando abaixo da viva (EST-0982). Default 0. */
  readonly stagedLines?: number;
}): number {
  const liveFloor =
    LIVE_CHROME_BASE_ROWS +
    respiroOverhead(args.rows) +
    modeIndicatorOverhead(args.mode) +
    // F163 — chrome estreito custa +2 (StatusBar/FooterHints em wrap); mesmo
    // desconto do speechMaxLines p/ `menu + viva ≤ rows-1` valer em tela estreita.
    narrowChromeOverhead(args.columns) +
    liveOverheadLines({
      live: args.live,
      phase: args.phase,
      hasBlocks: args.hasBlocks,
      rows: args.rows,
      ...(args.columns !== undefined ? { columns: args.columns } : {}),
    }) +
    MIN_SPEECH_LINES +
    (args.stagedLines ?? 0);
  // −1 (paddingTop do contêiner do menu) − SAFETY_MARGIN (gatilho `>=` do Ink).
  return Math.max(4, args.rows - liveFloor - 1 - SAFETY_MARGIN);
}

export function speechMaxLines(args: {
  readonly rows: number;
  readonly live: readonly SessionBlock[];
  readonly phase: SessionPhase;
  readonly hasBlocks: boolean;
  readonly mode: SessionMode;
  /**
   * EST-0982 (type-ahead) — altura (linhas) da FILA de inputs digitados durante o
   * trabalho (`<QueuedInputs>`, BOUNDED). Mora ABAIXO da região viva (acima do
   * composer), então CONSOME altura do frame: descontamos do teto da fala p/ a soma
   * caber em `rows-1` (anti-flicker). Default 0 (sem fila ⇒ sem desconto).
   */
  readonly queuedLines?: number;
  /**
   * EST-1015 (anti-flicker) — altura (linhas) do OVERLAY de `/` ABERTO (slash-menu/picker) que
   * mora ABAIXO do composer e PODE coexistir com o stream (EST-0982). Como a fila, CONSOME
   * altura do frame ⇒ desconta do teto da fala p/ a soma caber em `rows` (senão o Ink repinta a
   * tela inteira via clearTerminal a cada frame ⇒ cintilação). Default 0 (sem overlay aberto).
   */
  readonly overlayLines?: number;
  /**
   * RESIZE-FIX (bug do gap inline) — EXCEDENTE de linhas VISUAIS do composer ALÉM da 1 já
   * contada no chrome base. No inline o `<Composer>` renderiza o input CRU e o terminal o
   * QUEBRA (wrap) em N linhas visuais; sem descontar esse excedente o frame cruza `rows` e o
   * Ink cai no caminho `clearTerminal` (que NÃO reseta `previousLineCount`) ⇒ o erase acumula
   * espaço em branco a cada tecla. Default 0 (composer de 1 linha ⇒ sem desconto, não-regressão).
   */
  readonly composerOverflow?: number;
  /** EST-0965 (wrap) — largura do terminal; mede a altura VISUAL dos vivos. */
  readonly columns?: number;
}): number {
  const overhead = liveOverheadLines({
    live: args.live,
    phase: args.phase,
    hasBlocks: args.hasBlocks,
    rows: args.rows,
    ...(args.columns !== undefined ? { columns: args.columns } : {}),
  });
  // +1: reserva da linha do marcador `… (N linhas acima)` (ver doc).
  // EST-0989 — o chrome BASE (8) + o RESPIRO só quando renderiza (tela alta). Em telas
  // baixas/narrow o respiro some ⇒ não desconta (a região viva cabe em `rows-1` sem a
  // linha decorativa); em telas altas custa +1 (o caso `LIVE_CHROME_ROWS`=9).
  const budget =
    args.rows -
    LIVE_CHROME_BASE_ROWS -
    respiroOverhead(args.rows) -
    SAFETY_MARGIN -
    overhead -
    modeIndicatorOverhead(args.mode) -
    // F163 — StatusBar/FooterHints quebram p/ 2 linhas em colunas < 80; sem este
    // desconto o frame cruzava `rows` em tela baixa+estreita ⇒ clearTerminal
    // reescrevendo o histórico INTEIRO a cada frame (o flicker de sessão gigante).
    narrowChromeOverhead(args.columns) -
    (args.queuedLines ?? 0) -
    (args.overlayLines ?? 0) -
    (args.composerOverflow ?? 0) -
    1;
  return Math.max(MIN_SPEECH_LINES, budget);
}

/**
 * F196 (anti "espaço em branco GIGANTESCO no resize") — PISO ESTRUTURAL (linhas) da
 * região viva NESTE frame, IGNORANDO o corpo da fala (que varia com o conteúdo). É a
 * altura MÍNIMA que a região viva ocupa dê no que der: o chrome fixo do rodapé + os
 * excedentes condicionais (respiro/unsafe/estreito) + a altura dos OUTROS blocos vivos
 * (`liveOverheadLines` — que JÁ inclui o cabeçalho `Λ aluy` + cursor + pad da fala e o(s)
 * tool/subagents/working) + o excedente de wrap do composer. NÃO soma nenhuma linha de
 * CORPO de fala (a fala pode ter 1 linha só) — por isso é um PISO conservador: a região
 * viva REAL é sempre `≥` este valor.
 *
 * PARA QUE SERVE (o bug do dono): quando ESTE piso já `≥ rows`, a região viva NÃO CABE em
 * `rows` de jeito nenhum ⇒ o Ink É OBRIGADO a usar o caminho `outputHeight >= rows`
 * (`ink.js`), que a CADA frame reescreve `clearTerminal + fullStaticOutput + output` — um
 * REPAINT COMPLETO (via `overwriteInPlace`, sem flicker). Nesse regime, o `clearScreen()`
 * do RESIZE (que REMONTA o `<Static>` bumpando a `staticKey`) é (a) REDUNDANTE — o Ink já
 * repinta tudo sozinho — e (b) NOCIVO: cada remonta faz o Ink ANEXAR o histórico INTEIRO
 * ao seu `fullStaticOutput` DE NOVO (o Ink NUNCA reseta esse buffer), então a cada resize
 * o `clearTerminal` passa a reescrever 2×, 3×, … N× o scrollback — o "bloco/branco
 * gigantesco" que CRESCE a cada redimensionar e NUNCA encolhe (provado por captura de
 * bytes: 1→2→3→… cópias do header por resize). Com este piso o <App> PULA o `clearScreen`
 * do resize exatamente nesse regime (ver App.tsx, F196), matando a duplicação SEM regredir
 * a limpeza de órfãos do caminho `fits` (onde o piso `< rows` e o clearScreen segue valendo).
 *
 * CONSERVADOR DE PROPÓSITO: só devolve um piso `≥ rows` (⇒ pular o clearScreen) quando o
 * clearTerminal é GARANTIDO p/ QUALQUER conteúdo de fala. Se a fala coubesse (piso
 * `< rows`), NÃO pulamos — não há risco de perder o histórico/órfão no caminho `fits`. PURO.
 */
export function liveRegionMinRows(args: {
  readonly rows: number;
  readonly live: readonly SessionBlock[];
  readonly phase: SessionPhase;
  readonly hasBlocks: boolean;
  readonly mode: SessionMode;
  readonly columns?: number;
  /** Fila/encaixando abaixo da viva (EST-0982) — também ocupa altura de frame. Default 0. */
  readonly stagedLines?: number;
  /** Overlay `/` aberto que coexiste com o stream (EST-1015). Default 0. */
  readonly overlayLines?: number;
  /** Excedente VISUAL do composer (wrap) além da 1 linha do chrome (RESIZE-FIX). Default 0. */
  readonly composerOverflow?: number;
}): number {
  const overhead = liveOverheadLines({
    live: args.live,
    phase: args.phase,
    hasBlocks: args.hasBlocks,
    rows: args.rows,
    ...(args.columns !== undefined ? { columns: args.columns } : {}),
  });
  // Piso = chrome fixo + excedentes condicionais + outros blocos vivos + staged/overlay/
  // composer. SEM corpo de fala (o mínimo é 0 linhas de corpo) ⇒ a viva REAL é sempre ≥.
  return (
    LIVE_CHROME_BASE_ROWS +
    respiroOverhead(args.rows) +
    modeIndicatorOverhead(args.mode) +
    narrowChromeOverhead(args.columns) +
    overhead +
    (args.stagedLines ?? 0) +
    (args.overlayLines ?? 0) +
    (args.composerOverflow ?? 0)
  );
}

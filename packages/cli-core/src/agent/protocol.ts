// EST-0944 — protocolo estruturado de tool-call do loop agêntico.
//
// O contrato de modelo do CLI (EST-0943, `POST /v1/chat`) é chat de TEXTO puro
// (eventos `delta` de conteúdo) — NÃO tem um protocolo de tool-call nativo do
// provider. Então o loop define o SEU protocolo, estruturado e DETERMINÍSTICO de
// parsear (ADR-0053 §1: "determinístico onde dá, modelo onde não"): o modelo
// emite UM bloco JSON cercado por marcadores, o loop o parseia e executa via o
// ponto único de interceptação (CLI-SEC-H1). Tudo que não é esse bloco é texto
// livre do agente (raciocínio / resposta final).
//
// CLI-SEC-4: a OBSERVAÇÃO (resultado de tool) que volta ao modelo é DADO, num
// canal próprio (role `user`, envelopada e rotulada como não-confiável) — nunca
// vira instrução/system. Ver context.ts. ESTE módulo só parseia a RESPOSTA do
// modelo (`result.content` no loop.ts) — NUNCA observações/dado. Logo, um
// `<tool_call>` DENTRO de saída de comando não vira tool-call: ele só chega aqui
// se o MODELO o emitir no canal dele (anti-injeção é estrutural, não textual).
//
// EST-0944 (tolerância de formato) — modelos fortes (ex.: mimo-v2.5-pro) derrapam
// e emitem o tool-call no formato do TREINO deles, `<tool_call>{json}</tool_call>`,
// em vez do nativo `<<<ALUY_TOOL_CALL … ALUY_TOOL_CALL>>>`. Antes, só o nativo
// casava ⇒ a tool NÃO rodava, vazava CRU na tela e o turno acabava vazio. Agora o
// parser (e o hide de exibição) reconhecem MÚLTIPLOS formatos a partir de UMA
// fonte de verdade (`TOOL_CALL_FORMATS`). O JSON interno é o MESMO contrato
// (`{ name, input }`) e a tool extraída passa pela MESMA `decide()` (catraca): o
// formato é só SINTAXE de extração, não relaxa permissão. Caminho futuro:
// tool-calling NATIVO (provider expondo `tools`/`tool_calls` da API).

/** Marcadores do bloco de tool-call NATIVO. Estáveis e improváveis em prosa. */
export const TOOL_CALL_OPEN = '<<<ALUY_TOOL_CALL';
export const TOOL_CALL_CLOSE = 'ALUY_TOOL_CALL>>>';

/**
 * Um FORMATO de tool-call reconhecido: um par de marcadores OPEN/CLOSE que
 * cercam um corpo JSON `{ "name": ..., "input": {...} }`. O nativo é canônico
 * (o prompt ensina ele); os demais existem só porque modelos derrapam para o
 * formato do treino deles. Fonte ÚNICA de verdade — o parser E o hide de
 * exibição iteram sobre esta lista (DRY: um formato novo entra num lugar só).
 *
 * Ordem = só documental; a seleção do bloco a executar é sempre por POSIÇÃO no
 * texto (o que vier primeiro ganha), nunca por ordem desta lista.
 */
export interface ToolCallFormat {
  /** Rótulo p/ diagnóstico (ex.: 'nativo', 'tool_call'). */
  readonly label: string;
  /** Marcador de abertura. */
  readonly open: string;
  /** Marcador de fechamento. */
  readonly close: string;
}

/**
 * Formatos reconhecidos, do mais específico/canônico ao mais genérico. NÃO
 * adicione formatos cuja abertura apareça comumente em prosa legítima sem virar
 * ruído — cada marcador deve ser improvável fora de um tool-call de verdade.
 */
export const TOOL_CALL_FORMATS: readonly ToolCallFormat[] = [
  // Nativo do Aluy (canônico — o prompt ensina EXATAMENTE este).
  { label: 'nativo', open: TOOL_CALL_OPEN, close: TOOL_CALL_CLOSE },
  // Formato de treino de muitos modelos abertos (o que o mimo-v2.5-pro usa).
  { label: 'tool_call', open: '<tool_call>', close: '</tool_call>' },
];

/**
 * Uma chamada de ferramenta PROPOSTA pelo modelo, já parseada. `input` é opaco
 * aqui (cada tool valida o seu) e é o mesmo shape do `ToolCall` do gate.
 */
export interface ParsedToolCall {
  readonly name: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * Resultado de parsear a resposta de texto do modelo. Discriminado:
 *  - `tool_call`: o modelo pediu uma ferramenta (executar via gate→tool).
 *  - `final`: o modelo NÃO pediu ferramenta — é a resposta final (loop encerra).
 *  - `malformed`: havia um bloco de tool-call mas inválido (JSON quebrado / sem
 *    `name`). NÃO é fatal: o loop devolve um erro como observação e o modelo
 *    tenta de novo (determinístico, sem heurística frágil de adivinhar a intenção).
 */
export type ParsedModelTurn =
  | { readonly kind: 'tool_call'; readonly call: ParsedToolCall; readonly text: string }
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'malformed'; readonly reason: string; readonly text: string };

/**
 * Localização do PRIMEIRO bloco de tool-call no texto, em QUALQUER formato
 * reconhecido. `openIdx` é a posição do marcador de abertura; `format` o formato
 * que casou; `closeIdx` o índice do fechamento (ou -1 se ainda aberto — stream a
 * meio). Puro/determinístico: varre todos os formatos e devolve o que ABRE mais
 * cedo no texto (precedência por POSIÇÃO, CLI-SEC-8 — 1 tool-call/iteração).
 * Desempate (mesma posição de abertura): o formato listado primeiro vence.
 */
interface ToolCallLocation {
  readonly format: ToolCallFormat;
  readonly openIdx: number;
  readonly closeIdx: number;
}

function locateFirstToolCall(text: string): ToolCallLocation | null {
  let best: ToolCallLocation | null = null;
  for (const format of TOOL_CALL_FORMATS) {
    const openIdx = text.indexOf(format.open);
    if (openIdx === -1) continue;
    if (best !== null && openIdx >= best.openIdx) continue;
    const closeIdx = text.indexOf(format.close, openIdx + format.open.length);
    best = { format, openIdx, closeIdx };
  }
  return best;
}

/**
 * Parseia a resposta de TEXTO do modelo procurando UM bloco de tool-call em
 * QUALQUER formato reconhecido (`TOOL_CALL_FORMATS`). O parsing é puro e
 * determinístico (sem rede, sem heurística de NLP):
 *  - acha o 1º bloco (por POSIÇÃO, em qualquer formato); o miolo é JSON
 *    `{ "name": ..., "input": {...} }` — o MESMO contrato em todos os formatos.
 *  - sem bloco ⇒ resposta final.
 *  - bloco presente mas JSON inválido / sem `name` ⇒ `malformed` (reentra no loop).
 *
 * Só o PRIMEIRO bloco é considerado por turno (1 tool-call por iteração — mais
 * simples de auditar e de aplicar tetos; CLI-SEC-8). Texto após o bloco é ignorado
 * para fins de execução, mas preservado em `text` p/ observabilidade.
 *
 * SEGURANÇA (CLI-SEC-H1/CLI-SEC-4): o `{name,input}` extraído — seja qual for o
 * formato — entra no MESMO fluxo e passa pela MESMA `decide()` (catraca) no
 * loop.ts. O formato é só sintaxe de extração; NÃO relaxa permissão. E este parse
 * roda só sobre a resposta do MODELO, nunca sobre observações (dado), então um
 * `<tool_call>` dentro de saída de comando não vira tool-call (anti-injeção).
 */
export function parseModelTurn(modelText: string): ParsedModelTurn {
  // SEGURANÇA/CORRETUDE (modelos de RACIOCÍNIO — granito/MiMo/DeepSeek-R1): um
  // tool-call escrito DENTRO de `<think>…</think>` é RACIOCÍNIO ("vou considerar
  // rodar X… mas não preciso"), NÃO uma ação. Localizar/extrair sobre o texto CRU
  // faria o loop EXECUTAR um comando que o modelo só PENSOU em rodar — ou
  // explicitamente REJEITOU (em --yolo, rodaria sem barreira). Descartamos o
  // raciocínio ANTES de localizar a ação; só um tool-call FORA do `<think>` conta.
  // (Irmão do #358, que só limpava o DISPLAY — este fecha a EXECUÇÃO.) O `text`
  // devolvido segue CRU p/ observabilidade; o display o limpa via cleanAluyForDisplay.
  const actionText = stripThinkBlocks(modelText);
  const loc = locateFirstToolCall(actionText);
  if (loc === null) {
    return { kind: 'final', text: modelText };
  }
  if (loc.closeIdx === -1) {
    return {
      kind: 'malformed',
      reason: `bloco de tool-call aberto (${loc.format.open}) sem fechamento (${loc.format.close}).`,
      text: modelText,
    };
  }
  const raw = actionText.slice(loc.openIdx + loc.format.open.length, loc.closeIdx).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      kind: 'malformed',
      reason: 'o miolo do bloco de tool-call não é JSON válido.',
      text: modelText,
    };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'malformed', reason: 'tool-call não é um objeto JSON.', text: modelText };
  }
  const obj = parsed as Record<string, unknown>;
  const name = obj.name;
  if (typeof name !== 'string' || name.length === 0) {
    return {
      kind: 'malformed',
      reason: 'tool-call sem campo "name" (string não-vazia).',
      text: modelText,
    };
  }
  // `typeof [] === 'object'` ⇒ um `input:[]` (array) seria castado a Record sem
  // normalização. Array NÃO é um mapa de args ⇒ trata como ausente (`{}`).
  const input =
    typeof obj.input === 'object' && obj.input !== null && !Array.isArray(obj.input)
      ? (obj.input as Record<string, unknown>)
      : {};
  return { kind: 'tool_call', call: { name, input }, text: modelText };
}

/**
 * Remove o bloco CRU de tool-call do texto do modelo, p/ EXIBIÇÃO (TUI/linear),
 * em QUALQUER formato reconhecido (`TOOL_CALL_FORMATS` — nativo `<<<ALUY_TOOL_CALL
 * … ALUY_TOOL_CALL>>>` E `<tool_call> … </tool_call>`). O protocolo é detalhe de
 * máquina: o usuário vê o texto LIMPO do assistente (a prosa antes/depois do
 * bloco) + a linha `⏺ <tool>` que o loop já emite — nunca o JSON cru do envelope,
 * seja qual for o formato em que o modelo derrapou.
 *
 * Cirúrgico: tira só o 1º bloco (o que ABRE mais cedo, em qualquer formato — o
 * loop só executa o 1º; ver `parseModelTurn`) e PRESERVA todo o texto legítimo em
 * volta, colapsando o espaço em branco que sobra na junção p/ não deixar buraco.
 * Bloco aberto mas ainda SEM fechar (stream a meio / malformado): esconde do OPEN
 * em diante — o JSON parcial não é texto do assistente e não deve vazar. Sem
 * NENHUM bloco, devolve o texto intacto (não esconde nada por engano).
 * Determinístico, puro.
 */
export function stripToolCallBlock(modelText: string): string {
  const loc = locateFirstToolCall(modelText);
  if (loc === null) return modelText;
  const before = modelText.slice(0, loc.openIdx);
  const after = loc.closeIdx === -1 ? '' : modelText.slice(loc.closeIdx + loc.format.close.length);
  // Junta as duas pontas; se ambas têm conteúdo, separa por UMA quebra; senão,
  // só apara as bordas. Evita "buraco" (várias linhas em branco) na costura.
  const left = before.replace(/\s+$/, '');
  const right = after.replace(/^\s+/, '');
  if (left !== '' && right !== '') return `${left}\n${right}`;
  return (left + right).trim();
}

/**
 * Maior PREFIXO de `needle` com que `text` TERMINA (≥1). 0 se nenhum.
 *
 * Ex.: para `needle='<<<ALUY_TOOL_CALL'` e text `'…rodar isto: <<<ALUY_TOO'`,
 * devolve 9 (o tail `'<<<ALUY_TOO'`). Puro; O(n·m) no pior caso, mas n·m é trivial
 * (marcador curto). Usado p/ esconder o marcador a MEIO-CHEGADA durante o stream:
 * o protocolo nunca deve PISCAR cru na fala, nem mesmo um pedaço inicial dele.
 */
function trailingPrefixLen(text: string, needle: string): number {
  // O maior sufixo de `text` que é um prefixo PRÓPRIO de `needle` (mais curto que
  // o needle inteiro — o needle COMPLETO já é tratado como bloco aberto/fechado).
  const max = Math.min(text.length, needle.length - 1);
  for (let len = max; len >= 1; len--) {
    if (text.endsWith(needle.slice(0, len))) return len;
  }
  return 0;
}

/**
 * EST-0965/EST-0944 — limpa o texto do `aluy` para EXIBIÇÃO durante e depois do
 * stream, escondendo TODOS os marcadores internos do protocolo de tool-call
 * (detalhe de máquina), em QUALQUER formato reconhecido (`TOOL_CALL_FORMATS` —
 * nativo `<<<ALUY_TOOL_CALL …>>>` E `<tool_call> … </tool_call>`), sem JAMAIS
 * tocar o texto CRU armazenado/parseado pelo loop. Puro, idempotente e tolerante
 * (texto sem marcador ⇒ devolvido intacto):
 *
 *  1. Remove TODOS os blocos COMPLETOS (não só o 1º — o modelo pode emitir vários
 *     num delta acumulado), reusando o `stripToolCallBlock` (que já é multi-formato)
 *     num laço de ponto-fixo (DRY). Cada bloco vira a linha `⏺ <tool>` que o loop
 *     já pinta — aqui sobra só a prosa limpa em volta.
 *  2. Esconde o marcador a MEIO-CHEGAR no rabo: se o texto vivo termina com um
 *     PREFIXO de QUALQUER marcador de abertura (ex.: `…texto <<<ALUY_TOO` ou
 *     `…rodar <tool_c`) — fim de stream antes do marcador fechar — corta do
 *     prefixo em diante. Assim o usuário nunca vê o `<<<ALU…`/`<tool_c…` piscando
 *     antes de virar a linha `⏺ tool`.
 *
 * NÃO esconde um `<<<` ou `<` solto legítimo (alguém escrevendo "use <<< no shell"
 * ou "a < b"): só casa um marcador EXATO do protocolo ou um PREFIXO dele colado no
 * fim do texto.
 *
 * O corte é por CONTEÚDO (não por largura), então não precisa de `columns`; a
 * camada de render mede o wrap/janela depois, sobre o texto já limpo.
 */
/**
 * Remove os blocos de RACIOCÍNIO `<think>…</think>` que modelos de raciocínio
 * (granito/MiMo, DeepSeek-R1 etc.) emitem INLINE no conteúdo. Sem isto, o
 * raciocínio + as tags VAZAM cru na saída headless (`-p --output-format text`,
 * pra scripting) E na TUI — surfado por dogfood (granito: `<think>…</think>` +
 * `</think>` solto caíam no texto final). Casos cobertos:
 *  1. pares COMPLETOS `<think>…</think>` (todos, não-greedy, dotall, case-insensitive);
 *  2. CLOSE órfão `</think>` (o open foi consumido/cortado no stream) ⇒ tudo ATÉ ele
 *     é raciocínio: corta do início até depois do `</think>` (caso real do dogfood);
 *  3. OPEN órfão `<think>` sem close (stream A MEIO do raciocínio) ⇒ esconde do `<think>`
 *     em diante (espelha o tratamento de tool-call aberto).
 * Conservador/fail-safe: na presença de tag de raciocínio, preferimos esconder o
 * raciocínio a vazá-lo. Idempotente. Exportado p/ o context.ts também limpar o
 * `<think>` do HISTÓRICO re-enviado ao modelo (não só do display).
 */
export function stripThinkBlocks(input: string): string {
  // 1) pares completos.
  let t = input.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // 2) close órfão remanescente: o conteúdo ANTES dele era raciocínio.
  const closeIdx = t.search(/<\/think>/i);
  if (closeIdx !== -1) {
    t = t.slice(closeIdx).replace(/^<\/think>/i, '');
  }
  // 3) open órfão sem close: esconde do marcador em diante.
  const openIdx = t.search(/<think>/i);
  if (openIdx !== -1) {
    t = t.slice(0, openIdx);
  }
  return t;
}

/**
 * Marcadores do bloco de RACIOCÍNIO (`<think>` open e `</think>` close) — usados p/
 * detectar PREFIXOS PARCIAIS no rabo de um texto INTERROMPIDO (stream cortado a meio
 * da tag). Separados da regex de `stripThinkBlocks` p/ poder reutilizar `trailingPrefixLen`
 * sem duplicar as strings.
 */
const THINK_MARKERS = ['<think>', '</think>'] as const;

/**
 * EST-1015 — `stripThinkBlocks` + aparo de PREFIXO PARCIAL no rabo.
 *
 * Fecha a borda adjacente ao PR #383: quando um stream de modelo é INTERROMPIDO/
 * CANCELADO a meio de uma tag de raciocínio (Ctrl-C, abort, erro de rede), o texto
 * acumulado pode terminar num fragmento como `…resposta <thi` ou `…texto </thi`.
 * `stripThinkBlocks` NÃO toca esse fragmento (só lida com marcadores COMPLETOS ou
 * OPEN/CLOSE órfãos), então ele SOBREVIVE quando esse texto é armazenado no histórico
 * e reenviado ao modelo (contexto poluído) ou incluído no input do resumo (compact).
 *
 * Este helper aplica `stripThinkBlocks` normalmente e DEPOIS apara qualquer prefixo
 * parcial dos marcadores `<think>`/`</think>` que sobrar no fim — exatamente como
 * `cleanAluyForDisplay` faz p/ os marcadores de tool-call via `trailingPrefixLen`.
 * FALLBACK: se o texto resultante for VAZIO (turno era só raciocínio), o caller
 * deve tratar conforme o seu contexto (re-feed usa o original; compact descarta).
 *
 * Puro/determinístico. Não toca `stripThinkBlocks` em si (contrato intacto p/ o
 * display). Usado por `stripThinkForRefeed` (re-feed), `renderHistoryItemForSummary`
 * (compact) e `cleanAluyForDisplay` (display + export) — FONTE ÚNICA do aparo.
 */
export function stripThinkBlocksAndTrailingPrefix(text: string): string {
  let t = stripThinkBlocks(text);
  // Apara prefixo PARCIAL de qualquer marcador de raciocínio no rabo: corta no
  // prefixo que começa MAIS CEDO (maior trecho a esconder ⇒ corte mais à esquerda).
  let cutAt = t.length;
  for (const marker of THINK_MARKERS) {
    const tail = trailingPrefixLen(t, marker);
    if (tail > 0) cutAt = Math.min(cutAt, t.length - tail);
  }
  if (cutAt < t.length) {
    t = t.slice(0, cutAt).replace(/\s+$/, '');
  }
  return t;
}

export function cleanAluyForDisplay(rawText: string): string {
  // 0) Remove o RACIOCÍNIO `<think>…</think>` + prefixo PARCIAL no rabo (stream
  //    interrompido a meio da tag). Usa `stripThinkBlocksAndTrailingPrefix` (helper
  //    compartilhado com re-feed/compact) — DRY, sem lógica duplicada.
  let text = stripThinkBlocksAndTrailingPrefix(rawText);
  // 1) Drena todos os blocos COMPLETOS em qualquer formato. `stripToolCallBlock`
  //    tira o 1º bloco (qualquer formato) por chamada; iteramos até não sobrar
  //    par FECHADO. Guarda de iterações p/ robustez — cada passo remove ≥1 OPEN,
  //    então converge.
  for (let i = 0; i < 64; i++) {
    const loc = locateFirstToolCall(text);
    if (loc === null) break;
    if (loc.closeIdx === -1) break; // bloco aberto sem fechar: tratado abaixo
    text = stripToolCallBlock(text);
  }
  // Trata um eventual OPEN ainda-aberto remanescente (stream a meio do bloco, em
  // qualquer formato): o stripToolCallBlock esconde do OPEN em diante.
  if (locateFirstToolCall(text) !== null) {
    text = stripToolCallBlock(text);
  }

  // 2) Marcador a MEIO-CHEGAR no rabo (prefixo de QUALQUER OPEN colado no fim) ⇒
  //    esconde. Varre todos os formatos e corta no prefixo que começa MAIS CEDO
  //    (o trecho a esconder é o maior, então o corte mais à esquerda manda).
  let cutAt = text.length;
  for (const format of TOOL_CALL_FORMATS) {
    const tail = trailingPrefixLen(text, format.open);
    if (tail > 0) cutAt = Math.min(cutAt, text.length - tail);
  }
  if (cutAt < text.length) {
    text = text.slice(0, cutAt).replace(/\s+$/, '');
  }
  return text;
}

/**
 * Serializa a observação (resultado de tool) no formato que o loop devolve ao
 * modelo. Texto simples e rotulado — a ENVELOPAGEM de não-confiabilidade
 * (CLI-SEC-4) é responsabilidade do context.ts, que coloca isto num canal `user`
 * cercado por marcadores de dado-não-confiável.
 */
export function formatObservation(toolName: string, ok: boolean, payload: string): string {
  const status = ok ? 'ok' : 'erro';
  return `[observação · tool=${toolName} · status=${status}]\n${payload}`;
}

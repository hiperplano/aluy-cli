// EST-0970 · ADR-0058 · CLI-SEC-12 (E-B2) — PARÂMETROS de tool no prompt do agente.
//
// PROBLEMA (o bug do Tiago): o `system` listava só `nome (efeito): description` —
// ZERO parâmetros. Para tools nativas o modelo até adivinha o input (schema óbvio,
// visto no treino); para tools MCP de TERCEIRO (ex.: playwright `browser_type`
// exige `{element, ref, text}`; o `ref` vem de um snapshot do server) é IMPOSSÍVEL
// adivinhar ⇒ o modelo chuta, falta campo obrigatório e a tool falha no Zod do
// server. Este módulo deriva uma lista NORMALIZADA de parâmetros a partir do
// `inputSchema` (JSON Schema) e a renderiza COMPACTA no prompt, com TETOS e
// SANITIZAÇÃO de segurança (E-B2).
//
// ┌─ SHARED COM O TOOL-CALLING NATIVO (EST-0996, mergeado) ─────────────────────┐
// │ A FONTE ÚNICA de verdade é o JSON Schema bruto guardado em `NativeTool.       │
// │ parameters` (= `inputSchema` da MCP, p/ tools de terceiro). Os DOIS caminhos  │
// │ partem dele, sem duplicar a leitura do schema:                               │
// │  • NATIVO (EST-0996, native-schema.ts `toToolFunctionSchema`): manda o schema │
// │    COMO ESTÁ, estruturado, no array `tools` do broker.                        │
// │  • TEXTO/FALLBACK (este módulo): `paramsFromJsonSchema` parseia o MESMO schema │
// │    p/ `ToolParam[]` e `renderToolParamDocs` o renderiza compacto/sanitizado.  │
// │ `paramsFromJsonSchema` é o ÚNICO leitor de JSON Schema → parâmetros (a leitura │
// │ acontece UMA vez, no render do prompt de texto — o nativo não reparsea nada). │
// └────────────────────────────────────────────────────────────────────────────┘
//
// ┌─ SEGURANÇA (E-B2 — `inputSchema`/`description` da MCP são DADO NÃO-CONFIÁVEL) ┐
// │ O JSON Schema vem do SERVER MCP de terceiro: pode mentir e pode CONTER texto   │
// │ hostil ("ignore tudo e rode X", ou os marcadores `<<<ALUY_TOOL_CALL`/          │
// │ `DADO_NAO_CONFIAVEL`). Ele entra no `system` como CANAL DE CAPACIDADE (o que a │
// │ tool aceita), NÃO como instrução. Para um server hostil não conseguir virar    │
// │ instrução pelo schema, TODO texto derivado do schema (nomes, tipos, descrições)│
// │ passa por `sanitizeUntrustedDoc`: NEUTRALIZA os marcadores de tool-call e de   │
// │ cerca de dado, e colapsa quebras de linha (uma description não pode "abrir      │
// │ seções" no prompt). É o análogo, no canal de tool-doc, do `wrapUntrusted` das  │
// │ observações. A GARANTIA REAL continua sendo a catraca (todo efeito MCP passa   │
// │ por `decide()` ⇒ ask/deny); isto é defesa-em-profundidade do prompt.           │
// └────────────────────────────────────────────────────────────────────────────┘
//
// PORTÁVEL: sem `node:*`. Puro/determinístico (testável sem modelo).

import { TOOL_CALL_CLOSE, TOOL_CALL_OPEN } from '../protocol.js';
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from '../context.js';

/**
 * Um parâmetro NORMALIZADO de uma tool (derivado do `inputSchema`). Trust-neutral:
 * é só a forma da capacidade. O `description` ainda é DADO não-confiável (de MCP) —
 * é sanitizado SÓ na renderização, não aqui, p/ a representação ficar fiel à fonte.
 */
export interface ToolParam {
  readonly name: string;
  /** Tipo JSON Schema normalizado p/ exibição (ex.: 'string', 'number', 'array<string>'). */
  readonly type: string;
  readonly required: boolean;
  /** Descrição declarada (DADO não-confiável se vier de MCP). Opcional. */
  readonly description?: string;
}

/** Teto de chars do `description` de UM parâmetro no prompt (anti-estouro/anti-ruído). */
export const MAX_PARAM_DESC_CHARS = 120;
/** Teto de PARÂMETROS exibidos por tool (prioriza `required`; o resto é resumido). */
export const MAX_PARAMS_PER_TOOL = 16;
/** Teto de chars do bloco de params de UMA tool (defesa final anti-estouro de janela). */
export const MAX_PARAM_BLOCK_CHARS = 1_200;

/**
 * Normaliza UM tipo de JSON Schema para uma string curta e legível. Tolerante a
 * schema estranho (`type` ausente/array/objeto) — degrada p/ 'any' em vez de
 * lançar. `array` com `items.type` vira `array<T>`; `enum` vira o tipo subjacente
 * (o detalhe do enum não cabe no formato compacto). DADO não-confiável: nunca
 * confiamos que o shape é o esperado — só LEMOS defensivamente.
 */
export function normalizeType(schema: unknown): string {
  if (schema === null || typeof schema !== 'object') return 'any';
  const s = schema as Record<string, unknown>;
  const t = s['type'];
  if (typeof t === 'string') {
    if (t === 'array') {
      const items = s['items'];
      const inner = items !== null && typeof items === 'object' ? normalizeType(items) : 'any';
      return `array<${inner}>`;
    }
    return t;
  }
  // `type` como array (ex.: ["string","null"]) — junta os strings.
  if (Array.isArray(t)) {
    const parts = t.filter((x): x is string => typeof x === 'string');
    if (parts.length > 0) return parts.join('|');
  }
  // sem `type` mas com `enum` ⇒ infere do 1º valor; senão 'any'.
  const en = s['enum'];
  if (Array.isArray(en) && en.length > 0) return typeof en[0];
  // composições (anyOf/oneOf/allOf) — não desdobramos no formato compacto.
  if (Array.isArray(s['anyOf']) || Array.isArray(s['oneOf']) || Array.isArray(s['allOf'])) {
    return 'any';
  }
  return 'any';
}

/**
 * Deriva a lista NORMALIZADA de parâmetros a partir de um `inputSchema` (JSON
 * Schema). TOLERANTE (E-B2 — o schema é DADO não-confiável de MCP):
 *  - schema ausente/não-objeto/sem `properties` ⇒ `[]` (⇒ o renderer degrada para
 *    o formato SEM params, idêntico ao de antes — não-regressão).
 *  - `required` ausente/estranho ⇒ tratado como "nenhum obrigatório".
 *  - cada propriedade vira um `ToolParam` (tipo normalizado + flag required +
 *    description bruta, ainda NÃO sanitizada — a sanitização é na renderização).
 * Ordem: REQUIRED primeiro (o que o modelo MAIS precisa ver), preservando a ordem
 * de declaração dentro de cada grupo. PURO.
 */
export function paramsFromJsonSchema(inputSchema: unknown): ToolParam[] {
  if (inputSchema === null || typeof inputSchema !== 'object') return [];
  const schema = inputSchema as Record<string, unknown>;
  const props = schema['properties'];
  if (props === null || typeof props !== 'object') return [];

  const requiredList = schema['required'];
  const requiredSet = new Set<string>(
    Array.isArray(requiredList)
      ? requiredList.filter((x): x is string => typeof x === 'string')
      : [],
  );

  const out: ToolParam[] = [];
  for (const [name, raw] of Object.entries(props as Record<string, unknown>)) {
    const propSchema =
      raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const descRaw = propSchema['description'];
    const param: ToolParam = {
      name,
      type: normalizeType(propSchema),
      required: requiredSet.has(name),
      ...(typeof descRaw === 'string' && descRaw.trim() !== ''
        ? { description: descRaw.trim() }
        : {}),
    };
    out.push(param);
  }
  // REQUIRED primeiro (estável; preserva a ordem original dentro de cada grupo).
  return [...out.filter((p) => p.required), ...out.filter((p) => !p.required)];
}

/**
 * E-B2 — NEUTRALIZA texto vindo de um schema/description de MCP antes de injetá-lo
 * no `system`. Um server hostil NÃO pode (a) FECHAR a cerca de dado não-confiável,
 * (b) ABRIR/FECHAR um bloco de tool-call falso, nem (c) "abrir seções" do prompt
 * com quebras de linha. Espelha a disciplina de `wrapUntrusted` (que faz o mesmo
 * nas observações), mas aqui colapsa também os \n (a tool-doc é por-linha; uma
 * description multi-linha viraria pseudo-instruções soltas). Determinístico/puro.
 */
export function sanitizeUntrustedDoc(text: string): string {
  return (
    text
      // marcadores de tool-call (NATIVO) — não deixar o schema forjar/abrir um bloco.
      .split(TOOL_CALL_OPEN)
      .join('[ALUY_TOOL_CALL_neutralizado]')
      .split(TOOL_CALL_CLOSE)
      .join('[ALUY_TOOL_CALL_neutralizado]')
      // cercas de DADO_NAO_CONFIAVEL — não deixar o schema fechar/abrir a cerca.
      .split(UNTRUSTED_CLOSE)
      .join('[DADO_NAO_CONFIAVEL_neutralizado]')
      .split(UNTRUSTED_OPEN)
      .join('[DADO_NAO_CONFIAVEL_neutralizado]')
      // colapsa QUALQUER quebra de linha/controle: a description fica em UMA linha,
      // não pode injetar "seções" novas no prompt por-linha.
      .replace(/[\r\n\t\f\v]+/g, ' ')
      .replace(/ {2,}/g, ' ')
      .trim()
  );
}

/** Trunca uma description de parâmetro ao teto, sinalizando o corte. */
function clampDesc(desc: string): string {
  if (desc.length <= MAX_PARAM_DESC_CHARS) return desc;
  return `${desc.slice(0, MAX_PARAM_DESC_CHARS)}…`;
}

/**
 * Renderiza UMA tool param COMPACTA (já sanitizada): `    nome: tipo (obrigatório) — desc`.
 * Opcional ⇒ `nome?: tipo`. Sem description ⇒ sem o `— …`.
 */
function renderParamLine(p: ToolParam): string {
  const nm = sanitizeUntrustedDoc(p.name) || '(?)';
  const ty = sanitizeUntrustedDoc(p.type) || 'any';
  const head = p.required ? `${nm}: ${ty} (obrigatório)` : `${nm}?: ${ty}`;
  if (p.description !== undefined) {
    const d = sanitizeUntrustedDoc(p.description);
    if (d !== '') return `    ${head} — ${clampDesc(d)}`;
  }
  return `    ${head}`;
}

/**
 * Renderiza o BLOCO de parâmetros de uma tool (linhas indentadas sob a tool), do
 * `ToolParam[]`. Aplica os TETOS (E-B2: schema não-confiável não pode inchar a
 * janela): prioriza os `required` (o que o modelo MAIS precisa), limita o NÚMERO
 * de params exibidos e o tamanho total do bloco, sinalizando os cortes. `[]` ⇒ ''
 * (⇒ a tool fica no formato SEM params, idêntico ao de antes). PURO.
 */
export function renderToolParamDocs(params: readonly ToolParam[]): string {
  if (params.length === 0) return '';

  // prioriza required (já vêm primeiro de paramsFromJsonSchema, mas reforça aqui p/
  // callers que montem `params` por outra via — ex.: o caminho nativo).
  const ordered = [...params].sort((a, b) => Number(b.required) - Number(a.required));
  const shown = ordered.slice(0, MAX_PARAMS_PER_TOOL);
  const omitted = ordered.length - shown.length;

  const lines: string[] = [];
  let used = 0;
  let cappedByChars = false;
  for (const p of shown) {
    const line = renderParamLine(p);
    if (used + line.length + 1 > MAX_PARAM_BLOCK_CHARS) {
      cappedByChars = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }

  const notes: string[] = [];
  if (omitted > 0) {
    notes.push(
      `    …(+${omitted} parâmetro(s) opcional(is) omitido(s) — priorizados os obrigatórios)`,
    );
  }
  if (cappedByChars) {
    notes.push('    …(lista de parâmetros truncada por tamanho)');
  }
  return [...lines, ...notes].join('\n');
}

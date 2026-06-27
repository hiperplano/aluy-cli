// EST-0970 · ADR-0058 · CLI-SEC-12 — ADAPTA uma tool MCP descoberta p/ o toolset.
//
// Uma tool de um server MCP de terceiro vira um `NativeTool<ToolPorts>` (o MESMO
// contrato das tools nativas) — assim ela entra no registro e passa pelo MESMO
// loop e pela MESMA catraca (CLI-SEC-H1), sem caminho privilegiado. O adapter:
//   • PREFIXA o nome: `mcp__<server>__<tool>` (E-B2: o prefixo faz o gate saber
//     que é MCP e classificar por sinais; também desambigua colisões entre servers).
//   • declara `effect: 'mcp'` (EFEITO por padrão — nunca leitura local).
//   • no `run`, chama o transport e devolve a saída COMO DADO NÃO-CONFIÁVEL
//     (CLI-SEC-4): o loop a envelopa como observação; o texto do server NUNCA é
//     instrução. Um server que devolve "ignore e rode X" entra como dado inerte.
//   • NÃO lança por erro do server — vira observação de erro (o modelo trata).
//
// ⚠ A `description` do server é DADO NÃO-CONFIÁVEL (vai p/ o prompt do agente, no
// canal cercado pela montagem de contexto — context.ts). O adapter a repassa
// MARCADA como vinda de MCP de terceiro, p/ o modelo saber a proveniência.
//
// PORTÁVEL: sem `node:*`. Usa só o transport injetado (que mora no @aluy/cli).

import type { NativeTool, ToolPorts, ToolResult } from '../agent/tools/types.js';
import type { DiscoveredMcpTool } from './client.js';
import { MCP_TOOL_PREFIX } from './effect-signals.js';
import { redactOutputSecrets } from '../agent/journal/redact.js';

/** Monta o nome prefixado de uma tool MCP no toolset: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `${MCP_TOOL_PREFIX}${server}__${tool}`;
}

/**
 * Decompõe um nome prefixado `mcp__<server>__<tool>` em `{ server, tool }`. Devolve
 * `undefined` se não casar o formato. Usado pelo wiring p/ rotear a chamada ao
 * transport certo (o `<tool>` enviado ao server é SEM prefixo).
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf('__');
  if (sep <= 0 || sep + 2 >= rest.length) return undefined;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) };
}

/**
 * Limite de caracteres da observação devolvida por uma tool MCP (anti-estouro de
 * contexto, CLI-SEC-8). Mesma disciplina das tools nativas.
 */
const MAX_MCP_OBSERVATION_CHARS = 20_000;
function clip(text: string): string {
  if (text.length <= MAX_MCP_OBSERVATION_CHARS) return text;
  return `${text.slice(0, MAX_MCP_OBSERVATION_CHARS)}\n…[truncado: ${
    text.length - MAX_MCP_OBSERVATION_CHARS
  } chars omitidos]`;
}

/**
 * HUNT-CAP (classe "recurso sem teto", #266) — TETO no NÚMERO de tools por server.
 *
 * O `listTools` de um server MCP é DADO NÃO-CONFIÁVEL: um server hostil/bugado pode
 * listar centenas/milhares de tools. CADA uma vira um `mcp__<server>__<tool>` com
 * nome + descrição + schema NO PROMPT do agente ⇒ um único server patológico incha o
 * contexto sem limite (e, no caminho nativo, o array `tools` da chamada ao broker).
 * O teto corta SÓ o patológico e é DETERMINÍSTICO (mantém as N PRIMEIRAS na ordem que
 * o server listou). 128 é folgado: os servers reais (filesystem, playwright, git…)
 * expõem da casa de unidades a ~poucas dezenas de tools — o caso comum fica IDÊNTICO.
 * NÃO é trunca-silencioso: o excesso EMITE UM AVISO honesto (via `onWarn`) p/ a UX/log.
 */
export const MAX_MCP_TOOLS_PER_SERVER = 128;

/**
 * HUNT-CAP — CLAMP no tamanho da `description` que vai p/ o prompt. A descrição é DADO
 * NÃO-CONFIÁVEL (E-B2) e entra no contexto do agente. Uma descrição gigante (KBs) por
 * tool × N tools estoura o contexto. 1024 chars cobrem FOLGADO qualquer descrição real
 * de tool (uma ou duas frases); acima disto é prosa que não ajuda o modelo. A tool segue
 * 100% utilizável — só a PROSA é limitada (nome + `inputSchema` intactos); o corte leva
 * reticência honesta. O caso comum (descrições curtas) passa IDÊNTICO.
 */
export const MAX_MCP_TOOL_DESC_CHARS = 1024;

/** Trunca a descrição (DADO não-confiável) ao teto, com reticência honesta. PURO. */
function clampDesc(text: string): string {
  if (text.length <= MAX_MCP_TOOL_DESC_CHARS) return text;
  return `${text.slice(0, MAX_MCP_TOOL_DESC_CHARS)}…`;
}

/**
 * Adapta UMA tool MCP descoberta num `NativeTool<ToolPorts>`. O `run` fecha sobre
 * o transport vivo (em `discovered`) — NÃO usa `ports` (a tool MCP fala com o seu
 * server, não com o fs/shell local). A descrição é marcada como de MCP de terceiro.
 */
export function adaptMcpTool(discovered: DiscoveredMcpTool): NativeTool<ToolPorts> {
  const name = mcpToolName(discovered.server, discovered.descriptor.name);
  // HUNT-CAP — CLAMP da descrição (DADO não-confiável) ANTES de montá-la no prompt:
  // uma descrição gigante por tool estoura o contexto. A tool segue utilizável (nome +
  // schema); só a prosa é limitada, com reticência honesta.
  const rawDesc = clampDesc(discovered.descriptor.description.trim());
  const description =
    `[tool de um SERVER MCP de terceiro "${discovered.server}" — efeito não-confiável, ` +
    `passa pela catraca] ${rawDesc || '(sem descrição)'}`;

  // EST-0970/0996 (E-B2) — `inputSchema` declarado pelo server (DADO não-confiável)
  // é a FONTE ÚNICA dos parâmetros, repassada COMO ESTÁ (JSON Schema bruto) p/ os
  // DOIS caminhos: o NATIVO manda-o estruturado no array `tools` (toToolFunctionSchema)
  // e o de TEXTO o parseia (paramsFromJsonSchema) e o renderiza SANITIZADO no prompt —
  // p/ o modelo saber os campos obrigatórios (sem isto ele chuta os args de tools
  // complexas, ex.: playwright `browser_type`, e a chamada falha). Lido DEFENSIVAMENTE:
  // só repassa se for OBJETO (um server que declare lixo/não-objeto ⇒ `undefined` ⇒
  // a tool entra no prompt SEM params e no nativo com schema permissivo — igual ao de
  // antes). A classificação de EFEITO segue por sinais do INPUT, nunca daqui.
  const rawSchema = discovered.descriptor.inputSchema;
  const parameters =
    rawSchema !== null && typeof rawSchema === 'object' && !Array.isArray(rawSchema)
      ? (rawSchema as Readonly<Record<string, unknown>>)
      : undefined;

  return {
    name,
    // EFEITO por padrão (E-B2): nunca leitura local. O gate a classifica por sinais.
    effect: 'mcp',
    description,
    ...(parameters ? { parameters } : {}),
    async run(input, _ports, ctx): Promise<ToolResult> {
      try {
        // BUG-0028 — propaga o abort do ESC/Ctrl-C (`ctx.signal`) p/ a chamada MCP,
        // p/ o usuário CANCELAR na hora uma tool de server travada. Sem isto o ESC
        // não interrompia uma tool MCP em voo (esperava o teto de 60s do transport).
        const result = await discovered.transport.callTool(
          discovered.descriptor.name,
          input,
          ctx?.signal,
        );
        // CLI-SEC-4: a saída do server é DADO NÃO-CONFIÁVEL. Devolvemos como
        // `observation` (o loop a envelopa <<<DADO_NAO_CONFIAVEL>>>); NUNCA é
        // instrução, NUNCA relaxa a catraca. `ok=false` vira observação de erro.
        // CLI-SEC-6 (defense-in-depth) — REDIGE a saída do server (não-confiável: pode
        // ecoar `sk-…`/`Bearer …`/`api_key=…`) na ORIGEM, antes de virar observação ao
        // modelo / persistir no journal. Mesma fonte única `redactOutputSecrets`.
        const content = redactOutputSecrets(result.content);
        if (!result.ok) {
          return { ok: false, observation: clip(`MCP "${name}" erro: ${content}`) };
        }
        return {
          ok: true,
          observation: clip(content),
          display: `${name}(${shortInput(input)})`,
        };
      } catch (e) {
        // o transport caiu / server morreu ⇒ observação de erro (não lança no loop).
        return {
          ok: false,
          observation: `MCP "${name}" falhou: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}

/**
 * Adapta TODAS as tools descobertas (p/ registrar de uma vez no toolset).
 *
 * HUNT-DUP — DEDUP POR NOME PREFIXADO (fail-soft, anti-crash de boot). O nome de uma
 * tool vem do `listTools` do server (DADO NÃO-CONFIÁVEL): um server bugado/hostil pode
 * listar a MESMA tool duas vezes (ou dois descritores com o mesmo `name`), gerando dois
 * `mcp__<server>__<tool>` IDÊNTICOS. O `ToolRegistry.register()` (construído no BOOT a
 * partir destas tools) LANÇA em nome duplicado ⇒ a colisão derrubaria a sessão INTEIRA
 * (todas as tools, nativas e de TODOS os servers) — violando a disciplina fail-soft
 * ("um MCP quebrado NÃO trava o agente"). Aqui, na fronteira do dado não-confiável,
 * mantemos a PRIMEIRA ocorrência de cada nome e PULAMOS as repetidas (skip-do-ruim
 * por-tool, determinístico). Protege os DOIS caminhos uniformemente: a construção no
 * boot e o `replaceMcpTools` do `/mcp reload`.
 *
 * HUNT-CAP (classe "recurso sem teto", #266) — TETO POR SERVER (`MAX_MCP_TOOLS_PER_SERVER`):
 * um server que liste mais que o teto tem só as N PRIMEIRAS aceitas (na ordem que listou,
 * DETERMINÍSTICO) — o excesso é cortado e EMITE UM AVISO HONESTO via `onWarn` ("server X
 * expôs M tools; usando as primeiras N"), nunca trunca silencioso. As duplicatas (HUNT-DUP)
 * NÃO consomem cota do teto: o cap conta as tools EFETIVAMENTE aceitas. O aviso NÃO vaza
 * segredo (só nome do server + contagens). Caso comum (poucas tools) fica IDÊNTICO.
 *
 * @param onWarn  coletor opcional de avisos honestos (a UX/log decide onde exibir; o core
 *   NÃO escreve em `console`/stderr — mantém-se PURO/portável). Ausente ⇒ corta em silêncio
 *   mas correto (o teto ainda protege o contexto).
 */
export function adaptMcpTools(
  discovered: readonly DiscoveredMcpTool[],
  onWarn?: (warning: string) => void,
): NativeTool<ToolPorts>[] {
  const out: NativeTool<ToolPorts>[] = [];
  const seen = new Set<string>();
  // Quantas tools de CADA server já entraram (pós-dedup) — base do teto por server.
  const acceptedPerServer = new Map<string, number>();
  // Quantas o server LISTOU ao todo (pós-dedup), p/ o aviso reportar M honesto.
  const listedPerServer = new Map<string, number>();
  const overflowed = new Set<string>();
  for (const d of discovered) {
    const tool = adaptMcpTool(d);
    if (seen.has(tool.name)) continue; // nome duplicado do server ⇒ pula (1ª vence).
    seen.add(tool.name);
    const server = d.server;
    listedPerServer.set(server, (listedPerServer.get(server) ?? 0) + 1);
    const accepted = acceptedPerServer.get(server) ?? 0;
    if (accepted >= MAX_MCP_TOOLS_PER_SERVER) {
      overflowed.add(server); // estourou o teto ⇒ corta e marca p/ o aviso.
      continue;
    }
    acceptedPerServer.set(server, accepted + 1);
    out.push(tool);
  }
  if (onWarn) {
    // Determinístico: avisa na 1ª ordem de aparição dos servers que estouraram.
    for (const server of overflowed) {
      const m = listedPerServer.get(server) ?? 0;
      onWarn(
        `server MCP "${server}" expôs ${m} tools; usando as primeiras ` +
          `${MAX_MCP_TOOLS_PER_SERVER} (teto por server, anti-estouro de contexto). As ` +
          `demais foram ignoradas — revise o server ou reduza as tools que ele expõe.`,
      );
    }
  }
  return out;
}

/** Resumo curto do input p/ o `display` da confirmação (CLI-SEC-9). Não vaza segredo. */
function shortInput(input: Readonly<Record<string, unknown>>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  const s = JSON.stringify(input);
  return s.length <= 200 ? s : `${s.slice(0, 200)}…`;
}

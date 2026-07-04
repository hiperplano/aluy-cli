// ADR-0145 (frente d/e) — helpers PUROS que montam as PEÇAS do `CapabilitiesSnapshot`
// a partir do dado que o controller já tem em mãos (tools registradas, agentes `.md`,
// skills carregadas, tools MCP adaptadas). Extraídos do `controller.ts` para serem
// TESTÁVEIS sem precisar erguer um `SessionController`/loop/model inteiro — o
// controller só os chama e agrega o resto (contagem de memória — async — e
// `monitorStore.list()`, que são estado vivo, não dado puro).
//
// SEGURANÇA (AG-0008 · CLI-SEC-4), aplicada AQUI:
//  - Agentes/skills de origem `project` são DADO DE TERCEIRO (um repo clonado hostil
//    pode plantar `.claude/agents/evil.md` ou `.claude/skills/evil/SKILL.md`): o
//    `summary` passa por `sanitizeUntrustedDoc` (mesma disciplina do `context.ts` p/
//    description de tool MCP) ANTES de entrar no snapshot — nunca elevado a instrução
//    (a tool `capabilities` devolve OBSERVAÇÃO, não `system`).
//  - Skills: `invocable` é `true` SÓ p/ `origin === 'global'` (ADR-0145 §e — skill de
//    projeto é DESCOBERTA-APENAS; o agente nunca a invoca sozinho).
//  - MCP: SÓ `server`/`toolCount`/`prefix` — a description da tool de terceiro NUNCA
//    entra aqui (o `NativeTool` MCP nem é lido além do `.name`).

import {
  parseMcpToolName,
  sanitizeUntrustedDoc,
  type AgentProfile,
  type CapabilityGroup,
  type CapabilityMcpServer,
  type CapabilityNamedItem,
  type CapabilityToolInfo,
  type NativeTool,
  type Skill,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';

/**
 * Resumo de UMA LINHA do system prompt de um agente `.md` sem `description`
 * (fallback do menu de `capabilities`). PURA: colapsa espaço em branco e apara ao
 * teto — nunca mostra o corpo inteiro (que pode ser longo/multi-linha).
 */
export function clampAgentSummary(systemPrompt: string, max = 140): string {
  const flat = systemPrompt.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Mapeia as tools JÁ REGISTRADAS (`toolRegistry.list()`) para o formato do menu.
 * `group` de uma tool MCP (`mcp__<server>__<tool>`) é SEMPRE `'mcp'` — INFERIDO do
 * prefixo do nome (dado NOSSO), nunca de um `group` auto-declarado pelo server (que
 * nem existe: o adapter MCP não seta `group`/`when`, ver `tool-adapter.ts`).
 */
export function mapToolsToCapabilityInfo(
  tools: readonly NativeTool<ToolPorts>[],
): CapabilityToolInfo[] {
  return tools.map((t) => {
    const mcp = parseMcpToolName(t.name);
    const group: CapabilityGroup = mcp ? 'mcp' : (t.group ?? 'outro');
    return {
      name: t.name,
      effect: t.effect,
      group,
      ...(t.when !== undefined ? { when: t.when } : {}),
    };
  });
}

/**
 * Mapeia agentes `.md` (`AgentRegistry.list()`) para itens do menu. `origin==='project'`
 * ⇒ `summary` SANITIZADA (dado de terceiro — CLI-SEC-4); nunca marca `invocable`
 * (delegação de agente já é via a tool própria `spawn_agent`, não um flag de invocação).
 */
export function mapAgentsToCapabilityItems(
  agents: readonly AgentProfile[],
): CapabilityNamedItem[] {
  return agents.map((a) => {
    const raw = a.description ?? clampAgentSummary(a.systemPrompt);
    return {
      name: a.name,
      summary: a.origin === 'project' ? sanitizeUntrustedDoc(raw) : raw,
      origin: a.origin,
    };
  });
}

/**
 * Mapeia skills (`UserSkillsLoader`/`ProjectSkillsLoader`) para itens do menu —
 * ADR-0145 §e: DESCOBERTA para TODAS as origens; `invocable: true` SÓ p/ `global`
 * (skill de projeto nunca é auto-invocada — só descoberta/recomendada).
 */
export function mapSkillsToCapabilityItems(skills: readonly Skill[]): CapabilityNamedItem[] {
  return skills.map((s) => {
    const raw = s.description ?? '(sem descrição)';
    return {
      name: s.name,
      summary: s.origin === 'project' ? sanitizeUntrustedDoc(raw) : raw,
      origin: s.origin,
      invocable: s.origin === 'global',
    };
  });
}

/**
 * Agrupa as tools MCP adaptadas (`mcp__<server>__<tool>`) por SERVER — SÓ o
 * contador e o prefixo (NUNCA a description da tool de terceiro, que nem é lida:
 * só `t.name` é inspecionado aqui).
 */
export function groupMcpServers(
  mcpTools: readonly NativeTool<ToolPorts>[],
): CapabilityMcpServer[] {
  const byServer = new Map<string, number>();
  for (const t of mcpTools) {
    const parsed = parseMcpToolName(t.name);
    if (!parsed) continue;
    byServer.set(parsed.server, (byServer.get(parsed.server) ?? 0) + 1);
  }
  return [...byServer.entries()].map(([server, toolCount]) => ({
    server,
    toolCount,
    prefix: `mcp__${server}__`,
  }));
}

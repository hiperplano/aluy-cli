// ADR-0145 (frente d) — tool `capabilities` (+ sinônimo `list_tools`): o MENU VIVO,
// SOB DEMANDA, do que o agente pode disparar AGORA. Fecha o buraco #6 da auditoria
// ("sem auto-descoberta") e dá suporte ao buraco #3 ("skills invisíveis", frente e —
// descoberta-apenas): o agente chama esta tool ANTES de dizer "não tenho como".
//
// A tool é PURA quanto a I/O: ela só FORMATA o `CapabilitiesSnapshot` que a
// `CapabilitiesPort` entrega (o I/O real — enumerar agentes/skills/MCP/monitores —
// mora no locus concreto, que já tem esses dados em mãos no controller). `effect:
// 'read'` — não escreve, não executa, não faz rede.
//
// SEGURANÇA (AG-0008 · CLI-SEC-4), aplicada AQUI (na formatação) e no que os testes
// de fronteira cobrem:
//  - NUNCA imprime credencial/provider/base_url/api_key/`model`/`tier` — só nomes,
//    efeitos, contadores e agrupamento (dado já não-sensível, já em prosa no `system`).
//  - MCP: só `server`/`toolCount`/`prefix` — NUNCA a description da tool de terceiro
//    (essa já fica de fora do `CapabilityMcpServer`, então não há como vazá-la aqui).
//  - Memória: só `factCount` — nunca o conteúdo de um fato.
//  - O retorno é uma OBSERVAÇÃO (a tool devolve `ToolResult.observation`); quem a
//    ENVELOPA como DADO_NÃO_CONFIÁVEL no canal `user` é `context.ts` (como qualquer
//    tool) — esta tool nunca escreve no `system`.

import type {
  CapabilitiesSnapshot,
  CapabilityGroup,
  NativeTool,
  ToolPorts,
  ToolResult,
} from './types.js';

/** Nome canônico da tool. */
export const CAPABILITIES_TOOL_NAME = 'capabilities';
/** Sinônimo aceito (ADR-0145 §d) — mesmo comportamento, nome alternativo. */
export const CAPABILITIES_TOOL_ALIAS = 'list_tools';

const CAPABILITIES_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    filter: {
      type: 'string',
      description:
        'Filtro opcional (grupo ou termo, ex.: "mcp", "delegacao", "skills"). Ausente ⇒ menu completo.',
    },
  },
  additionalProperties: false,
});

/** Rótulo legível de cada `CapabilityGroup`, SÓ p/ a formatação (fonte única aqui). */
const GROUP_LABEL: Record<CapabilityGroup, string> = {
  arquivo: 'AÇÃO em arquivos',
  busca: 'BUSCA',
  execucao: 'EXECUÇÃO',
  delegacao: 'DELEGAÇÃO',
  memoria: 'MEMÓRIA',
  assincrono: 'ASSÍNCRONO',
  web: 'WEB',
  plano: 'PLANO/TODO',
  mcp: 'MCP conectados',
  outro: 'OUTRAS',
};

/** Ordem de exibição dos grupos (estável, legível — segue o mapa de capacidades do prompt). */
const GROUP_ORDER: readonly CapabilityGroup[] = [
  'arquivo',
  'busca',
  'execucao',
  'delegacao',
  'memoria',
  'assincrono',
  'web',
  'plano',
  'mcp',
  'outro',
];

function matches(filter: string | undefined, ...haystacks: readonly string[]): boolean {
  if (filter === undefined || filter.trim() === '') return true;
  const f = filter.trim().toLowerCase();
  return haystacks.some((h) => h.toLowerCase().includes(f));
}

/**
 * Renderiza o `CapabilitiesSnapshot` num texto AGRUPADO POR INTENÇÃO, ~concisão
 * alvo (~20 linhas sem filtro — o dono é BYO, tokens custam). PURA/determinística.
 */
export function renderCapabilities(
  snapshot: CapabilitiesSnapshot,
  filter: string | undefined,
): string {
  const lines: string[] = [];

  const byGroup = new Map<CapabilityGroup, string[]>();
  for (const t of snapshot.tools) {
    if (!matches(filter, t.group, t.name)) continue;
    const arr = byGroup.get(t.group) ?? [];
    arr.push(t.when ? `${t.name} (${t.when})` : t.name);
    byGroup.set(t.group, arr);
  }
  for (const g of GROUP_ORDER) {
    const names = byGroup.get(g);
    if (names === undefined || names.length === 0) continue;
    if (g === 'mcp') continue; // MCP tem seção própria abaixo (com toolCount/prefix por server).
    lines.push(`[${GROUP_LABEL[g]}] ${names.join(' · ')}`);
  }

  if (matches(filter, 'delegacao', 'agentes', 'spawn_agent') && snapshot.agents.length > 0) {
    const names = snapshot.agents.map((a) => a.name).join(', ');
    lines.push(`[DELEGAÇÃO] spawn_agent → agentes .md: ${names}`);
  }

  if (matches(filter, 'memoria', 'memory', 'recall', 'remember') && snapshot.memory) {
    lines.push(
      `[MEMÓRIA] remember · recall (você tem ${snapshot.memory.factCount} fato(s) gravado(s))`,
    );
  }

  if (matches(filter, 'assincrono', 'monitor') && snapshot.monitors) {
    lines.push(`[ASSÍNCRONO] monitor · monitores ativos: ${snapshot.monitors.length}`);
  }

  if (matches(filter, 'mcp') && snapshot.mcpServers.length > 0) {
    for (const s of snapshot.mcpServers) {
      lines.push(`[MCP conectado] server "${s.server}": ${s.toolCount} tool(s) (${s.prefix}*)`);
    }
  }

  if (matches(filter, 'skills', 'skill') && snapshot.skills.length > 0) {
    const names = snapshot.skills
      .map((s) => (s.invocable ? s.name : `${s.name} (descoberta)`))
      .join(', ');
    lines.push(`[SKILLS] ${names} — recomende via /skill; só as globais são invocáveis por você`);
  }

  if (matches(filter, 'comandos', 'command') && snapshot.sessionCommands.length > 0) {
    const names = snapshot.sessionCommands.map((c) => `/${c.name}`).join(', ');
    lines.push(`[COMANDOS p/ recomendar ao HUMANO] ${names}`);
  }

  if (lines.length === 0) {
    return filter !== undefined && filter.trim() !== ''
      ? `capabilities: nenhuma capacidade casou o filtro "${filter}".`
      : 'capabilities: nenhuma capacidade disponível nesta sessão.';
  }
  return `CAPACIDADES DISPONÍVEIS AGORA:\n${lines.join('\n')}`;
}

async function runCapabilities(
  input: Readonly<Record<string, unknown>>,
  ports: ToolPorts,
): Promise<ToolResult> {
  if (!ports.capabilities) {
    return {
      ok: false,
      observation: 'capabilities: indisponível nesta sessão (sem porta de capacidades).',
    };
  }
  const rawFilter = input['filter'];
  const filter = typeof rawFilter === 'string' ? rawFilter : undefined;
  try {
    const snapshot = await ports.capabilities.snapshot();
    return { ok: true, observation: renderCapabilities(snapshot, filter) };
  } catch (e) {
    return {
      ok: false,
      observation: `capabilities: falha ao montar o menu — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

const CAPABILITIES_DESCRIPTION =
  'Lista o MENU VIVO do que você pode disparar AGORA: tools nativas agrupadas por intenção, ' +
  'agentes .md p/ spawn_agent, servers MCP conectados, skills descobertas, nº de fatos na ' +
  'memória, monitores ativos e comandos da sessão (p/ recomendar ao humano). Use QUANDO tiver ' +
  'dúvida sobre uma capacidade — NUNCA diga "não consigo"/"não tenho como" sem checar aqui ' +
  'ANTES. Input: { "filter"?: string } (ex.: "mcp", "delegacao", "skills" — ausente = menu completo).';

export const capabilitiesTool: NativeTool<ToolPorts> = {
  name: CAPABILITIES_TOOL_NAME,
  effect: 'read',
  group: 'outro',
  when: 'em dúvida sobre o que você consegue fazer AGORA — ANTES de dizer "não dá"',
  description: CAPABILITIES_DESCRIPTION,
  parameters: CAPABILITIES_SCHEMA,
  async run(input, ports): Promise<ToolResult> {
    return runCapabilities(input, ports);
  },
};

/** Sinônimo (ADR-0145 §d): MESMA implementação, nome alternativo aceito do modelo. */
export const listToolsTool: NativeTool<ToolPorts> = {
  ...capabilitiesTool,
  name: CAPABILITIES_TOOL_ALIAS,
  description: `Sinônimo de \`${CAPABILITIES_TOOL_NAME}\` (idêntico). ${CAPABILITIES_DESCRIPTION}`,
};

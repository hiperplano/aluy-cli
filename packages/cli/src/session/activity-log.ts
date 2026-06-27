// EST-0990 — projeção PURA do LOG DE ATIVIDADE (Variação V2: AGRUPADO POR AGENTE).
//
// FONTE DE DADOS: a `FlowTree` (cli-core) — `flowOverview()` (resumo por nó) +
// `drillInFlow(id)` (atividade recente JÁ REDIGIDA, RES-C-1/CLI-SEC-6). NÃO inventamos
// stream cru (segurança RES-C-1): tudo que aparece no log saiu da projeção em árvore,
// que já passou por `redactCommandSecrets`. Um segredo na linha de comando vira
// `‹redigido›` ANTES de chegar aqui — esta camada só AGRUPA e JANELA.
//
// V2: cada nó da árvore (root + sub-agentes) é uma SEÇÃO colapsável; as atividades
// recentes (tool-calls/spawn/broker/ask-deny) vivem DENTRO da seção. Anel BOUNDED
// (teto global `MAX_LOG_EVENTS`) — anti-crescimento. A janela visível é a CAUDA
// (`▼ ao vivo`); o foco no log rola (offset). Esta projeção é DADO p/ o `<ActivityLog>`
// (componente puro, só renderiza props — nada de I/O nem de FlowTree direto).

import type { FlowSummary, FlowDrillIn, FlowPhase, FlowActivity, FlowKind } from '@aluy/cli-core';

/** Teto GLOBAL de eventos no anel (anti-crescimento — a spec: ex. 500). */
export const MAX_LOG_EVENTS = 500;

/** Tipo semântico de um evento do log (decide glifo + papel de cor do DS). */
export type LogEventKind =
  | 'tool' // ⏺ tool-call (ok) / ✗ (erro) / ◌ (rodando)
  | 'spawn' // ⤷ spawn de sub-agente
  | 'broker' // ● chamada ao broker (thinking)
  | 'ask' // ⚠ catraca pediu confirmação
  | 'deny'; // ✗ catraca negou

/** UM evento já projetado p/ exibição (display REDIGIDO na origem — RES-C-1). */
export interface LogEvent {
  readonly kind: LogEventKind;
  /** Nome da tool / verbo do evento (`bash`, `read_file`, `spawn`, `broker`). */
  readonly label: string;
  /** Alvo legível JÁ REDIGIDO (comando/path/agente). Pode ser vazio. */
  readonly detail: string;
  /** `running` enquanto em curso; `ok`/`err`/`info` quando concluído/informativo. */
  readonly status: 'running' | 'ok' | 'err' | 'info';
  // EST-1000 — o DADO RICO da `FlowActivity` (#142), encaminhado p/ o `<ActivityLog>`
  // mostrar mais agora que o painel tem altura cheia. TUDO opcional/redigido na origem
  // (RES-C-1); ausência = não exibe (degrada com graça — a árvore antiga renderiza igual).
  /** DURAÇÃO da tool-call (ms). Ao vivo enquanto running; congelada no fim. */
  readonly durationMs?: number;
  /** DIFFSTAT de um edit/write — linhas adicionadas/removidas (`+12 −4`). */
  readonly added?: number;
  readonly removed?: number;
  /** RESUMO curto REDIGIDO do resultado (`48 linhas`, `exit 0`, `aplicado`). */
  readonly summary?: string;
  /** TOKENS desta atividade (custo da tool-call, quando aplicável). */
  readonly tokens?: number;
  /** TAIL ao vivo (últimas linhas REDIGIDAS) de um comando em curso. */
  readonly tail?: string;
}

/** UMA seção do log — um nó da árvore (root/sub-agente) + seus eventos recentes. */
export interface LogSection {
  readonly id: string;
  readonly kind: FlowKind;
  /** Rótulo de origem (CLI-SEC-9) — `[root]`, `[test]`, … */
  readonly label: string;
  readonly phase: FlowPhase;
  /** `74.4k` tokens (abreviado). */
  readonly tokens: number;
  readonly toolCalls: number;
  readonly durationMs: number;
  /** `true` se a seção está COLAPSADA (`▶`) — não exibe os eventos. */
  readonly collapsed: boolean;
  /** Eventos recentes da seção (mais novo por último), JÁ redigidos. */
  readonly events: readonly LogEvent[];
}

/** A projeção completa do log (todas as seções) + metadados de janela. */
export interface ActivityLogProjection {
  readonly sections: readonly LogSection[];
  /** Total de eventos (somados) — p/ a contagem de "novidade" (badge `●N`). */
  readonly totalEvents: number;
}

/**
 * Mapeia uma `FlowActivity` (do drill-in, JÁ redigida) p/ um `LogEvent`. A catraca
 * ask/deny chega como atividade de tool com alvo prefixado pelo controller; aqui
 * classificamos pelo nome. Eventos `spawn`/`broker` são derivados à parte (ver build).
 */
function activityToEvent(a: FlowActivity): LogEvent {
  const status: LogEvent['status'] = a.running ? 'running' : a.ok === false ? 'err' : 'ok';
  // exactOptionalPropertyTypes: só inclui o campo quando DEFINIDO (ausência ≠ `undefined`).
  return {
    kind: 'tool',
    label: a.tool,
    detail: a.target,
    status,
    ...(a.durationMs !== undefined ? { durationMs: a.durationMs } : {}),
    ...(a.added !== undefined ? { added: a.added } : {}),
    ...(a.removed !== undefined ? { removed: a.removed } : {}),
    ...(a.summary !== undefined ? { summary: a.summary } : {}),
    ...(a.tokens !== undefined ? { tokens: a.tokens } : {}),
    ...(a.tail !== undefined ? { tail: a.tail } : {}),
  };
}

/**
 * Constrói a projeção do log a partir do overview (resumo por nó) + um leitor de
 * drill-in (atividade redigida por nó). PURO. Opções:
 *   • `collapsed`: conjunto de ids de seções colapsadas (foco+Enter alterna).
 *   • `showAllows`: incluir eventos `ask` que foram ALLOW silencioso (default: OFF —
 *     só ask/deny "ruidosos" aparecem; o toggle `a` liga os allows). A catraca em si
 *     não distingue aqui — o controller marca o que é deny; allow silencioso = ausência.
 *   • `errorsOnly`: filtra só eventos de erro/deny (filtro `e`).
 *   • `cap`: teto global de eventos (default `MAX_LOG_EVENTS`).
 *
 * RES-C-1: a função NUNCA toca o stream cru — só consome `drillIn(id).recent`, que o
 * core já redigiu. Não há caminho aqui p/ conteúdo confinado (journal/memória).
 */
export function buildActivityLog(
  overview: readonly FlowSummary[],
  drillIn: (id: string) => FlowDrillIn | undefined,
  opts: {
    readonly collapsed?: ReadonlySet<string>;
    readonly errorsOnly?: boolean;
    readonly cap?: number;
  } = {},
): ActivityLogProjection {
  const collapsed = opts.collapsed ?? new Set<string>();
  const cap = opts.cap ?? MAX_LOG_EVENTS;
  const sections: LogSection[] = [];
  let totalEvents = 0;

  for (const node of overview) {
    const isCollapsed = collapsed.has(node.id);
    const detail = drillIn(node.id);
    let events: LogEvent[] = (detail?.recent ?? []).map(activityToEvent);

    // SPAWN: um sub-agente é, ele próprio, um evento `⤷ spawn [label]` na seção do PAI.
    // Derivado da topologia (não do stream): a existência do nó-filho já é o spawn.
    // (A seção do filho mostra a atividade DELE; aqui só sinalizamos o spawn no pai.)

    // EST-1015 (pedido do dono: "mais coisas no log do fullscreen") — durante o THINKING o
    // modelo está GERANDO mas ainda não houve tool ⇒ a seção ficava SÓ com o cabeçalho (log
    // "vazio"). Derivamos um evento `● broker · gerando · N tok` VIVO p/ o usuário ver o que
    // está acontecendo (a chamada ao broker em curso). Some assim que a fase sai de `thinking`
    // (vira tool/done) — não polui o histórico. Tokens do accounting (do budget/broker, HG-2).
    if (node.phase === 'thinking') {
      events = [
        ...events,
        {
          kind: 'broker',
          label: 'broker',
          detail: 'gerando',
          status: 'running',
          ...(node.accounting.tokens > 0 ? { tokens: node.accounting.tokens } : {}),
        },
      ];
    }

    if (opts.errorsOnly) {
      events = events.filter((e) => e.status === 'err' || e.kind === 'deny');
    }

    totalEvents += events.length;

    sections.push({
      id: node.id,
      kind: node.kind,
      label: node.label,
      phase: node.phase,
      tokens: node.accounting.tokens,
      toolCalls: node.accounting.toolCalls,
      durationMs: node.accounting.durationMs,
      collapsed: isCollapsed,
      events: isCollapsed ? [] : events,
    });
  }

  // Anel BOUNDED global: se a soma de eventos exceder o teto, apara as seções MAIS
  // ANTIGAS por completo (a cauda — atividade recente — é o que importa no `▼ ao vivo`).
  // Cada nó já é bounded a MAX_RECENT (12) no core; o teto global é a segunda cerca.
  if (totalEvents > cap) {
    let budget = cap;
    // Mantém da CAUDA p/ o topo (seções mais recentes primeiro), apara o resto.
    for (let i = sections.length - 1; i >= 0; i--) {
      const s = sections[i]!;
      if (budget <= 0) {
        sections[i] = { ...s, events: [] };
        continue;
      }
      if (s.events.length > budget) {
        sections[i] = { ...s, events: s.events.slice(s.events.length - budget) };
        budget = 0;
      } else {
        budget -= s.events.length;
      }
    }
  }

  return { sections, totalEvents };
}

/**
 * EST-1015 (UX redesign) — nº de LINHAS lógicas que `sections` renderiza, p/ o
 * dimensionamento ADAPTATIVO do log no cockpit (não inflar a região além do conteúdo
 * real). Cada seção = 1 linha de cabeçalho + (COLAPSADA ⇒ 0, senão os `events`). PURO.
 */
export function countActivityLines(sections: readonly LogSection[]): number {
  let n = 0;
  for (const s of sections) {
    n += 1 + (s.collapsed ? 0 : s.events.length);
  }
  return n;
}

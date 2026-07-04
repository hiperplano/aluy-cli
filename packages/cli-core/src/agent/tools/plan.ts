// EST-1015 (pedido do dono) — tool nativa `update_plan`: o agente DECLARA e ATUALIZA
// um PLANO (checklist de passos com status) durante uma série de atividades. É o
// equivalente do TodoWrite/update_plan: dá ao USUÁRIO uma visão viva do progresso e
// ajuda o MODELO (sobretudo os baratos) a manter o foco numa tarefa longa.
//
// SEM efeito externo: a tool só REGISTRA a intenção/progresso do próprio agente (não
// lê nem muta o filesystem, a rede ou outro agente). Por isso `effect: 'read'`. MAS o
// gate do Aluy decide por NOME, não por rótulo de effect (R1/E-B2: rótulo auto-declarado
// não é confiável): o allow SILENCIOSO vem de estar em `READ_TOOLS` e o allow no modo
// Plan vem de estar em `PLAN_READ_ALLOWLIST`. Por isso `update_plan` foi ADICIONADO a
// AMBOS os Sets (engine.ts / permission/plan.ts) — senão cairia em `ask` a cada chamada
// (UX péssima) e em DENY no Plan (onde declarar um plano é justamente o que faz sentido).
// Tocar a allow-list do Plan mexe na garantia read-only do ADR-0055 ⇒ sinalizado ao
// `seguranca` (AG-0008): a tool não tem efeito externo, então é seguro (estado de UI local).
//
// FRONTEIRA (ADR-0053 §8): a LÓGICA é pura/portável (normalização do input do modelo +
// render do checklist). A SUPERFÍCIE (o painel `<Checklist>` na TUI) é do @hiperplano/aluy-cli e
// recebe o plano por uma PORTA opcional (`PlanPort`) — sem ela a tool segue útil
// (devolve o checklist renderizado como observação), só não acende o painel.

import type { NativeTool, ToolResult, ToolPorts } from './types.js';
import { ContextGraph, type BoxHorizon, type BoxSnapshot } from '../maestro/context-box-graph.js';

/** Nome estável da tool (FONTE ÚNICA — consumido pelos Sets do gate por-nome). */
export const PLAN_TOOL_NAME = 'update_plan';

/** Estado de um passo do plano (estilo TodoWrite). */
export type PlanStepStatus = 'pending' | 'in_progress' | 'completed';

/**
 * UM passo do plano: um título curto + seu status, e — opcionalmente —
 * `substeps`, sub-passos que o detalham (1 nível). Os sub-passos viram caixas
 * FILHAS no grafo (containment) e aparecem INDENTADAS no checklist (EST-1126).
 */
export interface PlanStep {
  readonly title: string;
  readonly status: PlanStepStatus;
  readonly substeps?: readonly PlanStep[];
}

/** Um passo achatado para render/painel: o passo + sua profundidade (0 = topo). */
export interface FlatPlanStep {
  readonly step: PlanStep;
  readonly depth: number;
}

/**
 * Achata a árvore de passos numa lista em ordem de leitura (pai, depois seus
 * sub-passos), carregando a profundidade. PURO. Sub-passos são 1 nível (a
 * profundidade de um sub-passo é sempre 1). Passos sem `substeps` ⇒ lista flat
 * idêntica à entrada (não-regressão).
 */
export function flattenPlan(steps: readonly PlanStep[]): FlatPlanStep[] {
  const out: FlatPlanStep[] = [];
  for (const s of steps) {
    out.push({ step: s, depth: 0 });
    for (const sub of s.substeps ?? []) out.push({ step: sub, depth: 1 });
  }
  return out;
}

/**
 * Porta OPCIONAL: o locus concreto (@hiperplano/aluy-cli) liga ao estado da sessão para o painel
 * `<Checklist>` refletir o plano vivo. Ausente ⇒ a tool é igualmente funcional (só não
 * há painel). Recebe SEMPRE o plano inteiro (substitui — não faz merge) — o modelo
 * re-emite a lista completa a cada atualização, como o TodoWrite.
 */
export interface PlanPort {
  set(steps: readonly PlanStep[]): void;
}

const VALID_STATUS: ReadonlySet<string> = new Set<PlanStepStatus>([
  'pending',
  'in_progress',
  'completed',
]);
/** Tetos defensivos (input do modelo = não-confiável; nunca deixar explodir a UI). */
export const MAX_PLAN_STEPS = 30;
export const MAX_STEP_TITLE = 120;

/** Resultado da normalização: a lista válida OU um erro acionável (boundary). */
export type PlanParse = { readonly steps: readonly PlanStep[] } | { readonly error: string };

const NO_TITLE_ERR = 'update_plan: cada passo precisa de um título (texto) não-vazio.';

/**
 * Parseia UM item cru (string ou objeto) num `PlanStep`. PURO. `allowSubsteps`
 * controla a recursão (sub-passos são 1 nível — um sub-passo não tem sub-passos).
 * Devolve a string de erro (acionável) quando o título falta. Tolerante à forma.
 */
function parseStepItem(item: unknown, allowSubsteps: boolean): PlanStep | string {
  let title: string | undefined;
  let status: PlanStepStatus = 'pending';
  let substeps: PlanStep[] | undefined;
  if (typeof item === 'string') {
    title = item;
  } else if (item !== null && typeof item === 'object') {
    const o = item as Record<string, unknown>;
    const t = o.title ?? o.step ?? o.text ?? o.name ?? o.content;
    if (typeof t === 'string') title = t;
    if (typeof o.status === 'string' && VALID_STATUS.has(o.status)) {
      status = o.status as PlanStepStatus;
    }
    if (allowSubsteps) {
      const subRaw = o.substeps ?? o.subtasks ?? o.subpassos ?? o.children;
      if (Array.isArray(subRaw) && subRaw.length > 0) {
        const subs: PlanStep[] = [];
        for (const s of subRaw) {
          const parsed = parseStepItem(s, false); // 1 nível: sub-passo não aninha
          if (typeof parsed === 'string') return parsed; // propaga o erro
          subs.push(parsed);
        }
        substeps = subs;
      }
    }
  }
  if (title === undefined || title.trim() === '') return NO_TITLE_ERR;
  const clipped = title.trim().slice(0, MAX_STEP_TITLE);
  return substeps ? { title: clipped, status, substeps } : { title: clipped, status };
}

/**
 * Normaliza o input CRU do modelo (não-confiável) em `PlanStep[]`. PURO. Tolerante à
 * forma (o modelo barato erra o formato): aceita `steps`/`plan`/`todos`; cada item pode
 * ser uma STRING (vira passo `pending`) ou um OBJETO `{title|step|text|name, status?,
 * substeps?}`. Status inválido/ausente ⇒ `pending`. Valida o teto sobre o TOTAL
 * achatado (passos + sub-passos) e exige título não-vazio.
 */
export function normalizePlanInput(input: Readonly<Record<string, unknown>>): PlanParse {
  const raw = input.steps ?? input.plan ?? input.todos ?? input.items;
  if (!Array.isArray(raw)) {
    return {
      error: 'update_plan: passe "steps" como uma LISTA de passos (string ou {title,status}).',
    };
  }
  if (raw.length === 0) return { error: 'update_plan: a lista de passos está vazia.' };
  const steps: PlanStep[] = [];
  for (const item of raw) {
    const parsed = parseStepItem(item, true);
    if (typeof parsed === 'string') return { error: parsed };
    steps.push(parsed);
  }
  // HUNT-GRAFO — títulos DUPLICADOS colidiam no `boxId` determinístico (slug-0): a
  // projeção do grafo (syncPlanToGraph + render por label) FUNDIA os passos homônimos
  // numa caixa só ⇒ o horizonte de um (ex.: o `in_progress` 📌) era CLOBBERADO pelo
  // duplicata. Desambiguamos como o `spawn_agent` faz com labels (uniqueLabel): o 1º
  // fica, os repetidos ganham " #2", " #3"… Determinístico (ordem top→subs, igual ao
  // flatten/sync) ⇒ estável entre updates. Também deixa o checklist LEGÍVEL (2 linhas
  // "Testar" idênticas eram ambíguas pro usuário).
  const usedTitles = new Set<string>();
  const uniqueTitle = (t: string): string => {
    if (!usedTitles.has(t)) {
      usedTitles.add(t);
      return t;
    }
    for (let n = 2; ; n++) {
      const candidate = `${t} #${n}`;
      if (!usedTitles.has(candidate)) {
        usedTitles.add(candidate);
        return candidate;
      }
    }
  };
  for (let i = 0; i < steps.length; i++) {
    const top = steps[i]!;
    const title = uniqueTitle(top.title);
    const subs = top.substeps?.map((s) => ({ ...s, title: uniqueTitle(s.title) }));
    steps[i] = subs !== undefined ? { ...top, title, substeps: subs } : { ...top, title };
  }
  const total = flattenPlan(steps).length;
  if (total > MAX_PLAN_STEPS) {
    return { error: `update_plan: no máximo ${MAX_PLAN_STEPS} passos (recebidos ${total}).` };
  }
  return { steps };
}

/** Glifo por status (caixa marcável + seta de "em curso"). */
const STATUS_MARKER: Readonly<Record<PlanStepStatus, string>> = {
  pending: '☐',
  in_progress: '▶',
  completed: '☑',
};

/**
 * Renderiza o checklist p/ a OBSERVAÇÃO (volta ao modelo como dado E é o que o usuário
 * vê quando não há painel). PURO. Cabeçalho com o progresso `(feitos/total)`.
 */
export function renderPlanChecklist(steps: readonly PlanStep[]): string {
  const flat = flattenPlan(steps);
  const done = flat.filter((f) => f.step.status === 'completed').length;
  const body = flat
    .map((f) => `${'  '.repeat(f.depth)}${STATUS_MARKER[f.step.status]} ${f.step.title}`)
    .join('\n');
  return `plano (${done}/${flat.length}):\n${body}`;
}

// ── EST-1126 · Projeção do grafo de caixas ──────────────────────────────────

/** Marcador textual por horizonte (prefixo leve no render). */
const HORIZON_MARKER: Readonly<Record<BoxHorizon, string>> = {
  longo: '[📐]',
  médio: '[📋]',
  curto: '[📌]',
};

/**
 * Heurística de HORIZONTE de um passo de TOPO (EST-1126): o foco é `curto`
 * (📌 perto), o futuro é `longo` (📐 horizonte), o resto é `médio` (📋).
 * `inProgressTop` = índice do primeiro passo de topo em curso (nele ou num
 * sub-passo); −1 se nada começou.
 *   - índice == foco          → `curto`  (área de trabalho atual)
 *   - índice  > foco          → `longo`  (ainda não começou — horizonte)
 *   - índice  < foco ou s/foco → `médio`  (já passou, ou plano não iniciado)
 */
function topHorizon(index: number, inProgressTop: number): BoxHorizon {
  if (inProgressTop < 0) return 'médio';
  if (index === inProgressTop) return 'curto';
  if (index > inProgressTop) return 'longo';
  return 'médio';
}

/**
 * Sincroniza os passos do plano com o grafo de caixas. Cada `PlanStep` vira uma
 * caixa; cada sub-passo vira uma caixa FILHA (aresta de containment). O
 * horizonte de cada caixa segue a heurística (`topHorizon`) — re-aplicada a
 * CADA chamada para acompanhar o avanço do plano (um passo em curso vira `curto`;
 * `in_progress` SEMPRE é `curto`, mesmo num sub-passo). Status `completed` fecha
 * a caixa; voltar de completed reabre. CA-PROJ-1/UNICA: plano e grafo, uma verdade.
 */
export function syncPlanToGraph(steps: readonly PlanStep[], graph: ContextGraph): void {
  // Índice label → boxId (existente) para casar passos com caixas já abertas.
  const labelToBoxId = new Map<string, string>();
  for (const box of graph.listBoxes()) {
    labelToBoxId.set(box.label, box.id);
  }

  // Passo de topo "ativo": o primeiro com in_progress nele OU num sub-passo.
  const inProgressTop = steps.findIndex(
    (s) => s.status === 'in_progress' || (s.substeps ?? []).some((x) => x.status === 'in_progress'),
  );

  /** Cria/atualiza a caixa de um passo (com pai e horizonte), devolvendo o boxId. */
  const upsert = (step: PlanStep, parentId: string | null, areaHorizon: BoxHorizon): string => {
    // in_progress é sempre foco (curto), mesmo num sub-passo de área distante.
    const horizon: BoxHorizon = step.status === 'in_progress' ? 'curto' : areaHorizon;
    const existingId = labelToBoxId.get(step.title);
    const boxId = existingId ?? ContextGraph.boxId(step.title, 0);

    if (!existingId) {
      graph.openBox(boxId, horizon, step.title, parentId);
    } else {
      if (step.status !== 'completed' && graph.isClosed(existingId)) graph.reopenBox(existingId);
      graph.setHorizon(existingId, horizon);
      graph.setParent(existingId, parentId);
    }
    if (step.status === 'completed' && !graph.isClosed(boxId)) graph.closeBox(boxId);

    labelToBoxId.set(step.title, boxId);
    return boxId;
  };

  // Topos primeiro (garante o pai existir antes dos filhos), depois sub-passos.
  steps.forEach((top, i) => {
    const area = topHorizon(i, inProgressTop);
    const topId = upsert(top, null, area);
    for (const sub of top.substeps ?? []) {
      upsert(sub, topId, area);
    }
  });

  // F86 — PODA: o grafo deve espelhar EXATAMENTE o plano atual (a projeção é seu
  // único consumidor — F79). update_plan substitui o plano inteiro; passos que
  // sumiram (renomeados/removidos) deixam caixas órfãs. Sem podar, elas acumulam
  // por toda a sessão ("acumulador sem teto", EST-1011) ⇒ listBoxes O(n²). Remoção
  // EXPLÍCITA (removeBox, não forceEvict — que protege horizonte `longo`/pinado).
  const currentLabels = new Set<string>();
  for (const top of steps) {
    currentLabels.add(top.title);
    for (const sub of top.substeps ?? []) currentLabels.add(sub.title);
  }
  for (const box of graph.listBoxes()) {
    if (!currentLabels.has(box.label)) graph.removeBox(box.id);
  }
}

/**
 * Projeta o grafo de caixas como `PlanStep[]`. Lê TODAS as caixas do grafo,
 * mapeia cada uma a um `PlanStep` (status ⇄ closed/aberta) e ordena por
 * hierarquia de containment (pais antes de filhos, profundidade-first).
 * CA-PROJ-1: o checklist reflete horizonte e aninhamento do grafo.
 */
export function projectPlanFromGraph(graph: ContextGraph): PlanStep[] {
  const boxes = graph.listBoxes('createdAt');
  // Índice: id → snapshot.
  const byId = new Map<string, BoxSnapshot>();
  for (const b of boxes) byId.set(b.id, b);

  // Determina profundidade de cada caixa (distância da raiz).
  const depth = new Map<string, number>();
  // HUNT-GRAFO — `seen` (caminho da recursão) é defesa-em-profundidade, igual ao
  // `getContextChain`: o `setParent` mantém o containment ACÍCLICO por construção, mas se
  // um ciclo ESCAPASSE (regressão futura / manipulação direta), esta recursão em `parentId`
  // estouraria a pilha (RangeError ⇒ crash do CLI no render do checklist). Ao reentrar um
  // id JÁ no caminho, trata como raiz (depth 0) e PARA — nunca pendura.
  const getDepth = (id: string, seen: Set<string>): number => {
    const cached = depth.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // ciclo no caminho — para (não cacheia)
    const box = byId.get(id);
    if (!box || !box.parentId) {
      depth.set(id, 0);
      return 0;
    }
    seen.add(id);
    const d = getDepth(box.parentId, seen) + 1;
    depth.set(id, d);
    return d;
  };

  // Ordena: primeiro por profundidade (pais antes de filhos), depois por createdAt.
  const sorted = [...boxes].sort((a, b) => {
    const dA = getDepth(a.id, new Set());
    const dB = getDepth(b.id, new Set());
    if (dA !== dB) return dA - dB;
    return a.createdAt - b.createdAt;
  });

  return sorted.map((box) => ({
    title: box.label,
    status: box.closed ? 'completed' : 'pending',
  }));
}

/**
 * Renderiza o checklist a partir do GRAFO, com horizonte e aninhamento.
 * CA-PROJ-1: marcadores de horizonte + indentação hierárquica.
 * Quando `graph` é null/undefined, cai de volta no render flat clássico
 * (não-regressão EST-1015).
 */
export function renderPlanChecklistFromGraph(
  steps: readonly PlanStep[],
  graph: ContextGraph | undefined,
): string {
  if (!graph) return renderPlanChecklist(steps);

  // Índice: label → box (p/ mapear cada passo à sua caixa).
  const labelToBox = new Map<string, BoxSnapshot>();
  for (const box of graph.listBoxes()) {
    labelToBox.set(box.label, box);
  }

  // Calcula profundidade hierárquica.
  const byId = new Map<string, BoxSnapshot>();
  for (const box of graph.listBoxes()) byId.set(box.id, box);

  const depthCache = new Map<string, number>();
  // HUNT-GRAFO — `seen` é defesa-em-profundidade contra um grafo cíclico: sem ele,
  // um ciclo de containment faria esta recursão ESTOURAR a pilha (crash no render do
  // update_plan). O `setParent` já mantém o grafo acíclico, mas o render não confia.
  const getDepth = (id: string, seen: ReadonlySet<string> = new Set()): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const box = byId.get(id);
    if (!box || !box.parentId || seen.has(id)) {
      depthCache.set(id, 0);
      return 0;
    }
    const d = getDepth(box.parentId, new Set(seen).add(id)) + 1;
    depthCache.set(id, d);
    return d;
  };

  const flat = flattenPlan(steps);
  const done = flat.filter((f) => f.step.status === 'completed').length;
  const lines: string[] = [`plano (${done}/${flat.length}):`];

  for (const { step, depth: fallbackDepth } of flat) {
    const box = labelToBox.get(step.title);
    const horizonStr = box ? HORIZON_MARKER[box.horizon] : '';
    // Profundidade vem do grafo (containment real); se a caixa sumiu, usa a da árvore.
    const depth = box ? getDepth(box.id) : fallbackDepth;
    const indent = '  '.repeat(depth);
    const marker = STATUS_MARKER[step.status];
    lines.push(`${indent}${horizonStr} ${marker} ${step.title}`);
  }

  return lines.join('\n');
}

/** Glifo por status, propriedades comuns a passo e sub-passo (DRY no schema). */
const STEP_STATUS_PROP = Object.freeze({
  type: 'string',
  enum: ['pending', 'in_progress', 'completed'],
  description: 'pending (a fazer) · in_progress (em curso) · completed (feito).',
});

/** JSON Schema do input (guia o function-calling nativo + o fallback de texto). */
const UPDATE_PLAN_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    steps: {
      type: 'array',
      description:
        'A lista COMPLETA de passos do plano (re-emita TODOS a cada atualização — substitui o anterior).',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'O passo, curto e no imperativo.' },
          status: STEP_STATUS_PROP,
          substeps: {
            type: 'array',
            description:
              'OPCIONAL: sub-passos que detalham este passo (1 nível). Aparecem indentados ' +
              'sob o passo e seguem o foco dele. Use quando um passo tem ações menores distintas.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'O sub-passo, curto e no imperativo.' },
                status: STEP_STATUS_PROP,
              },
              required: ['title'],
              additionalProperties: false,
            },
          },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  required: ['steps'],
  additionalProperties: false,
});

/**
 * `update_plan` — declara/atualiza o plano. Sempre re-emite a lista inteira (substitui).
 * Sem efeito externo (`effect:'read'`): nunca pede confirmação; permitida no modo Plan.
 */
export const PLAN_TOOL: NativeTool<ToolPorts> = {
  name: PLAN_TOOL_NAME,
  effect: 'read',
  group: 'plano', // ADR-0145 (frente d) — agrupamento no menu do `capabilities`.
  description:
    'Declara/atualiza um PLANO visível (checklist de passos). Use ao iniciar uma tarefa ' +
    'com VÁRIOS passos e a cada progresso: re-emita a lista TODA marcando o status de cada ' +
    'passo (pending/in_progress/completed). Mantenha 1 passo in_progress por vez. Não tem ' +
    'efeito no sistema — é só o seu plano, para você e para o usuário acompanharem.',
  parameters: UPDATE_PLAN_SCHEMA,
  async run(input: Readonly<Record<string, unknown>>, ports: ToolPorts): Promise<ToolResult> {
    const parsed = normalizePlanInput(input);
    if ('error' in parsed) return { ok: false, observation: parsed.error };

    // EST-1126: quando o grafo está presente, sincroniza passos → caixas
    // e renderiza com horizonte + aninhamento (CA-PROJ-1).
    if (ports.graph) {
      syncPlanToGraph(parsed.steps, ports.graph);
    }

    // Atualiza o painel da TUI quando a porta existe (substitui o plano inteiro).
    // Achata a árvore (pai + sub-passos como linhas próprias, sem `substeps`) p/ o
    // painel renderizar cada passo uma vez, mesmo sem conhecer hierarquia.
    if (ports.plan) {
      ports.plan.set(
        flattenPlan(parsed.steps).map((f) => ({ title: f.step.title, status: f.step.status })),
      );
    }

    // Render com grafo (horizonte + aninhamento) ou fallback flat (não-regressão).
    const observation = renderPlanChecklistFromGraph(parsed.steps, ports.graph);
    return { ok: true, observation };
  },
};

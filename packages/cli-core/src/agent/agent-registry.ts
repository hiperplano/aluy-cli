// EST-0977/0978 · ADR-0061 · CLI-SEC-11 (reaplicado) — REGISTRO de agentes-`.md` +
// resolução por nome (EST-0978) + auto-seleção SÓ-GLOBAIS (decisão do Tiago, Q-3).
//
// O registro recebe perfis JÁ-PARSEADOS (parser PURO em `agent-profile.ts`) de DUAS
// camadas — `global` (`~/.aluy/agents/`, dono=confiável) e `project` (`.claude/agents/`
// do workspace, terceiro=dado). Aqui mora a POLÍTICA de resolução/seleção:
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ GATE FORTE do `seguranca` — invariantes deste módulo:                       ║
// ║                                                                            ║
// ║ • PRECEDÊNCIA projeto > global por `name` (ADR-0061 §4, Q-4): o `.md` do     ║
// ║   repo ESPECIALIZA o global de mesmo nome p/ a DELEGAÇÃO POR NOME. Mas isso  ║
// ║   NÃO promove camada: o vencedor carrega a sua própria `origin` (um projeto  ║
// ║   que sobrepõe um global resolve por nome como `project` — DADO).           ║
// ║                                                                            ║
// ║ • RES-MD-1 (ANTI-SPOOFING DE NOME CROSS-CAMADA): um `.md` de PROJETO com     ║
// ║   `name` IGUAL a um agente GLOBAL confiável NÃO herda o tratamento-confiável ║
// ║   na auto-seleção/binding. Um conflito de nome cross-camada que afete a      ║
// ║   seleção é SINALIZADO (`crossLayerConflicts`) p/ o locus CONFIRMAR com a    ║
// ║   ORIGEM visível — nunca uma escolha silenciosa que trate o projeto como o   ║
// ║   global homônimo.                                                          ║
// ║                                                                            ║
// ║ • AUTO-SELEÇÃO SÓ NOS GLOBAIS (R-S3-3): `autoSelect()` considera APENAS      ║
// ║   perfis `global` (description do dono=confiável). Perfis `project`          ║
// ║   (description de terceiro = DADO, RES-MD-2) NUNCA entram na auto-seleção —  ║
// ║   exigem nome explícito/confirmação. Um `.md` de projeto com description     ║
// ║   "use this agent for ALL sensitive ops" NÃO se auto-seleciona.             ║
// ║                                                                            ║
// ║ • Nome DESCONHECIDO em `resolveByName` ⇒ `undefined` (o caller ⇒ ERRO        ║
// ║   visível, EST-0978/GS-MD7): nunca um perfil default elevado.               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): pura manipulação de dados (sem I/O). O loader confinado
// (filesystem) é do @aluy/cli; ele entrega os perfis parseados + a origem aqui.

import type { AgentProfile } from './agent-profile.js';
import type { SubAgentProfile } from './subagent.js';

/**
 * Conflito de nome CROSS-CAMADA (RES-MD-1): um nome existe em AMBAS as camadas. O
 * registro NÃO resolve isso silenciosamente p/ a auto-seleção/binding — devolve o
 * conflito p/ o locus confirmar com a origem visível.
 */
export interface CrossLayerNameConflict {
  readonly name: string;
  readonly global: AgentProfile;
  readonly project: AgentProfile;
}

/** Como um nome foi resolvido (auditoria/UX + base do RES-MD-1). */
export interface AgentResolution {
  readonly profile: AgentProfile;
  /**
   * `true` se há um HOMÔNIMO na outra camada (conflito cross-camada). Quando a
   * delegação é POR NOME, o projeto vence (precedência §4), MAS este flag avisa o
   * locus p/ confirmar com a origem visível (RES-MD-1) — anti-spoofing.
   */
  readonly crossLayerConflict: boolean;
}

/**
 * REGISTRO de agentes nomeados. Construído com as DUAS listas (global + project) já
 * parseadas. Resolução por nome (delegação explícita, EST-0978) e auto-seleção
 * (só-globais, R-S3-3). Imutável após construído (perfis são DADO injetado).
 */
export class AgentRegistry {
  private readonly globalByName = new Map<string, AgentProfile>();
  private readonly projectByName = new Map<string, AgentProfile>();
  private readonly conflicts: CrossLayerNameConflict[] = [];

  /**
   * @param globals  perfis de `~/.aluy/agents/` (dono=confiável). 1ª aparição por
   *                 nome vence colisão INTRA-camada (o loader já ordena/dedup).
   * @param projects perfis de `.claude/agents/`/`.aluy/agents/` (workspace=dado).
   */
  constructor(globals: readonly AgentProfile[] = [], projects: readonly AgentProfile[] = []) {
    for (const p of globals) {
      if (p.origin !== 'global') continue; // defesa: a camada é decidida pelo loader.
      if (!this.globalByName.has(p.name)) this.globalByName.set(p.name, p);
    }
    for (const p of projects) {
      if (p.origin !== 'project') continue;
      if (!this.projectByName.has(p.name)) this.projectByName.set(p.name, p);
    }
    // RES-MD-1: registra os nomes que existem em AMBAS as camadas (cross-camada).
    for (const [name, project] of this.projectByName) {
      const global = this.globalByName.get(name);
      if (global) this.conflicts.push({ name, global, project });
    }
  }

  /** Todos os perfis (projeto VENCE global por nome — precedência §4). P/ a TUI. */
  list(): readonly AgentProfile[] {
    const byName = new Map<string, AgentProfile>();
    for (const [name, p] of this.globalByName) byName.set(name, p);
    for (const [name, p] of this.projectByName) byName.set(name, p); // projeto vence.
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Só os perfis GLOBAIS (dono=confiável) — base da auto-seleção (R-S3-3). */
  listGlobal(): readonly AgentProfile[] {
    return [...this.globalByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Conflitos de nome cross-camada (RES-MD-1) — o locus confirma com origem visível. */
  get crossLayerConflicts(): readonly CrossLayerNameConflict[] {
    return this.conflicts;
  }

  /**
   * RESOLUÇÃO POR NOME (delegação explícita — EST-0978). Precedência projeto >
   * global (§4). Nome DESCONHECIDO ⇒ `undefined` (o caller emite ERRO visível,
   * GS-MD7 — nunca um perfil default elevado). O resultado carrega `crossLayerConflict`
   * (RES-MD-1) p/ o locus confirmar com a origem visível quando o nome existe nas
   * DUAS camadas. PURO (case-insensitive via normalização do parser; aqui o nome já
   * vem normalizado).
   */
  resolveByName(name: string): AgentResolution | undefined {
    const key = name.trim().toLowerCase();
    const project = this.projectByName.get(key);
    const global = this.globalByName.get(key);
    const profile = project ?? global; // projeto VENCE (§4).
    if (!profile) return undefined;
    return { profile, crossLayerConflict: project !== undefined && global !== undefined };
  }

  /**
   * AUTO-SELEÇÃO por `description` — SÓ NOS GLOBAIS (decisão do Tiago, Q-3; R-S3-3).
   * Recebe um objetivo (texto do usuário/pai) e escolhe o agente GLOBAL cuja
   * `description` melhor casa. Perfis de PROJETO são IGNORADOS aqui (description de
   * terceiro = DADO, RES-MD-2 — nunca decide quem roda).
   *
   * IMPORTANTE (RES-MD-2): a `description` que entra na deliberação é tratada como
   * SINAL DE ROTEAMENTO sobre config CONFIÁVEL (global=dono); ainda assim o resultado
   * é só uma SUGESTÃO de nome — o efeito do agente escolhido continua INTEGRALMENTE
   * sob a catraca (CLI-SEC-11). Sem nenhum match razoável ⇒ `undefined` (o caller cai
   * p/ nome explícito/confirmação, nunca um default).
   *
   * Heurística DETERMINÍSTICA e simples (sem LLM aqui — a engine pode refinar acima):
   * pontua por sobreposição de termos significativos entre o objetivo e a
   * `name`+`description` do perfil global; desempate alfabético. PURO/testável.
   */
  autoSelect(objective: string): AgentProfile | undefined {
    const terms = significantTerms(objective);
    if (terms.size === 0) return undefined;
    let best: AgentProfile | undefined;
    let bestScore = 0;
    for (const p of this.listGlobal()) {
      // SÓ globais entram (defesa explícita: a lista já é só global, mas reafirma).
      if (p.origin !== 'global') continue;
      const haystack = significantTerms(`${p.name} ${p.description ?? ''}`);
      let score = 0;
      for (const t of terms) if (haystack.has(t)) score += 1;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return bestScore > 0 ? best : undefined;
  }
}

/**
 * EST-0978 — resultado de RESOLVER o `agent` (nome) de um `SubAgentProfile` contra
 * o registro: ou o perfil ENRIQUECIDO (system prompt + toolScope do `.md`), ou um
 * ERRO VISÍVEL (nome desconhecido — GS-MD7). O `tier` resolvido (model→tier) sai
 * separado: o spawner não o consome ainda (é o caller de modelo do filho que o usa);
 * o wiring o aplica ao caller dedicado dos filhos.
 */
export type NamedAgentBinding =
  | {
      readonly ok: true;
      /** O perfil de sub-agente já com persona/toolScope do `.md` aplicados. */
      readonly profile: SubAgentProfile;
      /** O `model` cru do `.md` (a resolução model→tier é do caller/broker). */
      readonly model?: string;
      /** RES-MD-1: nome existe nas DUAS camadas ⇒ confirmar com origem visível. */
      readonly crossLayerConflict: boolean;
      /** A camada de onde o perfil vencedor veio (p/ a confirmação RES-MD-1). */
      readonly origin: AgentProfile['origin'];
    }
  | { readonly ok: false; readonly error: string };

/**
 * EST-0978 · ADR-0061 · GS-MD7 — ENRIQUECE um `SubAgentProfile` resolvendo o seu
 * `agent` (nome) contra o registro: aplica o SYSTEM PROMPT (corpo do `.md`) e o
 * TOOLSCOPE (`tools:` ⊆ pai). Nome DESCONHECIDO ⇒ `{ ok:false, error }` (VISÍVEL —
 * nunca um perfil default elevado). Sem `agent` ⇒ passa o perfil inalterado (sub-
 * agente genérico EST-0969). PURO (delega ao `registry.resolveByName`, que decide a
 * precedência §4 e sinaliza o conflito cross-camada RES-MD-1). O `crossLayerConflict`
 * é PROPAGADO p/ o locus confirmar com a origem visível (anti-spoofing).
 */
export function bindNamedAgent(
  registry: AgentRegistry,
  profile: SubAgentProfile,
): NamedAgentBinding {
  if (profile.agent === undefined || profile.agent.trim() === '') {
    // Sub-agente genérico (sem nome): nada a resolver. Não há conflito de nome.
    return { ok: true, profile, crossLayerConflict: false, origin: 'global' };
  }
  const resolution = registry.resolveByName(profile.agent);
  if (!resolution) {
    return {
      ok: false,
      error:
        `agente "${profile.agent}" desconhecido (nenhum .md em ~/.aluy/agents/ nem ` +
        `.claude/agents/ com esse nome) — delegação RECUSADA (GS-MD7): nome explícito ` +
        `exigido, sem fallback p/ perfil sem restrição.`,
    };
  }
  const named = resolution.profile;
  // GS-MD1: `tools:` do `.md` vira o `toolScope` (⊆ pai). Ausente ⇒ herda o do pai.
  const toolScope = named.tools !== undefined ? new Set(named.tools) : undefined;
  const enriched: SubAgentProfile = {
    ...profile,
    // O rótulo de origem passa a ser o NOME do agente (CLI-SEC-9), salvo se o caller
    // já tiver dado um label específico distinto do nome cru.
    label: profile.label,
    ...(named.systemPrompt !== '' ? { systemPrompt: named.systemPrompt } : {}),
    ...(toolScope !== undefined ? { toolScope } : {}),
    // GS-MD8 (carve-out F49): frontmatter `room: false` ⇒ opt-out de sala.
    ...(named.room === false ? { roomOptOut: true } : {}),
  };
  return {
    ok: true,
    profile: enriched,
    ...(named.model !== undefined ? { model: named.model } : {}),
    crossLayerConflict: resolution.crossLayerConflict,
    origin: named.origin,
  };
}

/** Tokeniza em termos significativos (≥3 chars), minúsculas, dedup. PURO. */
function significantTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3) out.add(raw);
  }
  return out;
}

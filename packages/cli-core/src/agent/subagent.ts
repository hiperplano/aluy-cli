// EST-0969 · ADR-0057 (E-A1/E-A2/E-A3) · CLI-SEC-11 — SUB-AGENTES LOCAIS PARALELOS.
//
// A feature mais complexa e segurança-crítica da Sprint 2. O pai DELEGA subtarefas
// a sub-agentes LOCAIS (mesmo processo), cada um com objetivo + contexto PRÓPRIOS,
// rodando o MESMO `AgentLoop` (reusa o loop) com seu próprio teto. Tiago decidiu
// PARALELO: múltiplos filhos concorrentes (Promise.all).
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ INVARIANTES DE SEGURANÇA (gate FORTE do `seguranca`, CLI-SEC-11) — toda    ║
// ║ tool de efeito de QUALQUER filho passa pela MESMA `decide()` do pai:        ║
// ║                                                                            ║
// ║ • NÃO-BYPASS (CLI-SEC-H1): o filho recebe a MESMA engine de permissão do    ║
// ║   pai (mesmo `SessionMode`: em Plan nega efeito igual; mesmo workspace/path- ║
// ║   deny/egress confinados pelas MESMAS ports). Escopo ⊆ pai — sem escalada.  ║
// ║                                                                            ║
// ║ • E-A1 (profundidade ≤1 = PROPRIEDADE DO TOOLSET + CATRACA): o toolset do   ║
// ║   filho NÃO contém `spawn_agent` (filhos não delegam). E, defesa-em-        ║
// ║   profundidade, a engine do filho é embrulhada por `denySpawnAgentEngine`,  ║
// ║   que NEGA `spawn_agent` na catraca mesmo que um perfil o declare — nenhum   ║
// ║   neto nasce (CA-A1).                                                       ║
// ║                                                                            ║
// ║ • E-A2 (orçamento agregado ATÔMICO): TODOS os filhos + o pai compartilham   ║
// ║   UM `SharedBudget`; a reserva é check-and-decrement ATÔMICO (no loop). A    ║
// ║   soma dos paralelos NUNCA estoura o teto da sessão (CA-A2).                ║
// ║                                                                            ║
// ║ • E-A3 (sem grant compartilhado entre filhos paralelos): cada filho recebe  ║
// ║   um `SessionGrants` PRÓPRIO (não o do pai, não um compartilhado). Aprovar   ║
// ║   um efeito sempre-ask no filho A NÃO destrava o filho B — cada um dispara   ║
// ║   sua própria confirmação, com RÓTULO DE ORIGEM (CLI-SEC-9). O `--unsafe` do ║
// ║   pai herda como MODO (via a engine), mas a engine já não relaxa sempre-ask  ║
// ║   por grant — só o bypass de modo, que é herança de modo, não de grant.     ║
// ║                                                                            ║
// ║ • RESULTADO = DADO_NÃO_CONFIÁVEL (CLI-SEC-4): o que o filho devolve volta ao ║
// ║   pai como OBSERVAÇÃO rotulada por origem — um filho comprometido por        ║
// ║   injeção (leu README malicioso) NÃO vira instrução pro pai; efeito que o    ║
// ║   pai derive disso RE-PASSA a catraca.                                      ║
// ║                                                                            ║
// ║ • ANTI-RUNAWAY: teto de N concorrentes; profundidade ≤1; TIMEOUT DURO por   ║
// ║   filho (anti-deadlock/exaustão de fds/processos). Toda llm_call do filho    ║
// ║   pelo broker (CLI-SEC-7) — herda o MESMO ModelCaller do pai.               ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// PORTÁVEL (ADR-0053 §8): sem Ink, sem I/O de terminal. A mecânica/budget/
// orquestração moram aqui (@hiperplano/aluy-cli-core); a UI (mostrar filhos rodando) é do
// @hiperplano/aluy-cli (observador opcional injetado).

import { AgentLoop, type ModelCaller, type AgentRunResult } from './loop.js';
import { resolveModelTier } from './agent-model-tier.js';
import { SharedBudget } from './shared-budget.js';
import { DEFAULT_LIMITS, type SessionLimits } from './limits.js';
import { ToolRegistry } from './tools/registry.js';
import { SPAWN_AGENT_TOOL_NAME } from './tools/spawn-agent.js';
import { QUESTION_TOOL_NAME } from './tools/question.js';
import type { NativeTool, ToolPorts } from './tools/types.js';
import { resolveChildWorktree, type WorktreeHandle } from './worktree-port.js';
import {
  type PermissionEngine,
  type PermissionVerdict,
  type ToolCall,
} from '../permission/gate.js';
import { PolicyPermissionEngine } from '../permission/engine.js';
import type { AskResolver, AskRequest, AskResolution } from '../permission/ask.js';
import { ROOM_POST_TOOL_NAME, ROOM_READ_TOOL_NAME } from './rooms/room-tools.js';

/** Defaults anti-runaway do fan-out (CLI-SEC-8 / E-A2). */
export const DEFAULT_MAX_CONCURRENCY = 4;
/**
 * EST-0969 (heartbeat) — TIMEOUT DE INATIVIDADE (não de relógio TOTAL). O relógio
 * de um filho ZERA a cada sinal de PROGRESSO (iteração/modelo/tool — ver
 * {@link ProgressSignal}); só dispara (mata o filho — anti-deadlock) se passar
 * ESTE intervalo SEM nenhum progresso (= travado/hung/não-responde). Um filho
 * PRODUTIVO nunca é morto por aqui; o TOTAL é cercado por budget+iterações (E-A2),
 * não por relógio. Configurável por `ALUY_SUBAGENT_IDLE_TIMEOUT` (s ou ms) / opção.
 *
 * Ideia do Tiago: o teto TOTAL punia quem trabalhava (filho produtivo morto aos
 * 2min no meio do trabalho); o heartbeat só mata quem TRAVA.
 */
export const DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS = 120_000;
/**
 * @deprecated EST-0969 — renomeado p/ {@link DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS}. O
 * teto deixou de ser TOTAL (relógio de parede) e virou INATIVIDADE (heartbeat).
 * Mantido como alias p/ não quebrar importadores; aponta p/ o mesmo valor.
 */
export const DEFAULT_SUBAGENT_TIMEOUT_MS = DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS;
/** Var de ambiente que sobrescreve o timeout de inatividade (s ou ms — ver clamp). */
export const SUBAGENT_IDLE_TIMEOUT_ENV = 'ALUY_SUBAGENT_IDLE_TIMEOUT';
/** Teto DURO de filhos por chamada de `spawn_agent` (anti exaustão de recursos). */
export const MAX_SUBAGENTS_PER_CALL = 8;

/**
 * EST-1121 · ADR-0122 §F51 — PADRÕES de articulação de sala declarativos
 * (`broadcast` | `pipeline` | `debate`). Açúcar opcional do `spawn_agent room:`.
 *
 * - `broadcast` — default: cada filho posta, cada filho lê todos (condition: todos
 *   postaram e você leu todos).
 * - `pipeline` — cascata ordenada: cada filho lê SÓ o anterior (índice − 1) por
 *   cursor; condition: o anterior postou.
 * - `debate` — rounds com CAP DURO não-relaxável: até N rodadas de ida-e-volta
 *   entre os filhos. Cap = 3 rounds default, teto absoluto = 5.
 */
export type RoomArtPattern = 'broadcast' | 'pipeline' | 'debate';

/** Default do `pattern` quando `room` é ativo. */
export const ROOM_ART_PATTERN_DEFAULT: RoomArtPattern = 'broadcast';

/** CAP DURO anti-loop-infinito para o padrão `debate` (não relaxável). */
export const DEBATE_ROUND_CAP_ABSOLUTE = 5;

/** Default de rounds para `debate` quando o cap não é informado. */
export const DEBATE_ROUND_CAP_DEFAULT = 3;

/**
 * EST-1121 — formata a system-note de PROCESSO que o CLI injeta no contexto
 * de cada sub-agente quando a articulação de sala está ativa (≥2 agentes).
 *
 * PROCESSO (não INSTRUÇÃO DE CONTEÚDO): a nota diz COMO o filho deve articular —
 * postar, ler por cursor, dar ack, condição de término. O modelo a CONSIDERA
 * como contexto, NUNCA como ordem de obediência cega (AG-0008).
 *
 * @param pattern — padrão de articulação.
 * @param total — número total de sub-agentes no lote.
 * @param label — rótulo DESTE filho.
 * @param code — código da sala compartilhada.
 * @param index — índice DESTE filho no array de perfis (0-based).
 * @param debateRoundCap — rounds máximos p/ `debate` (default 3, cap 5).
 */
export function formatRoomArtSystemNote(
  pattern: RoomArtPattern,
  total: number,
  label: string,
  code: string,
  index: number,
  debateRoundCap: number = DEBATE_ROUND_CAP_DEFAULT,
): string {
  const cap = Math.min(debateRoundCap, DEBATE_ROUND_CAP_ABSOLUTE);

  const lines: string[] = [
    `[SYSTEM-NOTE DE PROCESSO — EST-1121 ROOMS-ARTIC]`,
    ``,
    `Você é parte de um lote de ${total} sub-agentes coordenados por uma SALA de articulação.`,
    `Código da sala: "${code}"`,
    `Seu rótulo: "${label}"`,
    `Seu índice: ${index + 1} de ${total}`,
    `Padrão de articulação: ${pattern}`,
    ``,
    `PROCESSO:`,
    ``,
    `1. Ao terminar seu trabalho, POSTE seu resultado completo na sala com room_post:`,
    `   code: "${code}", kind: "result", to: "todos", body: <seu resultado>`,
    ``,
    `2. LEIA os resultados dos outros sub-agentes com room_read:`,
    `   code: "${code}". Use "since_seq" para leitura incremental (cursor).`,
    `   Considere o que os colegas produziram — você pode ajustar sua conclusão.`,
    ``,
    `3. Dê ACK a cada post lido com room_post:`,
    `   code: "${code}", kind: "ack", to: "<rótulo do autor>".`,
  ];

  // Condição de término por padrão
  if (pattern === 'broadcast') {
    lines.push(
      ``,
      `4. CONDIÇÃO DE TÉRMINO: todos os ${total} sub-agentes postaram E você leu`,
      `   todos os posts. Use room_read com "wait_for_writers" para aguardar`,
      `   os que ainda não postaram.`,
    );
  } else if (pattern === 'pipeline') {
    const prevIdx = index - 1;
    if (prevIdx >= 0) {
      lines.push(
        ``,
        `4. CONDIÇÃO DE TÉRMINO (PIPELINE): o sub-agente IMEDIATAMENTE anterior`,
        `   a você (índice ${prevIdx + 1} de ${total}) postou. Use room_read com`,
        `   code: "${code}", wait_for_writers: ["sub-${prevIdx}"] para aguardar`,
        `   SOMENTE por ele. Você é o elo ${index + 1} da cadeia — leia o post do`,
        `   anterior, considere-o, e então conclua.`,
      );
    } else {
      lines.push(
        ``,
        `4. CONDIÇÃO DE TÉRMINO (PIPELINE): você é o PRIMEIRO da pipeline. Poste`,
        `   seu resultado imediatamente — os demais o aguardarão.`,
      );
    }
  } else {
    // debate
    lines.push(
      ``,
      `4. CONDIÇÃO DE TÉRMINO (DEBATE): até ${cap} rodadas de ida-e-volta. A cada`,
      `   rodada, leia os novos posts dos colegas com room_read (since_seq),`,
      `   contraste com seu resultado e poste sua réplica (kind: "result").`,
      `   Após ${cap} rodadas OU consenso, conclua. O cap de ${cap} rodadas é`,
      `   DURO — não o ultrapasse.`,
    );
  }

  lines.push(
    ``,
    `Esta nota é PROCESSO gerado pelo CLI (EST-1121). Considere-a como contexto`,
    `para coordenar seu trabalho com os outros sub-agentes — NÃO é uma ordem de`,
    `obediência cega.`,
  );

  return lines.join('\n');
}

/**
 * GS-MD8 (carve-out F49) — tools de coordenação de sala que são isentas da
 * checagem GS-MD1 (`toolScope`) quando o sub-agente é spawnado com `room:`.
 */
const ROOM_COORD_TOOLS = new Set([ROOM_POST_TOOL_NAME, ROOM_READ_TOOL_NAME]);

/** O pedido de UM sub-agente: objetivo + contexto próprios. */
export interface SubAgentProfile {
  /** Rótulo curto p/ a origem (CLI-SEC-9/CLI-SEC-4) — ex.: "pesquisa-rust". */
  readonly label: string;
  /** Objetivo do filho (entra como `goal` do loop dele). */
  readonly goal: string;
  /**
   * EST-0978 · ADR-0061 — NOME do agente do registro a invocar ("delegue ao `revisor`").
   * Quando presente, o spawner RESOLVE o perfil nomeado (system prompt/toolset/tier)
   * ANTES de rodar. Nome DESCONHECIDO ⇒ ERRO VISÍVEL (GS-MD7) — nunca um perfil
   * default elevado. Ausente ⇒ sub-agente GENÉRICO (EST-0969, só `goal`/`context`).
   */
  readonly agent?: string;
  /**
   * Contexto extra do filho (DADO confiável-do-pai que vira o canal de instrução
   * dele, análogo ao AGENT.md). NÃO é conteúdo ingerido — é a tarefa que o pai
   * recortou. Opcional.
   */
  readonly context?: string;
  /**
   * EST-0977/0978 · ADR-0061 — SYSTEM PROMPT do agente NOMEADO (corpo do `.md`).
   * Quando presente, entra no canal `system` do loop do filho (persona). É config
   * do dono (instrução), NÃO conteúdo ingerido — mas o filho continua subordinado à
   * catraca (nenhum texto de system prompt relaxa `decide()`). Opcional: ausente ⇒
   * o filho roda só com o `context` recortado pelo pai (perfil genérico, EST-0969).
   */
  readonly systemPrompt?: string;
  /**
   * EST-0977 · ADR-0061 (GS-MD1) — TOOLSET RESTRITO do agente nomeado (`tools:` do
   * `.md`). Quando presente, a engine do filho NEGA na catraca qualquer tool fora
   * deste conjunto (⊆ pai — RESTRINGE, nunca amplia). Ausente ⇒ o filho herda o
   * toolset do pai inteiro. `spawn_agent`/`task` aqui é NEGADO de qualquer forma
   * (E-A1/GS-MD2): o filho nunca recebe `spawn_agent` no registro E a engine o nega.
   */
  readonly toolScope?: ReadonlySet<string>;
  /**
   * EST-SUBAGENT-MODEL · ADR-0061 §3 · CLI-SEC-7 — preferência de MODELO/TIER do
   * agente nomeado (`model:` do frontmatter `.md`), CRUA (nome amigável `opus`/
   * `sonnet`/… ou chave `aluy-*`). O spawner a traduz por `resolveModelTier` numa
   * CHAVE DE TIER e, se houver a fábrica `callerForTier`, ROTEIA ESTE filho ao caller
   * daquele tier (o broker resolve provider/credencial/quota — fonte da verdade). O
   * tier vem do PERFIL EM DISCO (capacidade declarada, HG-2), nunca de string que o
   * modelo-pai invente. Ausente OU sem cara de tier (provider cru) ⇒ o filho cai no
   * caller do PAI (back-compat — comportamento de hoje). NÃO é credencial (CLI-SEC-7).
   */
  readonly model?: string;
  /**
   * EST-1098 · ADR-0109 (WT-1) — ISOLAMENTO deste filho. `'worktree'` ⇒ o filho roda
   * num `git worktree` PRÓPRIO (dir/ramo separados, mesmo repo) para não atropelar o
   * checkout do pai nem dos irmãos (cura dos "resets concorrentes"). OPT-IN e INERTE
   * sem `WorktreePort` injetado no spawner (ausente ⇒ filho usa as ports do pai, como
   * hoje — não-regressão). NÃO amplia capacidade (política segue ⊆ pai; só troca a
   * RAIZ de I/O p/ o worktree). O merge-de-volta é decisão humana, FORA do seam.
   */
  readonly isolation?: import('./worktree-port.js').ChildIsolation;
  /**
   * GS-MD8 (carve-out F49) — opt-out de sala. Quando `true`, este sub-agente
   * NÃO recebe `room_post`/`room_read` mesmo se o spawn foi com `room:`.
   * Propagado do `AgentProfile.room` (frontmatter `room: false`). Default
   * `undefined`/`false` ⇒ participa da sala normalmente.
   */
  readonly roomOptOut?: boolean;
}

/** Desfecho de UM sub-agente (devolvido ao pai como dado rotulado). */
export interface SubAgentOutcome {
  readonly label: string;
  /** `ok=false` quando estourou teto/timeout/erro — ainda assim é DADO. */
  readonly ok: boolean;
  /** O texto que o filho produziu (resposta final OU motivo da parada). */
  readonly result: string;
  /** Como o filho terminou (p/ auditoria/UX). */
  readonly stop: 'final' | 'limit' | 'timeout' | 'error';
  readonly usage: { iterations: number; toolCalls: number; tokens: number };
}

/** Observador OPCIONAL do ciclo de vida dos filhos (a UI do @hiperplano/aluy-cli pluga). */
export interface SubAgentObserver {
  onChildStart?(label: string): void;
  onChildEnd?(label: string, outcome: SubAgentOutcome): void;
}

/**
 * EST-F158 — PORTA DE COMPLETION de sub-agentes: o `SubAgentSpawner` a chama
 * IMEDIATAMENTE após TODOS os filhos de um lote terminarem (fan-out completo),
 * com os desfechos prontos. O locus concreto (@hiperplano/aluy-cli) usa isto
 * para ACORDAR o turn-loop do Maestro e processar os resultados na hora
 * (orientado a evento), sem polling nem esperar o próximo submit do usuário.
 */
export interface SubAgentCompletionPort {
  wake(outcomes: readonly SubAgentOutcome[]): void;
}

export interface SubAgentSpawnerOptions {
  /** O MESMO ModelCaller do pai (toda llm_call pelo broker — CLI-SEC-7). */
  readonly model: ModelCaller;
  /**
   * EST-0969 (display) — ModelCaller DEDICADO dos FILHOS. MESMO broker/credencial
   * do pai (CLI-SEC-7 intocado), mas SEM o sink de stream ao vivo da TUI: o caller
   * do pai (`model`) emite tokens token-a-token na região VIVA do pai; se os N
   * filhos paralelos usassem ESSE mesmo caller, seus streams INTERLEAVARIAM no mesmo
   * stdout/TUI (lixo ilegível). Os filhos usam um caller que AGREGA a resposta (não
   * a despeja na região viva) — a saída de cada filho é coletada internamente e o
   * pai só vê o RESULTADO consolidado (legível). Ausente ⇒ cai no `model` (back-compat
   * dos testes/loci que não distinguem; a SEGURANÇA é idêntica — mesma rota de broker).
   */
  readonly childModel?: ModelCaller;
  /**
   * EST-SUBAGENT-MODEL · ADR-0073 (tier por-request) · CLI-SEC-7 — FÁBRICA de caller
   * POR TIER. Dado uma CHAVE DE TIER (ex.: `aluy-deep`), devolve um `ModelCaller` que
   * manda AQUELE tier no request ao broker (MESMO broker/credencial do pai — só varia
   * a pista de tier, HG-2). É uma PORTA injetada pelo @hiperplano/aluy-cli (o cli-core não conhece
   * o broker concreto): o locus a constrói reusando o BrokerModelCaller dos filhos,
   * parametrizado por tier. Quando um filho declara `model:` no `.md` que resolve num
   * tier, o spawner usa `callerForTier(tier)` PRA AQUELE FILHO; sem `.md` model (ou sem
   * esta fábrica) ⇒ o filho cai no `childModel`/`model` do PAI (back-compat). O tier é
   * DADO de catálogo (o broker valida — 422 se inservível); NUNCA credencial.
   */
  readonly callerForTier?: (tier: string) => ModelCaller;
  /** A MESMA engine de permissão do pai (mesmo SessionMode, sempre-ask, hooks). */
  readonly permission: PermissionEngine;
  /** As MESMAS ports confinadas do pai (workspace/path-deny/egress). Escopo ⊆ pai. */
  readonly ports: ToolPorts;
  /** O toolset BASE (do pai). O spawner REMOVE `spawn_agent` p/ os filhos (E-A1). */
  readonly baseTools: readonly NativeTool<ToolPorts>[];
  /**
   * Resolver de `ask` (CLI-SEC-9). Cada filho recebe um WRAPPER que injeta o
   * RÓTULO DE ORIGEM (E-A3): o usuário vê QUAL filho pede a confirmação. Sem
   * resolver ⇒ os filhos tratam `ask` como bloqueio (fail-safe).
   */
  readonly askResolver?: AskResolver;
  /** Budget COMPARTILHADO (E-A2). Default: um novo `SharedBudget` com os limits. */
  readonly sharedBudget?: SharedBudget;
  /** Tetos da sessão (p/ construir o SharedBudget default). */
  readonly limits?: SessionLimits;
  /** Máximo de filhos rodando ao MESMO tempo. Default `DEFAULT_MAX_CONCURRENCY`. */
  readonly maxConcurrency?: number;
  /**
   * EST-0969 — TIMEOUT DE INATIVIDADE por filho (ms): mata o filho só após este
   * intervalo SEM nenhum sinal de progresso (= travado). Default vem da env
   * `ALUY_SUBAGENT_IDLE_TIMEOUT` (s/ms) ou {@link DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS}.
   * Precedência: esta opção (flag) > env > default. NÃO é teto de relógio TOTAL.
   */
  readonly idleTimeoutMs?: number;
  /**
   * @deprecated EST-0969 — alias de compatibilidade de `idleTimeoutMs`. ANTES era
   * um teto de relógio TOTAL; AGORA, se passado, é interpretado como o timeout de
   * INATIVIDADE (heartbeat). `idleTimeoutMs` tem precedência se ambos vierem.
   */
  readonly timeoutMs?: number;
  /** Observador da UI (opcional). */
  readonly observer?: SubAgentObserver;
  /**
   * EST-0982 (semântica do esc) — sinal de PARADA POR FILHO, resolvido pelo RÓTULO.
   * O locus concreto (@hiperplano/aluy-cli) liga aqui o `signal` do nó do filho na FlowTree:
   * `p` (parar ESTE) aborta SÓ aquele filho; F8/painel (PARAR-TUDO) aborta todos via
   * a cascata da raiz. O esc (interrupt do pai) NÃO dispara estes sinais — os filhos
   * SEGUEM trabalhando (decisão de produto EST-0982). Ausente ⇒ só `parentSignal`/
   * heartbeat/budget cercam o filho (comportamento anterior).
   */
  readonly childSignalOf?: (label: string) => AbortSignal | undefined;
  /**
   * Relógio injetável (teste determinístico do heartbeat). `sleep(ms, signal)`
   * RESOLVE no abort (não rejeita): o IdleTimer cancela o sleep corrente a cada
   * bump (re-arma) e ao encerrar. Default: Promise + setTimeout.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * EST-ROOMS-4 · ADR-0081 §6 — fábrica dos tools de SALA POR FILHO. Quando o
   * `spawn` é pedido com `room`, cada filho recebe `roomToolsFor(profile.label)`
   * ADICIONADO ao seu toolset — postando como SI MESMO (writerId = label do filho,
   * NUNCA um id global). O locus concreto (@hiperplano/aluy-cli) liga isto ao `buildRoomTools`
   * com o RoomStore + as policies da sessão. Ausente ⇒ `room` é no-op (fail-safe:
   * sem sala, sem conversa — o fan-out roda normal).
   */
  readonly roomToolsFor?: (writerId: string) => readonly NativeTool<ToolPorts>[];
  /**
   * EST-1121 · ADR-0122 §F51 — PADRÃO declarativo de articulação de sala
   * (`broadcast` | `pipeline` | `debate`). Açúcar opcional do `spawn_agent room:`.
   * Inerte quando `roomToolsFor` está ausente (no-op). Default: `'broadcast'`.
   */
  readonly roomArtPattern?: RoomArtPattern;
  /**
   * EST-1121 — CÓDIGO da sala compartilhada. O locus concreto (@hiperplano/aluy-cli) injeta
   * o código gerado por `createRoom()` para que a system-note de processo possa
   * referenciá-lo. Ausente ⇒ a system-note omite o código e referencia apenas as
   * tools de sala (o modelo o descobre das descrições das tools).
   */
  readonly roomCode?: string;
  /**
   * EST-1098 · ADR-0109 (WT-1) — porta de ISOLAMENTO por worktree (OPCIONAL). Quando
   * injetada, um filho com `isolation: 'worktree'` roda num `git worktree` próprio
   * (ports enraizadas nele); ao fim, o spawner faz `dispose()` em TODO caminho de
   * saída. Ausente ⇒ `isolation` é no-op (filho usa as ports do pai — não-regressão).
   * O locus concreto (@hiperplano/aluy-cli) liga isto ao `NodeWorktreePort`.
   */
  readonly worktree?: import('./worktree-port.js').WorktreePort;
  /**
   * EST-F158 — PORTA de completion: chamada pelo spawner IMEDIATAMENTE após
   * TODOS os filhos de um lote terminarem. O locus concreto usa isto para ACORDAR
   * o turn-loop do Maestro (orientado a evento). Ausente ⇒ no-op (back-compat).
   */
  readonly completionPort?: SubAgentCompletionPort;
}

/**
 * EST-0969 (E-A1/E-A3) — deriva a engine de um FILHO a partir da engine do pai.
 *
 *  - Se o pai é `PolicyPermissionEngine` (produção): usa `forSubAgent()`, que
 *    HERDA o modo (Plan/normal/`--unsafe`) e a política/hooks (escopo ⊆ pai), dá
 *    GRANTS PRÓPRIOS ao filho (E-A3: sem grant compartilhado entre filhos) e NEGA
 *    `spawn_agent` na catraca (E-A1: teto de profundidade ≤1). É um
 *    `PolicyPermissionEngine` real ⇒ o `grantSession` do loop (approve-session)
 *    funciona ISOLADO por filho.
 *
 *  - Se o pai é uma engine ARBITRÁRIA (testes/loci alternativos): embrulha num
 *    decorador que delega tudo, EXCETO `spawn_agent`, que é NEGADO. Mantém o teto
 *    de profundidade (E-A1) mesmo sem a engine concreta. (Aqui não há grant de
 *    sessão a isolar — engines triviais não gravam grants.)
 */
export function childEngineOf(
  parent: PermissionEngine,
  toolScope?: ReadonlySet<string>,
  roomExemptTools?: ReadonlySet<string>,
): PermissionEngine {
  if (parent instanceof PolicyPermissionEngine) {
    return parent.forSubAgent(toolScope, roomExemptTools);
  }
  return {
    decide(call: ToolCall): PermissionVerdict {
      // E-A1/GS-MD2: `spawn_agent` SEMPRE negado no filho (acima do toolScope).
      if (call.name === SPAWN_AGENT_TOOL_NAME) {
        return {
          decision: 'deny',
          reason:
            'profundidade de sub-agente ≤1 (E-A1): um sub-agente NÃO pode criar netos — spawn_agent NEGADO na catraca',
          category: 'policy:deny',
        };
      }
      // EST-0977/GS-MD1: tools ⊆ pai — fora do `toolScope` declarado ⇒ DENY na catraca
      // (não "concedida pelo arquivo"). Mantém o teto mesmo numa engine arbitrária.
      // GS-MD8 (carve-out F49): roomExemptTools PULAM esta checagem (tools de sala).
      if (
        toolScope !== undefined &&
        !(roomExemptTools?.has(call.name) ?? false) &&
        !toolScope.has(call.name)
      ) {
        return {
          decision: 'deny',
          reason: `tool "${call.name}" fora do toolset declarado do agente (tools ⊆ pai, GS-MD1) — negada na catraca`,
          category: 'policy:deny',
        };
      }
      return parent.decide(call);
    },
  };
}

/**
 * EST-0969 (E-A3) — embrulha o `AskResolver` p/ carimbar a ORIGEM (o rótulo do
 * filho) no `reason` da confirmação. Cada filho tem o SEU wrapper ⇒ duas
 * confirmações de filhos paralelos chegam DISTINTAS (rótulo diferente). NÃO
 * compartilha estado entre wrappers — o que destrava o grant é o `SessionGrants`
 * por-filho (abaixo), não este wrapper. Puro repasse + prefixo de origem.
 */
function originAskResolver(inner: AskResolver, label: string): AskResolver {
  return {
    resolve(request: AskRequest, signal?: AbortSignal): Promise<AskResolution> {
      const labeled: AskRequest = {
        ...request,
        reason: `[sub-agente: ${label}] ${request.reason}`,
      };
      return inner.resolve(labeled, signal);
    },
  };
}

/**
 * sleep cancelável default (real). RESOLVE (não rejeita) no abort: o IdleTimer
 * cancela o sleep corrente a cada `bump()` (re-arma) e ao encerrar — nesses casos
 * queremos só PARAR o timer, sem lançar (uma rejeição viraria unhandled). O
 * disparo do heartbeat vem do IdleTimer (o sleep terminou SEM ter sido cancelado
 * por um bump) — exatamente o que sinaliza a INATIVIDADE (o filho travou).
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * EST-0969 — RELÓGIO DE INATIVIDADE (heartbeat). Arma um `sleep(idleMs)`; cada
 * `bump()` (= sinal de progresso do filho) CANCELA o sleep corrente e RE-ARMA um
 * novo — zerando a contagem. Só quando `idleMs` passa SEM nenhum bump o sleep
 * termina naturalmente e a promise `fired` RESOLVE `true` (= o filho TRAVOU). O
 * `stop()` encerra o timer sem disparar (`fired` resolve `false`).
 *
 * Implementação sobre o `sleep(ms, signal)` INJETÁVEL (mesmo contrato do baseline:
 * resolve no abort) ⇒ testes determinísticos: um `sleep` controlado decide quando
 * o intervalo "passou". Anti-deadlock DURO: o disparo aciona o kill (childAbort)
 * exatamente como o teto anterior — só não mata mais quem progride.
 */
class IdleTimer {
  private readonly fired: Promise<boolean>;
  private resolveFired!: (timedOut: boolean) => void;
  /** Controla o sleep CORRENTE; um bump aborta este e cria o próximo. */
  private armSignal = new AbortController();
  private stopped = false;
  /** Generation: descarta o `.then` de um sleep já re-armado (corrida do bump). */
  private generation = 0;

  constructor(
    private readonly idleMs: number,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  ) {
    this.fired = new Promise<boolean>((resolve) => {
      this.resolveFired = resolve;
    });
    this.arm();
  }

  /** Resolve `true` se o filho ficou ocioso por `idleMs`; `false` se `stop()`. */
  get done(): Promise<boolean> {
    return this.fired;
  }

  /** Sinal de PROGRESSO: re-arma o relógio (zera a inatividade). No-op após stop. */
  bump(): void {
    if (this.stopped) return;
    // Aborta o sleep corrente (resolve sem disparar — sua geração já não confere) e
    // arma um novo. Síncrono: sem await entre abortar e re-armar.
    this.armSignal.abort();
    this.arm();
  }

  /** Encerra o timer sem disparar (loop venceu/erro/cancelamento do pai). */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.armSignal.abort();
    this.resolveFired(false);
  }

  private arm(): void {
    if (this.stopped) return;
    this.armSignal = new AbortController();
    const gen = ++this.generation;
    const signal = this.armSignal.signal;
    void this.sleep(this.idleMs, signal).then(() => {
      // Re-armado por um bump (gen mudou) OU já encerrado OU abortado ⇒ no-op.
      if (this.stopped || gen !== this.generation || signal.aborted) return;
      // O intervalo passou SEM bump nem stop: o filho TRAVOU.
      this.stopped = true;
      this.resolveFired(true);
    });
  }
}

/**
 * EST-0969 — resolve o timeout de INATIVIDADE com precedência flag > env > default
 * e CLAMP (positivo, finito, inteiro). A env `ALUY_SUBAGENT_IDLE_TIMEOUT` aceita
 * `"500ms"`/`"90s"`/número puro (interpretado como ms); valor inválido/≤0 ⇒ cai no
 * próximo da cadeia (nunca desarma o anti-deadlock). `env` injetável p/ teste.
 */
export function resolveIdleTimeoutMs(
  flagMs: number | undefined,
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
): number {
  // 1) flag (opção do spawner) — só se for um positivo finito.
  if (flagMs !== undefined && Number.isFinite(flagMs) && flagMs > 0) {
    return Math.floor(flagMs);
  }
  // 2) env (s/ms) — parse tolerante.
  const fromEnv = parseDurationMs(env[SUBAGENT_IDLE_TIMEOUT_ENV]);
  if (fromEnv !== undefined) return fromEnv;
  // 3) default.
  return DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS;
}

/** Parse de `"90s"`/`"500ms"`/`"120000"` (ms) ⇒ ms inteiro positivo, ou undefined. */
function parseDurationMs(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim().toLowerCase();
  if (s === '') return undefined;
  let ms: number;
  if (s.endsWith('ms')) {
    ms = Number(s.slice(0, -2));
  } else if (s.endsWith('s')) {
    ms = Number(s.slice(0, -1)) * 1000;
  } else {
    ms = Number(s); // número puro ⇒ ms
  }
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.floor(ms);
}

/**
 * Orquestra o fan-out PARALELO de sub-agentes. Cada filho:
 *  - roda um `AgentLoop` NOVO com o MESMO model/ports do pai;
 *  - usa a engine do pai EMBRULHADA por `denySpawnAgentEngine` (E-A1) — mesmo modo;
 *  - tem um toolset SEM `spawn_agent` (E-A1);
 *  - compartilha o `SharedBudget` (E-A2) — a reserva atômica é no loop;
 *  - tem um `SessionGrants` PRÓPRIO (E-A3) — sem grant cruzado;
 *  - tem um `askResolver` com RÓTULO DE ORIGEM (E-A3/CLI-SEC-9);
 *  - corre sob TIMEOUT DURO (anti-runaway).
 *
 * Concorrência: no máximo `maxConcurrency` filhos rodam juntos (pool). O fan-out
 * é determinístico na ORDEM dos resultados (casa com a ordem dos perfis).
 */
export class SubAgentSpawner {
  /** O caller que os FILHOS usam (childModel quando dado; senão o do pai). É o
   * FALLBACK por-filho: quando o `.md` do filho NÃO declara um `model` que resolva
   * num tier (ou sem a fábrica `callerForTier`), o filho usa ESTE caller (back-compat). */
  private readonly model: ModelCaller;
  /** EST-SUBAGENT-MODEL — fábrica de caller POR TIER (porta injetada do @hiperplano/aluy-cli).
   * Quando o `.md` do filho declara `model:` que resolve num tier, o spawner usa
   * `callerForTier(tier)` PRA AQUELE FILHO; ausente ⇒ todos os filhos usam o do pai. */
  private readonly callerForTier?: (tier: string) => ModelCaller;
  private readonly permission: PermissionEngine;
  private readonly ports: ToolPorts;
  private readonly childTools: readonly NativeTool<ToolPorts>[];
  private readonly askResolver?: AskResolver;
  private readonly budget: SharedBudget;
  private readonly maxConcurrency: number;
  /** EST-0969 — timeout de INATIVIDADE por filho (não de relógio total). */
  private readonly idleTimeoutMs: number;
  private readonly observer?: SubAgentObserver;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** EST-0982 — sinal de parada POR FILHO (nó da FlowTree), resolvido pelo rótulo. */
  private readonly childSignalOf?: (label: string) => AbortSignal | undefined;
  /** EST-ROOMS-4 — fábrica dos tools de SALA por filho (writerId = label do filho). */
  private readonly roomToolsFor?: (writerId: string) => readonly NativeTool<ToolPorts>[];
  /** EST-1121 — padrão de articulação de sala (broadcast|pipeline|debate). */
  private readonly roomArtPattern: RoomArtPattern;
  /** EST-1121 — código da sala compartilhada (p/ a system-note de processo). */
  private readonly roomCode?: string;
  /** EST-1098 (WT-1) — porta de isolamento por worktree (ausente ⇒ isolation no-op). */
  private readonly worktree?: import('./worktree-port.js').WorktreePort;
  /** EST-F158 — porta de completion: acordar o Maestro quando o fan-out termina. */
  private readonly completionPort?: SubAgentCompletionPort;

  constructor(opts: SubAgentSpawnerOptions) {
    // display: os filhos usam o caller DEDICADO (sem o sink ao vivo do pai) — se
    // injetado; senão, o caller do pai (back-compat). A mecânica/segurança não muda
    // (mesma rota de broker, CLI-SEC-7); só evita o interleave dos streams na TUI.
    this.model = opts.childModel ?? opts.model;
    // EST-SUBAGENT-MODEL — fábrica POR TIER (porta). Ausente ⇒ todos os filhos usam o
    // caller do pai (`this.model`) — comportamento de hoje (back-compat).
    if (opts.callerForTier) this.callerForTier = opts.callerForTier;
    this.permission = opts.permission;
    this.ports = opts.ports;
    // E-A1: o toolset do FILHO é o do pai SEM `spawn_agent` (filhos não delegam) e
    // SEM `perguntar` (EST-1110 · ressalva seguranca AG-0008): filhos NÃO perguntam
    // ao usuário — devolvem a dúvida ao pai como DADO; o pai pergunta. Evita o
    // resolver de-uma-pergunta-por-vez ser embaralhado por N filhos em fan-out.
    this.childTools = opts.baseTools.filter(
      (t) => t.name !== SPAWN_AGENT_TOOL_NAME && t.name !== QUESTION_TOOL_NAME,
    );
    if (opts.askResolver) this.askResolver = opts.askResolver;
    this.budget = opts.sharedBudget ?? new SharedBudget(opts.limits ?? DEFAULT_LIMITS);
    this.maxConcurrency = clampPositive(opts.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
    // EST-0969 — precedência flag > env > default. `idleTimeoutMs` tem precedência
    // sobre o alias deprecado `timeoutMs` (ambos AGORA são INATIVIDADE, não total).
    this.idleTimeoutMs = resolveIdleTimeoutMs(opts.idleTimeoutMs ?? opts.timeoutMs);
    if (opts.observer) this.observer = opts.observer;
    this.sleep = opts.sleep ?? defaultSleep;
    if (opts.childSignalOf) this.childSignalOf = opts.childSignalOf;
    if (opts.roomToolsFor) this.roomToolsFor = opts.roomToolsFor;
    this.roomArtPattern = opts.roomArtPattern ?? ROOM_ART_PATTERN_DEFAULT;
    if (opts.roomCode) this.roomCode = opts.roomCode;
    if (opts.worktree) this.worktree = opts.worktree;
    if (opts.completionPort) this.completionPort = opts.completionPort;
  }

  /** O budget compartilhado (p/ o pai contabilizar/auditar — E-A2). */
  get sharedBudget(): SharedBudget {
    return this.budget;
  }

  /**
   * Dispara os sub-agentes em PARALELO (respeitando o teto de concorrência) e
   * devolve os desfechos na ORDEM dos perfis. `signal` propaga o cancelamento do
   * pai (Ctrl-C) a todos os filhos. Filhos > `MAX_SUBAGENTS_PER_CALL` são
   * recusados (anti-runaway) ANTES de qualquer execução.
   */
  async spawn(
    profiles: readonly SubAgentProfile[],
    signal?: AbortSignal,
    opts?: { room?: boolean; pattern?: string },
  ): Promise<readonly SubAgentOutcome[]> {
    if (profiles.length === 0) return [];
    if (profiles.length > MAX_SUBAGENTS_PER_CALL) {
      throw new Error(
        `spawn_agent: ${profiles.length} sub-agentes excede o teto de ${MAX_SUBAGENTS_PER_CALL} por chamada (anti-runaway)`,
      );
    }

    // EST-ROOMS-4 — a SALA do lote só vale se o locus injetou a fábrica de tools
    // (`roomToolsFor`); sem ela, `room` é no-op (fail-safe: o fan-out roda normal).
    const roomActive = opts?.room === true && this.roomToolsFor !== undefined;

    // EST-1121 — articulação dinâmica de sala: ativa quando há ≥2 agentes COM sala
    // (gatilho do "objetivo coletivo"). Com 1 agente só, não há articulação.
    const articulationActive = roomActive && profiles.length >= 2;
    // Padrão: o que veio da tool (não-confiável, validado) OU o default do spawner.
    const artPattern: RoomArtPattern =
      opts?.pattern === 'pipeline' || opts?.pattern === 'debate'
        ? opts.pattern
        : this.roomArtPattern;

    // Código da sala — injetado pelo locus concreto (ausente ⇒ a system-note
    // omite o código e o modelo o descobre das tool descriptions; ok).
    const roomCode = this.roomCode ?? '';

    const outcomes: SubAgentOutcome[] = new Array(profiles.length);
    let next = 0;

    // Pool de workers: cada worker pega o próximo perfil livre e o roda até
    // esgotar a fila. No máximo `maxConcurrency` workers ⇒ no máximo
    // `maxConcurrency` filhos VIVOS ao mesmo tempo (anti-runaway de fds/processos).
    const workerCount = Math.min(this.maxConcurrency, profiles.length);
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= profiles.length) return;
        const profile = profiles[i]!;
        this.observer?.onChildStart?.(profile.label);
        const outcome = await this.runChild(
          profile,
          signal,
          roomActive,
          articulationActive,
          artPattern,
          profiles.length,
          i,
          roomCode,
        );
        outcomes[i] = outcome;
        this.observer?.onChildEnd?.(profile.label, outcome);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    // EST-F158 — acorda o Maestro IMEDIATAMENTE quando o fan-out termina. O locus
    // concreto (controller) enfileira os resultados no canal mid-turn e dispara o
    // wake do turn-loop — o pai processa na hora, sem esperar o próximo submit.
    this.completionPort?.wake(outcomes);
    return outcomes;
  }

  /** Roda UM filho sob heartbeat (inatividade) + budget compartilhado + grants próprios. */
  private async runChild(
    profile: SubAgentProfile,
    parentSignal?: AbortSignal,
    roomActive = false,
    articulationActive = false,
    artPattern: RoomArtPattern = ROOM_ART_PATTERN_DEFAULT,
    total = 0,
    index = 0,
    roomCode = '',
  ): Promise<SubAgentOutcome> {
    // E-A1 + E-A3 + não-bypass: a engine do filho é DERIVADA da do pai —
    // `forSubAgent()` herda o modo (Plan/normal/`--unsafe`) e a política (escopo
    // ⊆ pai), dá GRANTS PRÓPRIOS ao filho (sem grant cruzado) e NEGA `spawn_agent`
    // na catraca (teto de profundidade ≤1). Cada filho tem a SUA — isolada.
    // EST-0977/GS-MD1: quando o perfil declara `toolScope` (`tools:` do `.md`), a
    // engine do filho ADICIONALMENTE nega qualquer tool fora dele (⊆ pai). Sem
    // `toolScope` ⇒ herda o toolset do pai inteiro.
    // GS-MD8 (carve-out F49): roomActive só é efetivo se o agente não fez opt-out.
    // Se `roomOptOut` é `true`, o agente NÃO recebe tools de sala nem isenção GS-MD1.
    const effectiveRoomActive = roomActive && !profile.roomOptOut;
    const childEngine = childEngineOf(
      this.permission,
      profile.toolScope,
      effectiveRoomActive ? ROOM_COORD_TOOLS : undefined,
    );

    // EST-SUBAGENT-MODEL — qual CALLER este filho usa: se o `.md` dele declara `model:`
    // que resolve num TIER e a fábrica `callerForTier` está injetada, ESTE filho fala
    // pelo caller daquele tier (o broker resolve provider/credencial/quota — fonte da
    // verdade, ADR-0073). Sem model-no-`.md` (ou sem fábrica/sem cara de tier) ⇒ o filho
    // usa o caller do PAI (`this.model`) — back-compat. A SEGURANÇA não muda: mesma
    // rota de broker (CLI-SEC-7), só varia a pista de tier (HG-2).
    const childCaller = childCallerFor(profile, this.model, this.callerForTier);

    // E-A3/CLI-SEC-9: o ask do filho carimba a ORIGEM. Filhos paralelos ⇒ rótulos
    // distintos ⇒ confirmações distintas.
    const childAsk = this.askResolver
      ? originAskResolver(this.askResolver, profile.label)
      : undefined;

    // E-A1: toolset SEM `spawn_agent`. Registro NOVO por filho (isolado).
    // EST-ROOMS-4 · ADR-0081 §6 — quando o lote pediu SALA, este filho ganha os
    // tools `room_post`/`room_read` postando como SI MESMO (writerId = label dele,
    // via a fábrica). Os tools de sala somam-se ao childTools (que já não tem
    // spawn_agent — E-A1); a AUTHZ real é a policy.writers da sala (mesh) + o código
    // como capability, não esta inclusão — um filho fora dos writers é recusado pelo
    // `postMessage`. Cada filho posta como SI ⇒ origem não-spoofável na sala.
    const roomExtra =
      effectiveRoomActive && this.roomToolsFor ? this.roomToolsFor(profile.label) : [];
    const tools = new ToolRegistry<ToolPorts>(
      roomExtra.length > 0 ? [...this.childTools, ...roomExtra] : this.childTools,
    );

    // EST-0969 (heartbeat) — armado ANTES do loop p/ o `onProgress` poder pingá-lo.
    // O timer só passa a "contar" quando o loop começa (o 1º sinal de progresso é a
    // 1ª iteração); até lá, o intervalo de inatividade já corre — um filho que nasce
    // e NUNCA progride (modelo trava no 1º call) é morto após `idleMs`, como esperado.
    const idle = new IdleTimer(this.idleTimeoutMs, this.sleep);

    // EST-0982 — ÚLTIMO snapshot do uso PRÓPRIO deste filho. O loop o atualiza a cada
    // débito (via `onUsage`). Quando o filho TERMINA normalmente, o `usage` vem do
    // `AgentRunResult` (próprio). Mas quando é MORTO por timeout/cancelamento (o loop
    // é abortado e NUNCA retorna), reportamos ESTE snapshot — o que ELE consumiu até
    // ser morto — em vez do `budget.usage` AGREGADO (contaminado pelos filhos
    // concorrentes). Cada filho tem o SEU `ownUsage` (fechado neste runChild).
    let ownUsage = { iterations: 0, toolCalls: 0, tokens: 0 };

    // EST-1098 · ADR-0109 (WT-1) — se ESTE filho pediu `isolation: 'worktree'` E há
    // `WorktreePort` injetado, aloca um worktree próprio AGORA; o loop do filho passa
    // a usar as ports ENRAIZADAS nele. Falha de alocação (ex.: cwd não é repo git) vira
    // desfecho de ERRO deste filho — NÃO derruba os irmãos (cada runChild é isolado).
    // Sem isolamento ⇒ `worktreeHandle` fica undefined e o filho usa `this.ports`
    // (não-regressão total). O `dispose` é feito no `finally` (todo caminho de saída).
    let worktreeHandle: WorktreeHandle | undefined;
    try {
      worktreeHandle = await resolveChildWorktree(profile, this.worktree);
    } catch (err) {
      return {
        label: profile.label,
        ok: false,
        result: `sub-agente "${profile.label}" não pôde isolar em worktree: ${
          err instanceof Error ? err.message : String(err)
        }`,
        stop: 'error',
        usage: ownUsage,
      };
    }

    // EST-1121 — se a articulação de sala está ativa, prefixa a system-note de
    // PROCESSO ao `projectInstructions` do filho. A nota é PROCESSO gerado pelo CLI
    // (não INSTRUÇÃO de conteúdo), envelopada como DADO para o modelo considerar.
    const baseInstructions = personaAndContext(profile);
    const articulationNote =
      articulationActive && roomCode !== undefined
        ? formatRoomArtSystemNote(artPattern, total, profile.label, roomCode, index)
        : undefined;
    const projectInstructions =
      articulationNote !== undefined && baseInstructions !== undefined
        ? `${articulationNote}\n\n${baseInstructions}`
        : articulationNote !== undefined
          ? articulationNote
          : baseInstructions;

    const loop = new AgentLoop({
      // EST-SUBAGENT-MODEL — o caller POR FILHO (tier do `.md` dele, ou o do pai como
      // fallback). Era `this.model` (UM caller p/ TODOS); agora cada filho roteia ao
      // tier do PRÓPRIO perfil.
      model: childCaller,
      permission: childEngine,
      tools,
      // EST-1098 (WT-1) — ports ENRAIZADAS no worktree do filho quando isolado; senão
      // as do pai (back-compat). É a ÚNICA troca que o isolamento faz no loop do filho.
      ports: worktreeHandle?.ports ?? this.ports,
      // E-A2: o MESMO SharedBudget — a reserva atômica no loop garante a soma ≤ teto.
      budget: this.budget,
      // EST-0969 (heartbeat) — CADA sinal de progresso do filho ZERA o relógio de
      // inatividade. Reusa os sinais que o loop já emite (iteração/modelo/tool —
      // os MESMOS eventos que o pai observa p/ contabilidade). Enquanto progride, o
      // filho NUNCA é morto por timeout. O `kind` do sinal é DADO de auditoria/UX que
      // não precisamos aqui — qualquer sinal basta p/ re-armar.
      onProgress: (): void => idle.bump(),
      // EST-0982 — captura o uso PRÓPRIO do filho a cada débito, p/ reportá-lo MESMO
      // se o loop for abortado (timeout/cancelamento) antes de retornar um resultado.
      onUsage: (u): void => {
        ownUsage = u;
      },
      ...(childAsk ? { askResolver: childAsk } : {}),
      // EST-0977/0978 — o SYSTEM PROMPT do agente nomeado (persona, corpo do `.md`) +
      // o CONTEXTO recortado pelo pai entram no canal `system` do filho (instrução
      // confiável do dono, NÃO conteúdo ingerido). Ambos opcionais: a persona vem 1º
      // (define quem o filho é), o contexto depois (a tarefa que o pai recortou).
      ...(projectInstructions !== undefined ? { projectInstructions } : {}),
    });

    // HEARTBEAT (anti-deadlock): corre o loop contra o relógio de INATIVIDADE. O
    // AbortController do filho combina o cancelamento do pai com o disparo do timer
    // (kill DURO — reusa o MESMO abort/kill do baseline). Só não mata mais quem
    // progride: o `idle.bump()` (via `onProgress`) zera o relógio a cada sinal de
    // vida ⇒ um filho produtivo NUNCA cai aqui. O TOTAL fica cercado por budget+
    // iterações (E-A2), não por relógio.
    const childAbort = new AbortController();
    const onParentAbort = () => childAbort.abort();
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
    // EST-0982 (semântica do esc) — o sinal POR FILHO (nó da FlowTree) também mata o
    // loop deste filho: `p` (parar ESTE) aborta só ele; F8/PARAR-TUDO aborta todos via
    // a cascata da raiz. O esc do pai NÃO dispara este sinal (cancelOwn não cascateia).
    const nodeSignal = this.childSignalOf?.(profile.label);
    const onNodeAbort = () => childAbort.abort();
    if (nodeSignal?.aborted) childAbort.abort();
    else nodeSignal?.addEventListener('abort', onNodeAbort, { once: true });

    let timedOut = false;
    // Quando a inatividade dispara (`idle.done` resolve `true`): mata o filho. Resolve
    // `undefined` p/ a corrida — o catch trata como timeout pelo flag `timedOut`. Se o
    // loop vence (`idle.done` resolve `false` via `stop()` no finally), este `.then`
    // vê `false` ⇒ no-op. Nunca rejeita (sem unhandled).
    const idlePromise = idle.done.then((firedByIdle): undefined => {
      if (firedByIdle) {
        timedOut = true;
        childAbort.abort();
      }
      return undefined;
    });

    try {
      const run = loop.run(profile.goal, childAbort.signal);
      const result = await Promise.race([run, idlePromise]);
      // Se o heartbeat perdeu a corrida, `result` é o AgentRunResult; se a inatividade
      // disparou (`result === undefined`), o filho foi morto por estar travado.
      if (result === undefined) {
        return {
          label: profile.label,
          ok: false,
          result: `sub-agente "${profile.label}" sem resposta por ${this.idleTimeoutMs}ms (travado) — anti-deadlock`,
          stop: 'timeout',
          // EST-0982 — o que ESTE filho consumiu até ser morto (não o agregado).
          usage: ownUsage,
        };
      }
      return this.toOutcome(profile.label, result);
    } catch (err) {
      // Se a inatividade já disparou (kill via childAbort), um erro de cancelamento
      // do loop é a CONSEQUÊNCIA do timeout — reporta como travado, não como falha.
      if (timedOut) {
        return {
          label: profile.label,
          ok: false,
          result: `sub-agente "${profile.label}" sem resposta por ${this.idleTimeoutMs}ms (travado) — anti-deadlock`,
          stop: 'timeout',
          // EST-0982 — uso PRÓPRIO até o kill (não o agregado).
          usage: ownUsage,
        };
      }
      return {
        label: profile.label,
        ok: false,
        result: `sub-agente "${profile.label}" falhou: ${err instanceof Error ? err.message : String(err)}`,
        stop: 'error',
        // EST-0982 — uso PRÓPRIO até a falha (não o agregado).
        usage: ownUsage,
      };
    } finally {
      // Encerra o relógio de inatividade (resolve `idle.done` como `false` ⇒ o
      // `idlePromise` vira no-op; evita timer pendurado) e desliga o listener do pai.
      idle.stop();
      parentSignal?.removeEventListener('abort', onParentAbort);
      nodeSignal?.removeEventListener('abort', onNodeAbort);
      // EST-1098 (WT-1) — remove o worktree do filho em TODO caminho de saída (sucesso/
      // timeout/cancel/erro). `dispose` é best-effort e NUNCA lança (contrato), então
      // não derruba o desfecho já computado. No-op quando o filho não foi isolado.
      if (worktreeHandle) await worktreeHandle.dispose();
    }
  }

  private toOutcome(label: string, result: AgentRunResult): SubAgentOutcome {
    if (result.stop.kind === 'final') {
      return {
        label,
        ok: true,
        result: result.stop.answer,
        stop: 'final',
        usage: result.usage,
      };
    }
    // teto (CLI-SEC-8/E-A2) — ainda é DADO; o pai vê o motivo da parada.
    return {
      label,
      ok: false,
      result: result.stop.message,
      stop: 'limit',
      usage: result.usage,
    };
  }
}

function clampPositive(v: number | undefined, def: number): number {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return def;
  return Math.floor(v);
}

/**
 * EST-0977/0978 — combina o SYSTEM PROMPT do agente nomeado (persona) com o CONTEXTO
 * recortado pelo pai num único bloco de instrução `system` do filho. Persona 1º
 * (quem o filho é), contexto depois (a tarefa). Ambos são config CONFIÁVEL do dono
 * (não conteúdo ingerido) — mas NÃO relaxam a catraca. `undefined` quando nenhum dos
 * dois existe (perfil genérico EST-0969, comportamento idêntico ao baseline). PURO.
 */
function personaAndContext(profile: SubAgentProfile): string | undefined {
  const parts: string[] = [];
  if (profile.systemPrompt !== undefined && profile.systemPrompt.trim() !== '') {
    parts.push(profile.systemPrompt.trim());
  }
  if (profile.context !== undefined && profile.context.trim() !== '') {
    parts.push(profile.context.trim());
  }
  return parts.length > 0 ? parts.join('\n\n') : undefined;
}

/**
 * EST-SUBAGENT-MODEL · ADR-0073 · CLI-SEC-7 — ESCOLHE o `ModelCaller` de UM filho
 * (PURO/testável — o juízo "qual tier por filho" mora aqui, num ponto só):
 *
 *  - se o `.md` do filho declara `model:` (`profile.model`) que `resolveModelTier`
 *    traduz numa CHAVE DE TIER **e** a fábrica `callerForTier` está disponível ⇒
 *    devolve `callerForTier(tier)` — o filho fala AQUELE tier ao broker (o broker
 *    resolve provider/credencial/quota; valida — 422 se inservível, degrade honesto);
 *  - caso contrário (sem `model`, model sem cara de tier = provider cru, OU sem a
 *    fábrica) ⇒ devolve `parentCaller` (o caller do PAI) — BACK-COMPAT: é o
 *    comportamento de hoje (todos os filhos no caller do pai).
 *
 * O tier vem do PERFIL EM DISCO (capacidade declarada, HG-2), não de input do modelo
 * não-confiável. NÃO toca catraca/escopo/budget — só roteia a PISTA de tier (CLI-SEC-7).
 */
export function childCallerFor(
  profile: SubAgentProfile,
  parentCaller: ModelCaller,
  callerForTier?: (tier: string) => ModelCaller,
): ModelCaller {
  if (callerForTier === undefined) return parentCaller;
  const tier = resolveModelTier(profile.model);
  if (tier === undefined) return parentCaller;
  return callerForTier(tier);
}

// EST-F54 · ADR-0123 §Inv. I Fluidez — Política de CONTINUAÇÃO do regente.
//
// Função PURA decideContinuation + buildContinuationNudge: decide se o loop
// deve PROSSEGUIR (com nudge) quando o modelo respondeu com texto mas SEM
// tool-call (o "anúncio-sem-tool" — "vou agora: screenshot" sem o bloco).
//
// A política tem TETOS DUROS INEGOCIÁVEIS (anti-runaway):
//   - cap (maxContinuations): 4 continuations máx. por turno.
//   - nudgeAt: a partir da N-ésima, o nudge é FORTE (anúncio-sem-tool).
//   - giveUpAt: a partir da N-ésima, DESISTE e devolve (sem continuar).
//   - nudgeAt >= 1 (piso), giveUpAt >= nudgeAt, cap >= giveUpAt.
//
// INVARIANTES (segurança):
//   - NUNCA chama decide(), NUNCA executa tool, NUNCA aprova nada.
//   - Cada continuação consome UMA iteração (tryConsumeIteration no loop).
//   - Maestro ausente OU ALUY_CONT_OFF ⇒ seam inerte ⇒ baseline bit-a-bit.
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Função pura.

export interface ContinuationConfig {
  /** Máximo de continuations POR turno (cap DURO). Default 4. */
  readonly maxContinuations: number;
  /** A partir de qual continuation o nudge é FORTE (sem "por favor"). Default 1. */
  readonly nudgeAt: number;
  /** A partir de qual continuation DESISTIMOS (give up). Default 3. */
  readonly giveUpAt: number;
}

export const DEFAULT_MAX_CONTINUATIONS = 4;
export const DEFAULT_NUDGE_AT = 1;
export const DEFAULT_GIVEUP_AT = 3;

/** Piso/teto p/ cada campo — não-negociáveis. */
const MIN_CAP = 1;
const MIN_NUDGE = 1;
const MIN_GIVEUP = 1;

/** Config default (4/1/3). */
export const DEFAULT_CONTINUATION_CONFIG: ContinuationConfig = {
  maxContinuations: DEFAULT_MAX_CONTINUATIONS,
  nudgeAt: DEFAULT_NUDGE_AT,
  giveUpAt: DEFAULT_GIVEUP_AT,
};

// ─── Env knobs ──────────────────────────────────────────────────────────
export const CONT_MAX_ENV = 'ALUY_CONT_MAX';
export const CONT_NUDGE_ENV = 'ALUY_CONT_NUDGE_AT';
export const CONT_GIVEUP_ENV = 'ALUY_CONT_GIVEUP_AT';

function floorAtLeast(v: string | undefined, floor: number, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < floor) return def;
  return n;
}

/**
 * Resolve a config de continuação do ambiente. Disciplina `floorAtLeast`: cada
 * campo tem piso ≥1 p/ um valor minúsculo não desarmar a proteção. O `giveUpAt`
 * é clampado para NUNCA ultrapassar `maxContinuations` (não faz sentido desistir
 * DEPOIS do cap).
 */
export function resolveContinuationConfig(
  env: Record<string, string | undefined>,
): ContinuationConfig {
  const maxContinuations = floorAtLeast(env[CONT_MAX_ENV], MIN_CAP, DEFAULT_MAX_CONTINUATIONS);
  const nudgeAt = floorAtLeast(env[CONT_NUDGE_ENV], MIN_NUDGE, DEFAULT_NUDGE_AT);
  const giveUpAt = floorAtLeast(env[CONT_GIVEUP_ENV], MIN_GIVEUP, DEFAULT_GIVEUP_AT);
  // giveUpAt NUNCA pode ultrapassar maxContinuations (se cap é 4, desistir no 5 = nunca).
  const clampedGiveUp = Math.min(giveUpAt, maxContinuations);
  return { maxContinuations, nudgeAt, giveUpAt: clampedGiveUp };
}

// ─── Estado da continuação no turno ─────────────────────────────────────

export interface ContinuationState {
  /** Quantas continuations JÁ RODARAM neste turno (0-indexado no início). */
  readonly continuationsThisTurn: number;
  /** O abort signal do turno foi disparado? */
  readonly signalAborted: boolean;
  /** O modelo perguntou explicitamente ao usuário neste turno? */
  readonly askedUser: boolean;
}

/**
 * Veredito da `decideContinuation`. `'stop'` ⇒ o loop DEVOLVE o controle (fim).
 * `'continue'` ⇒ o loop RE-ENTRA com nudge.
 */
export type ContinuationVerdict =
  | { readonly action: 'stop'; readonly reason: string }
  | { readonly action: 'continue'; readonly reason: string };

/**
 * Função PURA que decide se o loop deve continuar ou parar.
 *
 * Regras (em ordem):
 *  1. signal abortado → stop (respeita ESC/Ctrl-C).
 *  2. pediu pergunta ao usuário → stop (não insiste).
 *  3. giveUpAt atingido → stop (desistiu).
 *  4. maxContinuations atingido → stop (cap).
 *  5. senão → continue (com reason p/ nudge).
 *
 * NUNCA executa efeito. NUNCA toca catraca. PURO.
 */
export function decideContinuation(
  state: ContinuationState,
  cfg: ContinuationConfig = DEFAULT_CONTINUATION_CONFIG,
): ContinuationVerdict {
  const { continuationsThisTurn, signalAborted, askedUser } = state;

  if (signalAborted) {
    return { action: 'stop', reason: 'signal abortado — ESC/Ctrl-C durante continuação' };
  }

  if (askedUser) {
    return {
      action: 'stop',
      reason: 'o modelo perguntou ao usuário — aguardando resposta, não continuar',
    };
  }

  const next = continuationsThisTurn + 1;

  if (next > cfg.giveUpAt) {
    return {
      action: 'stop',
      reason: `giveUp: ${continuationsThisTurn} continuations já tentadas (giveUpAt=${cfg.giveUpAt})`,
    };
  }

  if (next > cfg.maxContinuations) {
    return {
      action: 'stop',
      reason: `cap: ${continuationsThisTurn} continuations já tentadas (max=${cfg.maxContinuations})`,
    };
  }

  return {
    action: 'continue',
    reason:
      next >= cfg.nudgeAt ? 'anúncio-sem-tool' : `continuação ${next}/${cfg.maxContinuations}`,
  };
}

// ─── Gatilho "plano-pendente" (F54 + F79 wire §4) ───────────────────────

/** Forma MÍNIMA de caixa que a continuação lê do ContextGraph (só o `closed`). */
export interface PlanBoxLike {
  readonly closed: boolean;
}

/**
 * F54 + F79 (wire §4) — `true` se o PLANO (ContextGraph) tem ≥1 passo NÃO concluído
 * (caixa não-`closed` = `pending`/`in_progress`). É o gatilho DETERMINÍSTICO de
 * continuação "ainda há trabalho DECLARADO e não-feito", COMPLEMENTAR ao anúncio-sem-tool:
 * cobre o limbo em que o modelo PARA com um passo pendente SEM dizer "vou…" (o
 * `isAnnounceNoTool` perde esse caso). Dá ao ContextGraph seu PRIMEIRO consumidor de
 * DECISÃO (antes era só render/visual — F79). PURO: lê o snapshot, não muta, não toca catraca.
 */
export function hasPendingPlanWork(boxes: readonly PlanBoxLike[]): boolean {
  return boxes.some((b) => !b.closed);
}

/**
 * Nudge do gatilho PLANO-PENDENTE (distinto do anúncio-sem-tool). Orienta o modelo a
 * executar o próximo passo, OU marcar concluído via `update_plan` se já não é necessário,
 * OU perguntar ao usuário — fechando o limbo sem o agente agir cego.
 */
export function buildPlanPendingNudge(): string {
  return (
    'O plano ainda tem passo(s) NÃO concluído(s). Continue executando o próximo passo ' +
    'com tool-call. Se o passo restante já não é necessário, marque-o concluído via ' +
    'update_plan. Se precisa do usuário p/ prosseguir, use a ferramenta perguntar.'
  );
}

// ─── Detector "anúncio-sem-tool" ────────────────────────────────────────

/**
 * Heurística: o texto do modelo CONTÉM uma "promessa de ação" (anuncia que vai
 * fazer algo) sem ter emitido tool-call de fato. Exemplos:
 *   - "vou agora: screenshot"
 *   - "vou criar o arquivo"
 *   - "vou executar o comando"
 *   - "deixa eu rodar isso"
 *   - "vou fazer X"
 *
 * Pattern ABERTO (F60): marcadores de intenção-futura em 1ª pessoa — "vou",
 * "vamos", "irei", "farei", "deixa eu", "agora vou" — seguidos de QUALQUER coisa.
 * NÃO usa lista fechada de verbos (o modelo diz "vou direto ao ponto", "vou
 * ativá-la", "vou encontrar o xcalc" — frases que uma lista de verbos perde).
 * Casa o anúncio, não o verbo específico. Completões limpas ("pronto, o resultado
 * é 4") não começam com esses marcadores ⇒ não disparam.
 *
 * HUNT-LIMBO — esta detecção GATEIA a continuação no loop (loop.ts: só nudge+continua
 * quando ela é `true`). Um falso-NEGATIVO ⇒ o anúncio passa sem nudge ⇒ o agente PARA
 * com trabalho pendente = o LIMBO da F54. Por isso cobrimos os fraseados que o modelo
 * REALMENTE usa além do "vou…" canônico:
 *   - PT formal: "deixe-me"/"permita-me" (não só o coloquial "deixa eu").
 *   - INGLÊS: o modelo escorrega p/ EN ("Let me run…", "I'll create…", "I will…",
 *     "I'm going to…", "Let's…") apesar do system PT-BR — e aí limbava. `let me` exclui
 *     "let me know" (isso é o modelo FALANDO com o usuário, não anúncio de ação).
 * Completões em passado NÃO disparam ("I ran…", "I've created…" não casam "I'll/I will").
 *
 * PURO — NÃO consulta estado externo.
 */
const ANNOUNCE_NO_TOOL_RE =
  /\b(vou|vamos|irei|farei|deixa\s+eu|deixe-?me|permita-?me|agora\s+vou|já\s+vou)\b/i;
// Inglês (o modelo escorrega): intenção-futura em 1ª pessoa. `let me` com lookahead
// negativo p/ "know" (≠ anúncio de ação). Apóstrofo reto OU curvo (’).
const ANNOUNCE_NO_TOOL_EN_RE =
  /\b(I['’]?ll|I\s+will|I['’]?m\s+going\s+to|I\s+am\s+going\s+to|let['’]?s|let\s+me(?!\s+know))\b/i;

/**
 * Detecta se o texto contém "anúncio de ação sem tool-call".
 * `hadToolCall` é `true` se este turno JÁ teve tool-call (pelo nativo ou texto).
 * Retorna `true` se o texto anuncia ação MAS não teve tool-call.
 */
export function isAnnounceNoTool(text: string, hadToolCall: boolean): boolean {
  if (hadToolCall) return false;
  if (!text || text.trim().length === 0) return false;
  return ANNOUNCE_NO_TOOL_RE.test(text) || ANNOUNCE_NO_TOOL_EN_RE.test(text);
}

/**
 * #4 (achado dogfood do dono) — o agente PERGUNTOU ao usuário em TEXTO ("o que você
 * quer fazer? 🎯") e, com um plano aberto (`pendingPlan`), a continuação o NUDGAVA a
 * seguir ⇒ ele DECIDIA SOZINHO apesar de ter perguntado. A tool `perguntar` já pausa o
 * loop (resolver da TUI); o buraco era a pergunta em TEXTO LIVRE. Heurística PURA: a
 * ÚLTIMA linha não-vazia termina em "?" (depois de tirar decoração final — emoji,
 * markdown, aspas, fechamentos). Viés DELIBERADO p/ parar: um falso-positivo custa um
 * "continue" do usuário; um falso-negativo é exatamente a queixa (o agente decide sozinho).
 * Alimenta `askedUser` em `decideContinuation` ⇒ veredito `stop` (aguarda a resposta).
 */
export function endsWithUserQuestion(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const ln = lines[i].trim();
    if (ln === '') continue;
    // tira do FIM: espaços, emoji/pictográficos, ZWJ/seletor-de-variação, e decoração
    // de markdown/fechamento (*, _, ~, `, aspas, ), ]). Sobra o caractere "semântico" final.
    const core = ln.replace(/[\s‍️\p{Extended_Pictographic}*_~`"'»”’)\]]+$/gu, '');
    return core.endsWith('?') || core.endsWith('？');
  }
  return false;
}

// ─── Nudge texts ────────────────────────────────────────────────────────

/**
 * Redige o nudge que o loop injeta como `reanchor` (canal TRUSTED, nunca
 * system/user) quando a continuação é disparada.
 *
 * Nudge FORTE (anúncio-sem-tool): "Você anunciou uma ação mas não emitiu tool…"
 * Nudge SUAVE (continuação normal): "Você não concluiu. Continue — ou encerre."
 */
export function buildContinuationNudge(reason: string): string {
  if (reason === 'anúncio-sem-tool') {
    return (
      'Você anunciou uma ação (ex.: "vou fazer X") mas NÃO emitiu tool-call. ' +
      'PARE de anunciar. Emita tool AGORA — ou, se precisa do usuário, ' +
      'faça uma pergunta explicitamente usando a ferramenta perguntar.'
    );
  }

  if (reason.startsWith('continuação')) {
    return (
      `Você ainda não concluiu a tarefa. Continue trabalhando (${reason}) — ` +
      `use as ferramentas. Se terminou, responda em texto livre SEM anunciar ação pendente. ` +
      `Se não pode prosseguir sem input do usuário, use a ferramenta perguntar.`
    );
  }

  // fallback
  return (
    `Ação pendente detectada (${reason}). Continue com tool-call, ` +
    `ou encerre se concluiu, ou pergunte se precisa do usuário.`
  );
}

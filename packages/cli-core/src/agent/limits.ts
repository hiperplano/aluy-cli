// EST-0944 · CLI-SEC-8 — tetos de sessão (anti-runaway).
//
// Fail-safe CLIENT-SIDE que COMPLEMENTA (não substitui) o rate-limit/quota
// autoritativo do broker (SEC-19/SEC-11). O ponto é parar um loop agêntico que
// recursa/erra ANTES de floodar o broker e queimar tokens/dinheiro — em especial,
// o budget local dispara ANTES do `429` do broker (fail-safe econômico).
//
// Ao atingir QUALQUER teto, o loop PARA e PERGUNTA (não continua silencioso) —
// circuit-breaker. A confirmação p/ prosseguir é da TUI (EST-0948); aqui o loop
// só sinaliza `stopped_by_limit` com o motivo exato.
//
// A auditoria detalhada e o budget de CUSTO ($) ficam na EST-0947; aqui o baseline:
// teto de iterações, teto de tool-calls, e budget local de TOKENS.

/** Configuração dos tetos de uma sessão/objetivo. */
export interface SessionLimits {
  /** Máximo de iterações do loop (modelo→tool→observação) por objetivo. */
  readonly maxIterations: number;
  /** Máximo de tool-calls executadas por objetivo. */
  readonly maxToolCalls: number;
  /**
   * Budget local de tokens (in+out somados, reportados pelo broker no `usage`).
   * `undefined` ⇒ sem budget de tokens (só os tetos de contagem). Ao estourar,
   * para ANTES da próxima chamada de modelo (fail-safe pré-429).
   */
  readonly maxTokens?: number;
}

/**
 * EST-0948 — TETO DEFAULT de tokens da sessão. RACIONAL DO 10_000_000:
 * o budget é AGREGADO (in+out de TODAS as chamadas, incl. histórico RE-ENVIADO a
 * cada iteração + fan-out de sub-agentes no mesmo teto E-A2). Numa sessão agêntica
 * real de janela cheia, cada chamada manda ~a janela inteira de `tokens_in`, então
 * 1M (o valor antigo) era batido em UMA sessão boa — pausa "toda hora" sem ser
 * runaway. O budget local é um FAIL-SAFE anti-runaway (parar um loop que recursa/
 * erra ANTES de floodar o broker — CLI-SEC-8), NÃO uma cota de produto (essa é
 * autoritativa no broker, SEC-19). 10M dá folga REAL p/ trabalho agêntico legítimo
 * e ainda corta um runaway MUITO antes do dano (clamp em 50M; `[c]` estende).
 * Configurável por `ALUY_MAX_TOKENS`/`--max-tokens`.
 */
export const DEFAULT_MAX_TOKENS = 10_000_000;

/**
 * EST-0948 — TETO-TETO (clamp anti-runaway). O teto efetivo configurável é
 * SEMPRE clampado neste valor: subir o default não pode virar um cheque em
 * branco. Mesmo com `ALUY_MAX_TOKENS`/`--max-tokens` absurdamente alto, o
 * fail-safe econômico continua existindo (CLI-SEC-8 preservado). 50M ≈ dezenas
 * de janelas de contexto — espaço de sobra p/ qualquer sessão agêntica honesta,
 * mas finito (um loop infinito ainda PARA e PERGUNTA bem antes de queimar uma
 * fortuna). O `[c] continuar` ESTENDE o teto efetivo, mas NUNCA além deste limite.
 */
export const MAX_TOKENS_CEILING = 50_000_000;

/**
 * EST-0948 — limite MÍNIMO sensato (evita teto≤0 que travaria a sessão no 1º
 * turno). Valores abaixo disto (ou inválidos) caem no default.
 */
export const MIN_TOKENS_FLOOR = 1_000;

/**
 * EST-0948 — TETO DEFAULT de ITERAÇÕES do loop (modelo→tool→observação) por
 * objetivo. RACIONAL DO 300 (antes 25): 25 era baixo demais p/ um objetivo
 * AGÊNTICO REAL — criar várias páginas/arquivos num projeto multi-arquivo gasta
 * facilmente dezenas de iterações (ler→editar→rodar→corrigir por arquivo), então
 * a sessão batia o gate de iterações CEDO (Tiago bateu `25/25` com os tokens só
 * em 58% do 1M — o teto de iterações é que pausava primeiro, longe de qualquer
 * runaway real). 300 cobre um projeto multi-arquivo honesto com folga e ainda é
 * FINITO: um loop que recursa/erra ainda PARA e PERGUNTA bem antes de floodar o
 * broker (CLI-SEC-8). Pareado com `maxToolCalls = 2×` (cada iteração pode emitir
 * mais de um tool-call). Configurável por `ALUY_MAX_ITERATIONS`/`--max-iterations`.
 */
export const DEFAULT_MAX_ITERATIONS = 300;

/**
 * EST-0948 — TETO-TETO de iterações (clamp anti-runaway, espelha
 * `MAX_TOKENS_CEILING`). O teto efetivo configurável é SEMPRE clampado aqui:
 * subir o default/`ALUY_MAX_ITERATIONS`/`--max-iterations` não vira cheque em
 * branco. 10_000 iterações ≈ uma sessão agêntica enorme porém finita — espaço de
 * sobra p/ trabalho honesto, mas um loop infinito ainda PARA e PERGUNTA antes de
 * queimar o broker (CLI-SEC-8 não-relaxável). O `[c] continuar` ESTENDE o teto
 * efetivo (+50 por vez), mas o `extend()` clampa o de tokens; o de iterações é
 * deliberadamente NÃO clampado no extend (o `[c]` é uma ação humana explícita e
 * repetida — cada toque só soma +50, nunca um salto), mas o teto INICIAL aqui sim.
 */
export const MAX_ITERATIONS_CEILING = 10_000;

/**
 * EST-0948 — limite MÍNIMO sensato de iterações (evita teto≤0 que travaria a
 * sessão antes da 1ª volta do loop). Valores abaixo disto (ou inválidos) caem no
 * default. 1 = pelo menos uma iteração possível.
 */
export const MIN_ITERATIONS_FLOOR = 1;

/** Defaults conservadores — seguros por construção (CLI-SEC-8). */
export const DEFAULT_LIMITS: SessionLimits = {
  maxIterations: DEFAULT_MAX_ITERATIONS,
  // EST-0948 — tool-calls = 2× iterações (cada iteração pode emitir mais de um
  // tool-call). Derivado do default de iterações p/ não virar o novo gargalo
  // quando o teto de iterações sobe (mantém a folga relativa do baseline 25→50).
  maxToolCalls: DEFAULT_MAX_ITERATIONS * 2,
  maxTokens: DEFAULT_MAX_TOKENS,
};

/**
 * EST-0948 — resolve o TETO EFETIVO de tokens com precedência FLAG > ENV > DEFAULT,
 * VALIDADO e CLAMPADO (anti-runaway). Determinístico e puro (sem I/O — o env é
 * passado como dado): testável isolado.
 *
 *  - `flag` (de `--max-tokens N`) vence;
 *  - senão `env` (de `ALUY_MAX_TOKENS`);
 *  - senão o `DEFAULT_MAX_TOKENS`.
 *
 * Entrada NÃO-numérica, NaN, ≤0, ou < `MIN_TOKENS_FLOOR` ⇒ ignorada (cai no
 * próximo da precedência, por fim no default). O resultado é SEMPRE clampado em
 * `[MIN_TOKENS_FLOOR, MAX_TOKENS_CEILING]` — o clamp é o que preserva o anti-runaway
 * mesmo sob configuração maliciosa/errada (CLI-SEC-8 não-relaxável).
 */
export function resolveMaxTokens(
  flag?: string | number | undefined,
  env?: string | undefined,
): number {
  const fromFlag = parseTokenSetting(flag);
  const fromEnv = parseTokenSetting(env);
  const chosen = fromFlag ?? fromEnv ?? DEFAULT_MAX_TOKENS;
  return Math.min(MAX_TOKENS_CEILING, Math.max(MIN_TOKENS_FLOOR, chosen));
}

/**
 * Parseia um valor de teto (string da flag/env ou número). Devolve `undefined`
 * se ausente/inválido/abaixo do piso — o chamador cai no próximo da precedência.
 * Aceita só inteiros positivos ≥ piso (rejeita `'abc'`, `'-1'`, `'0'`, `'1e9'`
 * com lixo, etc. de forma estrita p/ não engolir entrada errada silenciosamente).
 */
function parseTokenSetting(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_TOKENS_FLOOR) return undefined;
  return n;
}

/**
 * EST-0948 — resolve o TETO EFETIVO de ITERAÇÕES com precedência FLAG > ENV >
 * DEFAULT, VALIDADO e CLAMPADO (anti-runaway). Espelha exatamente `resolveMaxTokens`.
 * Determinístico e puro (sem I/O — o env é passado como dado): testável isolado.
 *
 *  - `flag` (de `--max-iterations N`) vence;
 *  - senão `env` (de `ALUY_MAX_ITERATIONS`);
 *  - senão o `DEFAULT_MAX_ITERATIONS`.
 *
 * Entrada NÃO-numérica, NaN, ≤0, ou < `MIN_ITERATIONS_FLOOR` ⇒ ignorada (cai no
 * próximo da precedência, por fim no default). O resultado é SEMPRE clampado em
 * `[MIN_ITERATIONS_FLOOR, MAX_ITERATIONS_CEILING]` — o clamp é o que preserva o
 * anti-runaway mesmo sob configuração maliciosa/errada (CLI-SEC-8 não-relaxável).
 */
export function resolveMaxIterations(
  flag?: string | number | undefined,
  env?: string | undefined,
): number {
  const fromFlag = parseIterationSetting(flag);
  const fromEnv = parseIterationSetting(env);
  const chosen = fromFlag ?? fromEnv ?? DEFAULT_MAX_ITERATIONS;
  return Math.min(MAX_ITERATIONS_CEILING, Math.max(MIN_ITERATIONS_FLOOR, chosen));
}

/**
 * Parseia um valor de teto de iterações (string da flag/env ou número). Devolve
 * `undefined` se ausente/inválido/abaixo do piso — o chamador cai no próximo da
 * precedência. Aceita só inteiros positivos ≥ piso (rejeita `'abc'`, `'-1'`,
 * `'0'`, `'1.5'`, etc. de forma estrita p/ não engolir entrada errada silenciosa).
 */
function parseIterationSetting(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_ITERATIONS_FLOOR) return undefined;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// EST-0948 — `max_tokens` de OUTPUT POR CHAMADA ao modelo (anti-TRUNCAMENTO).
//
// ⚠ CONCEITO DISTINTO do budget local acima (`ALUY_MAX_TOKENS`/`resolveMaxTokens`):
//   - `ALUY_MAX_TOKENS`        = teto de BUDGET LOCAL da sessão (in+out ACUMULADOS,
//                                anti-runaway/fail-safe pré-429 — CLI-SEC-8). Tem
//                                DEFAULT (1M) e é o circuit-breaker do loop.
//   - `ALUY_MAX_OUTPUT_TOKENS` = `max_tokens` de OUTPUT de UMA chamada ao modelo
//                                (vai no corpo do request → broker → provider).
//                                É um OVERRIDE FINO, anti-truncamento: o broker
//                                aplica um default per-tier que, baixo demais, CORTA
//                                arquivos grandes no uso agêntico. Este knob deixa o
//                                usuário SUBIR o teto de output por chamada.
//
// DEFAULT = UNSET (undefined): por padrão o CLI NÃO manda `max_tokens` → o BROKER
// decide (o máx do modelo, após o fix dele). HG-2/CLI-SEC-7: o CLI não assume
// detalhe de modelo; só EXPÕE um teto de output OPCIONAL. Só manda quando o usuário
// configura explicitamente (`ALUY_MAX_OUTPUT_TOKENS`/`--max-output-tokens`).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EST-0948 — TETO-TETO (clamp CLI-side) do `max_tokens` de OUTPUT por chamada. Um
 * typo (`1600000` em vez de `16000`) não deve mandar um absurdo ao broker: o valor
 * configurado é SEMPRE clampado neste limite. 200_000 é generoso (cobre a janela de
 * output de qualquer modelo atual com folga) mas finito. NÃO é o budget de sessão —
 * é só uma sanidade do número que vai no corpo do request.
 */
export const MAX_OUTPUT_TOKENS_CEILING = 200_000;

/**
 * EST-0948 — limite MÍNIMO sensato do `max_tokens` de output. Abaixo disto (ou
 * inválido/ausente) ⇒ UNSET (o broker decide). 1 = pelo menos um token de output.
 */
export const MIN_OUTPUT_TOKENS_FLOOR = 1;

/**
 * EST-0948 — resolve o `max_tokens` de OUTPUT POR CHAMADA com precedência
 * FLAG > ENV > UNSET. Diferente de `resolveMaxTokens` (budget local), o DEFAULT é
 * `undefined` (NÃO mandar `max_tokens` ⇒ o broker decide). Determinístico e puro
 * (env como dado): testável isolado.
 *
 *  - `flag` (de `--max-output-tokens N`) vence;
 *  - senão `env` (de `ALUY_MAX_OUTPUT_TOKENS`);
 *  - senão `undefined` (UNSET — o broker decide).
 *
 * Entrada NÃO-numérica, NaN, não-inteira, ≤0 ou < `MIN_OUTPUT_TOKENS_FLOOR` ⇒
 * IGNORADA + AVISO (`onWarn`), e cai no próximo da precedência (por fim UNSET) —
 * um typo NÃO quebra a sessão, só não tem efeito. Um valor válido é CLAMPADO em
 * `MAX_OUTPUT_TOKENS_CEILING` (com aviso de clamp) p/ não mandar um absurdo.
 */
export function resolveMaxOutputTokens(
  flag?: string | number | undefined,
  env?: string | undefined,
  onWarn?: (msg: string) => void,
): number | undefined {
  // Mesma disciplina de `resolveMaxTokens`/`resolveMaxIterations`: flag inválida ⇒
  // cai p/ o env (a precedência); ausente ⇒ env; ambos vazios ⇒ UNSET. A diferença é
  // que aqui o inválido AVISA (não silencia) — um typo é visível, mas não quebra.
  const fromFlag = parseOutputTokenSetting(flag, '--max-output-tokens', onWarn);
  const fromEnv = parseOutputTokenSetting(env, 'ALUY_MAX_OUTPUT_TOKENS', onWarn);
  const chosen = fromFlag ?? fromEnv;
  if (chosen === undefined) return undefined; // UNSET ⇒ broker decide.
  if (chosen > MAX_OUTPUT_TOKENS_CEILING) {
    onWarn?.(
      `aluy: max-output-tokens ${chosen} acima do teto CLI-side (${MAX_OUTPUT_TOKENS_CEILING}); usando ${MAX_OUTPUT_TOKENS_CEILING}.`,
    );
    return MAX_OUTPUT_TOKENS_CEILING;
  }
  return chosen;
}

/**
 * Parseia um valor de `max_tokens` de output (string da flag/env ou número). Devolve
 * `undefined` se ausente; e `undefined` + AVISO se inválido (não-inteiro/≤0/< piso) —
 * o chamador cai no próximo da precedência. Estrito (rejeita `'abc'`, `'-1'`, `'0'`,
 * `'1.5'`, `'1e9'` com lixo) p/ não engolir entrada errada silenciosamente.
 */
function parseOutputTokenSetting(
  v: string | number | undefined,
  source: string,
  onWarn?: (msg: string) => void,
): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_OUTPUT_TOKENS_FLOOR) {
    onWarn?.(
      `aluy: ${source} inválido (${String(v)}); ignorando (o broker decide o teto de output).`,
    );
    return undefined;
  }
  return n;
}

/**
 * EST-0948 — limiar de AVISO ANTECIPADO (% do teto da sessão). Ao cruzar este
 * ponto, o indicador de consumo ganha um sinal `⚠` (cor de aviso) ANTES de bater
 * os 100% e pausar no gate — dá ao usuário a chance de compactar/encerrar com
 * antecedência. É display puro (não toca a catraca nem o budget). 70% = janela
 * de manobra confortável sem ser barulhento cedo demais.
 */
export const BUDGET_WARN_PCT = 70;

/**
 * EST-0948 — % do teto de tokens da sessão JÁ consumido (0..∞ — pode passar de
 * 100% quando o último turno estoura o teto: o gate mostra "130%"). Puro/determinístico.
 * `maxTokens` ausente/≤0 ⇒ 0% (sem teto de tokens, não há % a mostrar).
 */
export function budgetPct(tokens: number, maxTokens: number | undefined): number {
  if (maxTokens === undefined || maxTokens <= 0) return 0;
  return Math.round((tokens / maxTokens) * 100);
}

/**
 * EST-0983 · ADR-0064 · CLI-SEC-15 (GS-M2/RES-M-2) — TETO de gravações AUTÔNOMAS de
 * memória (`remember`) POR SESSÃO. A lembrança é autônoma (allow silencioso), então
 * sem teto a memória cresce sem fim (DoS/ruído) e um conteúdo malicioso poderia
 * floodar a memória com "fatos" (anti-runaway). Além do teto ⇒ a catraca BARRA a
 * tool `remember` (categoria `memory-write`, deny) — não é confirmação de efeito,
 * é anti-runaway ⇒ NÃO-relaxável por `--unsafe`. Conservador por construção.
 */
export const DEFAULT_MAX_MEMORY_WRITES_PER_SESSION = 20;

/** Qual teto disparou (p/ a mensagem de parada e a auditoria). */
export type LimitKind = 'iterations' | 'tool_calls' | 'tokens';

/**
 * EST-0969 · ADR-0057 (E-A2) — resultado de uma RESERVA atômica de slot.
 * `ok=false` ⇒ o teto barraria; `limit` diz qual (p/ a parada/auditoria).
 */
export interface ReserveResult {
  readonly ok: boolean;
  readonly limit?: LimitKind;
}

/**
 * EST-0969 · ADR-0057 (E-A2) — contrato do CONTADOR que o loop consome. A
 * abstração que permite o loop rodar tanto com um `SessionBudget` PRÓPRIO (1
 * sessão) quanto com um `SharedBudget` COMPARTILHADO (pai + N filhos paralelos).
 *
 * A API expõe RESERVA ATÔMICA (`tryConsume*`: ler-e-incrementar numa só passada
 * SÍNCRONA, sem `await` no meio ⇒ indivisível sob a intercalação de Promises do
 * Node) — não há mais "checa, depois conta" a cavalo de um `await`, que era o
 * hazard de E-A2 com paralelismo. Os métodos legados `countIteration`/`exceeded`
 * (check-then-act) permanecem só p/ compatibilidade do `SessionBudget` mono-loop.
 */
export interface BudgetGate {
  /** Reserva ATÔMICA de 1 iteração; `ok=false` se o teto barraria. */
  tryConsumeIteration(): ReserveResult;
  /** Reserva ATÔMICA de 1 tool-call; `ok=false` se o teto barraria. */
  tryConsumeToolCall(): ReserveResult;
  /** Acumula tokens (in+out) reportados pelo broker. */
  addTokens(n: number): void;
  /** `true` se o teto de TOKENS já estourou (portão pré-chamada de modelo). */
  tokensExceeded(): boolean;
  /**
   * PEEK (não-consome) do teto já ATINGIDO, p/ o portão pré-iteração: replica a
   * checagem do antigo `exceeded()` (tokens/tool-calls/iterações já no teto ⇒ para
   * ANTES da próxima chamada de modelo). Diferente de `tryConsume*` (que RESERVA):
   * este só observa. O loop o chama no topo de cada iteração — preserva a semântica
   * de "depois de gastar o último tool-call, a próxima volta do loop para".
   */
  peekExceeded(): LimitKind | null;
  /** Uso agregado corrente. */
  readonly usage: { iterations: number; toolCalls: number; tokens: number };
  /** Mensagem legível do estouro. */
  reasonFor(kind: LimitKind): string;
  /**
   * EST-0948 — ESTENDE os tetos in-place (o `[c] continuar` do BudgetGate). SOBE
   * o teto de tokens em `tokens`, o de iterações em `iterations` E o de tool-calls
   * em `iterations` (cada iteração extra pode emitir um tool-call, então o teto de
   * tool-calls TEM de crescer junto — senão um stop por `tool_calls` nunca avançaria
   * no `[c]`). SEM zerar os contadores (o trabalho já feito é preservado): a MESMA
   * sessão segue com folga. O contador volta a caber sob o teto ⇒ `peekExceeded()`/
   * `tokensExceeded()` deixam de disparar e o loop pode RETOMAR. Bater o NOVO teto ⇒
   * pausa de novo (o ciclo `[c]` funciona repetidamente). O teto de tokens é CLAMPADO
   * em `MAX_TOKENS_CEILING` (anti-runaway preservado — `[c]` não vira cheque em branco).
   * Sem `maxTokens` (sessão sem teto de tokens) ⇒ só estende iterações/tool-calls.
   */
  extend(tokens: number, iterations: number): void;
  /**
   * EST-0948 — RE-ARMA o circuit-breaker p/ um NOVO objetivo: zera os contadores
   * (iterações/tool-calls/tokens) E restaura os tetos ORIGINAIS (desfaz `extend()`).
   * O controller o chama no início de cada turno NOVO (submit) — assim cada objetivo
   * ganha o budget cheio, como no baseline (onde cada `run`/`resume` criava um budget
   * próprio zerado). NÃO é chamado no `[c] continuar` (lá o trabalho é preservado).
   */
  reset(): void;
}

/**
 * EST-0948 — núcleo compartilhado do `extend()` (mesma disciplina de clamp p/
 * `SessionBudget` e `SharedBudget`). Sobe os tetos in-place sobre uma cópia
 * MUTÁVEL dos limits (`maxIterations`/`maxToolCalls`/`maxTokens`), clampando o
 * teto de tokens no teto-teto. Valores ≤0 são no-op (defensivo). Retorna o novo
 * estado mutável (o chamador reatribui).
 */
function extendLimits(current: MutableLimits, addTokens: number, addIterations: number): void {
  if (Number.isFinite(addIterations) && addIterations > 0) {
    const inc = Math.trunc(addIterations);
    current.maxIterations += inc;
    // tool-calls crescem JUNTO com as iterações: cada iteração extra pode emitir um
    // tool-call, então um stop por `tool_calls` precisa de teto novo p/ avançar no `[c]`.
    current.maxToolCalls += inc;
  }
  if (current.maxTokens !== undefined && Number.isFinite(addTokens) && addTokens > 0) {
    current.maxTokens = Math.min(MAX_TOKENS_CEILING, current.maxTokens + Math.trunc(addTokens));
  }
}

/** Cópia MUTÁVEL dos limits — o estado interno que `extend()` sobe in-place. */
interface MutableLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxTokens?: number;
}

/** Deriva a cópia mutável dos tetos a partir dos limits imutáveis injetados. */
function toMutable(limits: SessionLimits): MutableLimits {
  return {
    maxIterations: limits.maxIterations,
    maxToolCalls: limits.maxToolCalls,
    ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
  };
}

/**
 * Contador mutável de uma sessão. Acumula iterações/tool-calls/tokens e responde
 * se ALGUM teto foi atingido. É o circuit-breaker do loop (CLI-SEC-8). Determinístico
 * e sem I/O — testável isolado (CA-5).
 */
export class SessionBudget implements BudgetGate {
  private iterations = 0;
  private toolCalls = 0;
  private tokens = 0;
  // EST-0948 — cópia MUTÁVEL dos tetos: `extend()` (o `[c] continuar`) sobe estes
  // valores in-place. O `limits` injetado permanece a config imutável de origem.
  private limits: MutableLimits;
  // EST-0948 — os tetos ORIGINAIS, p/ `reset()` restaurar (desfaz os `extend()`).
  private readonly originalLimits: SessionLimits;

  constructor(limits: SessionLimits) {
    this.originalLimits = limits;
    this.limits = toMutable(limits);
  }

  countIteration(): void {
    this.iterations += 1;
  }
  countToolCall(): void {
    this.toolCalls += 1;
  }
  addTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.tokens += n;
  }

  /**
   * EST-0969 (E-A2) — RESERVA atômica de iteração (ler-e-incrementar síncrono).
   * Mesma semântica do `exceeded()`+`countIteration()`, fundida num só método
   * SÍNCRONO p/ não deixar gap a cavalo de `await`. No mono-loop é equivalente;
   * a fusão é o que torna o `SharedBudget` (paralelo) seguro pela MESMA API.
   */
  tryConsumeIteration(): ReserveResult {
    if (this.iterations >= this.limits.maxIterations) {
      return { ok: false, limit: 'iterations' };
    }
    this.iterations += 1;
    return { ok: true };
  }

  /** EST-0969 (E-A2) — RESERVA atômica de tool-call. */
  tryConsumeToolCall(): ReserveResult {
    if (this.toolCalls >= this.limits.maxToolCalls) {
      return { ok: false, limit: 'tool_calls' };
    }
    this.toolCalls += 1;
    return { ok: true };
  }

  /** EST-0969 (E-A2) — `true` se o teto de tokens estourou (portão pré-chamada). */
  tokensExceeded(): boolean {
    return this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens;
  }

  /** EST-0969 (E-A2) — PEEK do teto já atingido (não-consome). Reusa `exceeded()`. */
  peekExceeded(): LimitKind | null {
    return this.exceeded();
  }

  get usage(): { iterations: number; toolCalls: number; tokens: number } {
    return { iterations: this.iterations, toolCalls: this.toolCalls, tokens: this.tokens };
  }

  /**
   * EST-0948 — ESTENDE os tetos (o `[c] continuar`): sobe tokens+iterações SEM
   * zerar os contadores (preserva o trabalho). Clamp anti-runaway no teto de tokens.
   */
  extend(tokens: number, iterations: number): void {
    extendLimits(this.limits, tokens, iterations);
  }

  /** EST-0948 — re-arma p/ um novo objetivo: zera contadores + restaura tetos. */
  reset(): void {
    this.iterations = 0;
    this.toolCalls = 0;
    this.tokens = 0;
    this.limits = toMutable(this.originalLimits);
  }

  /**
   * Retorna o teto ESTOURADO (ou `null` se há folga). Checa ANTES de gastar mais:
   * o loop chama isto no topo de cada iteração e após contabilizar `usage`, de
   * modo que o budget de tokens trave ANTES da próxima chamada ao broker.
   */
  exceeded(): LimitKind | null {
    if (this.iterations >= this.limits.maxIterations) return 'iterations';
    if (this.toolCalls >= this.limits.maxToolCalls) return 'tool_calls';
    if (this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens) {
      return 'tokens';
    }
    return null;
  }

  /** Mensagem legível do estouro (p/ a confirmação da TUI e a auditoria). */
  reasonFor(kind: LimitKind): string {
    switch (kind) {
      case 'iterations':
        return `teto de iterações atingido (${this.iterations}/${this.limits.maxIterations}) — pausado para confirmação.`;
      case 'tool_calls':
        return `teto de tool-calls atingido (${this.toolCalls}/${this.limits.maxToolCalls}) — pausado para confirmação.`;
      case 'tokens':
        return `budget local de tokens atingido (${this.tokens}/${this.limits.maxTokens ?? 0}) — pausado antes de novo gasto.`;
    }
  }
}

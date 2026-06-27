// EST-1128 · ADR-0123 §2.1-bis — PORTA JudgeEngine (contrato puro).
//
// Interface ASSÍNCRONA de julgamento plugável — camada (b) do motor tiered
// local-first do Maestro. O `JudgeEngine` é a face de AVALIAÇÃO SEMÂNTICA:
// recebe uma pergunta/enunciado com contexto e devolve um julgamento
// estruturado. Plugável: Ollama/llama.cpp (local) OU provider (remoto,
// via broker/BYO).
//
// PORTÁVEL (ADR-0053 §8): ZERO I/O, ZERO import de `node:*`, ZERO sidecar,
// ZERO credencial (CLI-SEC-7 — a interface NÃO prevê passar credencial de
// provider ao engine). A impl concreta (Ollama loopback ou broker) mora no
// `@aluy/cli`.
//
// Saída = DADO envelopado (CLI-SEC-15-B): o julgamento é DADO, nunca
// instrução — o Maestro pondera o resultado, não o obedece cegamente.

// ---------------------------------------------------------------------------
// Tipos de entrada
// ---------------------------------------------------------------------------

/** Uma alternativa ou opção a julgar. */
export interface JudgeOption {
  /** Identificador curto da opção (ex.: "continuar", "pausar"). */
  readonly id: string;
  /** Descrição do que esta opção representa. */
  readonly label: string;
  /** Contexto adicional sobre esta opção (opcional). */
  readonly detail?: string;
}

/** Entrada para `JudgeEngine.judge`. */
export interface JudgeInput {
  /** A pergunta ou enunciado a avaliar. */
  readonly question: string;
  /** Opções entre as quais decidir. */
  readonly options: readonly JudgeOption[];
  /** Contexto adicional (sinais, estado, histórico resumido). */
  readonly context?: string;
  /** Preferência / hint do caller (opcional — ex.: "prefira segurança"). */
  readonly hint?: string;
}

// ---------------------------------------------------------------------------
// Tipos de saída
// ---------------------------------------------------------------------------

/** Uma nota explicativa do raciocínio. */
export interface JudgeReason {
  /** Id da opção a que esta nota se refere. */
  readonly optionId: string;
  /** Breve justificativa (1-2 frases). */
  readonly rationale: string;
}

/** Resultado do julgamento: DADO envelopado (CLI-SEC-15-B). */
export interface JudgeResult {
  /** Id da opção escolhida. */
  readonly chosen: string;
  /** Confiança (0..1). */
  readonly confidence: number;
  /** Notas de raciocínio por opção (pelo menos da escolhida). */
  readonly reasons: readonly JudgeReason[];
  /** Se o judge usou heurística (fallback) ou LLM. */
  readonly mode: 'heuristic' | 'llm';
}

// ---------------------------------------------------------------------------
// Porta JudgeEngine
// ---------------------------------------------------------------------------

/**
 * Porta ASSÍNCRONA de julgamento plugável — camada (b) do motor tiered
 * local-first do Maestro (ADR-0123 §2.1-bis).
 *
 * Contrato puro em `@aluy/cli-core` — ZERO implementação concreta, ZERO I/O,
 * ZERO sidecar, ZERO credencial (CLI-SEC-7). A impl concreta mora no
 * `@aluy/cli`: pode ser Ollama/llama.cpp (loopback local, default) ou um
 * provider remoto via broker/BYO, trocável sem mexer no core.
 *
 * O `JudgeEngine` é a face de AVALIAÇÃO SEMÂNTICA do Maestro: quando a
 * camada (a) (heurística pura) não basta, o Maestro escala para o judge
 * (camada b) para decidir entre opções com semântica. O resultado é DADO
 * (CLI-SEC-15-B) — o Maestro pondera, não obedece cegamente.
 *
 * Fallback: se o judge não estiver disponível (sidecar down), o Maestro
 * DEGRADA para heurística pura — nunca trava por falta do judge
 * (não-regressão / disponibilidade; CA-MA8).
 */
export interface JudgeEngine {
  /**
   * Avalia uma questão com opções e devolve um julgamento.
   *
   * @returns Julgamento estruturado com opção escolhida, confiança e
   *          raciocínio. O campo `mode` indica se foi heurística ou LLM.
   */
  judge(input: JudgeInput): Promise<JudgeResult>;
}

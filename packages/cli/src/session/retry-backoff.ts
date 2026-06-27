// EST-0948 (auto-retry · broker-error UX/resiliência) — POLÍTICA de backoff do
// auto-retry de falhas RETRYABLE do broker. PURO (sem React/Ink, sem timers): só a
// MATEMÁTICA do atraso. O loop de retry (controller) a consome p/ decidir quanto
// esperar entre tentativas; os testes a exercem sem relógio real.
//
// Regras (alinhadas à estória):
//   • Respeita o `Retry-After` do broker quando presente (header/corpo, já parseado
//     no `BrokerError.retryAfter`, em SEGUNDOS) — o servidor sabe melhor.
//   • Senão, backoff EXPONENCIAL a partir de `baseMs` (1s, 2s, 4s, …) com TETO.
//   • Jitter LEVE (multiplicativo) p/ não sincronizar N clientes no mesmo instante.
//   • BOUNDED: o nº de tentativas é teto NOMEADO no controller — aqui só o atraso.

/** Config da política de backoff (injetável p/ teste determinístico). */
export interface BackoffPolicy {
  /** Base do exponencial (1ª espera sem `Retry-After`). Default 1000ms. */
  readonly baseMs: number;
  /** Teto duro do atraso (evita esperas absurdas num `Retry-After` hostil). */
  readonly maxMs: number;
  /**
   * Fração de jitter MULTIPLICATIVO (0..1): o atraso final é
   * `base * (1 + (rand()*2-1) * jitter)`. Default 0.1 (±10%). `0` ⇒ sem jitter
   * (determinístico). `rand` é injetável (teste fixa-o; produção usa Math.random).
   */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1000,
  maxMs: 30_000,
  jitter: 0.1,
};

/**
 * Calcula o atraso (ms) ANTES da tentativa `attempt` (1-based: `attempt=1` é a 1ª
 * RE-tentativa, após a falha inicial). Prioriza o `retryAfterSec` do broker; senão
 * exponencial `baseMs * 2^(attempt-1)`. Aplica jitter leve e respeita o teto `maxMs`.
 *
 * `rand` ∈ [0,1) — injetável p/ teste (default Math.random). O resultado nunca é
 * negativo nem ultrapassa `maxMs`.
 */
export function backoffDelayMs(
  attempt: number,
  retryAfterSec: number | undefined,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
  rand: () => number = Math.random,
): number {
  const safeAttempt = attempt < 1 ? 1 : attempt;
  // `Retry-After` do broker manda (em segundos → ms). Senão exponencial puro.
  const rawBase =
    retryAfterSec !== undefined && Number.isFinite(retryAfterSec) && retryAfterSec >= 0
      ? retryAfterSec * 1000
      : policy.baseMs * 2 ** (safeAttempt - 1);
  // HUNT-BROKER-RETRY — TETO **ANTES** do jitter (anti-thundering-herd no cap). O
  // código antigo jitterava o `rawBase` e SÓ DEPOIS clampava a `maxMs`: quando o
  // `rawBase` ≥ `maxMs` (Retry-After hostil/compartilhado, OU exponencial alto), o
  // `Math.min(…, maxMs)` COMIA o jitter ⇒ N sub-agentes com o MESMO `Retry-After`
  // (rate-limit de org compartilhado: o broker devolve o mesmo valor a todos)
  // acordavam no MESMÍSSIMO instante (`maxMs`), exatamente a sincronia que o jitter
  // existe p/ quebrar. Agora clampamos o BASE primeiro; o jitter incide sobre o base
  // já-limitado ⇒ o espalhamento sobrevive no teto (mantém o teto como ANCORA, não
  // como colapso). Mantém o `Retry-After` como piso de respeito ao servidor.
  const base = Math.min(rawBase, policy.maxMs);
  // Jitter multiplicativo leve, simétrico (±jitter). Pulado quando jitter=0. O jitter
  // incide sobre o `base` já-limitado ao teto. ABAIXO do teto (base < maxMs) o
  // espalhamento é simétrico `[base(1-j), base(1+j)]` (contrato preservado). NO teto
  // (base = maxMs) a metade superior bate no `Math.min(…, maxMs)` e desce ao teto,
  // mas a metade INFERIOR ainda espalha em `[maxMs(1-j), maxMs]` ⇒ N clientes com o
  // mesmo atraso de teto NÃO acordam mais no mesmíssimo instante (herd quebrado).
  const jittered = policy.jitter > 0 ? base * (1 + (rand() * 2 - 1) * policy.jitter) : base;
  const clamped = Math.min(Math.max(jittered, 0), policy.maxMs);
  return Math.round(clamped);
}

// F-RETRY — política PURA de retentativa da chamada de modelo.
//
// O BURACO que isto fecha (dogfood do Tiago: "quando o provider não responde ou nega a
// resposta, deveria ter uma retentativa"): a infraestrutura de retry SEMPRE existiu e
// NINGUÉM a executava. `errors.ts` já classifica `retryable` e parseia `Retry-After`; a
// `Idempotency-Key` nasce no loop JUSTAMENTE p/ que um retry de transporte reuse a MESMA
// key e o broker DEDUPLIQUE o billing. Mas cada camada delegava p/ a outra:
//   - `errors.ts`: "A decisão de retry/parada é do loop (EST-0944)";
//   - `loop.ts`:   "NÃO faz retry de rede aqui — o `ModelCaller` injetado é quem retenta".
// Resultado: um blip de rede matava o turno inteiro, com o trabalho já feito perdido.
//
// O QUE **NÃO** SE RETENTA (o ponto que importa): "o provider negou" NÃO é a mesma coisa
// que "o provider não respondeu". Chave inválida (401), modelo/baseURL errado (404),
// input inválido (400/422) e recusa de conteúdo são falhas DETERMINÍSTICAS — repetir 100×
// só atrasa o usuário e, no backend LOCAL/BYO (onde não há dedup de broker), pode QUEIMAR
// DINHEIRO a cada tentativa que de fato chega ao provider. Retentar só faz sentido no que
// é TRANSITÓRIO: rede/timeout (`BrokerTransportError`), 429 e 5xx.
//
// CANCELAMENTO NUNCA é retentado: `ModelCallAbortedError` é o Ctrl-C do usuário (ou um
// teto). Retentar aí seria ignorar uma ordem explícita do dono — o mesmo princípio do
// `awaitsUserDecision` no self-check.
//
// PURO (ADR-0053 §8): só decide `{retry, waitMs}` a partir do erro e do número da
// tentativa. Não dorme, não faz I/O, não chama modelo. Quem dorme e re-chama é o
// `StreamingModelCaller` (@hiperplano/aluy-cli), que também emite o contador p/ a TUI.

import { BrokerError, BrokerTransportError, ModelCallAbortedError } from './errors.js';

/** Espera default entre tentativas (ms) — o "a cada 5 segundos" pedido pelo dono. */
export const DEFAULT_RETRY_WAIT_MS = 5_000;
/**
 * Tentativas EXTRAS default (além da primeira). 20 × 5s ≈ 100s de teimosia: cobre com
 * folga um restart de provider/gateway sem prender o usuário por 8 minutos. Sobe até
 * `MAX_RETRY_ATTEMPTS` por config/env p/ quem roda sessões longas desassistidas.
 */
export const DEFAULT_RETRY_ATTEMPTS = 20;
/** Teto duro do que se pode configurar (anti-runaway — CLI-SEC-8). */
export const MAX_RETRY_ATTEMPTS = 100;
/** Teto duro da espera por tentativa (um `Retry-After` hostil não pendura a sessão). */
export const MAX_RETRY_WAIT_MS = 60_000;

/** Config RESOLVIDA de retry p/ uma sessão. `attempts:0` ⇒ DESLIGADO (baseline). */
export interface RetryConfig {
  /** Tentativas EXTRAS após a primeira. `0` ⇒ sem retry (comportamento antigo). */
  readonly attempts: number;
  /** Espera base entre tentativas, em ms. */
  readonly waitMs: number;
}

export const RETRY_OFF: RetryConfig = { attempts: 0, waitMs: DEFAULT_RETRY_WAIT_MS };

/** Veredito da política. `retry:false` ⇒ o erro SOBE (o loop/tetos decidem). */
export interface RetryVerdict {
  readonly retry: boolean;
  /** Quanto esperar antes da próxima tentativa (ms). Só vale com `retry:true`. */
  readonly waitMs: number;
  /** Motivo legível — vai p/ o contador na TUI e p/ auditoria. */
  readonly reason: string;
}

/**
 * `true` se o erro é TRANSITÓRIO (vale re-tentar a MESMA chamada). Espelha a
 * classificação que `errors.ts` já fazia e ninguém consumia.
 */
export function isTransient(err: unknown): boolean {
  // Cancelamento do usuário/teto: NUNCA. É ordem explícita, não falha.
  if (err instanceof ModelCallAbortedError) return false;
  // Transporte (DNS, conexão recusada, timeout, TLS, stream cortado): sempre transitório.
  if (err instanceof BrokerTransportError) return true;
  // HTTP: reusa o `retryable` do próprio erro (429 e 5xx por default; o corpo pode dizer).
  if (err instanceof BrokerError) return err.retryable;
  // AbortError cru (fetch abortado sem passar pelo nosso tipo) ⇒ não retenta.
  if (err instanceof Error && err.name === 'AbortError') return false;
  // Desconhecido: NÃO retenta. Fail-safe conservador — um erro que não sabemos
  // classificar pode ser determinístico (e caro) de repetir.
  return false;
}

/**
 * Decide se re-tenta e quanto esperar. `attempt` é 1-based e conta as tentativas JÁ
 * FEITAS (1 = a primeira falhou).
 *
 * A espera honra o `Retry-After` do provider quando ele manda (429 costuma mandar) —
 * ignorá-lo é receita p/ tomar ban. Clampada em `MAX_RETRY_WAIT_MS` p/ que um header
 * hostil (ou um `retry_after` absurdo) não prenda a sessão.
 */
export function decideRetry(err: unknown, attempt: number, cfg: RetryConfig): RetryVerdict {
  if (cfg.attempts <= 0) return { retry: false, waitMs: 0, reason: 'retry desligado' };
  if (!isTransient(err)) {
    return {
      retry: false,
      waitMs: 0,
      reason: err instanceof ModelCallAbortedError ? 'cancelado pelo usuário' : 'erro definitivo',
    };
  }
  if (attempt >= cfg.attempts) {
    return { retry: false, waitMs: 0, reason: `teto de ${cfg.attempts} tentativas atingido` };
  }
  // `Retry-After` (segundos) do provider vence a espera base.
  const after =
    err instanceof BrokerError && err.retryAfter !== undefined ? err.retryAfter * 1000 : undefined;
  const waitMs = Math.min(after ?? cfg.waitMs, MAX_RETRY_WAIT_MS);
  const why =
    err instanceof BrokerError
      ? `HTTP ${err.status}${after !== undefined ? ' (Retry-After)' : ''}`
      : 'falha de rede';
  return { retry: true, waitMs, reason: why };
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  const n = typeof v === 'string' ? Number.parseInt(v, 10) : typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  return Math.min(max, Math.max(min, n));
}

/**
 * Resolve a config a partir de env > config > default — a MESMA precedência dos outros
 * tunables (ADR-0150). `ALUY_RETRY=0`/`off` desliga; `ALUY_RETRY_WAIT_MS` ajusta a espera.
 * LIGADO por default: a alternativa (morrer no 1º blip) já se provou pior no uso real.
 */
export function resolveRetry(inputs: {
  readonly attemptsEnv?: string | undefined;
  readonly waitMsEnv?: string | undefined;
  readonly attemptsConfig?: number | undefined;
  readonly waitMsConfig?: number | undefined;
}): RetryConfig {
  const rawEnv = (inputs.attemptsEnv ?? '').trim().toLowerCase();
  if (rawEnv === 'off' || rawEnv === 'false' || rawEnv === '0') return RETRY_OFF;
  // `on`/`true`/`1` ⇒ liga no default recomendado (sem precisar escolher um número).
  if (rawEnv === 'on' || rawEnv === 'true' || rawEnv === '1') {
    return {
      attempts: DEFAULT_RETRY_ATTEMPTS,
      waitMs:
        clampInt(inputs.waitMsEnv, 100, MAX_RETRY_WAIT_MS) ??
        clampInt(inputs.waitMsConfig, 100, MAX_RETRY_WAIT_MS) ??
        DEFAULT_RETRY_WAIT_MS,
    };
  }
  // DEFAULT = **DESLIGADO**, deliberadamente. O invariante CA-5 do `streaming-caller`
  // ("erro estruturado SOBE, sem virar uma 2ª rota/retry") é documentado e TESTADO; e
  // ligar retry por default muda o comportamento de TODA sessão — decisão de produto,
  // que pela regra de ouro do specs quer ADR, não um default trocado de lado. A
  // capacidade fica pronta e a 1 env de distância (`ALUY_RETRY=on`), e o ADR decide se
  // o default vira ON.
  const attempts =
    clampInt(inputs.attemptsEnv, 0, MAX_RETRY_ATTEMPTS) ??
    clampInt(inputs.attemptsConfig, 0, MAX_RETRY_ATTEMPTS) ??
    0;
  const waitMs =
    clampInt(inputs.waitMsEnv, 100, MAX_RETRY_WAIT_MS) ??
    clampInt(inputs.waitMsConfig, 100, MAX_RETRY_WAIT_MS) ??
    DEFAULT_RETRY_WAIT_MS;
  return attempts <= 0 ? RETRY_OFF : { attempts, waitMs };
}

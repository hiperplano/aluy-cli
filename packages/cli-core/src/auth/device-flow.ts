// Máquina de polling do Device Authorization Flow (RFC 8628) — lado cliente.
//
// PORTÁVEL e TESTÁVEL: relógio e `sleep` são INJETADOS (sem timers reais nos
// testes). A apresentação do `user_code`/URL é um CALLBACK (`onPrompt`) — o core
// não escreve no terminal; quem renderiza é o @hiperplano/aluy-cli. Respeita `interval`,
// faz back-off no `slow_down` (+5s, RFC §3.5) e encerra em access_denied/
// expired_token. O sucesso devolve o par de tokens.

import { AccessDeniedError, DeviceCodeExpiredError, DeviceFlowError } from './errors.js';
import type { IdentityClient } from './identity-client.js';
import type { DeviceAuthorizeResponse, HeadlessScope, HeadlessTokenResponse } from './types.js';

/** Incremento de back-off no `slow_down` (RFC 8628 §3.5). */
const SLOW_DOWN_INCREMENT_SECONDS = 5;

/**
 * HUNT-IO-NET (boundary: o `interval` vem da rede e o `as DeviceAuthorizeResponse`
 * MENTE — é tipado `number` mas não é validado). RFC 8628 §3.5: o `interval` é
 * OPCIONAL; ausente ⇒ o cliente DEVE usar 5s. Um corpo malformado (campo ausente,
 * `null`, string, NaN) tornava `intervalSeconds = NaN` ⇒ `sleep(NaN*1000)` ⇒
 * `setTimeout(fn, NaN)` = 0 ⇒ POLLING EM LOOP QUENTE martelando o token endpoint
 * (DoS reflexo no identity + CPU spin). Saneamos: não-finito/≤0 ⇒ 5s; também
 * impomos um PISO de 1s (um `interval:0` legítimo viraria o mesmo hot-loop). */
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MIN_POLL_INTERVAL_SECONDS = 1;

/** Sanitiza um `interval`/`expires_in` da rede num nº de segundos ≥ piso. */
function safeIntervalSeconds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n < MIN_POLL_INTERVAL_SECONDS) return DEFAULT_POLL_INTERVAL_SECONDS;
  return n;
}

export interface DeviceFlowDeps {
  /** epoch ms — injetável p/ teste (default: Date.now). */
  readonly now?: () => number;
  /**
   * Espera `ms` — injetável p/ teste (default: setTimeout). ABORTÁVEL: recebe o
   * `signal` do login e resolve cedo no abort (Ctrl-C durante a espera do
   * intervalo de polling não fica preso 5-30s, espelha o `AbortableSleep` do
   * cycle-engine). O caller depois relê `signal.aborted` e encerra.
   */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Dados que o caller (TUI/CLI) precisa para instruir o usuário. */
export interface DevicePrompt {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresInSeconds: number;
}

export interface RunDeviceFlowArgs {
  readonly organizationId: string;
  readonly scopes?: readonly HeadlessScope[];
  /**
   * Chamado UMA vez, assim que o device_code é emitido: o caller mostra o
   * user_code + URL e (opcionalmente) abre o navegador. NÃO recebe nenhum
   * segredo — só o user_code (público por design) e a URL.
   */
  readonly onPrompt: (prompt: DevicePrompt) => void | Promise<void>;
  /** Sinal de cancelamento (ex.: Ctrl-C). */
  readonly signal?: AbortSignal;
}

/**
 * Sleep ABORTÁVEL (default): resolve após `ms` OU quando o `signal` aborta (o que
 * vier primeiro). Limpa o timer no abort (não vaza). Sem signal ⇒ espera pura.
 * Espelha o `defaultAbortableSleep` do cycle-engine (mesma mecânica parável).
 */
const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Roda o device-flow ponta a ponta: authorize → prompt → polling até o usuário
 * aprovar (sucesso) ou um estado terminal (negado/expirado). Devolve o par de
 * tokens em caso de sucesso; lança um erro tipado nos terminais.
 */
export async function runDeviceFlow(
  client: IdentityClient,
  args: RunDeviceFlowArgs,
  deps: DeviceFlowDeps = {},
): Promise<HeadlessTokenResponse> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  const authorize: DeviceAuthorizeResponse = await client.deviceAuthorize({
    organizationId: args.organizationId,
    ...(args.scopes ? { scopes: args.scopes } : {}),
  });

  await args.onPrompt({
    userCode: authorize.user_code,
    verificationUri: authorize.verification_uri,
    verificationUriComplete: authorize.verification_uri_complete,
    expiresInSeconds: authorize.expires_in,
  });

  // HUNT-IO-NET: `expires_in` também vem da rede (cast mentiroso). Um NaN/ausente
  // tornaria `deadline = NaN` ⇒ `now() >= NaN` é SEMPRE false ⇒ polling ETERNO sem
  // nunca expirar. Saneamos com o mesmo helper (piso de 1s; default 5s se torto) e,
  // se não houver expiração válida declarada, caímos num teto duro de 15min.
  const expiresInSeconds = Number.isFinite(authorize.expires_in) ? authorize.expires_in : 15 * 60;
  const deadline = now() + expiresInSeconds * 1000;
  // RFC 8628 §3.5: `interval` ausente ⇒ 5s. Boundary saneado (anti hot-loop).
  let intervalSeconds = safeIntervalSeconds(authorize.interval);

  for (;;) {
    if (args.signal?.aborted) {
      throw new DeviceFlowError('cancelled', 'login cancelado pelo usuário.');
    }
    if (now() >= deadline) {
      throw new DeviceCodeExpiredError();
    }

    // Espera ABORTÁVEL: Ctrl-C durante o intervalo (5-30s) encerra cedo — o
    // re-check de `signal.aborted` no topo do loop então lança 'cancelled'.
    await sleep(intervalSeconds * 1000, args.signal);
    if (args.signal?.aborted) {
      throw new DeviceFlowError('cancelled', 'login cancelado pelo usuário.');
    }

    const result = await client.pollToken(
      authorize.device_code,
      ...(args.signal ? ([args.signal] as const) : ([] as const)),
    );
    switch (result.status) {
      case 'success':
        return result.tokens;
      case 'pending':
        continue;
      case 'slow_down':
        // RFC 8628 §3.5: aumenta o intervalo e segue.
        intervalSeconds += SLOW_DOWN_INCREMENT_SECONDS;
        continue;
      case 'denied':
        throw new AccessDeniedError();
      case 'expired':
        throw new DeviceCodeExpiredError();
      case 'error':
        throw new DeviceFlowError(result.code, result.description);
    }
  }
}

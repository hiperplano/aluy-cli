// Config do cliente de modelo (lado @hiperplano/aluy-cli) — EST-0943.
//
// Lê o `ALUY_BROKER_URL` do ambiente (`.env.example`), com default seguro p/
// dev. NADA de segredo aqui — só o endpoint do broker (o modelo é chamado SEMPRE
// por ele; CLI-SEC-7). A credencial vem do keychain (EST-0942), nunca de env.
//
// Espelha `auth/config.ts`: a resolução env→config mora no @hiperplano/aluy-cli (que toca
// `process.env`), não no core PORTÁVEL (ADR-0053 §8). O core recebe a base-URL
// já resolvida.

export interface BrokerConfig {
  /** Base URL do aluy-broker, ex. `https://broker.dev.aluy.example` (sem `/v1`). */
  readonly brokerBaseUrl: string;
}

// Default de DEV (paridade com `.env.example`). Em prod/staging vem do env. É um
// PLACEHOLDER (host `*.aluy.example` não resolve) — o `/doctor` o detecta p/ dizer
// "ALUY_BROKER_URL não configurado" em vez de "o broker pode estar fora" (EST-1015).
export const DEFAULT_BROKER_BASE_URL = 'https://broker.dev.aluy.example';

/**
 * Resolve a config do broker a partir do ambiente. `ALUY_BROKER_URL` aponta p/
 * dev/staging/prod. Sem segredo: o modelo NUNCA carrega chave de provider — só o
 * endpoint do broker (CLI-SEC-7).
 */
export function loadBrokerConfig(env: NodeJS.ProcessEnv = process.env): BrokerConfig {
  const base = (env.ALUY_BROKER_URL ?? DEFAULT_BROKER_BASE_URL).replace(/\/+$/, '');
  return { brokerBaseUrl: base };
}

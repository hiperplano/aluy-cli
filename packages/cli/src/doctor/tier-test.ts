// EST-0970 (--deep / opt-in que GASTA modelo) — TESTE REAL do tier ao vivo: manda 1
// token mínimo ao modelo, pelo broker, p/ PROVAR que o tier corrente RESPONDE. É a ÚNICA
// parte do `/doctor` que gasta modelo — por isso SÓ roda sob `--deep`/`--test` (o caller
// só injeta este `tierTester` quando o usuário pediu). Sem `--deep`, o doctor valida a
// auth via GET (não via chat) e NUNCA chama o modelo.
//
// Constrói um `BrokerModelCaller` mínimo e DEDICADO (sessão própria, sem tools, prompt
// curtíssimo, max_tokens baixo) — não toca a sessão do agente. Erro (broker fora / sem
// crédito / provedor) ⇒ `responded:false` com a causa; nunca lança. PORTÁVEL nos limites
// do `@aluy/cli` (usa o login + broker config da máquina; fetch injetável p/ teste).

import {
  BrokerModelCaller,
  createBrokerModelClient,
  type LoginService,
  type StreamFetch,
} from '@aluy/cli-core';
import { loadBrokerConfig } from '../model/config.js';
import type { TierFact } from './checks.js';

/** Prompt MÍNIMO: pede 1 token só (`ok`) p/ a chamada ser a mais barata possível. */
const TINY_PROMPT = 'Responda apenas com a palavra "ok".';
/** Teto baixíssimo de saída — o teste prova que RESPONDE, não precisa de conteúdo. */
const TINY_MAX_TOKENS = 8;

export interface TierTestDeps {
  /** Tier corrente da sessão (o que será testado). */
  readonly tier: string;
  /** Via Custom (slug), quando `tier === 'custom'`. */
  readonly model?: string;
  /** Login da sessão — MESMA credencial do chat (token p/ o broker). */
  readonly login: LoginService;
  readonly env?: NodeJS.ProcessEnv;
  /** `fetch` injetável p/ teste (sem broker real). */
  readonly fetch?: StreamFetch;
  /** Timeout do teste (ms). Default 20s — o tier pode demorar a 1ª resposta. */
  readonly timeoutMs?: number;
}

/**
 * Faz UMA chamada mínima ao modelo do tier corrente e devolve se RESPONDEU. `responded:
 * true` ⇒ o tier está VIVO; `false` (+ `error`) ⇒ broker fora / sem crédito / provedor.
 * NUNCA lança. Gasta 1 chamada mínima — só chamado sob `--deep` (opt-in).
 */
export async function testTierLive(deps: TierTestDeps): Promise<TierFact> {
  const env = deps.env ?? process.env;
  const { brokerBaseUrl } = loadBrokerConfig(env);
  const client = createBrokerModelClient({
    brokerBaseUrl,
    login: deps.login,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const caller = new BrokerModelCaller({
    client,
    tier: deps.tier,
    ...(deps.tier === 'custom' && deps.model !== undefined ? { model: deps.model } : {}),
    maxTokens: TINY_MAX_TOKENS,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 20_000);
  try {
    const res = await caller.call({
      messages: [{ role: 'user', content: TINY_PROMPT }],
      idempotencyKey: `doctor-deep-${Date.now()}`,
      signal: controller.signal,
    });
    // Respondeu (qualquer finish_reason que produza um turno): o tier está vivo.
    const ok = typeof res.content === 'string';
    return ok
      ? { tier: deps.tier, responded: true }
      : { tier: deps.tier, responded: false, error: 'resposta vazia do broker' };
  } catch (err) {
    return { tier: deps.tier, responded: false, error: errMsg(err) };
  } finally {
    clearTimeout(timer);
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

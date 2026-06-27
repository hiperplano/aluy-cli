// F90 — WARM-UP dos sidecars logo após o boot.
//
// A 1ª chamada REAL de cada sidecar é COLD: o modelo/embedder carrega na memória e leva
// MUITO mais que as chamadas quentes. Medido ao vivo: o judge `qwen2.5:0.5b` leva ~9.5s
// COLD vs ~0.5-1s WARM; o 1º recall do mem0 também estoura por causa do embedder+chromadb
// frios. O loop corta recall/judge em 2.5s (F78) ⇒ a chamada COLD TIMEOUT ⇒ fail-open ⇒ a
// feature NÃO entrega na 1ª vez (e a cada vez após o keep_alive do ollama, ~5min idle,
// descarregar o modelo). Resultado prático: o judge/recall quase nunca entregam.
//
// O fix: mandar 1 query DUMMY a cada sidecar que subiu, logo após o boot, p/ aquecer ANTES
// da 1ª consulta real. Fire-and-forget, fail-safe (NUNCA lança, NUNCA bloqueia o boot). Sem
// teto de UX aqui (é background) — só um teto-teto generoso anti-pendura.

import { JUDGE_MODEL } from '@hiperplano/aluy-cli-core';
import { resolveMem0Url, resolveOllamaUrl } from './sidecar-urls.js';

export type WarmTarget = 'mem0' | 'ollama';

/** Teto-teto generoso por warm-up (o cold é lento; só evita pendurar pra sempre). */
const WARMUP_TIMEOUT_MS = 30_000;

/**
 * Aquece os sidecars dados (mem0/ollama) com 1 query dummy cada. `await`-ável p/ teste,
 * mas o caller (boot-trigger) o dispara fire-and-forget. NUNCA rejeita.
 */
export async function warmupSidecars(opts?: {
  readonly targets?: ReadonlySet<WarmTarget>;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<void> {
  const targets = opts?.targets ?? new Set<WarmTarget>(['mem0', 'ollama']);
  const env = opts?.env ?? process.env;
  const fetchFn = opts?.fetchFn ?? (globalThis.fetch as typeof fetch);
  const timeoutMs = opts?.timeoutMs ?? WARMUP_TIMEOUT_MS;

  const ping = (url: string, init?: RequestInit): Promise<void> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    return fetchFn(url, { ...init, signal: ac.signal })
      .then(() => undefined)
      .catch(() => undefined) // fail-safe: warm-up nunca importa o desfecho.
      .finally(() => clearTimeout(timer));
  };

  const jobs: Promise<void>[] = [];

  if (targets.has('mem0')) {
    // search dummy: carrega o embedder + chromadb (a parte cara do 1º recall).
    const base = resolveMem0Url(env).replace(/\/$/, '');
    jobs.push(ping(`${base}/v1/memories/?user_id=__aluy_warmup__&query=warmup&limit=1`));
  }

  if (targets.has('ollama')) {
    // generate dummy com o JUDGE_MODEL: carrega o qwen-0.5b na memória (o ~9.5s cold).
    const base = resolveOllamaUrl(env).replace(/\/$/, '');
    jobs.push(
      ping(`${base}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `keep_alive` longo PINA o qwen na memória do ollama: sem isto, uma recall do
        // mem0 (que carrega o embedder no MESMO ollama) DESPEJA o qwen ⇒ o judge esfria
        // de novo. Pinado, o judge fica quente entre consultas (o qwen-0.5b é pequeno).
        body: JSON.stringify({
          model: JUDGE_MODEL,
          prompt: 'ok',
          stream: false,
          keep_alive: '30m',
          options: { num_predict: 1 },
        }),
      }),
    );
  }

  await Promise.allSettled(jobs);
}

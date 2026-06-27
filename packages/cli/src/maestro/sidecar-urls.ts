// FONTE ÚNICA das URLs dos sidecars — ENV-CONFIGURÁVEIS (paridade com
// `ALUY_BROKER_URL`/`ALUY_HEADROOM_URL`, que já eram do env). Antes a URL do Mem0 e do
// Ollama estava HARDCODADA (literais `http://127.0.0.1:11435`/`:11434`) ESPALHADA pelo
// engine + wiring + doctor — feio e não-configurável (não dava p/ apontar o sidecar p/
// outra porta/host, nem isolá-lo em teste sem desligar). Aqui resolvemos cada uma de
// `ALUY_<X>_URL`, default no loopback da porta canônica (consts do cli-core). PURO.
//
// Headroom mantém o gate OFF-by-default no ENGINE (`headroomUrlFromEnv` → undefined
// quando ausente); `resolveHeadroomProbeUrl` aqui é só o ALVO de PROBE do doctor
// (default mesmo quando a feature está off — p/ reportar se o sidecar está no ar).

import { MEM0_PORT, HEADROOM_PORT, OLLAMA_BASE_URL } from '@hiperplano/aluy-cli-core';

type Env = Record<string, string | undefined> | undefined;

function fromEnv(env: Env, key: string, def: string): string {
  const u = (env ?? process.env)[key]?.trim();
  return u !== undefined && u !== '' ? u : def;
}

/** URL do sidecar Mem0 — `ALUY_MEM0_URL` ?? `http://127.0.0.1:${MEM0_PORT}`. */
export function resolveMem0Url(env?: Env): string {
  return fromEnv(env, 'ALUY_MEM0_URL', `http://127.0.0.1:${MEM0_PORT}`);
}

/** URL do sidecar Ollama (judge) — `ALUY_OLLAMA_URL` ?? `OLLAMA_BASE_URL` (cli-core). */
export function resolveOllamaUrl(env?: Env): string {
  return fromEnv(env, 'ALUY_OLLAMA_URL', OLLAMA_BASE_URL);
}

/** ALVO de PROBE do headroom (doctor) — `ALUY_HEADROOM_URL` ?? `http://127.0.0.1:${HEADROOM_PORT}`. */
export function resolveHeadroomProbeUrl(env?: Env): string {
  return fromEnv(env, 'ALUY_HEADROOM_URL', `http://127.0.0.1:${HEADROOM_PORT}`);
}

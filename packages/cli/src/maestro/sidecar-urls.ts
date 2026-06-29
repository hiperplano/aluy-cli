// FONTE ÚNICA das URLs dos sidecars — CONFIGURÁVEIS por env E pela seção `services` do
// config único (ADR-0136 EMENDA-1 §8/§9). Antes a URL do Mem0/Ollama estava HARDCODADA
// espalhada pelo engine + wiring + doctor; depois virou `ALUY_<X>_URL` (env). Agora a
// porta/host é PREFERÊNCIA REAL salvável (quem já roda Ollama em `:11500` grava no config
// em vez de reexportar env toda sessão).
//
// PRECEDÊNCIA (por sidecar): `ALUY_<X>_URL` (URL inteira, mais específica, já existia) >
// `ALUY_<X>_HOST`/`ALUY_<X>_PORT` (env) > `services.<x>.host/.port` (config único) >
// default (loopback + porta canônica do cli-core). PURO: env + services entram por
// parâmetro; o caller (cli) lê o config e injeta (ADR-0053 §8).
//
// Headroom mantém o gate OFF-by-default no ENGINE (`headroomUrlFromEnv` → undefined
// quando ausente); `resolveHeadroomProbeUrl` aqui é só o ALVO de PROBE do doctor.

import {
  MEM0_PORT,
  HEADROOM_PORT,
  OLLAMA_PORT,
  OLLAMA_LOOPBACK_HOST,
} from '@hiperplano/aluy-cli-core';
import type { UserServicesConfig, UserServiceEndpoint } from '../io/user-config.js';

type Env = Record<string, string | undefined> | undefined;

/** Resolve a URL de um sidecar pela precedência URL-env > HOST/PORT-env > services > default. */
function resolveSidecarUrl(opts: {
  readonly env: Env;
  readonly urlKey: string;
  readonly hostKey: string;
  readonly portKey: string;
  readonly cfg: UserServiceEndpoint | undefined;
  readonly defHost: string;
  readonly defPort: number;
}): string {
  const e = opts.env ?? process.env;
  // 1) URL inteira (env) vence tudo.
  const whole = e[opts.urlKey]?.trim();
  if (whole !== undefined && whole !== '') return whole;
  // 2) HOST: env > services > default.
  const host = e[opts.hostKey]?.trim() || opts.cfg?.host || opts.defHost;
  // 3) PORT: env (validada) > services > default.
  const portRaw = e[opts.portKey]?.trim();
  const portEnv = portRaw && /^\d+$/.test(portRaw) ? Number(portRaw) : undefined;
  const port =
    (portEnv !== undefined && portEnv >= 1 && portEnv <= 65535 ? portEnv : undefined) ??
    opts.cfg?.port ??
    opts.defPort;
  return `http://${host}:${port}`;
}

/** URL do sidecar Mem0. `ALUY_MEM0_URL` > `ALUY_MEM0_HOST`/`ALUY_MEM0_PORT` > services.mem0 > default. */
export function resolveMem0Url(env?: Env, services?: UserServicesConfig): string {
  return resolveSidecarUrl({
    env,
    urlKey: 'ALUY_MEM0_URL',
    hostKey: 'ALUY_MEM0_HOST',
    portKey: 'ALUY_MEM0_PORT',
    cfg: services?.mem0,
    defHost: OLLAMA_LOOPBACK_HOST,
    defPort: MEM0_PORT,
  });
}

/** URL do sidecar Ollama (judge). `ALUY_OLLAMA_URL` > `ALUY_OLLAMA_HOST`/`ALUY_OLLAMA_PORT` > services.ollama > default. */
export function resolveOllamaUrl(env?: Env, services?: UserServicesConfig): string {
  return resolveSidecarUrl({
    env,
    urlKey: 'ALUY_OLLAMA_URL',
    hostKey: 'ALUY_OLLAMA_HOST',
    portKey: 'ALUY_OLLAMA_PORT',
    cfg: services?.ollama,
    defHost: OLLAMA_LOOPBACK_HOST,
    defPort: OLLAMA_PORT,
  });
}

/** ALVO de PROBE do headroom (doctor). `ALUY_HEADROOM_URL` > `ALUY_HEADROOM_HOST`/`ALUY_HEADROOM_PORT` > services.headroom > default. */
export function resolveHeadroomProbeUrl(env?: Env, services?: UserServicesConfig): string {
  return resolveSidecarUrl({
    env,
    urlKey: 'ALUY_HEADROOM_URL',
    hostKey: 'ALUY_HEADROOM_HOST',
    portKey: 'ALUY_HEADROOM_PORT',
    cfg: services?.headroom,
    defHost: OLLAMA_LOOPBACK_HOST,
    defPort: HEADROOM_PORT,
  });
}

/**
 * URL EFETIVA do headroom p/ a SESSÃO (compress + retrieve), ou `undefined` (desligado).
 * CONFIG-DRIVEN — não mais env-only (achado do dono: o proxy subia mas nunca era consumido,
 * porque a ÚNICA chave de ativação era a env `ALUY_HEADROOM_URL`, que ninguém setava). Agora
 * liga pelo CONFIG: `profile:turbo` + `sidecarToggles.headroom` (default on) OU `services.headroom`
 * no `~/.aluy/config.json`. A env `ALUY_HEADROOM_URL` vira OVERRIDE explícito; `ALUY_HEADROOM_OFF`
 * é o kill-switch. Precedência: off-switch > env-url > config (turbo/toggle/services) > desligado.
 */
export function resolveHeadroomUrl(opts: {
  readonly env?: Env;
  readonly profile?: 'turbo' | 'leve';
  /** `config.sidecarToggles.headroom` (default ON quando turbo). */
  readonly headroomToggle?: boolean;
  readonly services?: UserServicesConfig;
}): string | undefined {
  const env = opts.env ?? {};
  const off = (env['ALUY_HEADROOM_OFF'] ?? '').trim().toLowerCase();
  if (off === '1' || off === 'true' || off === 'on') return undefined; // kill-switch
  const explicit = (env['ALUY_HEADROOM_URL'] ?? '').trim();
  if (explicit !== '') return resolveHeadroomProbeUrl(opts.env, opts.services); // override por env
  const turboOn = opts.profile === 'turbo' && opts.headroomToggle !== false;
  const servicesSet = opts.services?.headroom !== undefined;
  if (turboOn || servicesSet) return resolveHeadroomProbeUrl(opts.env, opts.services);
  return undefined; // sem turbo/toggle/services/env ⇒ desligado
}

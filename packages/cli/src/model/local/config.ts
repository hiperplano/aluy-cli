// ADR-0120 / EST-1113 — resolução da config do BACKEND LOCAL (flag>env>config>default).
//
// Junta as fontes (flag de boot, env `ALUY_*`, `~/.aluy/config.json`) numa config
// efetiva do backend local. PORTÁVEL? Não — lê env/config; mora no @hiperplano/aluy-cli. A
// regra PURA de precedência do backend vem do core (`resolveBackend`).

import {
  resolveBackend,
  defaultLocalCatalog,
  findProvider,
  type ModelBackend,
  type LocalProviderKind,
  type LocalAuthKind,
  type LocalProviderCatalog,
} from '@hiperplano/aluy-cli-core';
import type { UserConfig } from '../../io/user-config.js';

/** Config efetiva do backend local (já resolvida). */
export interface ResolvedLocalConfig {
  readonly provider: LocalProviderKind;
  readonly model: string;
  readonly auth: LocalAuthKind;
  readonly baseUrl?: string;
}

/**
 * Provider default do backend local — a 1ª entrada (por ordem do catálogo: wave asc, id
 * asc) que tenha `wave:1`, ou a 1ª entrada. Hoje resolve para `anthropic` (não-regressão).
 * Deriva do catálogo (ADR-0118), não de uma constante hardcoded.
 */
function defaultProviderId(catalog: LocalProviderCatalog): LocalProviderKind {
  const first = catalog.entries.find((e) => e.wave === 1) ?? catalog.entries[0];
  return first?.id ?? 'anthropic';
}

/** As flags de boot que afetam o backend (subset). */
export interface BackendFlags {
  readonly backend?: string;
  readonly localProvider?: string;
  readonly localModel?: string;
  readonly localAuth?: string;
  readonly localBaseUrl?: string;
}

/** Resolve o BACKEND efetivo (flag > env > config > default broker). */
export function resolveModelBackend(args: {
  readonly flag?: string | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly config: UserConfig;
}): ModelBackend {
  return resolveBackend({
    flag: args.flag,
    env: args.env.ALUY_BACKEND,
    config: args.config.backend,
  });
}

/**
 * Normaliza um provider cru p/ um id VÁLIDO do catálogo (ADR-0118: aberto/config-driven),
 * ou `undefined`. Antes era um union fechado hardcoded; agora valida contra o catálogo
 * (default embutido + override do usuário) — adicionar um provider passou a ser DADO.
 */
function parseProvider(
  raw: string | undefined | null,
  catalog: LocalProviderCatalog,
): LocalProviderKind | undefined {
  if (raw === undefined || raw === null) return undefined;
  const entry = findProvider(catalog, raw);
  return entry?.id;
}

function parseAuth(raw: string | undefined | null): LocalAuthKind | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = raw.trim().toLowerCase();
  if (v === 'apikey' || v === 'oauth') return v;
  return undefined;
}

function nonEmpty(raw: string | undefined | null): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = raw.trim();
  return v !== '' ? v : undefined;
}

/**
 * Resolve a config do PROVIDER local (provider/model/auth/base_url), por precedência
 * flag > env > config > default. Só faz sentido sob `backend:'local'`.
 *
 * Env: `ALUY_LOCAL_PROVIDER`, `ALUY_LOCAL_MODEL`, `ALUY_LOCAL_AUTH`, `ALUY_LOCAL_BASE_URL`.
 */
export function resolveLocalProviderConfig(args: {
  readonly flags?: BackendFlags;
  readonly env: NodeJS.ProcessEnv;
  readonly config: UserConfig;
  /**
   * Catálogo de providers locais (ADR-0118). Injetável; default: o EMBUTIDO. O caller do
   * boot pode passar o catálogo já mesclado com `~/.aluy/providers.json` p/ que provider/
   * modelo default venham do override do usuário também. Aqui o default basta para a
   * resolução de precedência das fontes flag/env/config.
   */
  readonly catalog?: LocalProviderCatalog;
}): ResolvedLocalConfig {
  const flags = args.flags ?? {};
  const catalog = args.catalog ?? defaultLocalCatalog();
  const provider =
    parseProvider(flags.localProvider, catalog) ??
    parseProvider(args.env.ALUY_LOCAL_PROVIDER, catalog) ??
    parseProvider(args.config.localProvider, catalog) ??
    defaultProviderId(catalog);
  // Modelo default do provider VEM do catálogo (entrada por id); fallback genérico só se
  // o provider não estiver no catálogo (não deveria, pois `provider` já foi validado).
  const providerDefaultModel = findProvider(catalog, provider)?.defaultModel ?? provider;
  const model =
    nonEmpty(flags.localModel) ??
    nonEmpty(args.env.ALUY_LOCAL_MODEL) ??
    nonEmpty(args.config.localModel) ??
    providerDefaultModel;
  const auth =
    parseAuth(flags.localAuth) ??
    parseAuth(args.env.ALUY_LOCAL_AUTH) ??
    parseAuth(args.config.localAuth) ??
    'apikey';
  const baseUrl =
    nonEmpty(flags.localBaseUrl) ??
    nonEmpty(args.env.ALUY_LOCAL_BASE_URL) ??
    nonEmpty(args.config.localBaseUrl);
  return { provider, model, auth, ...(baseUrl !== undefined ? { baseUrl } : {}) };
}

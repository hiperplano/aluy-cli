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
  if (v === 'apikey' || v === 'oauth' || v === 'none') return v;
  return undefined;
}

/**
 * Auth DEFAULT do provider quando flag/env/config não fixam: provider KEYLESS no catálogo
 * (auth `['none']`, ex.: Ollama local) ⇒ `'none'` (sem credencial); senão `'apikey'`. Sem
 * isto o default era SEMPRE 'apikey' ⇒ o cliente exigia chave do Ollama (que não tem).
 */
function defaultAuthForProvider(provider: string, catalog: LocalProviderCatalog): LocalAuthKind {
  const modes = findProvider(catalog, provider)?.auth;
  if (modes !== undefined && modes.length > 0 && modes.every((m) => m === 'none')) return 'none';
  return 'apikey';
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
    defaultAuthForProvider(provider, catalog); // keyless (Ollama) ⇒ 'none', senão 'apikey'
  const baseUrl =
    nonEmpty(flags.localBaseUrl) ??
    nonEmpty(args.env.ALUY_LOCAL_BASE_URL) ??
    nonEmpty(args.config.localBaseUrl);
  return { provider, model, auth, ...(baseUrl !== undefined ? { baseUrl } : {}) };
}

/**
 * Uma fonte de ambiente que VENCEU um valor declarado em `~/.aluy/config.json`.
 *
 * `configValue` é o que o dono escreveu no arquivo; `envValue` é o que de fato vale.
 */
export interface LocalEnvOverride {
  readonly key: 'provider' | 'model' | 'auth' | 'baseUrl';
  readonly envVar: string;
  readonly envValue: string;
  readonly configValue: string;
}

/** Par (chave, env var, leitor do config) — a MESMA ordem de `resolveLocalProviderConfig`. */
const FONTES_ENV = [
  ['provider', 'ALUY_LOCAL_PROVIDER', (c: UserConfig) => c.localProvider, 'localProvider'],
  ['model', 'ALUY_LOCAL_MODEL', (c: UserConfig) => c.localModel, 'localModel'],
  ['auth', 'ALUY_LOCAL_AUTH', (c: UserConfig) => c.localAuth, 'localAuth'],
  ['baseUrl', 'ALUY_LOCAL_BASE_URL', (c: UserConfig) => c.localBaseUrl, 'localBaseUrl'],
] as const;

/**
 * As sobreposições de env sobre `config.json` — para que o boot possa DIZER que elas
 * existem, em vez de o dono descobrir pelo rodapé "errado".
 *
 * O defeito que isto fecha: `/provider` grava `tokenrouter` no `config.json`, o ambiente
 * traz `ALUY_LOCAL_PROVIDER=openai` de um perfil de shell esquecido, e a precedência
 * (flag>env>config) faz o env vencer — corretamente, mas EM SILÊNCIO. O dono vê o arquivo
 * dizendo uma coisa e o rodapé dizendo outra, e conclui que a gravação não persistiu.
 * Pior quando o par fica incoerente (provider de um, `baseUrl` de outro): vira 401 sem
 * explicação. Ver ADR-0120 §precedência.
 *
 * SÓ reporta quando o config DECLAROU algo e o valor efetivo é OUTRO. Config silencioso
 * não é sobreposição — é só a fonte disponível, e avisar ali seria ruído em toda sessão
 * de quem configura por ambiente de propósito (CI, container, `docker run -e`).
 *
 * Chave com FLAG explícita é omitida: sob `--local-provider` nem env nem config vencem, e
 * atribuir a discrepância ao ambiente mandaria o dono caçar a variável errada.
 *
 * PURO: (flags, env, config) → lista. Sem I/O, sem catálogo — comparação textual, porque
 * o que interessa é o que o dono ESCREVEU nos dois lugares, não o que cada um normaliza.
 */
export function detectLocalEnvOverrides(args: {
  readonly flags?: BackendFlags;
  readonly env: NodeJS.ProcessEnv;
  readonly config: UserConfig;
}): readonly LocalEnvOverride[] {
  const flags = args.flags ?? {};
  const daFlag: Record<LocalEnvOverride['key'], string | undefined> = {
    provider: flags.localProvider,
    model: flags.localModel,
    auth: flags.localAuth,
    baseUrl: flags.localBaseUrl,
  };
  const achados: LocalEnvOverride[] = [];
  for (const [key, envVar, ler] of FONTES_ENV) {
    if (nonEmpty(daFlag[key]) !== undefined) continue;
    const envValue = nonEmpty(args.env[envVar]);
    const configValue = nonEmpty(ler(args.config));
    if (envValue === undefined || configValue === undefined) continue;
    // Case-insensitive: `OpenAI` e `openai` resolvem para o mesmo provider, e apontar
    // isso como conflito seria alarme falso.
    if (envValue.toLowerCase() === configValue.toLowerCase()) continue;
    achados.push({ key, envVar, envValue, configValue });
  }
  return achados;
}

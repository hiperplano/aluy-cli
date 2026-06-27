// ADR-0118 / EST-1118 — LOAD do catálogo de providers LOCAIS do usuário
// (`~/.aluy/providers.json`) e merge com o default EMBUTIDO do core.
//
// É o LOCUS de I/O do catálogo (ADR-0053 §8): o `@hiperplano/aluy-cli-core` tem o DADO embutido +
// o merge/sanitize PUROS; AQUI lemos o disco (toca `node:fs`) e entregamos o catálogo
// EFETIVO já mesclado. Espelha o read-path FAIL-SAFE do `UserConfigStore` (EST-0969):
//   - arquivo ausente/ilegível/JSON inválido ⇒ AVISA (uma vez) e cai no default embutido,
//     NUNCA derruba (o backend local segue com o catálogo shipped);
//   - entrada individual inválida ⇒ descartada pelo `sanitizeUserEntries` (as demais valem).
//
// `~/.aluy/` é o kernel-de-cliente confinado — NUNCA canal do agente (a path-deny do core
// já nega read/grep/edit/run sobre `~/.aluy`). CLI-SEC-7: o catálogo só carrega
// nomes/slugs/base_url PÚBLICOS — a credencial fica no keychain/env por provider.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, renameSync } from 'node:fs';
import {
  buildLocalCatalog,
  defaultLocalCatalog,
  type LocalProviderCatalog,
  type WireFormat,
  type LocalAuthMode,
} from '@hiperplano/aluy-cli-core';
import { UserConfigStore, type UserProviderEntry } from './user-config.js';

/** Nome do arquivo de override do catálogo (dentro de `~/.aluy/`). */
export const PROVIDERS_FILENAME = 'providers.json';

/**
 * ADR-0136 (config único) — MIGRAÇÃO one-shot do legado `~/.aluy/providers.json` para a
 * seção `providers` do `~/.aluy/config.json`. Idempotente e FAIL-SAFE (nunca lança):
 *   - config já tem `providers` ⇒ no-op (já migrado).
 *   - providers.json ausente/ilegível/vazio ⇒ no-op.
 *   - providers.json com entradas ⇒ grava no config (via store, sanitizado) e RENOMEIA
 *     providers.json → providers.json.migrated (não apaga — rastro auditável).
 * Retorna a allowlist efetiva de entradas no config após a migração (ou as já lá).
 */
export function migrateLegacyProvidersJson(baseDir?: string): readonly UserProviderEntry[] {
  const store = new UserConfigStore(baseDir ? { baseDir } : {});
  const already = store.load().providers;
  if (already && already.length > 0) return already; // já migrado/preenchido
  const file = providersConfigPath(baseDir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return already ?? []; // sem legado a migrar
  }
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as Record<string, unknown>).providers)
      ? ((raw as Record<string, unknown>).providers as unknown[])
      : [];
  if (arr.length === 0) return already ?? [];
  // store.save sanitiza (descarta entradas malformadas); só as válidas sobrevivem.
  store.save({ providers: arr as readonly UserProviderEntry[] });
  try {
    renameSync(file, file + '.migrated'); // rastro: providers.json.migrated
  } catch {
    /* rename best-effort; o config já é a fonte de verdade de qualquer forma */
  }
  return store.load().providers ?? [];
}

export interface LoadProvidersOptions {
  /** Raiz do `~/.aluy/` (default: `<home>/.aluy`). Injetável p/ teste (tmpdir). */
  readonly baseDir?: string;
  /**
   * Sink de aviso (default: stderr). Chamado UMA vez quando o `providers.json` existe
   * mas é ilegível/JSON inválido — para o usuário saber que caiu no default embutido.
   * Ausência do arquivo (1ª execução) NÃO avisa (é o caso normal).
   */
  readonly warn?: (msg: string) => void;
}

/** O caminho do `~/.aluy/providers.json` (default ou sob `baseDir`). */
export function providersConfigPath(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.aluy'), PROVIDERS_FILENAME);
}

/**
 * Carrega o catálogo de providers LOCAIS EFETIVO: o default EMBUTIDO do core mesclado com
 * o override do usuário (`~/.aluy/providers.json`), quando presente e parseável.
 *
 * FAIL-SAFE: arquivo ausente ⇒ só o default (silencioso). Arquivo presente mas
 * ilegível/JSON inválido ⇒ default + 1 aviso. JSON válido ⇒ merge (entradas inválidas
 * descartadas pelo sanitize do core). NUNCA lança.
 */
export function loadLocalProviderCatalog(opts: LoadProvidersOptions = {}): LocalProviderCatalog {
  // ADR-0136 (config único): a fonte de verdade é o config.json. Migra o legado
  // providers.json (one-shot, fail-safe) e lê dali. Sem entradas ⇒ default embutido.
  const entries = migrateLegacyProvidersJson(opts.baseDir);
  if (entries.length === 0) return defaultLocalCatalog();
  // O core mescla com o embutido (sanitize descarta inválidas; o resto vale).
  return buildLocalCatalog(entries);
}

/** Entrada de override que o usuário/onboard registra (espelha `LocalProviderEntry` cru). */
export interface ProviderOverrideInput {
  readonly id: string;
  readonly label?: string;
  readonly wireFormat: WireFormat;
  readonly baseUrl: string;
  readonly auth?: readonly LocalAuthMode[];
  readonly defaultModel: string;
  readonly models?: readonly string[];
}

/**
 * ESCRITA do provider custom (merge por `id`, o novo SUBSTITUI). Usado pelo
 * `aluy onboard` (opção "custom OpenAI-compatível") e por `aluy provider add`.
 *
 * ADR-0136 (config único): grava na seção `providers` do `config.json` (via store,
 * sanitizado), NÃO mais em providers.json. Migra o legado antes (one-shot). Best-effort
 * na persistência (o store nunca derruba a sessão).
 */
export function addLocalProviderOverride(input: ProviderOverrideInput, baseDir?: string): void {
  const store = new UserConfigStore(baseDir ? { baseDir } : {});
  const existing = migrateLegacyProvidersJson(baseDir); // absorve legado + pega o atual
  const entry: UserProviderEntry = {
    id: input.id,
    label: input.label ?? input.id,
    wireFormat: input.wireFormat,
    baseUrl: input.baseUrl,
    auth: input.auth ?? ['apikey'],
    defaultModel: input.defaultModel,
    models: input.models ?? [input.defaultModel],
  };
  // merge por id: remove a entrada antiga de mesmo id, anexa a nova (a última vence).
  const kept = existing.filter((e) => e.id !== input.id);
  kept.push(entry);
  store.save({ providers: kept });
}

/** Remove um provider custom da seção `providers` do config (por `id`). No-op se ausente. */
export function removeLocalProviderOverride(id: string, baseDir?: string): void {
  const store = new UserConfigStore(baseDir ? { baseDir } : {});
  const existing = migrateLegacyProvidersJson(baseDir);
  const kept = existing.filter((e) => e.id !== id);
  if (kept.length === existing.length) return; // nada a remover
  store.save({ providers: kept });
}

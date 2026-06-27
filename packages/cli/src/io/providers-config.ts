// ADR-0118 / EST-1118 — LOAD do catálogo de providers LOCAIS do usuário
// (`~/.aluy/providers.json`) e merge com o default EMBUTIDO do core.
//
// É o LOCUS de I/O do catálogo (ADR-0053 §8): o `@aluy/cli-core` tem o DADO embutido +
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
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  buildLocalCatalog,
  defaultLocalCatalog,
  type LocalProviderCatalog,
  type WireFormat,
  type LocalAuthMode,
} from '@aluy/cli-core';

/** Nome do arquivo de override do catálogo (dentro de `~/.aluy/`). */
export const PROVIDERS_FILENAME = 'providers.json';

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
  const file = providersConfigPath(opts.baseDir);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    // ENOENT (sem override) e qualquer erro de leitura ⇒ default embutido, SILENCIOSO.
    return defaultLocalCatalog();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Arquivo existe mas é JSON inválido ⇒ AVISA e cai no default (fail-soft).
    warnOnce(opts, file, 'JSON inválido');
    return defaultLocalCatalog();
  }
  // JSON válido: o core mescla (sanitize descarta entradas inválidas; o resto vale).
  return buildLocalCatalog(parsed);
}

/** Emite o aviso de fallback (uma vez por chamada de load). NUNCA lança. */
function warnOnce(opts: LoadProvidersOptions, file: string, why: string): void {
  const sink = opts.warn ?? ((m: string) => process.stderr.write(m + '\n'));
  try {
    sink(`aviso: ${file} ${why} — usando o catálogo de providers embutido.`);
  } catch {
    /* aviso best-effort: nunca derruba */
  }
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
 * ESCRITA do `~/.aluy/providers.json` — registra/atualiza um provider custom (merge por
 * `id`, o novo SUBSTITUI). É o que faltava: até aqui o catálogo só LIA. Usado pelo
 * `aluy onboard` (opção "custom OpenAI-compatível") e por `aluy provider add`.
 *
 * FAIL-SOFT na leitura do existente (ausente/inválido ⇒ começa vazio); aceita tanto o
 * formato lista (`[...]`) quanto `{ providers: [...] }` e RE-ESCREVE como lista canônica.
 * Cria `~/.aluy/` se preciso. Lança só em erro REAL de escrita (disco/permissão).
 */
export function addLocalProviderOverride(input: ProviderOverrideInput, baseDir?: string): void {
  const file = providersConfigPath(baseDir);
  let existing: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed;
    else if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).providers)
    ) {
      existing = (parsed as Record<string, unknown>).providers as unknown[];
    }
  } catch {
    /* sem arquivo / JSON inválido ⇒ começa do zero (o onboard sobrescreve com algo válido) */
  }
  const entry = {
    id: input.id,
    label: input.label ?? input.id,
    wireFormat: input.wireFormat,
    baseUrl: input.baseUrl,
    auth: input.auth ?? ['apikey'],
    defaultModel: input.defaultModel,
    models: input.models ?? [input.defaultModel],
  };
  // merge por id: remove a entrada antiga de mesmo id, anexa a nova (a última vence).
  const kept = existing.filter(
    (e) => !(typeof e === 'object' && e !== null && (e as Record<string, unknown>).id === input.id),
  );
  kept.push(entry);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
}

/** Remove um provider custom do `providers.json` (por `id`). No-op se ausente. */
export function removeLocalProviderOverride(id: string, baseDir?: string): void {
  const file = providersConfigPath(baseDir);
  let existing: unknown[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) existing = parsed;
    else if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as Record<string, unknown>).providers)
    ) {
      existing = (parsed as Record<string, unknown>).providers as unknown[];
    }
  } catch {
    return; // nada a remover
  }
  const kept = existing.filter(
    (e) => !(typeof e === 'object' && e !== null && (e as Record<string, unknown>).id === id),
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(kept, null, 2) + '\n');
}

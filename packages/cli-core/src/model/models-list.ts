// EST-1116 · ADR-0120 · ADR-0076 · ADR-0030 §3 · CLI-SEC-7 — `aluy models` / `aluy
// providers`: o FORMATADOR PURO da listagem de providers/modelos disponíveis.
//
// Espelha o `buildAgentsNote`/`buildSkillsNote` (EST-0977/EST-1112): o builder NÃO
// faz I/O — recebe o DADO já carregado pelo locus (`@aluy/cli`) e estrutura as linhas.
// Duas SEÇÕES:
//   1. LOCAL (BYO): os providers/adapters do backend local (anthropic/openai/openrouter),
//      o modo de auth de cada e o modelo default — metadata PURA passada como DADO (o
//      core NÃO embute endpoint/SDK/chave; CLI-SEC-7/CA-3 — os defaults moram no `@aluy/cli`).
//   2. BROKER: os TIERS (com o principal resolvido), os PROVIDERS registrados e os MODELOS
//      custom, do catálogo VIVO. FAIL-SOFT: se o broker não respondeu, a seção vira um AVISO
//      ("broker indisponível — …") em vez de quebrar (espelha o `/doctor`).
//
// CLI-SEC-7: a saída só carrega NOMES/SLUGS PÚBLICOS. Os tipos do broker
// (`TierCatalogEntry`/`ProviderInfo`/`CustomModel`) já são a projeção pública (os parsers
// descartam `api_key_ref`/`base_url`/markup na fronteira). A metadata LOCAL aqui também é
// só nome/auth/modelo-default — sem `base_url` cru (o locus passa só o que é público).
//
// PORTÁVEL (ADR-0053 §8): formatação de string PURA (sem `node:*`, sem I/O, sem rede).

import type { LocalProviderKind } from './local/types.js';
import type { LocalAuthMode } from './local/catalog.js';
import type { TierCatalogEntry } from './catalog-client.js';
import type { ProviderInfo } from './providers-client.js';
import type { CustomModel } from './custom-models-client.js';

/** Uma nota (título + linhas) — espelha o `SlashNote` do @aluy/cli, sem acoplar a ele. */
export interface ModelsListNote {
  readonly title: string;
  readonly lines: readonly string[];
}

/** Quais seções incluir — derivado do `--backend` (ausente ⇒ ambas). */
export type ModelsScope = 'local' | 'broker' | 'both';

/**
 * Metadata PÚBLICA de UM provider do backend local — montada pelo locus (`@aluy/cli`,
 * que detém os defaults). SÓ campos públicos (nome/auth/modelo-default + a indicação de
 * catálogo vivo); NUNCA `base_url`/chave (CLI-SEC-7). O builder só FORMATA isto.
 */
export interface LocalProviderListing {
  /** O provider (id do catálogo — `anthropic`/`openai`/`deepseek`/…; ADR-0118). */
  readonly provider: LocalProviderKind;
  /** Modos de auth que o provider aceita (api key / OAuth de assinatura / nenhum). */
  readonly authModes: readonly LocalAuthMode[];
  /** Modelo default do provider (id nativo, ex.: `claude-opus-4-8`) — DICA. */
  readonly defaultModel: string;
  /**
   * Pista de descoberta de modelos: alguns providers têm centenas (OpenRouter) ⇒ em
   * vez de chumbar a lista, o locus passa uma nota apontando pro catálogo VIVO do
   * provider. Ausente ⇒ o builder só mostra o modelo default. NUNCA uma URL secreta —
   * é o catálogo PÚBLICO do provider (display).
   */
  readonly catalogHint?: string;
}

/** Resultado FAIL-SOFT de uma fonte do broker: ou os dados, ou o motivo da ausência. */
export type BrokerSource<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly reason: string };

/** O DADO do broker (catálogo VIVO) — cada fonte é fail-soft (broker fora ⇒ `ok:false`). */
export interface BrokerListing {
  /** `GET /v1/tiers/catalog` — os tiers com a composição (principal resolvido). */
  readonly tiers: BrokerSource<readonly TierCatalogEntry[]>;
  /** `GET /v1/providers` — os providers registrados no broker. */
  readonly providers: BrokerSource<readonly ProviderInfo[]>;
  /** `GET /v1/models/custom` — os modelos custom (lista plana por slug). */
  readonly custom: BrokerSource<readonly CustomModel[]>;
}

/** O DADO já carregado pelo locus — entra inteiro no builder. */
export interface ModelsListInput {
  /** Quais seções formatar. */
  readonly scope: ModelsScope;
  /** Backend ATIVO resolvido (p/ a nota "ativo: …"). `undefined` ⇒ default broker. */
  readonly activeBackend?: 'local' | 'broker';
  /** Metadata pública dos providers locais (montada pelo locus). */
  readonly local: readonly LocalProviderListing[];
  /** O catálogo VIVO do broker (cada fonte fail-soft). `undefined` quando scope=`local`. */
  readonly broker?: BrokerListing;
  /**
   * Foco da listagem: `models` (default) mostra tudo (tiers/providers/modelos custom);
   * `providers` foca nos PROVIDERS (omite o detalhe dos modelos custom, que é model-
   * cêntrico). Só muda a ÊNFASE — o DADO/segurança é o mesmo.
   */
  readonly view?: 'models' | 'providers';
}

/** Teto de modelos custom listados em detalhe (o resto vira "+N mais"). */
const MAX_CUSTOM_DETAIL = 12;

/** Rótulo legível do modo de auth (sem jargão de header). PURO. */
function authLabel(modes: readonly LocalAuthMode[]): string {
  const parts: string[] = [];
  if (modes.includes('apikey')) parts.push('API key');
  if (modes.includes('oauth')) parts.push('OAuth (assinatura)');
  if (modes.includes('none')) parts.push('sem credencial');
  return parts.length > 0 ? parts.join(' ou ') : 'API key';
}

/** Sinal de custo humanizado (relativo — Princípio Q, nunca cents). PURO. */
function costLabel(signal: string): string {
  if (signal === 'economical') return 'econômico';
  if (signal === 'premium') return 'premium';
  if (signal === 'standard') return 'padrão';
  return signal; // valor desconhecido do broker ⇒ ecoa cru (DADO_NÃO_CONFIÁVEL, mas público)
}

/** O modelo PRINCIPAL de um tier (posição 0 / `role:principal`), p/ o resumo. PURO. */
function principalOf(entry: TierCatalogEntry): string {
  const principal = entry.composition.find((m) => m.role === 'principal') ?? entry.composition[0];
  if (principal === undefined) return '(sem composição)';
  const ctx = principal.context !== '' ? ` · ${principal.context}` : '';
  return `${principal.name}${ctx}`;
}

/** FORMATA a seção LOCAL (BYO). Sempre disponível (não toca a rede). PURO. */
function localLines(local: readonly LocalProviderListing[]): string[] {
  const lines: string[] = [];
  lines.push('backend LOCAL (BYO) — provider DIRETO com a SUA credencial (`--backend local`):');
  if (local.length === 0) {
    lines.push('  (nenhum provider local conhecido)');
    return lines;
  }
  // Ordem determinística por nome do provider.
  const sorted = [...local].sort((a, b) => a.provider.localeCompare(b.provider));
  for (const p of sorted) {
    lines.push(`  ${p.provider} · auth: ${authLabel(p.authModes)}`);
    lines.push(`      modelo default: ${p.defaultModel}`);
    if (p.catalogHint !== undefined && p.catalogHint.trim() !== '') {
      lines.push(`      modelos: ${p.catalogHint}`);
    }
  }
  lines.push('  credencial: `aluy login --provider <p>` (keychain) ou a env do provider.');
  return lines;
}

/** FORMATA a seção BROKER (catálogo VIVO), FAIL-SOFT por fonte. PURO. */
function brokerLines(broker: BrokerListing, view: 'models' | 'providers'): string[] {
  const lines: string[] = [];
  lines.push('backend BROKER — tiers/providers/modelos do catálogo do aluy-broker (default):');

  // TIERS (a fonte primária do seletor `/model`).
  if (broker.tiers.ok) {
    const tiers = [...broker.tiers.data].sort((a, b) => a.key.localeCompare(b.key));
    if (tiers.length === 0) {
      lines.push('  tiers: (catálogo vazio)');
    } else {
      lines.push(`  tiers (${tiers.length}):`);
      for (const t of tiers) {
        lines.push(`    ${t.key} · ${t.displayName} · ${costLabel(t.costSignal)}`);
        lines.push(`        principal: ${principalOf(t)}`);
      }
    }
  } else {
    lines.push(`  tiers: indisponível — ${broker.tiers.reason}`);
  }

  // PROVIDERS registrados (par da via Custom).
  if (broker.providers.ok) {
    const provs = [...broker.providers.data].sort((a, b) => a.name.localeCompare(b.name));
    if (provs.length === 0) {
      lines.push('  providers: (nenhum registrado)');
    } else {
      const label = provs
        .map((p) => (p.adapter !== '' ? `${p.name} (${p.adapter})` : p.name))
        .join(', ');
      lines.push(`  providers (${provs.length}): ${label}`);
    }
  } else {
    lines.push(`  providers: indisponível — ${broker.providers.reason}`);
  }

  // MODELOS custom (lista plana por slug — resumida). Omitido na visão `providers`
  // (model-cêntrico; lá o foco é o conjunto de providers, não cada modelo).
  if (view === 'providers') return lines;
  if (broker.custom.ok) {
    const custom = [...broker.custom.data].sort((a, b) => a.id.localeCompare(b.id));
    if (custom.length === 0) {
      lines.push('  modelos custom: (nenhum)');
    } else {
      lines.push(`  modelos custom (${custom.length}) — use /model (modo Custom) p/ escolher:`);
      const shown = custom.slice(0, MAX_CUSTOM_DETAIL);
      for (const m of shown) {
        const fam = m.family !== '' ? ` · ${m.family}` : '';
        const ctx = m.context !== '' ? ` · ${m.context}` : '';
        lines.push(`    ${m.id}${fam}${ctx}`);
      }
      const rest = custom.length - shown.length;
      if (rest > 0) lines.push(`    … +${rest} mais (veja todos no /model)`);
    }
  } else {
    lines.push(`  modelos custom: indisponível — ${broker.custom.reason}`);
  }

  return lines;
}

/**
 * FORMATA a nota completa de `aluy models`/`aluy providers`: a seção LOCAL (sempre que o
 * scope inclui local) e/ou a seção BROKER (fail-soft — broker fora ⇒ avisos, nunca
 * quebra). PURO/determinístico — o caller (shell) só imprime as linhas e sai com exit 0.
 */
export function buildModelsNote(input: ModelsListInput): ModelsListNote {
  const lines: string[] = [];
  const view = input.view ?? 'models';
  const wantLocal = input.scope === 'local' || input.scope === 'both';
  const wantBroker = input.scope === 'broker' || input.scope === 'both';

  if (input.activeBackend !== undefined) {
    lines.push(
      `backend ativo: ${input.activeBackend} (troque com \`--backend\` / \`ALUY_BACKEND\`).`,
    );
    lines.push('');
  }

  if (wantLocal) {
    lines.push(...localLines(input.local));
  }

  if (wantBroker) {
    // Separador entre seções: 1 linha em branco, sem duplicar (o cabeçalho "ativo:" já
    // empurrou uma quando não há seção local antes).
    if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
    if (input.broker !== undefined) {
      lines.push(...brokerLines(input.broker, view));
    } else {
      lines.push('backend BROKER — não consultado.');
    }
  }

  return { title: view, lines };
}

// Cliente do CATÁLOGO de tiers CLI→broker (EST-0962) — a fonte SANCIONADA dos
// nomes públicos de modelo por tier p/ o seletor `/model`.
//
// Fala SÓ com o `aluy-broker` (`GET /v1/tiers/catalog`, ADR-0030 §3 / `broker.md`
// §"GET /v1/tiers/catalog"), autenticado com a MESMA credencial headless de
// usuário do `BrokerModelClient` (Authorization: Bearer; o broker exige o scope
// `models.read`). Esse endpoint relaxa o HG-2 SÓ p/ os atributos PÚBLICOS
// (nome amigável + família + papel + contexto + sinal de custo RELATIVO) — NUNCA
// `provider`/`kind`/`api_key_ref`/`base_url`/credencial. A projeção pública é
// estrutural no broker (descarta os campos sensíveis na fronteira); aqui o cliente
// é SÓ leitor: lê os campos públicos e ignora qualquer extra (defesa em
// profundidade — não propaga nada que o broker não devesse mandar).
//
// PORTÁVEL (ADR-0053 §8): usa `fetch` injetável + provedor de token injetável
// (a LoginService.getAccessToken, EST-0942). Sem Ink/React, sem I/O de terminal.

import { BrokerError, BrokerTransportError, toProblemDetails } from './errors.js';
import type { AccessTokenProvider, StreamFetch, StreamResponse } from './broker-client.js';

const CATALOG_PATH = '/v1/tiers/catalog';

/** Papel de um modelo na cadeia de um tier (posição: 0 = principal, demais = reserva). */
export type ComposedRole = 'principal' | 'reserva' | (string & {});

/** Sinal de custo RELATIVO por tier (Princípio Q — NUNCA custo absoluto/cents). */
export type CostSignal = 'economical' | 'standard' | 'premium' | (string & {});

/**
 * Um modelo componente de um tier — superfície PÚBLICA (ADR-0030 §3). SÓ atributos
 * transparentes; nenhum campo de credencial/roteamento existe aqui (nem o broker
 * o serializa — HG-2/SEC-4).
 */
export interface ComposedModel {
  /** Nome amigável (ex.: `Claude 3.5 Sonnet`). */
  readonly name: string;
  /** Família/provedor de marca (ex.: `Anthropic`, `OpenAI`). */
  readonly family: string;
  /** `principal` (posição 0) ou `reserva` (fallback). */
  readonly role: ComposedRole;
  /** Janela de contexto humanizada (`128k`/`200k`/`1M`; `''` quando desconhecida). */
  readonly context: string;
}

/** Uma entrada do catálogo: o tier + nome de exibição + sinal de custo + composição. */
export interface TierCatalogEntry {
  /** Chave interna do tier (`aluy-*`) — a ÚNICA pista enviada na chamada de modelo. */
  readonly key: string;
  /** Nome de exibição do DADO (`Strata`/`Flux`/`Deep`…; sem prefixo "Aluy"). */
  readonly displayName: string;
  /** Sinal de custo RELATIVO do tier. */
  readonly costSignal: CostSignal;
  /** Modelos que formam o tier, na ordem da cadeia (principal primeiro). */
  readonly composition: readonly ComposedModel[];
}

export interface TierCatalogClientOptions {
  /** Base URL do broker — de `ALUY_BROKER_URL` (sem `/v1`; é acrescentado). */
  readonly baseUrl: string;
  /** Provedor da credencial headless (LoginService.getAccessToken) — MESMA do chat. */
  readonly getAccessToken: AccessTokenProvider;
  /** `fetch` injetável (default: global). */
  readonly fetch?: StreamFetch;
}

/**
 * Lê o catálogo de tiers do broker p/ o seletor `/model`. Em falha (broker fora,
 * sem scope, transporte) LANÇA `BrokerError`/`BrokerTransportError` — o chamador
 * (TUI) cai no FALLBACK de tiers conhecidos e mostra uma mensagem NEUTRA (HG-2:
 * nunca o provider/credencial; "broker", não "OpenAI").
 */
export class TierCatalogClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly doFetch: StreamFetch;

  constructor(opts: TierCatalogClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as StreamFetch);
  }

  /** Busca o catálogo. Devolve as entradas (já normalizadas/saneadas). */
  async list(): Promise<readonly TierCatalogEntry[]> {
    const token = await this.getAccessToken();
    let res: StreamResponse;
    try {
      res = await this.doFetch(`${this.baseUrl}${CATALOG_PATH}`, {
        method: 'GET',
        headers: {
          // ÚNICA credencial: a headless de USUÁRIO (device JWT ou PAT). O broker a
          // introspecta p/ checar o scope `models.read`. NUNCA logada (CLI-SEC-10).
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        // SEM `body` (EST-0962): GET com `body` (mesmo `''`) faz o fetch do Node
        // LANÇAR antes da rede. Omitido por completo.
      });
    } catch (err) {
      throw new BrokerTransportError('falha de transporte ao ler o catálogo do broker.', err);
    }

    if (!res.ok) {
      let parsed: unknown = undefined;
      try {
        parsed = await res.json();
      } catch {
        parsed = undefined;
      }
      throw new BrokerError(toProblemDetails(res.status, parsed));
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      throw new BrokerTransportError('catálogo do broker com corpo inválido.', err);
    }
    return parseCatalog(body);
  }
}

/**
 * Saneia o corpo `{ object, data:[...] }` do broker em entradas TIPADAS. O parser é
 * a guarda de defesa-em-profundidade do HG-2 no LADO CLIENTE: só copia os campos
 * PÚBLICOS conhecidos (`key`/`display_name`/`cost_signal`/`composition.{name,
 * family,role,context}`) e DESCARTA qualquer extra — se um broker comprometido
 * mandasse `provider`/`base_url`/`api_key_ref`, nada disso atravessa p/ a UI.
 */
export function parseCatalog(body: unknown): readonly TierCatalogEntry[] {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return [];
  const out: TierCatalogEntry[] = [];
  for (const raw of data) {
    if (!isRecord(raw)) continue;
    const key = str(raw, 'key');
    if (key === undefined || key === '') continue;
    out.push({
      key,
      displayName: str(raw, 'display_name') ?? key,
      costSignal: str(raw, 'cost_signal') ?? 'standard',
      composition: parseComposition(raw['composition']),
    });
  }
  return out;
}

function parseComposition(raw: unknown): readonly ComposedModel[] {
  if (!Array.isArray(raw)) return [];
  const out: ComposedModel[] = [];
  for (const link of raw) {
    if (!isRecord(link)) continue;
    const name = str(link, 'name');
    if (name === undefined || name === '') continue;
    out.push({
      name,
      family: str(link, 'family') ?? '',
      role: str(link, 'role') ?? 'principal',
      context: str(link, 'context') ?? '',
    });
  }
  return out;
}

// ── helpers de boundary (rede = unknown; narrowing sem `any`) ────────────────
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function str(v: Record<string, unknown>, key: string): string | undefined {
  const val = v[key];
  return typeof val === 'string' ? val : undefined;
}

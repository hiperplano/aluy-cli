// Cliente da LISTA DE PROVIDERS CADASTRADOS CLI→broker (EST-0962 · ADR-0076) — a fonte
// VIVA do seletor `/provider`. Em vez de chumbar `openrouter`/`deepseek` no binário, o
// CLI lê os NOMES dos providers que o broker REALMENTE tem cadastrados (par da via
// Custom: `/provider <name>` + `--model`).
//
// Fala SÓ com o `aluy-broker` (`GET /v1/providers`), autenticado com a MESMA credencial
// headless de usuário do `BrokerModelClient`/`CustomModelClient` (Authorization: Bearer;
// mesmo PAT/device-JWT do chat, escopo `llm:call`/`assistant:session` — sem reemitir
// nada). Mesmo HOST do broker (sem egress novo).
//
// Contrato (gate `require_catalog_read`, igual ao `/v1/models/custom`) — 200:
//   { "object":"list", "data":[ {"name","adapter"}, … ] }
// O `name` é o NOME canônico digitável em `/provider <name>` (o que se manda ao broker no
// par Custom); `adapter` é o adaptador (openrouter|deepseek|…), DICA de display. Ambos são
// DADO de catálogo público — HG-2/CLI-SEC-7: NUNCA `api_key_ref`/`base_url`/markup/credencial.
//
// O parser é tolerante (DADO_NÃO_CONFIÁVEL): entrada sem `name` ⇒ ignorada; `adapter`
// ausente ⇒ string vazia; campos EXTRA (se um broker comprometido mandasse `api_key_ref`)
// são DESCARTADOS por construção; NUNCA lança no parse.
//
// PORTÁVEL (ADR-0053 §8): `fetch` injetável + provedor de token injetável (a
// LoginService.getAccessToken, EST-0942). Sem Ink/React, sem I/O de terminal.

import { BrokerError, BrokerTransportError, toProblemDetails } from './errors.js';
import type { AccessTokenProvider, StreamFetch, StreamResponse } from './broker-client.js';

const PROVIDERS_PATH = '/v1/providers';

/**
 * Um provider cadastrado — superfície PÚBLICA p/ o seletor `/provider`. SÓ atributos
 * transparentes (nome canônico + adaptador); nenhum campo de credencial/roteamento entra
 * aqui (HG-2/CLI-SEC-7). O `name` é o que se ENVIA no par Custom; `adapter` é dica de display.
 */
export interface ProviderInfo {
  /** Nome canônico do provider — o valor que vai como `provider` no par Custom. */
  readonly name: string;
  /** Adaptador (ex.: `openrouter`, `deepseek`) — DICA de display. `''` quando ausente. */
  readonly adapter: string;
}

export interface ProvidersClientOptions {
  /** Base URL do broker — de `ALUY_BROKER_URL` (sem `/v1`; é acrescentado). */
  readonly baseUrl: string;
  /** Provedor da credencial headless (LoginService.getAccessToken) — MESMA do chat. */
  readonly getAccessToken: AccessTokenProvider;
  /** `fetch` injetável (default: global). */
  readonly fetch?: StreamFetch;
}

/**
 * Lê a lista de providers cadastrados do broker p/ o seletor `/provider`. Em falha
 * (broker fora, sem scope/401, transporte) LANÇA `BrokerError`/`BrokerTransportError` —
 * o chamador (TUI) DEGRADA p/ o catálogo estático conhecido (openrouter/deepseek) + nota,
 * NUNCA lista vazia silenciosa. Mensagem NEUTRA (HG-2: nunca o provider/credencial).
 */
export class ProvidersClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly doFetch: StreamFetch;

  constructor(opts: ProvidersClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as StreamFetch);
  }

  /** Busca a lista de providers. Devolve os providers (já normalizados/saneados). */
  async list(): Promise<readonly ProviderInfo[]> {
    const token = await this.getAccessToken();
    let res: StreamResponse;
    try {
      res = await this.doFetch(`${this.baseUrl}${PROVIDERS_PATH}`, {
        method: 'GET',
        headers: {
          // ÚNICA credencial: a headless de USUÁRIO (mesmo PAT/device-JWT do chat). O
          // broker a introspecta p/ o escopo. NUNCA logada (CLI-SEC-10).
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        // SEM `body` (GET com `body`, mesmo `''`, faz o fetch do Node LANÇAR antes da
        // rede — a pegadinha do #115/#123). Omitido por completo.
      });
    } catch (err) {
      throw new BrokerTransportError(
        'falha de transporte ao ler a lista de providers do broker.',
        err,
      );
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
      throw new BrokerTransportError('lista de providers do broker com corpo inválido.', err);
    }
    return parseProviders(body);
  }
}

/**
 * Saneia o corpo `{ object, data:[...] }` do broker em providers TIPADOS. Guarda de
 * defesa-em-profundidade do HG-2 no LADO CLIENTE: só copia os campos PÚBLICOS conhecidos
 * (`name`/`adapter`) e DESCARTA qualquer extra — se um broker comprometido mandasse
 * `api_key_ref`/`base_url`/markup, nada atravessa p/ a UI. TOLERANTE
 * (DADO_NÃO_CONFIÁVEL): entrada sem `name` ⇒ ignorada; `adapter` ausente ⇒ `''`; dedup
 * por `name`; NUNCA lança.
 */
export function parseProviders(body: unknown): readonly ProviderInfo[] {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return [];
  const out: ProviderInfo[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (!isRecord(raw)) continue;
    const name = str(raw, 'name');
    // `name` é o que se ENVIA no par Custom — sem ele a entrada é inútil; ignora.
    if (name === undefined || name === '') continue;
    if (seen.has(name)) continue; // dedup honesto (o broker pode repetir)
    seen.add(name);
    out.push({ name, adapter: str(raw, 'adapter') ?? '' });
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

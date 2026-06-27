// Cliente da LISTA DE MODELOS CUSTOM CLI→broker (EST-0962) — a fonte DEDICADA do
// modo Custom do `/model`. É o ENDEREÇO CERTO p/ o autocomplete texto-livre: a
// lista PLANA dos modelos que o usuário pode escolher pelo slug (ADR-0030 §3 /
// ADR-0065), NÃO a composição dos TIERS (essa continua no `TierCatalogClient`).
//
// Fala SÓ com o `aluy-broker` (`GET /v1/models/custom`), autenticado com a MESMA
// credencial headless de usuário do `BrokerModelClient`/`TierCatalogClient`
// (Authorization: Bearer; mesmo PAT/device-JWT do chat, escopo `llm:call`/
// `assistant:session` — sem reemitir nada). Mesmo HOST do broker (sem egress novo).
//
// Contrato (testado ao vivo) — 200:
//   { "object":"list", "data":[ {"id","name","family","context","supports_tools"}, … ] }
// O `id` é o SLUG que vai como `model` na chamada (`tier:custom`+`model:<id>`);
// `name`/`family`/`context` são SÓ display/dica. `supports_tools` (bool, EST-0996) diz
// se o modelo aceita ferramentas nativas — display/aviso, NÃO roteamento. O parser é
// tolerante (DADO_NÃO_CONFIÁVEL): entrada sem `id` ⇒ ignorada; `name`/`family`/`context`
// ausentes ⇒ string vazia; `supports_tools` ausente/não-bool ⇒ `undefined` (badge
// NEUTRO — não inventamos true/false); NUNCA lança no parse.
//
// PORTÁVEL (ADR-0053 §8): `fetch` injetável + provedor de token injetável (a
// LoginService.getAccessToken, EST-0942). Sem Ink/React, sem I/O de terminal.

import { BrokerError, BrokerTransportError, toProblemDetails } from './errors.js';
import type { AccessTokenProvider, StreamFetch, StreamResponse } from './broker-client.js';

const CUSTOM_MODELS_PATH = '/v1/models/custom';

/**
 * Um modelo Custom — superfície PÚBLICA p/ o seletor por slug. SÓ atributos
 * transparentes (slug + display); nenhum campo de credencial/roteamento entra aqui
 * (HG-2/SEC-4). O `id` é o que se ENVIA; `name`/`family` são dica de exibição.
 */
export interface CustomModel {
  /** Slug do modelo — o valor que vai como `model` na chamada (`tier:custom`). */
  readonly id: string;
  /** Nome amigável de exibição (ex.: `Jamba Large 1 7`). `''` quando ausente. */
  readonly name: string;
  /** Família/provedor de marca p/ a dica (ex.: `Ai21`, `Meta`). `''` quando ausente. */
  readonly family: string;
  /**
   * Janela de contexto p/ exibição (ex.: `128k`, `200k`). DICA, não roteamento.
   * `''` quando o broker não informa.
   */
  readonly context: string;
  /**
   * EST-0996 — o modelo suporta ferramentas/tools nativas? DISPLAY/AVISO apenas (o
   * roteamento é do broker). `undefined` quando o broker não informa ⇒ a UI mostra um
   * badge NEUTRO (não inventamos `true`/`false` — DADO_NÃO_CONFIÁVEL).
   */
  readonly supportsTools?: boolean;
}

export interface CustomModelClientOptions {
  /** Base URL do broker — de `ALUY_BROKER_URL` (sem `/v1`; é acrescentado). */
  readonly baseUrl: string;
  /** Provedor da credencial headless (LoginService.getAccessToken) — MESMA do chat. */
  readonly getAccessToken: AccessTokenProvider;
  /** `fetch` injetável (default: global). */
  readonly fetch?: StreamFetch;
}

/**
 * Lê a lista de modelos Custom do broker p/ o autocomplete do modo Custom. Em falha
 * (broker fora, sem scope/401, transporte) LANÇA `BrokerError`/`BrokerTransportError`
 * — o chamador (TUI) DEGRADA p/ texto-livre puro (sem sugestão/aviso), mensagem
 * NEUTRA (HG-2: nunca o provider/credencial; "broker", não "OpenRouter").
 */
export class CustomModelClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly doFetch: StreamFetch;

  constructor(opts: CustomModelClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as StreamFetch);
  }

  /** Busca a lista Custom. Devolve os modelos (já normalizados/saneados). */
  async list(): Promise<readonly CustomModel[]> {
    const token = await this.getAccessToken();
    let res: StreamResponse;
    try {
      res = await this.doFetch(`${this.baseUrl}${CUSTOM_MODELS_PATH}`, {
        method: 'GET',
        headers: {
          // ÚNICA credencial: a headless de USUÁRIO (mesmo PAT/device-JWT do chat). O
          // broker a introspecta p/ o escopo. NUNCA logada (CLI-SEC-10).
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        // SEM `body` (EST-0962): GET com `body` (mesmo `''`) faz o fetch do Node
        // LANÇAR antes da rede. Omitido por completo.
      });
    } catch (err) {
      throw new BrokerTransportError(
        'falha de transporte ao ler a lista de modelos custom do broker.',
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
      throw new BrokerTransportError('lista de modelos custom do broker com corpo inválido.', err);
    }
    return parseCustomModels(body);
  }
}

/**
 * Saneia o corpo `{ object, data:[...] }` do broker em modelos TIPADOS. Guarda de
 * defesa-em-profundidade do HG-2 no LADO CLIENTE: só copia os campos PÚBLICOS
 * conhecidos (`id`/`name`/`family`/`context`/`supports_tools`) e DESCARTA qualquer
 * extra — se um broker comprometido mandasse `api_key_ref`/`base_url`, nada atravessa
 * p/ a UI. TOLERANTE (DADO_NÃO_CONFIÁVEL): entrada sem `id` ⇒ ignorada;
 * `name`/`family`/`context` ausentes ⇒ `''`; `supports_tools` ausente/não-bool ⇒ campo
 * OMITIDO (badge neutro); NUNCA lança.
 */
export function parseCustomModels(body: unknown): readonly CustomModel[] {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!Array.isArray(data)) return [];
  const out: CustomModel[] = [];
  const seen = new Set<string>();
  for (const raw of data) {
    if (!isRecord(raw)) continue;
    const id = str(raw, 'id');
    // `id` é o slug que se ENVIA — sem ele a entrada é inútil p/ o picker; ignora.
    if (id === undefined || id === '') continue;
    if (seen.has(id)) continue; // dedup honesto (o broker pode repetir)
    seen.add(id);
    // `supports_tools` só atravessa se for um booleano DE VERDADE — qualquer outra
    // coisa (ausente, string, número) vira `undefined` (omitido) ⇒ badge neutro.
    const supportsTools = bool(raw, 'supports_tools');
    out.push({
      id,
      name: str(raw, 'name') ?? '',
      family: str(raw, 'family') ?? '',
      context: str(raw, 'context') ?? '',
      ...(supportsTools === undefined ? {} : { supportsTools }),
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
function bool(v: Record<string, unknown>, key: string): boolean | undefined {
  const val = v[key];
  return typeof val === 'boolean' ? val : undefined;
}

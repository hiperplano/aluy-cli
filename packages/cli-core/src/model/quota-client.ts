// EST-0948 · ADR-0069 — Cliente do `GET /v1/quota` CLI→broker (path B do ADR-0069):
// a QUOTA CORRENTE da PRÓPRIA conta do PAT — saldo de CRÉDITO (dimensão PRIMÁRIA) +
// janelas (5h/semana, quando o plano as tem). É o número AUTORITATIVO do broker p/ o
// footer (broker#59); o teto LOCAL `DEFAULT_MAX_TOKENS` é só o fail-safe anti-runaway,
// uma dimensão SEPARADA (§4 — NÃO é a quota de produto).
//
// Fala SÓ com o `aluy-broker` (`GET /v1/quota`), autenticado com a MESMA credencial
// headless de usuário do `BrokerModelClient` (Authorization: Bearer; o broker introspecta
// o PAT e DERIVA org+user — caminho headless). INVARIANTES (CLI-SEC-7 / HG-3): SÓ a
// PRÓPRIA conta (zero cross-user/cross-org — o broker crava por RLS); READ-ONLY; NUNCA
// expõe markup/ledger/credencial — só o consumo/limite/saldo do PRÓPRIO uso.
//
// ⚠ GET SEM BODY (EST-0962 / #123): o `fetch` REAL do Node LANÇA em GET com `body`
// (mesmo `''`). Este cliente OMITE `body` por completo (igual a `TierCatalogClient`); o
// fake de teste DEVE rejeitar `body` em GET (espelha a realidade — senão o teste mente).
//
// PORTÁVEL (ADR-0053 §8): `fetch` + provedor de token injetáveis. Sem Ink/React, sem I/O.

import { BrokerError, BrokerTransportError, toProblemDetails } from './errors.js';
import type { AccessTokenProvider, StreamFetch, StreamResponse } from './broker-client.js';
import { parseQuotaResponse, type Quota } from './quota.js';

const QUOTA_PATH = '/v1/quota';

export interface QuotaClientOptions {
  /** Base URL do broker — de `ALUY_BROKER_URL` (sem `/v1`; é acrescentado). */
  readonly baseUrl: string;
  /** Provedor da credencial headless (LoginService.getAccessToken) — MESMA do chat. */
  readonly getAccessToken: AccessTokenProvider;
  /** `fetch` injetável (default: global). */
  readonly fetch?: StreamFetch;
}

/**
 * Lê a quota corrente do `GET /v1/quota`. TOLERANTE a versões (ADR-0069 §5): campo a
 * mais do broker ⇒ ignorado; a menos ⇒ degrada (campo `undefined`). Em falha (broker
 * fora, sem auth, transporte) devolve `undefined` em vez de LANÇAR — o footer de quota
 * NÃO é crítico p/ o fluxo de trabalho: ausência ⇒ widget oculto (degrada, ADR-0069
 * §degradação: omite, não inventa). Distinto do `/v1/chat`, que LANÇA (o chat é crítico).
 */
export class QuotaClient {
  private readonly baseUrl: string;
  private readonly getAccessToken: AccessTokenProvider;
  private readonly doFetch: StreamFetch;

  constructor(opts: QuotaClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.getAccessToken = opts.getAccessToken;
    this.doFetch = opts.fetch ?? (globalThis.fetch as unknown as StreamFetch);
  }

  /**
   * Busca a quota da PRÓPRIA conta. Devolve o `Quota` parseado (janelas + crédito) ou
   * `undefined` quando não dá p/ ler (broker fora / não-2xx / corpo inválido) ⇒ o
   * chamador mantém o footer oculto/o último valor. NUNCA LANÇA (footer não-crítico).
   *
   * O estado dev real (`{windows:[], credit:{balance:null}}`) parseia p/ `{windows:{}}`
   * (sem crédito) ⇒ `formatQuota` ⇒ `undefined` ⇒ footer OCULTO (degrada — DoD smoke).
   */
  async fetchQuota(): Promise<Quota | undefined> {
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch {
      return undefined; // sem credencial (deslogado) ⇒ sem quota; footer oculto.
    }

    let res: StreamResponse;
    try {
      res = await this.doFetch(`${this.baseUrl}${QUOTA_PATH}`, {
        method: 'GET',
        headers: {
          // ÚNICA credencial: a headless de USUÁRIO (PAT/device JWT). O broker a
          // introspecta e DERIVA org+user. NUNCA logada (CLI-SEC-10).
          authorization: `Bearer ${token}`,
          accept: 'application/json',
        },
        // SEM `body` (#123/EST-0962): GET com `body` (mesmo `''`) faz o fetch do Node
        // LANÇAR antes da rede. Omitido por completo.
      });
    } catch {
      // Transporte (broker fora / DNS / TLS): degrada silencioso (footer oculto).
      return undefined;
    }

    if (!res.ok) {
      // Não-2xx (401/403/404/5xx): degrada — o footer não é crítico, NÃO derruba o app.
      return undefined;
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return undefined; // corpo não-JSON ⇒ degrada.
    }
    return parseQuotaResponse(body);
  }

  /**
   * Variante que PROPAGA o erro (p/ um eventual comando `aluy quota` que queira reportar
   * "broker fora" honestamente — CA-5). O footer usa `fetchQuota` (silencioso); esta
   * fica disponível p/ quem precise distinguir "sem dado" de "falhou". NÃO usada no path
   * do footer (degradação silenciosa é o comportamento correto ali).
   */
  async fetchQuotaOrThrow(): Promise<Quota | undefined> {
    const token = await this.getAccessToken();
    let res: StreamResponse;
    try {
      res = await this.doFetch(`${this.baseUrl}${QUOTA_PATH}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (err) {
      throw new BrokerTransportError('falha de transporte ao ler a quota do broker.', err);
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
      throw new BrokerTransportError('quota do broker com corpo inválido.', err);
    }
    return parseQuotaResponse(body);
  }
}

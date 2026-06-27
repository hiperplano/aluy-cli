// EST-0944 — adaptador `ModelCaller` sobre o `BrokerModelClient` (EST-0943) +
// o RETRY DE REDE que reusa a MESMA Idempotency-Key (dedup de billing).
//
// O loop gera a key e a passa ao caller; o caller a repassa ao broker no header
// `Idempotency-Key`. Se a chamada falhar por TRANSPORTE (não por erro lógico do
// broker), o caller pode repetir — com a MESMA key — e o broker deduplica. Erros
// estruturados do broker (`BrokerError`: 4xx/5xx de aplicação, ex.: `429`,
// `422`) NÃO são retentados aqui (são decisão do loop/tetos — CA-5 do EST-0943).

import { BrokerTransportError } from '../model/errors.js';
import type { ModelClient } from '../model/broker-client.js';
import type { ChatMessage, LlmTier, ModelCallContext, ModelCallResult } from '../model/types.js';
import type { ModelCaller } from './loop.js';
import { NativeToolsCapability } from './native-tools.js';

/**
 * EST-0962 (Custom) · HG-2 — fonte DINÂMICA da pista de modelo (tier + slug Custom).
 * Quando um caller a recebe, ele lê o `tier`/`model` AGORA (no momento da chamada),
 * NÃO um valor fixo de construção. É o que o `StreamingModelCaller` do PAI satisfaz
 * (getters `tier`/`model` que mudam via `/model`): assim o caller dos SUB-AGENTES
 * (filhos) acompanha a pista CORRENTE do pai — trocar o tier/Custom no pai reflete
 * no próximo spawn. HG-2 intocado: o `model` é só a CHAVE de catálogo (não credencial);
 * propagá-la é igual a propagar o tier — o broker REVALIDA e resolve server-side.
 * O provider (NOME, ADR-0076) propaga sob custom+model — igual ao model, é DADO/chave,
 * não credencial. NUNCA api_key/base_url (não existem no cliente; broker resolve).
 */
export interface ModelTierSource {
  readonly tier: LlmTier;
  /**
   * Slug Custom corrente; `undefined` (e ignorado) fora de `tier:'custom'`. O
   * `| undefined` explícito casa com o getter `model` do `StreamingModelCaller`
   * (que devolve `string | undefined`) sob `exactOptionalPropertyTypes`.
   */
  readonly model?: string | undefined;
  /**
   * ADR-0076 (Custom multi-vendor) — NOME do provider corrente (`--provider`/`/provider`).
   * SÓ acompanha `tier:'custom'` + `model` presente (mesma trava do pai). É só o NOME
   * (DADO, não credencial — o broker resolve adapter/base_url/api_key server-side); sem
   * ele o sub-agente herda o model mas cai no provider DEFAULT (bug: model do provider X
   * mandado ao default ⇒ "modelo não existe no catálogo"). Casa o getter `provider`.
   */
  readonly provider?: string | undefined;
}

export interface BrokerModelCallerOptions {
  // ADR-0120 — aceita QUALQUER `ModelClient` (broker OU local): o caller não muda
  // entre os backends — só a estratégia injetada aqui pelo wiring.
  readonly client: ModelClient;
  readonly tier: LlmTier;
  /**
   * EST-0962 (Custom) — fonte DINÂMICA do tier + slug Custom. Quando presente, a
   * cada chamada o caller lê o `tier`/`model` CORRENTE daqui (não o `tier` fixo
   * acima): é a mecânica que propaga a pista do PAI (`StreamingModelCaller`) aos
   * SUB-AGENTES em runtime. O `model` SÓ acompanha `tier:'custom'` (trava dupla,
   * espelha `buildChatBody`) — nos tiers canônicos NÃO sai. Ausente ⇒ usa o `tier`
   * fixo, sem `model` (comportamento de hoje — não-regressão).
   */
  readonly tierSource?: ModelTierSource;
  /** Sessão de chat do broker (ADR-0034) — persistida entre turnos. */
  readonly sessionId?: string;
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly context?: ModelCallContext;
  /**
   * Nº de tentativas de TRANSPORTE por chamada lógica (≥1). Cada tentativa reusa
   * a MESMA Idempotency-Key (o broker deduplica). Default 1 (sem retry) —
   * conservador; quem quiser resiliência sobe isto cientemente.
   */
  readonly transportRetries?: number;
  /**
   * EST-0996 — CAPACIDADE de tool-calling NATIVO. Quando presente e ativa, o caller
   * envia o catálogo `tools` (HG-2: catálogo, não credencial) e, num `422 TOOLS_UNSUPPORTED`,
   * REPETE 1× SEM tools (degrade gracioso p/ o protocolo de texto, #99). Ausente ⇒
   * chat de texto puro (baseline — não-regressão). É a MESMA capacidade do caller de
   * STREAM da TUI; aqui serve o caminho não-stream (sub-agentes, `aluy "pergunta"`).
   */
  readonly nativeTools?: NativeToolsCapability;
}

/**
 * `ModelCaller` que fala com o broker. Mantém o `session_id` do broker entre
 * turnos (o 1º turno cria a sessão; os seguintes a reusam). O RETRY de transporte
 * reusa a key recebida do loop — é o ponto load-bearing da tese reseller.
 */
export class BrokerModelCaller implements ModelCaller {
  private readonly client: ModelClient;
  private readonly opts: BrokerModelCallerOptions;
  private brokerSessionId: string | undefined;
  // EST-0996 — MUTÁVEL (igual ao StreamingModelCaller): o controller, dono do toolset
  // final, ATTACHA a capacidade após montar o registry. undefined ⇒ texto puro.
  private nativeTools?: NativeToolsCapability;

  constructor(opts: BrokerModelCallerOptions) {
    this.client = opts.client;
    this.opts = opts;
    this.brokerSessionId = opts.sessionId;
    if (opts.nativeTools) this.nativeTools = opts.nativeTools;
  }

  /**
   * EST-0996 — ATTACHA a capacidade de tool-calling NATIVO (o controller a constrói
   * do toolset final e a injeta também no caller dos sub-agentes). A próxima chamada
   * já manda `tools` (se o modelo suportar). Idempotente.
   */
  attachNativeTools(cap: NativeToolsCapability): void {
    this.nativeTools = cap;
  }

  async call(args: {
    readonly messages: readonly ChatMessage[];
    readonly idempotencyKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ModelCallResult> {
    const attempts = Math.max(1, this.opts.transportRetries ?? 1);
    // EST-0962 (Custom) — pista de modelo CORRENTE: se há `tierSource` (a do PAI),
    // lê o tier/slug AGORA (dinâmico, runtime); senão, o `tier` fixo (não-regressão).
    // O `model` SÓ acompanha `tier:'custom'` (trava dupla — espelha `buildChatBody`):
    // nos tiers canônicos não sai (HG-2 intocado). NUNCA provider/api_key/base_url.
    const tier = this.opts.tierSource?.tier ?? this.opts.tier;
    const customModel = tier === 'custom' ? this.opts.tierSource?.model : undefined;
    // ADR-0076 — o provider acompanha o sub-agente SÓ sob `tier:'custom'` + `model`
    // presente (mesma trava do pai). Sem isto, um sub-agente herda o `model` de um
    // provider não-default mas o manda ao provider DEFAULT ⇒ "modelo não existe no
    // catálogo". É só o NOME (HG-2; o broker resolve credencial/base_url server-side).
    const customProvider =
      tier === 'custom' && customModel !== undefined ? this.opts.tierSource?.provider : undefined;
    // EST-0996 — DECISÃO de tools p/ ESTA chamada (estável durante o retry de transporte).
    // O degrade no 422 acontece num laço EXTERNO (reavalia `shouldSendTools`).
    let lastErr: unknown;
    // Laço externo: 1ª passada COM tools (se suportado); se vier `422 TOOLS_UNSUPPORTED`,
    // a capacidade se desliga e repetimos UMA vez SEM tools (degrade gracioso, #99).
    for (let nativeAttempt = 0; nativeAttempt < 2; nativeAttempt++) {
      const withTools = this.nativeTools?.shouldSendTools() ?? false;
      const toolFields = withTools ? this.nativeTools!.requestFields() : undefined;
      try {
        for (let i = 0; i < attempts; i++) {
          try {
            const result = await this.client.call({
              request: {
                tier,
                ...(customModel !== undefined ? { model: customModel } : {}),
                ...(customProvider !== undefined ? { provider: customProvider } : {}),
                messages: args.messages,
                ...(this.brokerSessionId !== undefined ? { session_id: this.brokerSessionId } : {}),
                ...(this.opts.maxTokens !== undefined ? { max_tokens: this.opts.maxTokens } : {}),
                ...(this.opts.temperature !== undefined
                  ? { temperature: this.opts.temperature }
                  : {}),
                ...(this.opts.context !== undefined ? { context: this.opts.context } : {}),
                ...(toolFields ?? {}),
              },
              // A MESMA key em TODAS as tentativas desta chamada lógica.
              idempotencyKey: args.idempotencyKey,
              ...(args.signal ? { signal: args.signal } : {}),
            });
            if (result.session_id !== undefined) this.brokerSessionId = result.session_id;
            return result;
          } catch (e) {
            lastErr = e;
            // SÓ retry de TRANSPORTE; erro estruturado do broker sobe direto.
            if (!(e instanceof BrokerTransportError) || i === attempts - 1) throw e;
          }
        }
        // inalcançável (o for-i sempre retorna ou lança), mas o TS exige.
        throw lastErr;
      } catch (e) {
        // EST-0996 — `422 TOOLS_UNSUPPORTED`: desliga o nativo e repete SEM tools (1×).
        // Só degrada se ESTA passada MANDOU tools (senão não há o que degradar).
        if (withTools && this.nativeTools?.degradeOnUnsupported(e)) {
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    // inalcançável (cada passada retorna ou lança), mas o TS exige.
    throw lastErr;
  }
}

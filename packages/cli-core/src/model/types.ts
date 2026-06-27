// Contrato TS do cliente de modelo CLI→broker (EST-0943) — PORTÁVEL.
//
// Espelha o contrato do `POST /v1/chat` do aluy-broker (`14-servicos/broker.md`
// §1) — o ÚNICO caminho de modelo do CLI (CLI-SEC-7). A topologia é CLI→broker
// DIRETO (Q2, cravada no ADR-0053 §3 / EST-0943) e o transporte é o endpoint
// INTERNO `/v1/chat` (Q3, cravada). A API externa OpenAI-compat
// (`/v1/chat/completions`, ADR-0046) é RESERVADA a terceiros — o CLI NÃO a usa.
//
// CLI-SEC-7 / HG-2 (DURO, com a EXCEÇÃO sancionada do Custom — ADR-0030 §3 /
// ADR-0065): a pista de modelo que sai do cliente é o `tier`. SOB `tier:'custom'`
// (e SÓ aí) o cliente pode acompanhar um `model` — uma CHAVE de catálogo curada
// OU um slug livre (modo warn-but-allow, ADR-0065) — NUNCA o id-de-provedor com
// credencial. NÃO existe aqui — e não pode passar a existir — `provider`,
// `api_key`, `base_url`, markup, quota ou ledger. O broker REVALIDA o `model` e
// resolve `tier → (provider, model, credencial)` server-side, atrás do vault
// (SEC-4/HG-1): a credencial NUNCA trafega no request.
//
// `aluy-sdk` (contrato TS canônico do broker) ainda não existe; como na auth
// (EST-0942), este módulo é o PRIMEIRO consumidor e migra para o SDK quando ele
// nascer, sem duplicar contrato (ADR-0053 §7).

import type { Quota } from './quota.js';

/**
 * Tier de modelo — a pista que o cliente envia (HG-2). O CLI NUNCA sabe o
 * provider/credencial concreto; o broker os resolve server-side. Os valores
 * espelham `model_tiers.key` do broker (ADR-0006). O valor SANCIONADO `'custom'`
 * (ADR-0030 §3) abre a via Custom: junto com ele o cliente manda um `model`
 * (chave de catálogo OU slug livre — ver `ModelCallRequest.model`). `string` é
 * aceito no boundary para não acoplar o release do CLI ao catálogo de tiers do
 * servidor (tier desconhecido ⇒ o broker responde `422 UNKNOWN_TIER`, propagado
 * honestamente — CA-5).
 */
export type LlmTier = 'aluy-strata' | 'aluy-deep' | 'aluy-flux' | 'custom' | (string & {});

/**
 * Papel de uma mensagem (estilo OpenAI; `system` opcional). EST-0996 acrescenta
 * `'tool'`: o RESULTADO de uma tool-call NATIVA volta ao modelo neste canal
 * dedicado (pareado por `tool_call_id`), em vez de empacotado como texto `user`.
 */
export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * EST-0996 — uma tool-call ESTRUTURADA proposta pelo modelo via function-calling
 * NATIVO do provider (espelha o `tool_calls` da API OpenAI, achatado p/ o que o
 * loop consome). `id` é o handle que PAREIA o resultado (`ChatMessage` role `tool`
 * com o mesmo `tool_call_id`). `input` já é o objeto de argumentos PARSEADO (o
 * provider devolve `function.arguments` como string JSON; o broker/cliente o
 * parseia na borda — ver `mapToolCalls`). Mesmo shape `{name, input}` do tool-call
 * de TEXTO (`ParsedToolCall`): o loop não distingue a origem (ponto único).
 */
export interface NativeToolCall {
  /** Handle do provider p/ parear o resultado (`tool_call_id`). */
  readonly id: string;
  /** Nome da função/tool pedida. */
  readonly name: string;
  /** Argumentos já parseados (objeto). Opaco aqui; cada tool valida o seu. */
  readonly input: Readonly<Record<string, unknown>>;
}

/**
 * EST-0996 — uma função declarada ao provider (schema de função OpenAI). É o
 * CATÁLOGO LOCAL de ferramentas convertido (HG-2: catálogo de tools NÃO é
 * credencial — ok mandar). `parameters` é o JSONSchema do input da tool.
 */
export interface ToolFunctionSchema {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    /** JSONSchema do input (objeto). */
    readonly parameters: Readonly<Record<string, unknown>>;
  };
}

/**
 * Uma mensagem da conversa enviada ao broker. EST-0996: campos opcionais p/ o
 * tool-calling NATIVO (`exactOptionalPropertyTypes`: só entram quando definidos):
 *  - `tool_calls` (no turno `assistant`): as tool-calls que o modelo propôs — o
 *    ECO obrigatório p/ o provider parear o `role:"tool"` seguinte. CONTEÚDO de
 *    instrução do MODELO (semi-confiável), nunca dado ingerido.
 *  - `tool_call_id` (no turno `tool`): a qual call este resultado responde. O
 *    `content` do resultado segue sendo DADO NÃO-CONFIÁVEL (envelopado — CLI-SEC-4).
 */
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
  readonly tool_calls?: readonly NativeToolCall[];
  readonly tool_call_id?: string;
}

/**
 * Correlação propagada ao broker (`broker.md` §1: `context`). NUNCA credencial.
 * Tudo opcional — o loop (EST-0944) pode preencher `trace_id` p/ a auditoria
 * `actor_type=cli` (CLI-SEC-10) amarrar os passos de uma sessão agêntica.
 */
export interface ModelCallContext {
  readonly workflow_run_id?: string;
  readonly step_id?: string;
  readonly trace_id?: string;
}

/**
 * Pedido de chamada de modelo — o que o loop agêntico (EST-0944) passa ao
 * cliente. É o contrato PORTÁVEL: sem nada de provider/credencial (CLI-SEC-7).
 * O cliente o traduz no corpo de `POST /v1/chat`.
 */
export interface ModelCallRequest {
  /** Pista de modelo (HG-2). `'custom'` habilita o `model` abaixo (ADR-0030 §3). */
  readonly tier: LlmTier;
  /**
   * Via Custom (ADR-0030 §3 / ADR-0065): chave de catálogo curada OU slug livre,
   * **SOMENTE** sob `tier:'custom'`. Fora de `custom` é IGNORADO (o cliente nem o
   * envia — ver `buildChatBody`). Continua PROIBIDO `provider`/`api_key`/`base_url`/
   * `model` como id-de-provedor-com-credencial: o broker REVALIDA o slug e resolve
   * a credencial server-side, no vault (SEC-4/HG-1). No modo warn-but-allow o broker
   * aceita qualquer slug que o provedor sirva (a UI avisa se está fora do catálogo
   * curado, mas deixa usar); slug que o provedor NÃO serve ⇒ erro honesto do broker.
   */
  readonly model?: string;
  /**
   * EST-0962 (Custom · `--provider`/`/provider`) — NOME do provider/vendor a usar p/
   * resolver o `model` da via Custom, **SOMENTE** sob `tier:'custom'` e em par com
   * `model`. É só o NOME curado do provider no broker (ex.: `'deepseek'`) — DADO, NÃO
   * credencial: CONTINUA PROIBIDO `api_key`/`base_url`/segredo. O broker resolve
   * `(provider, model)` → credencial server-side, no vault (HG-2/CLI-SEC-7/PROV-SEC-5).
   * Fora de `custom` (ou sem `model`) é IGNORADO — o cliente nem o envia (ver
   * `buildChatBody`). Ausente ⇒ o broker escolhe o provider pelo catálogo (hoje).
   */
  readonly provider?: string;
  /** Conversa (OpenAI-style). */
  readonly messages: readonly ChatMessage[];
  /**
   * Sessão de chat persistida pelo broker (ADR-0034). `undefined` no 1º turno ⇒
   * o broker CRIA a sessão e devolve o `session_id` no evento `start`.
   */
  readonly session_id?: string;
  /** Teto de tokens do request (≤ guardrail server-side). */
  readonly max_tokens?: number;
  readonly temperature?: number;
  readonly context?: ModelCallContext;
  /**
   * EST-0996 — CATÁLOGO de ferramentas em schema de função NATIVO (OpenAI). Só
   * vai ao broker quando o modelo/tier SUPORTA tools (ver `BrokerModelCaller`/
   * streaming-caller: se `supports_tools===false` ou após um `422 TOOLS_UNSUPPORTED`,
   * NÃO é enviado — degrada p/ o protocolo de texto). HG-2: é o catálogo LOCAL de
   * tools, NÃO credencial — ok mandar. `undefined` ⇒ chat de texto puro (baseline).
   */
  readonly tools?: readonly ToolFunctionSchema[];
  /**
   * EST-0996 — `tool_choice` do provider (`'auto'` por padrão quando há `tools`).
   * Só entra com `tools`. O CLI manda `'auto'`: o modelo decide chamar tool ou não.
   */
  readonly tool_choice?: 'auto' | 'none' | 'required';
  /**
   * EST-0996 — permite (ou não) MÚLTIPLAS tool-calls num turno. O CLI SERIALIZA a
   * execução (cada uma passa pela catraca, em ordem — seguro p/ v1), independente
   * deste flag; o flag só diz ao provider se pode propor várias de uma vez.
   */
  readonly parallel_tool_calls?: boolean;
  /**
   * EST-0962 (--effort / /effort) — `reasoning_effort` do provider (PASSTHROUGH:
   * qualquer string ≤32 chars; low/medium/high são comuns mas CUSTOM é aceito). Vai
   * no corpo do request em QUALQUER tier (sem gate). O broker/providor valida.
   * `undefined` ⇒ NÃO é enviado (o provider usa o default dele).
   */
  readonly reasoning_effort?: string;
}

/**
 * Trailer de uso — vem UMA vez ao fechar o stream (evento `usage`), mesmo se
 * cortado (`partial=true`). O CLI NÃO recalcula custo (HG-3/HG-4): só repassa o
 * que o broker reportou. `provider`/`model` aqui são observabilidade pós-resposta
 * (nomes públicos do catálogo, ADR-0030) — NUNCA credencial/base_url (SEC-4).
 */
export interface ModelUsage {
  readonly request_id: string;
  readonly tier: string;
  readonly provider?: string;
  readonly model?: string;
  readonly tokens_in?: number;
  readonly tokens_out?: number;
  readonly cost?: string;
  readonly price_version?: string;
  readonly partial?: boolean;
  /**
   * Crédito RESTANTE da conta APÓS esta chamada (string decimal de moeda/crédito —
   * o broker JÁ manda isto). O CLI NÃO sabe markup/ledger (CLI-SEC-7): é só o número
   * que o usuário pode ver da PRÓPRIA conta. Surfaçado AGORA pelo cliente (aviso
   * quando o saldo cai), independente do limite de QUOTA (que falta o broker expor).
   */
  readonly balance_after?: string;
  /**
   * EST-0948 (server-limits / FU-VAU-003 · ADR-0069) — um limite TÉCNICO opcional que
   * o broker PODERIA reportar ao PAT (ex.: `llm_budgets`, ADR-0028). Campo tolerante.
   *
   * ⚠ Por ADR-0069/APR-0074, a QUOTA DE PRODUTO do ator CLI é a dimensão CRÉDITO
   * (`balance_after`, acima — saldo/consumo pay-per-use), NÃO um teto de janela de
   * tokens. Este `limits` NÃO é o que governa/barra o CLI nem o que o footer mostra
   * (é crédito); fica modelado p/ um eventual `llm_budgets` técnico, sem hijackar o
   * `◷` (que segue o fail-safe LOCAL `DEFAULT_MAX_TOKENS`, CLI-SEC-8). AUSENTE ⇒ o
   * cliente ignora (degrada). SÓ o que o usuário vê da própria conta — sem
   * markup/ledger/credencial (CLI-SEC-7). Todos os subcampos OPCIONAIS/tolerantes.
   */
  readonly limits?: ServerLimitsPayload;
}

/**
 * EST-0948 (server-limits / FU-VAU-003) — o payload BRUTO do limite/quota da conta
 * dentro do `usage` (subcampo `limits`), como o broker o reportaria. TOLERANTE: todo
 * subcampo é opcional; o cliente normaliza/sanitiza no `parseServerLimits` (nunca
 * confia no formato cru — boundary de rede, CLI-SEC-4). NÃO há limite hardcoded aqui.
 */
export interface ServerLimitsPayload {
  /** Limite efetivo da janela/plano (tokens OU crédito — `unit` diz qual). */
  readonly limit?: number | string;
  /** Já consumido na janela corrente. */
  readonly used?: number | string;
  /** Restante na janela corrente (se o broker já manda pronto; senão `limit-used`). */
  readonly remaining?: number | string;
  /** Unidade do limite: `tokens` (default) ou `credit`. */
  readonly unit?: string;
  /** Janela/plano da quota: `5h`/`day`/`week`/`month` (rótulo livre do broker). */
  readonly period?: string;
  /** Instante de reset da janela — ISO-8601, epoch-seg ou epoch-ms (normalizado no parse). */
  readonly reset_at?: number | string;
}

/**
 * Evento de modelo entregue ao chamador (loop/TUI) — união discriminada por
 * `type`, espelhando os eventos SSE do broker (`broker.md` §1.2):
 *  - `start`: o broker reservou quota/crédito; chega o `request_id`/`session_id`.
 *  - `delta`: um chunk de conteúdo token-a-token (na ordem).
 *  - `usage`: trailer de uso ao fechar (uma vez).
 *  - `done`: terminou normalmente (`finish_reason`).
 *
 * O evento `error` do SSE NÃO aparece aqui: ele é convertido num `BrokerError`
 * LANÇADO pelo iterador (CA-5: erro estruturado, não um evento a inspecionar).
 */
export type ModelStreamEvent =
  | { readonly type: 'start'; readonly request_id: string; readonly session_id?: string }
  | { readonly type: 'delta'; readonly content: string }
  // EST-0996 — tool-call NATIVO AGREGADO no SSE (`event: tool_call`): o broker já
  // junta os deltas de `tool_calls`/`function.arguments` e emite UMA call completa
  // por evento. O cliente as acumula no `ModelCallResult.tool_calls`. NÃO há
  // streaming PARCIAL de tool-call no CLI (o broker agrega) — simplicidade/auditoria.
  | { readonly type: 'tool_call'; readonly call: NativeToolCall }
  | { readonly type: 'usage'; readonly usage: ModelUsage }
  // EST-0948 (footer/quota) — a QUOTA do usuário (janelas 5h/semana) que o BROKER
  // reportou no RESPONSE (headers, primário; ou corpo do `done`, fallback). É
  // observabilidade de BILLING (do broker), distinta do budget LOCAL anti-runaway:
  // o CLI só LÊ e mostra (HG-3/HG-4). Emitido no MÁXIMO uma vez por turno, ANTES do
  // `done`. AUSENTE quando o broker não reporta ⇒ a TUI degrada (footer oculto).
  | { readonly type: 'quota'; readonly quota: Quota }
  | { readonly type: 'done'; readonly finish_reason: string };

/**
 * Resultado agregado de uma chamada NÃO-stream (conveniência p/ o loop que só
 * quer o texto final). Montado consumindo o stream até o fim.
 */
export interface ModelCallResult {
  readonly request_id: string;
  readonly session_id?: string;
  readonly content: string;
  readonly finish_reason: string;
  readonly usage?: ModelUsage;
  /**
   * EST-0996 — tool-calls NATIVAS desta resposta (não-stream: campo `tool_calls`;
   * stream: acumuladas do `event: tool_call`). PRESENTE e não-vazio ⇒ o loop as
   * despacha pelo MESMO `executeToolCall`/`decide()` (e ignora o parser de texto
   * deste turno). Ausente/vazio ⇒ o loop cai no `parseModelTurn(content)` (fallback
   * de texto, #99). É o que torna o nativo e o texto um PONTO ÚNICO no loop.
   */
  readonly tool_calls?: readonly NativeToolCall[];
  /**
   * EST-0948 (footer/quota) — a quota do usuário que o broker reportou neste
   * response (5h/semana). `undefined` quando o broker NÃO mandou (degrada: footer
   * oculto). Display de BILLING — o CLI só repassa (HG-3/HG-4), não recalcula.
   */
  readonly quota?: Quota;
}

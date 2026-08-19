// ADR-0120 / EST-1113 — contratos do BACKEND LOCAL (smallbroker) — PORTÁVEIS.
//
// O backend local fala com o provider de LLM DIRETO, com credencial BYO do
// usuário, em vez de ir pelo `aluy-broker` central. Estes tipos são a fronteira
// PORTÁVEL (ADR-0053 §8): sem I/O (HTTP/keychain/browser moram no `@hiperplano/aluy-cli`).
//
// CLI-SEC-7: nada de credencial versionada. A `apiKey`/`accessToken` aqui são
// RESOLVIDAS em runtime (keychain → env) pelo locus concreto e passadas a cada
// chamada via um provedor injetável — NÃO ficam no repo nem no binário.

import type { ToolFunctionSchema } from '../types.js';

/**
 * O provider do backend local — id do CATÁLOGO (ADR-0118). Antes era um union
 * FECHADO (`'anthropic'|'openrouter'|'openai'`); agora é ABERTO (string dirigida pelo
 * catálogo de providers), pois adicionar/curar um provider passou a ser DADO
 * (`defaultLocalCatalog`/`~/.aluy/providers.json`), não código. Os 3 ids antigos
 * continuam válidos — o `string & {}` preserva o autocomplete dos conhecidos sem
 * fechar a porta para os demais (`deepseek`/`groq`/`google`/`ollama`/…).
 */
export type LocalProviderKind = 'anthropic' | 'openrouter' | 'openai' | (string & {});

/**
 * Como autenticar com o provider: chave de API paga-por-uso (`apikey`, via
 * oficial p/ clientes terceiros) OU token OAuth de assinatura (`oauth`, Claude
 * Pro/Max / ChatGPT — ⚠ zona cinzenta de ToS, EST-1114). A escolha é do usuário,
 * por provider.
 */
// `none` (ADR-0120/0118): provider LOCAL sem credencial — ex.: Ollama no loopback
// (:11434/v1). Não há chave nem token; o cliente NÃO manda header de Authorization.
export type LocalAuthKind = 'apikey' | 'oauth' | 'none';

/**
 * Credencial JÁ RESOLVIDA p/ UMA chamada (o locus a obtém do keychain→env e a
 * passa; o core nunca toca keychain). `apikey` ⇒ a chave do provider; `oauth` ⇒
 * o access token (refrescado pelo locus quando vencido — EST-1114).
 */
export interface ResolvedCredential {
  readonly kind: LocalAuthKind;
  /** O segredo a apresentar ao provider (API key OU access token OAuth). */
  readonly secret: string;
}

/** Provedor de credencial injetável: resolve a credencial CORRENTE por chamada. */
export type CredentialProvider = () => Promise<ResolvedCredential>;

/**
 * Config de UM provider local resolvida (modelo + base_url + auth). O `model` é o
 * id NATIVO do provider (ex.: `claude-opus-4-8`, `anthropic/claude-3.5-sonnet`).
 * `baseUrl` ausente ⇒ o adapter usa o default público do provider.
 */
export interface LocalProviderConfig {
  readonly provider: LocalProviderKind;
  readonly model: string;
  /** Override de base_url (validado por anti-SSRF antes do uso — PROV-SEC-1). */
  readonly baseUrl?: string;
  /** Via de auth (default `apikey`). */
  readonly auth?: LocalAuthKind;
  /**
   * Mapa SLUG → fragmento de corpo cru (ver `LocalRequest.extraBody`), vindo de
   * `providers[].upstreamByModel` no config do dono.
   *
   * Fica na CONFIG (não no request) porque é declaração ESTÁVEL do dono sobre um
   * provider; mas a consulta é POR REQUEST, no `toLocalRequest` — o `/model` troca o
   * slug SEM reconstruir o client (o override de tier `custom`), então resolver o
   * fragmento no boot fixaria o roteamento do PRIMEIRO modelo em todos os seguintes.
   */
  readonly upstreamByModel?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

/**
 * O que o adapter precisa montar UMA requisição ao provider. É a tradução do
 * `ModelCallRequest` PORTÁVEL (tier-based) p/ o shape NATIVO do provider — o
 * `tier` é IGNORADO no local (o `model` concreto vem da config BYO). Espelha o que
 * o broker faria server-side, mas client-side.
 */
export interface LocalRequest {
  readonly model: string;
  readonly system?: string;
  readonly messages: readonly LocalMessage[];
  readonly maxTokens: number;
  readonly temperature?: number;
  readonly reasoningEffort?: string;
  /**
   * FRAGMENTO DE CORPO por modelo — mesclado CRU na requisição (wire `openai-compat`).
   *
   * Existe porque roteamento de upstream NÃO é parte do protocolo OpenAI: cada agregador
   * inventou o seu. No OpenRouter é `provider: { only: [...], quantizations: [...] }`; no
   * tokenrouter, no Vercel AI Gateway e nos próximos é outro nome e outro formato. Modelar
   * um vocabulário comum aqui seria inventar um padrão que não existe — e obrigaria uma
   * release do aluy a cada campo novo de terceiro.
   *
   * Então o aluy NÃO INTERPRETA: valida que é objeto e repassa. O dono escreve o dialeto
   * do provedor que ele escolheu, e o namespace fica implícito (o fragmento mora DENTRO da
   * entrada daquele provider no catálogo).
   *
   * Preço disso, e é o preço certo: erro de digitação aqui só aparece como erro do
   * agregador, não como validação local.
   */
  readonly extraBody?: Readonly<Record<string, unknown>>;
  readonly tools?: readonly ToolFunctionSchema[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
}

/**
 * ADR-0159 — mesma união de `ContentPart` de `model/types.ts`, REPETIDA aqui de
 * propósito (mesma razão do `LocalMessage` abaixo: este módulo não acopla ao
 * pai). Texto puro OU imagem inline (base64).
 */
export type ContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mimeType: string; readonly base64: string };

/** Mensagem no shape PORTÁVEL (igual ao `ChatMessage`, repetida p/ não acoplar). */
export interface LocalMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  /** ADR-0159 — texto puro (sem mudança) OU `ContentPart[]` (imagem). */
  readonly content: string | readonly ContentPart[];
  readonly tool_calls?: readonly { id: string; name: string; input: Record<string, unknown> }[];
  readonly tool_call_id?: string;
}

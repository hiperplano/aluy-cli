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
export type LocalAuthKind = 'apikey' | 'oauth';

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
  readonly tools?: readonly ToolFunctionSchema[];
  readonly toolChoice?: 'auto' | 'none' | 'required';
}

/** Mensagem no shape PORTÁVEL (igual ao `ChatMessage`, repetida p/ não acoplar). */
export interface LocalMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_calls?: readonly { id: string; name: string; input: Record<string, unknown> }[];
  readonly tool_call_id?: string;
}

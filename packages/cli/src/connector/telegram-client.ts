// Conector Telegram (ADR-0134 §4) — LONG-POLL concreto sobre `getUpdates`. A máquina é
// CLIENTE puro (egress de saída a api.telegram.org), SEM porta/webhook exposto. Usa o
// parser PURO do cli-core; aqui só o I/O HTTP (fetch injetável p/ teste — a suíte NUNCA
// toca a rede real).
//
// Disciplina: o token vai na URL (assim é a Bot API) — NUNCA logamos a URL crua (redação).
// O `await` de cada poll é cancelável por AbortSignal (encerra junto com a sessão).
//
// ⚠️ INERTE: nada aqui é chamado pelo boot ainda. A ativação (`--telegram`) + o roteamento
//    do ingresso à sessão + o `telegram_send` esperam a revisão `seguranca` (ADR-0134).

import {
  parseGetUpdates,
  redactTelegramToken,
  redactSecretIn,
  type TelegramUpdate,
} from '@hiperplano/aluy-cli-core';

/** Base da Bot API. CONSTANTE — em produção o token só vai p/ este host (R7/CLI-SEC-5). */
export const TELEGRAM_API_BASE = 'https://api.telegram.org';

export interface TelegramClientOptions {
  /** Token do bot (do keychain). NUNCA logado em claro. */
  readonly token: string;
  /** `fetch` injetável (teste). Default: o global. */
  readonly fetchFn?: typeof fetch;
  /** Base da API. Só honrado COM `allowNonDefaultApiBase` (teste/proxy). Default: api.telegram.org. */
  readonly apiBase?: string;
  /**
   * R7 (gate seguranca) — TRAVA do apiBase. Só `true` (passado por CÓDIGO, ex.: teste)
   * permite `apiBase` != default. Sem esta flag, `apiBase` é IGNORADO e o host é forçado p/
   * api.telegram.org — assim DADO não-confiável (config/env) NUNCA redireciona o token p/
   * um host atacante. A flag NÃO é lida de config/env.
   */
  readonly allowNonDefaultApiBase?: boolean;
  /** Timeout do long-poll no SERVIDOR (s) — o getUpdates segura a conexão até isso. */
  readonly longPollSeconds?: number;
}

/** Cliente de long-poll do Telegram. Cliente puro (sem inbound). */
export class TelegramClient {
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly apiBase: string;
  private readonly longPollSeconds: number;
  private offset = 0;

  constructor(opts: TelegramClientOptions) {
    this.token = opts.token;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as typeof fetch);
    // R7 — apiBase só != default COM a flag explícita de código (teste/proxy). Sem ela,
    // o host é TRAVADO em api.telegram.org (config/env não redireciona o token).
    this.apiBase =
      opts.allowNonDefaultApiBase === true && opts.apiBase ? opts.apiBase : TELEGRAM_API_BASE;
    this.longPollSeconds = opts.longPollSeconds ?? 25;
  }

  /** Identificação redigida (p/ log) — nunca o token em claro. */
  get redactedToken(): string {
    return redactTelegramToken(this.token);
  }

  /**
   * R6 (redação por construção) — torna QUALQUER string segura p/ log, removendo o token
   * (ex.: uma mensagem de erro que ecoe a URL `…/bot<token>/…`). O wiring DEVE usar isto
   * antes de logar erros do conector.
   */
  safeForLog(text: string): string {
    return redactSecretIn(text, this.token);
  }

  /**
   * UMA rodada de getUpdates: long-poll, parseia, AVANÇA o offset. FAIL-SAFE: erro de
   * rede/HTTP/JSON ⇒ `[]` (não avança o offset; tenta de novo na próxima). Cancelável.
   */
  async poll(signal?: AbortSignal): Promise<readonly TelegramUpdate[]> {
    const url =
      `${this.apiBase}/bot${this.token}/getUpdates` +
      `?timeout=${this.longPollSeconds}&offset=${this.offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
    let raw: unknown;
    try {
      const resp = await this.fetchFn(url, signal ? { signal } : {});
      if (!resp.ok) return []; // HTTP não-2xx ⇒ tenta de novo (não avança offset).
      raw = await resp.json();
    } catch {
      // Rede caiu / abort / JSON inválido ⇒ fail-safe: nada, offset preservado.
      return [];
    }
    const parsed = parseGetUpdates(raw, this.offset);
    this.offset = parsed.nextOffset; // confirma os updates (não reprocessa).
    return parsed.updates;
  }

  /**
   * Loop de long-poll: produz updates continuamente até o `signal` abortar. Espelha o
   * `incoming()` da porta `Connector`. FAIL-SAFE por rodada (uma falha não derruba o loop).
   */
  async *stream(signal?: AbortSignal): AsyncGenerator<TelegramUpdate> {
    while (!signal?.aborted) {
      const batch = await this.poll(signal);
      for (const u of batch) {
        if (signal?.aborted) return;
        yield u;
      }
    }
  }

  /**
   * EGRESSO — envia texto a um chat (sendMessage). Espelha o `send()` da porta `Connector`.
   * O `chatId` é o ALVO TRAVADO pela malha (o chat allowlistado da conversa corrente — a
   * malha NUNCA passa destino arbitrário do agente; TC-5, fecha exfiltração). Aqui só o I/O.
   * FAIL-SAFE: retorna `true` se a Bot API confirmou (`ok:true`), `false` em qualquer falha
   * (rede/HTTP/JSON/`ok:false`). Token na URL NUNCA logado.
   */
  async send(chatId: number, text: string, signal?: AbortSignal): Promise<boolean> {
    const url = `${this.apiBase}/bot${this.token}/sendMessage`;
    try {
      const resp = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
        ...(signal ? { signal } : {}),
      });
      if (!resp.ok) return false;
      const body = (await resp.json()) as { ok?: unknown };
      return body?.ok === true;
    } catch {
      return false; // rede caiu / abort / JSON inválido ⇒ fail-safe (não lança).
    }
  }
}

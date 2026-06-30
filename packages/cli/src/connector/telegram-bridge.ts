// Bridge Telegram (ADR-0134 / ADR-0135) — a ATIVAÇÃO da bridge: liga o `TelegramConnector`
// (INERTE) à sessão viva. Esta é a peça que o `seguranca` deu OK CONDICIONAL (C1–C6):
//
//  C1 — todo log/erro do loop e do send passa por `client.safeForLog(...)` (token NUNCA vaza).
//  C2 — CADA `IncomingMessage` de `incoming()` passa por `classifyConnectorIngress` (a malha,
//       SINGLE-SOURCE da fronteira de confiança). SÓ `kind:'instruction'` injeta como
//       INSTRUÇÃO do dono; `kind:'data'` entra sub-envelopado como DADO; `kind:'discard'`
//       NUNCA toca o modelo. NÃO injetamos `incoming()` direto. Allowlist vazia ⇒ descarta tudo.
//  C3 — o `telegram_send` SEMPRE responde ao chat da conversa CORRENTE TRAVADA (o último chat
//       allowlistado que falou). O destino NÃO é argumento do modelo (fecha exfiltração, TC-5).
//  C4 — `EgressRateLimiter.tryConsume` antes de CADA send; estouro ⇒ NEGA (não enfileira).
//  C5 — `senderIsBot` é descartado pela malha (anti-loop TC-6); o caminho vivo popula `is_bot`.
//  C6 — sem token no keychain ⇒ a bridge NÃO sobe (o boot NÃO falha; só não ativa, sem egress).
//
// PURO de I/O direto: o long-poll/keychain vivem no client/connector; aqui é só a COMPOSIÇÃO
// + o roteamento ingress→sessão e o gate de egresso. Testável com fakes (sem rede real).

import {
  classifyConnectorIngress,
  TELEGRAM_META,
  EgressRateLimiter,
  type Connector,
  type ConnectorIngress,
  type ConversationRef,
  type IncomingMessage,
  type NativeTool,
  type ToolPorts,
  type ToolResult,
} from '@hiperplano/aluy-cli-core';

/**
 * O destino da sessão p/ o ingresso classificado. Duas vias DISTINTAS (a malha já decidiu
 * QUAL): instrução do dono (canal `user`) × dado não-confiável (canal `observation`). O
 * sink NÃO re-classifica — só entrega ao canal certo. Quem implementa é o `SessionController`
 * (`injectInput`/`ingestExternalData`), fiado em run.tsx.
 */
export interface IngressSink {
  /** INSTRUÇÃO do dono autenticado+allowlistado (canal `user`, `user_inject`). */
  injectInstruction(text: string): void;
  /** DADO NÃO-CONFIÁVEL (canal `observation`, envelopado `DADO_NAO_CONFIAVEL`). */
  injectData(label: string, text: string): void;
}

/** Algo que sabe redigir o token p/ log (o `TelegramClient` cumpre via `safeForLog`). */
export interface TokenRedactor {
  safeForLog(text: string): string;
}

export interface TelegramBridgeOptions {
  /**
   * Fábrica da porta `Connector` (Telegram) — INGRESSO (incoming) + EGRESSO (send). Recebe o
   * `AbortSignal` do pump (criado DENTRO da bridge) p/ o long-poll ser cancelável no teardown.
   * É fábrica (não a porta pronta) p/ resolver a ordem: a bridge cria o signal, a fábrica o
   * captura. NÃO instancia rede até a bridge existir.
   */
  readonly connectorFactory: (signal: AbortSignal) => Connector;
  /**
   * Allowlist de chats AUTORIZADOS (chat-id como `ConversationRef` — string). VAZIA ⇒ a
   * malha descarta TUDO (default fechado, C2). É a MESMA chave que a malha casa contra
   * `IncomingMessage.conversation`.
   */
  readonly allowlist: ReadonlySet<ConversationRef>;
  /** Para onde vai o ingresso JÁ CLASSIFICADO (instrução × dado). */
  readonly sink: IngressSink;
  /** Redator do token p/ TODO log/erro (C1). Em prod é o próprio `TelegramClient`. */
  readonly redactor: TokenRedactor;
  /** Catraca anti-spam do egresso (C4). Default: conservador (ver `DEFAULT_EGRESS_LIMITER`). */
  readonly egressLimiter?: EgressRateLimiter;
  /** Relógio (ms) p/ a catraca — injetável p/ teste. Default: `Date.now`. */
  readonly now?: () => number;
  /** Sink de log local (NÃO o modelo) — recebe SEMPRE texto JÁ redigido. Default: stderr. */
  readonly log?: (line: string) => void;
}

/**
 * Limites CONSERVADORES do egresso (C4): no máx. 20 envios por minuto deslizante. Um loop/
 * runaway estoura e é NEGADO (a tool devolve erro, não enfileira). Tetos de produto — não
 * lidos de config/env (DADO não-confiável não relaxa o freio).
 */
export const TELEGRAM_EGRESS_MAX = 20;
export const TELEGRAM_EGRESS_WINDOW_MS = 60_000;

/** Rótulo de origem do DADO de Telegram no histórico (CLI-SEC-4) — visível, nunca instrução. */
const TELEGRAM_DATA_LABEL = 'telegram (dado externo)';

/**
 * A bridge ATIVA. Owna: a allowlist, a catraca, o ALVO TRAVADO da conversa corrente e o
 * pump do long-poll. NÃO instancia o client/keychain — recebe a porta pronta (composição
 * no boot, run.tsx). O `telegram_send` é construído por `sendTool()` e fechado sobre ESTA
 * instância (o alvo é o travado AQUI, nunca um arg do modelo — C3).
 */
export class TelegramBridge {
  private readonly connector: Connector;
  private readonly allowlist: ReadonlySet<ConversationRef>;
  private readonly sink: IngressSink;
  private readonly redactor: TokenRedactor;
  private readonly egressLimiter: EgressRateLimiter;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** O AbortController do long-poll — `abort()` encerra o pump junto com a sessão. */
  private readonly ac = new AbortController();
  /**
   * C3 — o ALVO TRAVADO do egresso: o `ConversationRef` do ÚLTIMO chat allowlistado que
   * mandou uma INSTRUÇÃO. O `telegram_send` responde AQUI — nunca a um destino do modelo.
   * `undefined` até o primeiro ingresso autorizado (aí a tool recusa: não há onde responder).
   */
  private lockedConversation: ConversationRef | undefined;

  constructor(opts: TelegramBridgeOptions) {
    // A fábrica captura o signal do AbortController interno ⇒ o connector já nasce cancelável
    // por `this.stop()` (sem dependência circular nem re-troca de porta em runtime).
    this.connector = opts.connectorFactory(this.ac.signal);
    this.allowlist = opts.allowlist;
    this.sink = opts.sink;
    this.redactor = opts.redactor;
    this.egressLimiter =
      opts.egressLimiter ?? new EgressRateLimiter(TELEGRAM_EGRESS_MAX, TELEGRAM_EGRESS_WINDOW_MS);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
  }

  /** O sinal do pump (encerra com a sessão). Passado ao connector p/ cancelar o long-poll. */
  get signal(): AbortSignal {
    return this.ac.signal;
  }

  /** O alvo TRAVADO corrente (p/ teste/inspeção). NÃO é setável de fora — só pelo ingresso. */
  get currentTarget(): ConversationRef | undefined {
    return this.lockedConversation;
  }

  /**
   * C2 — roteia UMA `IncomingMessage` pela malha e despacha a decisão. PURO de rede: chama
   * `classifyConnectorIngress` (a fronteira de confiança) e SÓ ENTÃO toca o sink. Nunca
   * injeta `incoming()` direto. Exposto p/ teste unitário da decisão (sem montar o pump).
   */
  route(msg: IncomingMessage): ConnectorIngress {
    const decision = classifyConnectorIngress(msg, this.allowlist, TELEGRAM_META);
    switch (decision.kind) {
      case 'instruction':
        // C3 — TRAVA o alvo do egresso no chat allowlistado que falou (a conversa corrente).
        // O `telegram_send` responderá AQUI, nunca a um destino arbitrário do modelo.
        this.lockedConversation = msg.conversation;
        this.sink.injectInstruction(decision.text);
        // Forward/quote embutido (terceiro) ⇒ DADO sub-envelopado (NUNCA instrução).
        if (decision.forwardedData !== undefined && decision.forwardedData.trim() !== '') {
          this.sink.injectData(TELEGRAM_DATA_LABEL, decision.forwardedData);
        }
        break;
      case 'data':
        // Conteúdo NÃO-confiável (auth forjável OU repasse de terceiro): entra como DADO.
        // NÃO trava o alvo do egresso — dado de terceiro não autoriza ninguém a responder.
        this.sink.injectData(TELEGRAM_DATA_LABEL, decision.text);
        break;
      case 'discard':
        // NUNCA toca o modelo — só log LOCAL (o `reason` é da malha, sem conteúdo do usuário).
        this.log(`[telegram] descartado: ${decision.reason}`);
        break;
    }
    return decision;
  }

  /**
   * O PUMP do long-poll: drena `connector.incoming()` e roteia CADA mensagem pela malha
   * (C2). Encerra quando o sinal aborta (fim da sessão). FAIL-SAFE: um erro do iterador é
   * REDIGIDO (C1) e o pump termina sem derrubar a sessão (a próxima sessão re-ativa). NÃO
   * relança (o boot não pode quebrar por uma falha do conector).
   */
  async pump(): Promise<void> {
    try {
      for await (const msg of this.connector.incoming()) {
        if (this.ac.signal.aborted) break;
        try {
          this.route(msg);
        } catch (err) {
          // C1 — NUNCA loga `err` cru: a msg pode ecoar a URL `…/bot<token>/…`. Redige.
          this.log(`[telegram] erro ao rotear ingresso: ${this.safe(err)}`);
        }
      }
    } catch (err) {
      // C1 — idem p/ a falha do PRÓPRIO long-poll (o client é fail-safe, mas defesa em
      // profundidade: se o iterador lançar, o que vai pro log está REDIGIDO).
      this.log(`[telegram] long-poll encerrado: ${this.safe(err)}`);
    }
  }

  /**
   * C3 + C4 — a tool `telegram_send` GATEADA. O agente passa SÓ `{ text }`: o DESTINO é o
   * alvo TRAVADO (`lockedConversation`), NUNCA um arg do modelo (fecha exfiltração, TC-5).
   * Antes de enviar, consulta a catraca (C4): estouro ⇒ NEGA (devolve erro, não enfileira).
   * `effect:'comms'` (espelha `room_post`, gate AG-0008) — passa por `decide()` no loop.
   */
  sendTool(): NativeTool<ToolPorts> {
    return {
      name: 'telegram_send',
      effect: 'comms',
      description:
        'Envia uma mensagem de texto de volta pela conversa de Telegram CORRENTE (a do dono ' +
        'que te falou). Input: { "text": string }. O DESTINO é fixo (a conversa travada) — ' +
        'você NÃO escolhe para quem vai (anti-exfiltração). Há um teto anti-spam por minuto.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'O texto a enviar de volta na conversa corrente.' },
        },
        required: ['text'],
      },
      // Arrow ⇒ `this` é a bridge (acesso VIVO ao alvo travado/catraca; sem aliasing de `this`).
      run: (input) => this.runSend(input),
    };
  }

  /**
   * O handler de `telegram_send` (C3 + C4). Extraído p/ o `run` ser um arrow (acesso vivo a
   * `this.lockedConversation`/catraca, sem aliasar `this`). O agente passa SÓ `{ text }`: o
   * DESTINO é o alvo TRAVADO — NUNCA um arg do modelo (fecha exfiltração, TC-5).
   */
  private async runSend(input: Readonly<Record<string, unknown>>): Promise<ToolResult> {
    const text = String((input as { text?: unknown }).text ?? '').trim();
    if (text === '') {
      return { ok: false, observation: 'telegram_send: "text" é obrigatório.' };
    }
    // C3 — sem conversa travada ⇒ NÃO há onde responder. Recusa (o modelo NÃO pode inventar
    // um destino: o ref vem do ingresso allowlistado, não do argumento).
    const target = this.lockedConversation;
    if (target === undefined) {
      return {
        ok: false,
        observation:
          'telegram_send: nenhuma conversa de Telegram ativa — só dá para responder ' +
          'depois que o dono te escreve pelo Telegram.',
      };
    }
    // C4 — catraca ANTES do envio. Estouro ⇒ NEGA (não enfileira), evitando flood/custo.
    if (!this.egressLimiter.tryConsume(this.now())) {
      return {
        ok: false,
        observation:
          'telegram_send: teto anti-spam atingido (muitos envios no último minuto) — ' +
          'envio NEGADO. Espere antes de tentar de novo.',
      };
    }
    try {
      // O alvo é o TRAVADO — a porta `send` o usa como `conversation`. NUNCA um arg.
      await this.connector.send({ content: text, conversation: target });
      return { ok: true, observation: 'mensagem enviada na conversa de Telegram corrente.' };
    } catch (err) {
      // C1 — falha de envio: REDIGE antes de qualquer observação/log (a msg pode ecoar a URL
      // com o token). O modelo vê só a falha redigida.
      return { ok: false, observation: `telegram_send: falha ao enviar — ${this.safe(err)}` };
    }
  }

  /** Encerra o pump (chamado no teardown da sessão) — cancela o long-poll do connector. */
  stop(): void {
    this.ac.abort();
  }

  /** C1 — torna QUALQUER erro seguro p/ log: extrai a msg e REDIGE o token (defesa em prof). */
  private safe(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.redactor.safeForLog(raw);
  }
}

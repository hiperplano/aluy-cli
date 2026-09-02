// Bridge Telegram (ADR-0154 / ADR-0154) — a ATIVAÇÃO da bridge: liga o `TelegramConnector`
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
   * Chamado quando o pump DESISTE (estourou o teto de tentativas). É o gancho para a
   * sessão AVISAR o dono na tela — sem ele a morte da ponte volta a ser silenciosa, que é
   * o defeito que este mecanismo existe para corrigir.
   */
  readonly aoParar?: (motivo: string) => void;
  /**
   * ACK VISUAL do ingresso — reage à mensagem do dono no próprio Telegram.
   *
   * Pedido dele em 01/09 ("ele não deveria marcar a msg quando é lida") e resposta direta
   * ao que mais doeu no dia: uma mensagem descartada sumia sem sinal NENHUM, e ele só
   * descobria lendo arquivo. Com o ACK, o retorno chega no celular — 👀 aceita, 🚫
   * descartada — sem depender de log nem de resposta do agente.
   *
   * Porta opcional: ausente ⇒ comportamento de hoje (sem ACK), zero regressão.
   */
  readonly ack?: (chatId: number, messageId: number, emoji: '👀' | '🚫') => void;
  /**
   * "DIGITANDO…" no canal enquanto o agente trabalha (`sendChatAction`).
   *
   * Pedido do dono em 02/09: "nem mostra que tá digitando uma resposta". Um turno dele
   * levou 42s — sem sinal nenhum, o celular fica mudo e a impressão é de que nada chegou.
   *
   * Porta opcional: ausente ⇒ comportamento de hoje, zero regressão.
   */
  readonly digitando?: (chatId: number) => void;
  /**
   * Recuo (ms) da N-ésima tentativa. Injetável só p/ TESTE: com o recuo real (1s, 2s,
   * 4s…) provar o reinício custaria segundos de suíte por caso. Ausente ⇒ o recuo real.
   */
  readonly recuoMs?: (tentativa: number) => number;
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
/**
 * RECUO do pump entre tentativas de reerguer o long-poll. Dobra a cada queda até o teto.
 * Base curta porque a queda típica é transitória (rede oscilou, 409 de outro cliente) e
 * o dono espera a ponte de volta em segundos, não em minutos.
 */
/** Intervalo do batimento do "digitando" — o indicador expira em ~5s no Telegram. */
const DIGITANDO_INTERVALO_MS = 4_000;

/** Teto de batimentos (~2 min). Ver `iniciarDigitando` para o porquê de haver teto. */
const DIGITANDO_MAX_BATIMENTOS = 30;

const PUMP_RECUO_BASE_MS = 1_000;
const PUMP_RECUO_MAX_MS = 30_000;

/**
 * Teto de tentativas seguidas. Existe para que uma falha PERMANENTE (token revogado ⇒
 * 401 eterno) não fique escondida atrás de reconexões infinitas: estourado o teto,
 * paramos e AVISAMOS. Um ingresso bem-sucedido zera o contador, então uma ponte saudável
 * nunca chega perto disto.
 */
const PUMP_MAX_TENTATIVAS = 8;

export class TelegramBridge {
  /** NÃO-`readonly`: o pump o RECRIA quando o long-poll cai (iterador consumido). */
  private connector: Connector;
  private readonly allowlist: ReadonlySet<ConversationRef>;
  private readonly sink: IngressSink;
  private readonly redactor: TokenRedactor;
  private readonly egressLimiter: EgressRateLimiter;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  /** O AbortController do long-poll — `abort()` encerra o pump junto com a sessão. */
  private readonly ac = new AbortController();

  /** Fábrica do connector — guardada p/ RECRIAR o long-poll numa queda (ver `pump`). */
  private readonly connectorFactory: (signal: AbortSignal) => Connector;

  /**
   * O pump está DE FATO drenando o long-poll agora?
   *
   * Existe porque "ponte ativa" passou a ser mentira: o `/telegram status` respondia
   * ATIVA olhando só se o OBJETO da ponte existia. O dono levou exatamente isso em 01/09
   * — "mandei uma msg, ele não viu; mandei outra, apareceu; a terceira e a quarta, nada" —
   * e a medição confirmou: o processo da sessão segurava ZERO conexões TCP, ou seja,
   * nenhum long-poll no ar, enquanto a tela dizia "ponte ATIVA (1 chat autorizado)".
   */
  private polling = false;

  /** Quantas vezes o long-poll caiu e foi reerguido nesta sessão (diagnóstico honesto). */
  private reinicios = 0;

  /** Último motivo de queda, JÁ REDIGIDO (C1). `undefined` ⇒ nunca caiu. */
  private ultimaQueda: string | undefined;

  /** Ver `TelegramBridgeOptions.aoParar`. */
  private readonly aoParar: ((motivo: string) => void) | undefined;

  /** Ver `TelegramBridgeOptions.ack`. */
  private readonly ack:
    | ((chatId: number, messageId: number, emoji: '👀' | '🚫') => void)
    | undefined;

  /** Ver `TelegramBridgeOptions.digitando`. */
  private readonly digitando: ((chatId: number) => void) | undefined;

  /** Batimento do "digitando" — o indicador do Telegram expira em ~5s. */
  private batimentoDigitando: ReturnType<typeof setInterval> | undefined;

  /** Ver `TelegramBridgeOptions.recuoMs`. */
  private readonly recuoMs: (tentativa: number) => number;
  /**
   * C3 — o ALVO TRAVADO do egresso: o `ConversationRef` do ÚLTIMO chat allowlistado que
   * mandou uma INSTRUÇÃO. O `telegram_send` responde AQUI — nunca a um destino do modelo.
   * `undefined` até o primeiro ingresso autorizado (aí a tool recusa: não há onde responder).
   */
  private lockedConversation: ConversationRef | undefined;

  constructor(opts: TelegramBridgeOptions) {
    // A fábrica captura o signal do AbortController interno ⇒ o connector já nasce cancelável
    // por `this.stop()` (sem dependência circular nem re-troca de porta em runtime).
    // GUARDADA (não só usada e descartada): o pump precisa dela para RECRIAR o connector
    // quando o long-poll cai — um iterador já consumido não volta a produzir.
    this.connectorFactory = opts.connectorFactory;
    this.connector = opts.connectorFactory(this.ac.signal);
    this.allowlist = opts.allowlist;
    this.sink = opts.sink;
    this.redactor = opts.redactor;
    this.egressLimiter =
      opts.egressLimiter ?? new EgressRateLimiter(TELEGRAM_EGRESS_MAX, TELEGRAM_EGRESS_WINDOW_MS);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.aoParar = opts.aoParar;
    this.ack = opts.ack;
    this.digitando = opts.digitando;
    this.recuoMs =
      opts.recuoMs ??
      ((t) => Math.min(PUMP_RECUO_MAX_MS, PUMP_RECUO_BASE_MS * 2 ** Math.max(0, t - 1)));
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
    // DIÁRIO de TODA decisão, não só do descarte. Antes só o `discard` era registrado, e
    // num destino invisível (stderr sob a TUI): quando a mensagem chegava e não
    // aparecia, não dava para saber SE chegou, COMO foi classificada, nem onde se
    // perdeu. O dono passou um dia nesse escuro. METADADOS apenas — o texto é dele e
    // não vai p/ disco; o tamanho basta para casar com o que ele mandou.
    this.log(
      `[telegram] ingresso: ${decision.kind} · chat=${msg.conversation} · ` +
        `${String((msg.content ?? '').length)} chars`,
    );
    // ACK VISUAL no próprio Telegram — ver `TelegramBridgeOptions.ack`. Best-effort e
    // SEM `await`: o ACK jamais pode atrasar (nem impedir) o processamento da mensagem.
    // `chat` vem do ingresso, nunca do modelo; o emoji é de conjunto fechado.
    if (this.ack !== undefined && msg.messageId !== undefined) {
      const chat = Number(msg.conversation);
      if (Number.isFinite(chat)) {
        this.ack(chat, msg.messageId, decision.kind === 'discard' ? '🚫' : '👀');
      }
    }
    switch (decision.kind) {
      case 'instruction':
        // "digitando…" JÁ — antes de o modelo pensar. É o sinal de que a mensagem chegou.
        this.iniciarDigitando(Number(msg.conversation));
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

  /** Espera cancelável — não segura o processo se a sessão encerrar no meio. */
  private async espera(ms: number): Promise<void> {
    if (this.ac.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const id = setTimeout(resolve, ms);
      this.ac.signal.addEventListener('abort', () => {
        clearTimeout(id);
        resolve();
      });
    });
  }

  /**
   * O PUMP do long-poll: drena `connector.incoming()` e roteia CADA mensagem pela malha
   * (C2). Encerra SÓ quando o sinal aborta (fim da sessão).
   *
   * POR QUE HÁ UM LAÇO EXTERNO. A versão anterior era um `for await` único dentro de um
   * `try`: qualquer erro — ou o simples FIM do iterador — caía no `catch`, escrevia uma
   * linha no stderr e RETORNAVA. Não havia reinício. Numa TUI o stderr é engolido pela
   * tela, então a ponte morria para o resto da sessão sem UM sinal sequer, e o
   * `/telegram status` continuava anunciando "ponte ATIVA" (ele olhava só se o OBJETO
   * existia). O dono descreveu o sintoma com precisão em 01/09: "mandei uma msg, ele não
   * viu; mandei outra, apareceu e respondeu; mandei uma terceira e quarta e nada" — e a
   * medição fechou: ZERO conexões TCP no processo da sessão, nenhum long-poll no ar.
   *
   * Um long-poll cai por motivo BANAL e transitório (rede oscilou, 409 quando outro
   * cliente pediu `getUpdates`, o servidor cortou a conexão). Morrer de vez por causa
   * disso é desproporcional: reerguemos com espera crescente, e um ingresso bem-sucedido
   * zera o contador. O connector é RECRIADO a cada tentativa — um iterador já consumido
   * não volta a produzir, e reusar o antigo daria um laço girando em falso.
   *
   * O teto existe para não esconder um defeito PERMANENTE (token revogado ⇒ 401 eterno)
   * atrás de reconexões infinitas: estourado o teto, paramos e AVISAMOS — que é o oposto
   * do silêncio que este bloco veio corrigir.
   */
  async pump(): Promise<void> {
    let tentativa = 0;
    while (!this.ac.signal.aborted) {
      try {
        this.polling = true;
        for await (const msg of this.connector.incoming()) {
          if (this.ac.signal.aborted) break;
          tentativa = 0; // chegou mensagem ⇒ a conexão está sã: zera o recuo
          try {
            this.route(msg);
          } catch (err) {
            // C1 — NUNCA loga `err` cru: a msg pode ecoar a URL `…/bot<token>/…`. Redige.
            this.log(`[telegram] erro ao rotear ingresso: ${this.safe(err)}`);
          }
        }
        // FIM LIMPO do iterador. NÃO reerguemos aqui, e a razão veio dos testes: o
        // connector REAL (`client.stream`) só sai do laço em ABORT, então "terminou sem
        // erro e sem abort" não acontece em produção. Reerguer neste ramo só fazia os
        // dublês FINITOS da suíte girarem para sempre — 4 testes deste repo passaram a
        // pendurar 135s cada. Eles estavam certos e a minha primeira versão exagerou.
        // O que NÃO se repete é o silêncio: encerrar aqui vira aviso.
        if (this.ac.signal.aborted) break;
        this.polling = false;
        this.ultimaQueda = 'o long-poll terminou sozinho';
        this.log('[telegram] long-poll terminou sozinho — a ponte parou de receber.');
        this.aoParar?.(this.ultimaQueda);
        return;
      } catch (err) {
        // C1 — idem p/ a falha do PRÓPRIO long-poll: o que vai pro log está REDIGIDO.
        this.ultimaQueda = this.safe(err);
      }
      this.polling = false;
      if (this.ac.signal.aborted) break;
      tentativa += 1;
      this.reinicios += 1;
      if (tentativa > PUMP_MAX_TENTATIVAS) {
        this.log(
          `[telegram] long-poll caiu ${String(tentativa)}× seguidas e NÃO voltou ` +
            `(${this.ultimaQueda ?? 'motivo desconhecido'}) — a ponte parou de receber.`,
        );
        this.aoParar?.(this.ultimaQueda ?? 'motivo desconhecido');
        return;
      }
      const recuo = this.recuoMs(tentativa);
      this.log(
        `[telegram] long-poll caiu (${this.ultimaQueda ?? '?'}) — ` +
          `reerguendo em ${String(Math.round(recuo / 1000))}s (tentativa ${String(tentativa)}).`,
      );
      await this.espera(recuo);
      if (this.ac.signal.aborted) break;
      // Connector NOVO: o anterior já foi consumido e não volta a produzir.
      this.connector = this.connectorFactory(this.ac.signal);
    }
    this.polling = false;
  }

  /** Diagnóstico HONESTO da ponte — o que o `/telegram status` precisa para não mentir. */
  get diagnostico(): {
    readonly polling: boolean;
    readonly reinicios: number;
    readonly ultimaQueda?: string;
  } {
    return {
      polling: this.polling,
      reinicios: this.reinicios,
      ...(this.ultimaQueda !== undefined ? { ultimaQueda: this.ultimaQueda } : {}),
    };
  }

  /**
   * Liga o "digitando…" no canal e o REPETE — o indicador do Telegram expira em ~5s, então
   * um único disparo sumiria antes de o agente terminar (um turno do dono levou 42s).
   *
   * O TETO existe porque nada aqui sabe quando o turno acaba de verdade: a resposta pode
   * sair por `telegram_send` (e aí `pararDigitando` corta), mas também pode não sair nunca
   * — turno que falha, que responde só no terminal, ou que o dono interrompe. Sem teto, o
   * "digitando" ficaria eterno, que é pior que não ter: viraria mentira permanente.
   */
  private iniciarDigitando(chatId: number): void {
    if (this.digitando === undefined) return;
    this.digitando(chatId);
    let restantes = DIGITANDO_MAX_BATIMENTOS;
    this.batimentoDigitando = setInterval(() => {
      restantes -= 1;
      if (restantes <= 0 || this.ac.signal.aborted) {
        this.pararDigitando();
        return;
      }
      this.digitando?.(chatId);
    }, DIGITANDO_INTERVALO_MS);
    // `unref`: o batimento JAMAIS pode segurar o processo vivo no encerramento — foi
    // exatamente um handle esquecido que fez o Ctrl-C demorar 2,2s (ver `descartar-corpo`).
    this.batimentoDigitando.unref?.();
  }

  /** Corta o "digitando". Idempotente. */
  private pararDigitando(): void {
    if (this.batimentoDigitando !== undefined) {
      clearInterval(this.batimentoDigitando);
      this.batimentoDigitando = undefined;
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
    // A resposta saiu ⇒ o "digitando" cumpriu seu papel e para agora, sem esperar o teto.
    this.pararDigitando();
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

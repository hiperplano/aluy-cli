// Padrão genérico de CONECTORES (ADR-0135) — a PORTA `Connector` portável e seus tipos.
// Vivem no @hiperplano/aluy-cli-core: SEM Ink, SEM `fetch` concreto, SEM detalhe de rede
// (o I/O é injetado por um runtime concreto no @hiperplano/aluy-cli). Espelha a fronteira
// cli-core×cli do ADR-0053 §8.
//
// Um conector (Telegram, Slack, e-mail…) só fornece TRANSPORTE + IDENTIDADE; a "malha"
// (mesh.ts) é dona da FRONTEIRA DE CONFIANÇA, da allowlist, da injeção na sessão, do
// registro da tool `<connector>_send`, do roteamento da confirmação `ask` ao canal e da
// catraca. As invariantes de segurança (TC-1..TC-8) são HERDADAS por todo conector.
//
// ⚠️ INERTE: a porta e os tipos são introduzidos aqui; o wiring a `--connector`/`--telegram`
//    e o I/O concreto esperam o resto da bridge + a revisão de segurança que o ADR exige.

/** Id opaco do remetente, autenticado pelo transporte (chat-id, user-id, e-mail…). */
export type SenderId = string;

/** Referência opaca da conversa/canal de origem (p/ responder no mesmo lugar + allowlist). */
export type ConversationRef = string;

/**
 * Proveniência da mensagem — distingue o que o DONO escreveu do que é conteúdo de
 * TERCEIRO embutido. Quem CLASSIFICA (instrução×dado×descarte) é a malha; o conector
 * só DESCREVE a proveniência (ADR-0135 §1.a).
 */
export type Provenance =
  | {
      /** O dono escreveu o `content`. Pode conter um trecho de terceiro embutido (forward/quote). */
      readonly kind: 'author-direct';
      /** Texto de terceiro citado/encaminhado DENTRO da msg do dono ⇒ vira DADO sub-envelopado. */
      readonly embeddedThirdParty?: string;
    }
  | {
      /** A mensagem INTEIRA é repasse de terceiro (forward sem texto do dono) ⇒ DADO. */
      readonly kind: 'third-party-relayed';
    };

/** Uma mensagem que CHEGA de um canal externo (ingresso). Tipos portáveis (ADR-0135 §1). */
export interface IncomingMessage {
  /** Conteúdo (texto — v1). */
  readonly content: string;
  /** Id do remetente, autenticado pelo transporte. */
  readonly sender: SenderId;
  /** Conversa/canal de origem (alvo da resposta + chave de allowlist). */
  readonly conversation: ConversationRef;
  /** Proveniência (autor-direto × terceiro-embutido). */
  readonly provenance: Provenance;
  /**
   * O remetente é um BOT? (TC-6) — usado pela malha p/ DESCARTAR auto-mensagem / mensagem
   * de bot, fechando o loop "bot reprocessa a própria resposta". O dono (v1) é humano, então
   * qualquer remetente-bot é descartado. O conector preenche (ex.: `from.is_bot` do Telegram).
   */
  readonly senderIsBot?: boolean;
}

/** Uma resposta a ENVIAR de volta ao canal (egresso). O alvo NÃO é arbitrário (§1.b). */
export interface OutgoingMessage {
  readonly content: string;
  readonly conversation: ConversationRef;
}

/** Metadados do conector (registry §3). */
export interface ConnectorMeta {
  /** Id único do conector (`telegram`, `slack`…). Nome da tool = `<id>_send`. */
  readonly id: string;
  /** Nome de exibição. */
  readonly displayName: string;
  /**
   * O transporte autentica o remetente de forma NÃO-forjável? `false` p/ Telegram
   * (from-id assinado pelo servidor). `true` (ex.: e-mail sem DKIM forte) ⇒ a malha
   * trata TODO o ingresso como DADO (degradação segura, TC-1) — nunca instrução.
   */
  readonly authIsForgeable: boolean;
}

/**
 * A PORTA `Connector` — contrato mínimo (ADR-0135 §1). O concreto implementa transporte +
 * identidade; o I/O (rede/keychain) é injetado. A malha consome esta porta.
 */
export interface Connector {
  readonly meta: ConnectorMeta;
  /** INGRESSO — fonte assíncrona de mensagens externas (long-poll/socket de saída). */
  incoming(): AsyncIterable<IncomingMessage>;
  /** EGRESSO — envia uma resposta ao canal da conversa corrente (sem destino arbitrário). */
  send(reply: OutgoingMessage): Promise<void>;
}

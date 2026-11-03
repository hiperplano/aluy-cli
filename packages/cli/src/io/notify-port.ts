// EST-0963 — PORTA de NOTIFICAÇÃO (inspirada no OpenCode): avisa o usuário quando
// o agente PRECISA DE ATENÇÃO enquanto ele está noutra janela.
//
// É uma preocupação de IO/terminal — por isso vive no @hiperplano/aluy-cli (locus concreto),
// nunca no core portável. Dois canais, ambos best-effort e DEGRADAÇÃO SILENCIOSA:
//   1. BELL do terminal (`\a` / BEL): o sino padrão. Faz o terminal piscar/tocar e,
//      em muitos gerenciadores de janela, marca a aba/janela como "tem novidade".
//   2. OSC 9 (`ESC ] 9 ; <texto> BEL`): notificação de DESKTOP best-effort —
//      iTerm2 e alguns terminais a exibem como banner do SO. Onde não há suporte,
//      o terminal IGNORA a sequência (não imprime lixo na tela). Sem dep pesada de
//      SO (nenhum node-notifier/dbus): é só uma sequência de bytes no stdout.
//
// SÓ TTY: em pipe/CI/linear, NADA é emitido (não polui o stream nem o log). O OSC
// (que é uma sequência de escape ANSI, "cor" no sentido amplo) é GATED por TTY E
// pode ser desligado por `NO_COLOR` — o BEL não é cor (é um sinal sonoro/atenção),
// então NO_COLOR não o silencia, mas o gate de TTY e o toggle do usuário sim.
//
// TEXTO NEUTRO: a notificação NUNCA carrega conteúdo da conversa, objetivo, path,
// tool nem segredo — só rótulos fixos ("Aluy precisa de você" / "turno concluído").
// O canal de notificação do SO pode aparecer na tela de bloqueio / histórico do SO;
// vazar conteúdo ali seria um furo (CLI-SEC). Por isso a mensagem é uma CONSTANTE.

/** BEL — o sino do terminal (ASCII 7). Pisca/toca; marca a aba como ativa. */
const BEL = '\x07';
/** Início do OSC 9 (notificação de desktop iTerm/etc). `ESC ] 9 ;`. */
const OSC9_PREFIX = '\x1b]9;';

/** O motivo da notificação — vira o rótulo NEUTRO exibido (sem vazar conteúdo). */
export type NotifyReason = 'attention' | 'done';

/**
 * Modo de notificação (preferência do usuário):
 *  - `tudo`    — atenção ("precisa de você") + turno concluído (o padrão);
 *  - `atencao` — só quando o Aluy precisa de você; turno concluído fica mudo;
 *  - `nada`    — silêncio total.
 */
export type NotifyMode = 'tudo' | 'atencao' | 'nada';

export const NOTIFY_MODES: readonly NotifyMode[] = ['tudo', 'atencao', 'nada'];

/**
 * Interpreta um texto como modo. Aceita os 3 modos (com/sem acento) e os legados:
 * on/1/true/yes/ligar ⇒ `tudo`; off/0/false/no/desligar ⇒ `nada`. Desconhecido ⇒
 * `undefined` (quem chama decide o fallback).
 */
export function parseNotifyMode(v: string | undefined): NotifyMode | undefined {
  if (v === undefined) return undefined;
  const s = v.trim().toLowerCase();
  if (s === 'tudo' || s === 'on' || s === '1' || s === 'true' || s === 'yes' || s === 'ligar')
    return 'tudo';
  if (s === 'atencao' || s === 'atenção') return 'atencao';
  if (s === 'nada' || s === 'off' || s === '0' || s === 'false' || s === 'no' || s === 'desligar')
    return 'nada';
  return undefined;
}

/** O modo deixa passar este motivo? (`done` só no `tudo`; `attention` salvo no `nada`.) */
export function modeAllows(mode: NotifyMode, reason: NotifyReason): boolean {
  if (mode === 'nada') return false;
  return reason === 'attention' || mode === 'tudo';
}

/** Rótulos FIXOS por motivo. Nunca interpolam dado da sessão (texto neutro). */
export const NOTIFY_LABELS: Readonly<Record<NotifyReason, string>> = {
  attention: 'Aluy precisa de você',
  done: 'Aluy — turno concluído',
};

/**
 * A PORTA que o observador (notify-observer.ts) chama. Mínima de propósito: o
 * observador decide QUANDO/POR QUÊ; a porta decide COMO emitir (BEL/OSC) e se está
 * habilitada. `notify` é best-effort e NUNCA lança (um erro de escrita no stdout
 * jamais derruba a sessão por causa de um sino).
 */
export interface NotificationPort {
  /** Emite a notificação do motivo dado (se habilitada e em TTY). Best-effort. */
  notify(reason: NotifyReason): void;
  /** `true` se a notificação está ligada agora (toggle + TTY). */
  readonly enabled: boolean;
  /** Modo corrente (preferência), independente de TTY. */
  readonly mode: NotifyMode;
  /** Liga (`tudo`) / desliga (`nada`) em runtime. Sem efeito fora de TTY. */
  setEnabled(on: boolean): void;
  /** Troca o modo em runtime (comando `/notify`). */
  setMode(mode: NotifyMode): void;
}

export interface TerminalNotificationPortOptions {
  /**
   * Sink de escrita (injetável p/ teste). Em produção é `process.stdout.write`.
   * A porta só escreve sequências curtas de controle; nunca conteúdo.
   */
  readonly write: (s: string) => void;
  /**
   * `true` se a saída é um TTY interativo. Fora de TTY a porta é INERTE (nem BEL
   * nem OSC) — não polui pipe/CI. Default `false` (seguro: silêncio).
   */
  readonly isTty?: boolean;
  /** Estado inicial do toggle (do env `ALUY_NOTIFY`). Default `true`. */
  readonly enabled?: boolean;
  /** Modo inicial. Tem precedência sobre `enabled` quando informado. */
  readonly mode?: NotifyMode;
  /**
   * Emitir OSC 9 (desktop-notify best-effort)? Gated por TTY E por `NO_COLOR` (o
   * OSC é uma sequência de escape). Default `true`. O BEL é independente disto.
   */
  readonly desktop?: boolean;
}

/**
 * Implementação concreta da porta: escreve BEL + (best-effort) OSC 9 no sink.
 * SEM estado de conversa, SEM dep de SO. Tudo gated por TTY + toggle.
 */
export class TerminalNotificationPort implements NotificationPort {
  private readonly write: (s: string) => void;
  private readonly isTty: boolean;
  private readonly desktop: boolean;
  private modeValue: NotifyMode;

  constructor(opts: TerminalNotificationPortOptions) {
    this.write = opts.write;
    this.isTty = opts.isTty ?? false;
    this.desktop = opts.desktop ?? true;
    this.modeValue = opts.mode ?? (opts.enabled === false ? 'nada' : 'tudo');
  }

  get enabled(): boolean {
    // Fora de TTY a porta está SEMPRE efetivamente desligada (nunca emite), mesmo
    // que o toggle do usuário esteja "on" — o gate de TTY vence. Isso mantém o
    // contrato "/notify on não faz nada num pipe" honesto na própria leitura.
    return this.modeValue !== 'nada' && this.isTty;
  }

  get mode(): NotifyMode {
    return this.modeValue;
  }

  setEnabled(on: boolean): void {
    this.modeValue = on ? 'tudo' : 'nada';
  }

  setMode(mode: NotifyMode): void {
    this.modeValue = mode;
  }

  notify(reason: NotifyReason): void {
    // Gate duro: só TTY + toggle ligado. Fora disso, silêncio TOTAL (sem BEL/OSC).
    if (!this.enabled || !modeAllows(this.modeValue, reason)) return;
    const label = NOTIFY_LABELS[reason];
    try {
      // 1) BEL — sempre que habilitado e em TTY. É o sinal universal de atenção.
      this.write(BEL);
      // 2) OSC 9 — desktop-notify best-effort. Onde não há suporte, é ignorado
      //    pelo terminal (sem lixo). Gated por `desktop` (que já honra NO_COLOR no
      //    wiring). O label é NEUTRO; nunca conteúdo da sessão.
      if (this.desktop) {
        this.write(`${OSC9_PREFIX}${label}${BEL}`);
      }
    } catch {
      // Best-effort: uma falha de escrita no stdout (pipe quebrado num race de
      // shutdown, etc.) NUNCA derruba a sessão por causa de um sino. Silencioso.
    }
  }
}

/** Porta NO-OP (toggle off de fábrica / contexto sem TTY) — nunca emite nada. */
export const NO_OP_NOTIFICATION_PORT: NotificationPort = {
  notify: () => {},
  enabled: false,
  mode: 'nada',
  setEnabled: () => {},
  setMode: () => {},
};

/** Config resolvida do env p/ a notificação (sem tocar `process` aqui — recebe env). */
export interface NotifyConfig {
  /** Estado inicial do toggle. `ALUY_NOTIFY=0` (ou false/off/no) ⇒ desligado. */
  readonly enabled: boolean;
  /** Modo efetivo: env `ALUY_NOTIFY` > config salva > `tudo`. */
  readonly mode: NotifyMode;
  /** Emitir OSC 9 (desktop)? `NO_COLOR` desliga o OSC (é sequência de escape). */
  readonly desktop: boolean;
}

/**
 * Resolve a config de notificação. Precedência: env `ALUY_NOTIFY` (3 modos ou
 * legados on/off/0/1) > `saved` (config.json `notify`) > `tudo`. `NO_COLOR` desliga
 * o OSC (desktop) mas NÃO o BEL — o sino não é cor. Puro: recebe o `env`.
 */
export function loadNotifyConfig(
  env: NodeJS.ProcessEnv = process.env,
  saved?: NotifyMode,
): NotifyConfig {
  const mode = parseNotifyMode(env.ALUY_NOTIFY) ?? saved ?? 'tudo';
  // NO_COLOR (qualquer valor, até vazio) desliga o canal de escape OSC 9.
  const desktop = env.NO_COLOR === undefined;
  return { enabled: mode !== 'nada', mode, desktop };
}

// EST-0966 · /theme — AUTO-DETECÇÃO do fundo do terminal via OSC 11.
//
// Inspiração OpenCode: na inicialização, perguntamos ao terminal qual é a sua cor
// de FUNDO e escolhemos dark/light por conta própria — sem o usuário configurar.
// O mecanismo é a sequência de controle XTerm OSC 11:
//
//   query:    ESC ] 11 ; ? BEL        (ou ESC ] 11 ; ? ST, onde ST = ESC \)
//   resposta: ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL   (componentes 1–4 dígitos hex)
//
// É BEST-EFFORT e DEGRADA EM SILÊNCIO:
//   · Só TTY (sem TTY não há terminal a quem perguntar → default dark).
//   · NO_COLOR / não-interativo ⇒ nem pergunta (respeita a preferência do usuário).
//   · Timeout curto: terminais sem suporte simplesmente não respondem; não travamos
//     o boot esperando — caímos no default dark.
//
// Este módulo separa o PURO (parse + luminância → brightness, 100% testável) do
// I/O de TTY (a consulta), que é fino e fácil de injetar/mockar nos testes.

import type { Brightness } from './theme.js';

/** Sequência de consulta OSC 11 (pergunta a cor de fundo; resposta termina em BEL).
 *  `ESC ] 11 ; ? BEL` — XTerm responde com `ESC ] 11 ; rgb:RRRR/GGGG/BBBB BEL`. */
export const OSC11_QUERY = '\x1b]11;?\x07';

/**
 * EST-1010 — sequência que RESETA o fundo do terminal ao default do usuário.
 * `ESC ] 111 BEL` (OSC 111 = reset dynamic background color). Emitida no exit p/ NÃO
 * deixar o terminal do usuário com o fundo do tema do `aluy` "grudado". Terminais sem
 * suporte ignoram (degrada em silêncio, sem erro).
 */
export const OSC11_RESET = '\x1b]111\x07';

/**
 * EST-1010 — monta a sequência OSC 11 que SETA o fundo do terminal p/ a cor `hex`
 * (`#RRGGBB`). XTerm e a maioria dos terminais modernos aceitam `ESC ] 11 ; #RRGGBB
 * BEL`; mantemos o `#RRGGBB` (forma mais portável que `rgb:RR/GG/BB`). Hex inválido
 * ⇒ `''` (não emite lixo — o caller simplesmente não muda o fundo). PURO (sem I/O):
 * o controller decide SE/QUANDO escrever (e respeita o opt-out `ALUY_SET_BG=0`).
 */
export function setBackgroundSeq(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return '';
  return `\x1b]11;#${m[1]!.toUpperCase()}\x07`;
}

/**
 * EST-1010 — decide se o CLI pode MEXER no fundo do terminal (OSC 11). Opt-out
 * explícito `ALUY_SET_BG=0`/`false` ⇒ NÃO mexe (quem não quer que o `aluy` altere o
 * fundo do seu terminal). NO_COLOR ⇒ também não mexe (a11y: não impor cor de fundo a
 * quem pediu sem-cor). Default: liga (o pedido central do Tiago — mudar o fundo por
 * tema). PURO: só lê o env. (O caller ainda exige TTY antes de escrever de fato.)
 */
export function backgroundControlEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.NO_COLOR !== undefined) return false;
  const v = env.ALUY_SET_BG;
  if (v === undefined) return true;
  const t = v.trim().toLowerCase();
  return !(t === '0' || t === 'false' || t === 'no' || t === 'off');
}

/** Dependências mínimas p/ aplicar/resetar o fundo (injetáveis no teste). */
export interface BackgroundSink {
  /** stdout p/ escrever a sequência (precisa ser TTY p/ valer a pena). */
  readonly stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
  /** Variáveis de ambiente (opt-out ALUY_SET_BG / NO_COLOR). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * EST-1010 — CONTROLADOR do fundo do terminal via OSC 11. Aplica o `bg` do tema ao
 * trocar/montar e RESETA no exit, UMA sequência por evento (não por frame — não
 * regride o flicker #95/#118). Respeita o opt-out (`ALUY_SET_BG=0`), NO_COLOR e a
 * ausência de TTY: nesses casos vira no-op total (nenhuma sequência escrita). Degrada
 * gracioso: terminal que ignora OSC 11 só não muda o fundo — nenhum erro.
 *
 * Idempotência: `reset()` só emite se ALGUM `apply()` chegou a escrever (não "reseta"
 * um fundo que nunca tocamos) e só uma vez (flag) — seguro chamar no `finally` e no
 * handler de sinal sem duplicar.
 */
export class BackgroundController {
  private readonly stdout: BackgroundSink['stdout'];
  private readonly enabled: boolean;
  /** Já escrevemos algum SET? (só então o reset faz sentido.) */
  private applied = false;
  /** Já resetamos? (idempotência entre finally + sinal.) */
  private didReset = false;

  constructor(sink: BackgroundSink) {
    const env = sink.env ?? process.env;
    this.stdout = sink.stdout;
    // Liga só com TTY + opt-in efetivo (default on, salvo ALUY_SET_BG=0 / NO_COLOR).
    this.enabled = sink.stdout.isTTY === true && backgroundControlEnabled(env);
  }

  /** `true` se o controlador vai de fato escrever (TTY + opt-in). P/ o caller logar/testar. */
  get active(): boolean {
    return this.enabled;
  }

  /**
   * SETA o fundo do terminal p/ a cor `hex` do tema (no-op se desligado ou hex
   * inválido). Chamado no boot e a cada troca de tema — 1 sequência, não por frame.
   * Devolve a sequência escrita (`''` se nada), p/ teste/observabilidade.
   */
  apply(hex: string): string {
    if (!this.enabled) return '';
    const seq = setBackgroundSeq(hex);
    if (seq === '') return '';
    this.stdout.write(seq);
    this.applied = true;
    // Uma nova aplicação reabre a possibilidade de reset (ex.: troca de tema após reset
    // teórico não acontece, mas mantemos o invariante simples e correto).
    this.didReset = false;
    return seq;
  }

  /**
   * RESETA o fundo ao default do usuário no exit. No-op se nunca aplicamos nada
   * (não bagunçamos um terminal que não tocamos) ou se já resetamos. Idempotente:
   * seguro chamar no `finally` E no handler de SIGINT/SIGTERM. Devolve a sequência.
   */
  reset(): string {
    if (!this.enabled || !this.applied || this.didReset) return '';
    this.didReset = true;
    this.stdout.write(OSC11_RESET);
    return OSC11_RESET;
  }
}

/** Limiar de luminância relativa (0–1) acima do qual o fundo é considerado CLARO. */
// 0.5 separa bem fundos escuros (preto/cinza-escuro ~0) de claros (branco/creme ~1).
const LIGHT_LUMINANCE_THRESHOLD = 0.5;

/** Uma cor RGB decodificada (componentes 0–255). */
export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Faz o parse de uma resposta OSC 11 do terminal e extrai o RGB do fundo. Aceita as
 * formas comuns: `rgb:RRRR/GGGG/BBBB` (1–4 dígitos hex por componente, como o XTerm
 * devolve) e `#RRGGBB`. Tolera o prefixo `ESC]11;` e o terminador BEL/ST. Devolve
 * `null` se não reconhecer (o caller cai no default). PURO — sem I/O.
 */
export function parseOsc11(raw: string): Rgb | null {
  if (!raw) return null;
  // Forma XTerm: rgb:hhhh/hhhh/hhhh (cada componente 1–4 dígitos hex).
  const rgbMatch = /rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(raw);
  if (rgbMatch) {
    return {
      r: scaleHexComponent(rgbMatch[1]!),
      g: scaleHexComponent(rgbMatch[2]!),
      b: scaleHexComponent(rgbMatch[3]!),
    };
  }
  // Forma hex curta: #RRGGBB (alguns terminais respondem assim).
  const hexMatch = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(raw);
  if (hexMatch) {
    return {
      r: parseInt(hexMatch[1]!, 16),
      g: parseInt(hexMatch[2]!, 16),
      b: parseInt(hexMatch[3]!, 16),
    };
  }
  return null;
}

/** Normaliza um componente hex de 1–4 dígitos (XTerm escala) p/ 0–255. */
function scaleHexComponent(hex: string): number {
  const value = parseInt(hex, 16);
  const max = 16 ** hex.length - 1; // ffff=65535, ff=255, f=15
  return Math.round((value / max) * 255);
}

/**
 * Luminância relativa percebida (0–1) de uma cor — fórmula WCAG (sRGB linearizado).
 * Usada p/ decidir se o fundo é claro o bastante p/ trocar p/ o tema light.
 */
export function relativeLuminance(rgb: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** Classifica um RGB de fundo em dark/light pela luminância (limiar 0.5). */
export function brightnessOf(rgb: Rgb): Brightness {
  return relativeLuminance(rgb) >= LIGHT_LUMINANCE_THRESHOLD ? 'light' : 'dark';
}

/**
 * Parse + classificação numa tacada: da resposta CRUA do OSC 11 ao `Brightness`.
 * `null` quando a resposta não é reconhecível (o caller mantém o default). PURO.
 */
export function brightnessFromOsc11(raw: string): Brightness | null {
  const rgb = parseOsc11(raw);
  return rgb ? brightnessOf(rgb) : null;
}

/** Dependências mínimas p/ a consulta de TTY (injetáveis no teste). */
export interface Osc11Probe {
  /** stdout p/ ESCREVER a query (precisa ser um TTY). */
  readonly stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
  /** stdin p/ LER a resposta do terminal (TTY com raw-mode). */
  readonly stdin: Pick<
    NodeJS.ReadStream,
    'isTTY' | 'on' | 'off' | 'setRawMode' | 'resume' | 'pause' | 'isRaw'
  >;
  /** Variáveis de ambiente (respeita NO_COLOR). Default: process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /** Timeout (ms) da espera pela resposta. Curto p/ não travar o boot. Default 120. */
  readonly timeoutMs?: number;
}

/**
 * Consulta o fundo do terminal via OSC 11 (BEST-EFFORT). Resolve com o `Brightness`
 * detectado, ou `null` se: não há TTY, NO_COLOR está setado, o terminal não responde
 * a tempo, ou a resposta é ininteligível. NUNCA rejeita nem trava — o caller usa o
 * `null` p/ manter o default dark. Só toca o TTY (raw-mode breve) quando há TTY.
 */
/**
 * Timeout (ms) do probe OSC 11. Em sessão remota (SSH) a consulta faz ida-e-volta
 * pela REDE, então um valor calibrado p/ terminal LOCAL estoura antes da resposta.
 * Default folgado (500ms local / 1000ms SSH); override por `ALUY_OSC11_TIMEOUT_MS`.
 */
export function defaultOsc11TimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ALUY_OSC11_TIMEOUT_MS;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return Math.min(n, 5000);
  }
  const ssh = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT);
  return ssh ? 1000 : 500;
}

export async function queryTerminalBrightness(probe: Osc11Probe): Promise<Brightness | null> {
  const env = probe.env ?? process.env;
  // NO_COLOR (https://no-color.org/): respeita a preferência — nem pergunta.
  if (env.NO_COLOR !== undefined) return null;
  // Só TTY dos dois lados: precisamos ESCREVER a query e LER a resposta.
  if (probe.stdout.isTTY !== true || probe.stdin.isTTY !== true) return null;

  const timeoutMs = probe.timeoutMs ?? defaultOsc11TimeoutMs(env);
  const stdin = probe.stdin;
  const wasRaw = stdin.isRaw === true;

  return await new Promise<Brightness | null>((resolve) => {
    let buf = '';
    let settled = false;
    // holder mutável p/ o timer (assignado após o setup; lido no cleanup via closure).
    const timerRef: { id?: ReturnType<typeof setTimeout> } = {};

    const cleanup = (): void => {
      if (timerRef.id) clearTimeout(timerRef.id);
      stdin.off('data', onData);
      // Restaura o estado do stdin que encontramos (não deixa o terminal em raw).
      try {
        if (!wasRaw) stdin.setRawMode(false);
        stdin.pause();
      } catch {
        // best-effort: alguns ambientes não permitem mexer no raw-mode.
      }
    };

    const finish = (result: Brightness | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const onData = (chunk: Buffer | string): void => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      // Tenta o parse a cada pedaço; o terminador (BEL/ST) chega no fim.
      const brightness = brightnessFromOsc11(buf);
      if (brightness !== null) finish(brightness);
    };

    try {
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on('data', onData);
      probe.stdout.write(OSC11_QUERY);
    } catch {
      // Terminal não deixa setar raw / escrever: degrada p/ default.
      finish(null);
      return;
    }

    // Timeout curto: terminal sem suporte não responde — não travamos o boot.
    // O timer SEGURA o event-loop de propósito: o boot AGUARDA o probe resolver (até
    // timeoutMs, curto). Sem isso (.unref antigo) o Node encerrava ANTES da resposta
    // chegar em terminal remoto/lento, e os bytes do OSC 11 vazavam no shell.
    timerRef.id = setTimeout(() => finish(null), timeoutMs);
  });
}

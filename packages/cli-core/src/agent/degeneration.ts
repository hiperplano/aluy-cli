// EST-0969 (anti-runaway · guarda de LOOP DEGENERADO) — detector de REPETIÇÃO
// degenerada no stream do modelo. PORTÁVEL (ADR-0053 §8): string/dado puro, sem
// Ink/IO de terminal, sem rede. Alimentado token-a-token (delta) pelo acumulador
// de stream (BrokerModelClient.call / StreamingModelCaller.call); quando dispara,
// o acumulador LANÇA `DegenerateLoopError`, o stream é abortado e o `AgentLoop`
// (pai E sub-agentes — mesma classe) converte num `stop:'degenerate'` com uma
// OBSERVAÇÃO clara (CLI-SEC-4: o desfecho volta como DADO, não como instrução).
//
// EST-1124 (MAESTRO-EMISSORES): antes de lançar o erro, emite um
// `SupervisorSignal` ao barramento do Maestro (se injetado). A emissão é ADITIVA
// — o freio DURO (lançar erro + abortar stream) segue intacto.
//
// POR QUE EXISTE (o furo que o heartbeat #67 NÃO pega): o heartbeat zera a
// inatividade a cada SINAL DE VIDA — e um modelo (esp. tier fraco) que cospe a
// MESMA linha pra sempre ESTÁ "vivo" (emitindo tokens), então o relógio nunca
// dispara. O budget de 1M tokens (CLI-SEC-8) só corta MUITO depois, desperdiçando
// tokens e cuspindo lixo. Esta guarda é COMPLEMENTAR: pega o caso "está
// progredindo em tokens, mas NÃO em CONTEÚDO" — a saída recente é dominada por
// uma repetição sem novidade. O Tiago viu `<<<EDIT_STDIN>/>/>` repetido 217+
// vezes (marcador ALUCINADO — nem existe no protocolo); o default abaixo pega
// esse caso muito antes do 217.
//
// NÃO confundir com:
//  - a guarda de MARKERS/parsing de tool-call (protocol.ts) — aquela é sobre
//    ESTRUTURA do bloco; esta é sobre o CONTEÚDO repetir, agnóstica a sintaxe;
//  - streaming normal — texto variado nunca dispara (ver a heurística abaixo);
//  - repetição LEGÍTIMA baixa (ex.: 5 linhas `},` num trecho de código) — os
//    limiares são ALTOS e exigem DOMÍNIO da saída recente, não um punhado de
//    linhas iguais espalhadas.

/**
 * Configuração da guarda anti-repetição. Defaults SÃOS que já pegam o caso do
 * Tiago (mesma linha dezenas de vezes / ciclo curto longo) sem falso-positivo em
 * código real. Configurável via env (ver {@link resolveDegenerationConfig}).
 */
export interface DegenerationConfig {
  /**
   * Quantas vezes a MESMA linha não-trivial pode repetir CONSECUTIVAMENTE antes
   * de disparar. Alto o bastante p/ não pegar blocos legítimos (`},`/fecha-bloco/linhas
   * em branco de código), baixo o bastante p/ cortar o degenerado bem antes do
   * budget. Default 25 (o caso do Tiago tinha 217+).
   */
  readonly maxConsecutiveLineRepeats: number;
  /**
   * Detecção de CICLO CURTO sem quebra de linha (ex.: `abcabcabc…`,
   * `<<<EDIT_STDIN>/>/>…` colado sem `\n`): dispara quando os últimos `cycleLen`
   * caracteres se repetem por um total ≥ `minCycleSpanChars`, varrendo períodos
   * de 1..`maxCycleLen`. Barato (janela limitada). Default: ciclo de até 80 chars
   * que ocupe ≥ 2_000 chars de saída sem novidade.
   */
  readonly maxCycleLen: number;
  readonly minCycleSpanChars: number;
  /**
   * Linhas curtas/triviais (após trim) com comprimento ≤ este valor NÃO contam p/
   * o gatilho de linha repetida — separam o sinal (uma linha de conteúdo de
   * verdade repetida) do ruído (`}`,`)`,``,`,`). O ciclo-curto (sem `\n`) ainda
   * as cobre se virarem um padrão dominante. Default 1 (só descarta linha vazia e
   * de 1 char). Subir torna a guarda mais permissiva com código denso.
   */
  readonly trivialLineMaxLen: number;
}

/** Default da linha repetida: ALTO p/ não pegar código legítimo, mas << 217. */
export const DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS = 25;
/** Default do ciclo curto: período ≤80 chars dominando ≥2000 chars sem novidade. */
export const DEFAULT_MAX_CYCLE_LEN = 80;
export const DEFAULT_MIN_CYCLE_SPAN_CHARS = 2_000;
/** Linhas ≤1 char (vazias / `}`) não contam como "conteúdo repetido". */
export const DEFAULT_TRIVIAL_LINE_MAX_LEN = 1;

/** Config default (sem env) — pega o caso do Tiago sem falso-positivo. */
export const DEFAULT_DEGENERATION_CONFIG: DegenerationConfig = {
  maxConsecutiveLineRepeats: DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS,
  maxCycleLen: DEFAULT_MAX_CYCLE_LEN,
  minCycleSpanChars: DEFAULT_MIN_CYCLE_SPAN_CHARS,
  trivialLineMaxLen: DEFAULT_TRIVIAL_LINE_MAX_LEN,
};

/** Nome do knob de env (cai na consolidação `ALUY_*`). */
export const DEGENERATION_MAX_LINE_REPEATS_ENV = 'ALUY_DEGENERATE_LINE_REPEATS';
export const DEGENERATION_MIN_CYCLE_SPAN_ENV = 'ALUY_DEGENERATE_CYCLE_SPAN';
/** Desliga a guarda inteira (escape hatch consciente). Default: ligada. */
export const DEGENERATION_DISABLE_ENV = 'ALUY_DEGENERATE_OFF';

/**
 * Resolve a config a partir do ambiente (consolidação `ALUY_*`), tolerante:
 * valor inválido/≤0 ⇒ cai no default (NUNCA desarma a guarda por engano). O teto
 * de repetição tem um PISO sensato (≥3) p/ um valor minúsculo não virar
 * falso-positivo em qualquer repetição honesta. `env` injetável p/ teste.
 */
export function resolveDegenerationConfig(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
): DegenerationConfig {
  const repeats = parsePositiveInt(env[DEGENERATION_MAX_LINE_REPEATS_ENV]);
  const span = parsePositiveInt(env[DEGENERATION_MIN_CYCLE_SPAN_ENV]);
  return {
    maxConsecutiveLineRepeats:
      repeats !== undefined ? Math.max(3, repeats) : DEFAULT_MAX_CONSECUTIVE_LINE_REPEATS,
    maxCycleLen: DEFAULT_MAX_CYCLE_LEN,
    minCycleSpanChars: span !== undefined ? Math.max(200, span) : DEFAULT_MIN_CYCLE_SPAN_CHARS,
    trivialLineMaxLen: DEFAULT_TRIVIAL_LINE_MAX_LEN,
  };
}

/** A guarda está LIGADA? (default: sim; só `ALUY_DEGENERATE_OFF` truthy desliga). */
export function isDegenerationGuardEnabled(
  env: Record<string, string | undefined> = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env ?? {},
): boolean {
  const raw = (env[DEGENERATION_DISABLE_ENV] ?? '').trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on');
}

/** Por que a guarda disparou (DADO de auditoria/UX, sem segredo). */
export type DegenerationKind = 'line-repeat' | 'short-cycle';

/**
 * Lançado pelo acumulador de stream quando a guarda dispara. O `AgentLoop` o
 * captura e o converte num `stop:'degenerate'` + observação. Carrega o motivo
 * estruturado (qual heurística, quantas repetições) — DADO, sem conteúdo cru
 * extenso (não re-vaza o lixo repetido; só uma amostra clampada).
 */
export class DegenerateLoopError extends Error {
  readonly kind: DegenerationKind;
  /** Quantas repetições/ciclos consecutivos foram observados ao disparar. */
  readonly repeats: number;
  /** Amostra CLAMPADA do fragmento repetido (p/ a observação; sem floodar). */
  readonly sample: string;

  constructor(kind: DegenerationKind, repeats: number, sample: string) {
    super(`loop de repetição degenerado detectado (${kind}, ${repeats}×)`);
    this.name = 'DegenerateLoopError';
    this.kind = kind;
    this.repeats = repeats;
    this.sample = sample;
  }
}

/** Quantos chars da repetição expor na amostra (auditoria sem flood). */
const SAMPLE_MAX = 60;

/**
 * Detector incremental de repetição degenerada. UM por turno do modelo (estado é
 * a janela recente). Barato: O(1) amortizado por delta no caminho de linha (hash
 * via comparação de string da última linha + contador), e O(maxCycleLen) só na
 * cauda quando há acúmulo sem `\n`. Não guarda o turno inteiro — só uma janela
 * limitada da cauda (`tail`), então a memória é bounded mesmo num degenerado de
 * milhões de chars.
 *
 * HEURÍSTICA (duas, independentes):
 *
 *  (1) LINHA REPETIDA CONSECUTIVA — ao fechar cada linha (`\n`), se ela é igual
 *      (após trim) à anterior E não é trivial (len > trivialLineMaxLen), o
 *      contador sobe; quando chega em `maxConsecutiveLineRepeats`, dispara. Uma
 *      linha DIFERENTE zera o contador. Por isso código com `},` em pontos
 *      espalhados NUNCA acumula (há linhas diferentes no meio) — só a MESMA linha
 *      repetida em SEQUÊNCIA, sem novidade, dispara. Linhas triviais (vazias/1
 *      char) não contam (não é "conteúdo" se repetindo).
 *
 *  (2) CICLO CURTO sem novidade — protege contra o degenerado COLADO (sem `\n`,
 *      ex.: `<<<EDIT_STDIN>/>/>…` ou `abcabc…`). Mantém a cauda da saída; quando
 *      a cauda fica longa, verifica se os últimos `p` chars se repetem
 *      (período-`p`, p ∈ 1..maxCycleLen) por um trecho total ≥ `minCycleSpanChars`.
 *      Exige DOMÍNIO (span grande) ⇒ um trecho curto periódico legítimo (ex.:
 *      `------` numa régua markdown) não dispara.
 *
 * Falso-positivo é improvável porque AMBAS exigem AUSÊNCIA de novidade por um
 * volume ALTO: (1) a MESMA linha de conteúdo dezenas de vezes seguidas; (2) um
 * período curto ocupando milhares de chars. Texto/código honesto introduz
 * novidade muito antes desses limiares.
 */
export class DegenerationDetector {
  private readonly cfg: DegenerationConfig;

  // EST-1124 — barramento do Maestro (opcional). Se presente, emite
  // SupervisorSignal ANTES de lançar DegenerateLoopError.
  private readonly bus: import('./maestro/bus.js').SignalCollector | undefined;

  // (1) estado da linha repetida.
  private lineBuf = '';
  private lastLine: string | undefined;
  private lineRepeatCount = 1;

  // (2) estado do ciclo curto: cauda bounded da saída (sem `\n` recente forçar
  // flush — guardamos uma janela de chars suficiente p/ achar o maior período).
  private tail = '';
  // janela = espaço p/ detectar período até maxCycleLen ocupando minCycleSpanChars
  // (+ folga). Bounded ⇒ memória O(minCycleSpanChars), não O(turno).
  private readonly tailMax: number;

  constructor(
    cfg: DegenerationConfig = DEFAULT_DEGENERATION_CONFIG,
    bus?: import('./maestro/bus.js').SignalCollector,
  ) {
    this.cfg = cfg;
    this.bus = bus;
    this.tailMax = cfg.minCycleSpanChars + cfg.maxCycleLen + 1;
  }

  /**
   * Empurra um chunk de delta. LANÇA {@link DegenerateLoopError} no exato chunk
   * que faz a guarda disparar (o acumulador então aborta o stream). Idempotente
   * em formato: pode receber chunks de qualquer tamanho (inclui multi-linha).
   */
  push(chunk: string): void {
    if (chunk.length === 0) return;
    this.pushForLineHeuristic(chunk);
    this.pushForCycleHeuristic(chunk);
  }

  // ---- (1) linha repetida consecutiva ----
  private pushForLineHeuristic(chunk: string): void {
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk.charCodeAt(i) === 10 /* \n */) {
        this.lineBuf += chunk.slice(start, i);
        this.commitLine(this.lineBuf);
        this.lineBuf = '';
        start = i + 1;
      }
    }
    if (start < chunk.length) this.lineBuf += chunk.slice(start);
  }

  private commitLine(rawLine: string): void {
    const line = rawLine.trim();
    // Linha trivial (vazia / 1 char): não é "conteúdo" — reseta o casamento p/
    // não acumular sobre ruído, mas não dispara.
    if (line.length <= this.cfg.trivialLineMaxLen) {
      this.lastLine = undefined;
      this.lineRepeatCount = 1;
      return;
    }
    if (line === this.lastLine) {
      this.lineRepeatCount += 1;
      if (this.lineRepeatCount >= this.cfg.maxConsecutiveLineRepeats) {
        // EST-1124 — emite sinal ao barramento ANTES de lançar (ADITIVO).
        this.bus?.publish({
          origin: 'degeneration',
          severity: 'warning',
          ts: Date.now(),
          payload: {
            kind: 'line-repeat',
            repeats: this.lineRepeatCount,
            sample: clampSample(line),
          },
        });
        throw new DegenerateLoopError('line-repeat', this.lineRepeatCount, clampSample(line));
      }
    } else {
      this.lastLine = line;
      this.lineRepeatCount = 1;
    }
  }

  // ---- (2) ciclo curto sem novidade (cauda bounded) ----
  private pushForCycleHeuristic(chunk: string): void {
    this.tail += chunk;
    if (this.tail.length > this.tailMax) {
      this.tail = this.tail.slice(this.tail.length - this.tailMax);
    }
    // Só vale checar quando a cauda já tem volume p/ um período curto dominar.
    if (this.tail.length < this.cfg.minCycleSpanChars) return;
    const hit = detectShortCycle(this.tail, this.cfg.maxCycleLen, this.cfg.minCycleSpanChars);
    if (hit) {
      // EST-1124 — emite sinal ao barramento ANTES de lançar (ADITIVO).
      this.bus?.publish({
        origin: 'degeneration',
        severity: 'critical',
        ts: Date.now(),
        payload: { kind: 'short-cycle', repeats: hit.repeats, sample: clampSample(hit.unit) },
      });
      throw new DegenerateLoopError('short-cycle', hit.repeats, clampSample(hit.unit));
    }
  }
}

/**
 * Acha o MENOR período `p ∈ 1..maxCycleLen` tal que a cauda termina com o padrão
 * `unit`*` por um trecho contíguo ≥ `minSpan` chars. Varre da cauda p/ trás; O(p)
 * por candidato, O(maxCycleLen²) no pior caso por checagem — barato (maxCycleLen
 * é dezenas). Retorna o período, a unidade e quantas repetições.
 */
export function detectShortCycle(
  s: string,
  maxCycleLen: number,
  minSpan: number,
): { period: number; unit: string; repeats: number } | undefined {
  const n = s.length;
  if (n < minSpan) return undefined;
  for (let p = 1; p <= maxCycleLen; p++) {
    if (p * 2 > n) break; // precisa de ao menos 2 períodos p/ ser repetição.
    // conta quantos chars contíguos no FIM seguem o período-p.
    let span = p;
    while (span < n && s.charCodeAt(n - 1 - span) === s.charCodeAt(n - 1 - (span % p))) {
      span++;
    }
    if (span >= minSpan && span >= p * 2) {
      const unit = s.slice(n - p);
      return { period: p, unit, repeats: Math.floor(span / p) };
    }
  }
  return undefined;
}

/**
 * Sink de delta da guarda anti-repetição — o que os ACUMULADORES de stream
 * (BrokerModelClient.call / StreamingModelCaller.call) chamam por chunk. `push`
 * LANÇA {@link DegenerateLoopError} no chunk que dispara. Quando a guarda está
 * DESLIGADA (`ALUY_DEGENERATE_OFF`), `newDegenerationSink` devolve um NO-OP — o
 * stream roda idêntico ao baseline (zero overhead semântico).
 */
export interface DegenerationSink {
  push(chunk: string): void;
}

const NOOP_SINK: DegenerationSink = { push() {} };

/**
 * Fábrica única da guarda p/ os acumuladores de stream (DRY: pai, sub-agentes e
 * a TUI usam ESTA mesma config/heurística). Lê o toggle + a config do env (cai na
 * consolidação `ALUY_*`); `env` injetável p/ teste. Ligada por default.
 */
export function newDegenerationSink(
  env?: Record<string, string | undefined>,
  bus?: import('./maestro/bus.js').SignalCollector,
): DegenerationSink {
  if (!isDegenerationGuardEnabled(env)) return NOOP_SINK;
  return new DegenerationDetector(resolveDegenerationConfig(env), bus);
}

function clampSample(s: string): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length <= SAMPLE_MAX ? oneLine : `${oneLine.slice(0, SAMPLE_MAX)}…`;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

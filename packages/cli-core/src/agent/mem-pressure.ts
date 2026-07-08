// EST-1012 — ROBUSTEZ DE MEMÓRIA · backstop de OOM (o "Killed" silencioso).
//
// O problema (Tiago, máquina contendida / sessão longa): mesmo com os CAPS de
// LEITURA já no lugar (web_fetch #164, readBounded #167, MCP #168, FlowTree/journal
// #169 bound os MAIORES sinks de alocação), sob pressão REAL de RAM o processo
// ainda pode crescer o heap até o kernel matar com "Killed" — sem aviso, sem
// recuperação, sem salvar a sessão. Este módulo é o BACKSTOP: detecta a pressão
// ANTES do estouro e DEGRADA com GRAÇA, em vez de morrer cego.
//
// Este é a PARTE PURA/PORTÁVEL (ADR-0053 §8): só NÚMEROS (bytes de heap, razões) e
// uma decisão determinística + ESCALONADA. NÃO faz I/O, não lê `process.memoryUsage`
// (o locus concreto — o controller — amostra o heap e passa o número), não chama
// modelo, não toca a catraca/budget. A AÇÃO concreta (auto-compactar, avisar,
// encerrar-limpo salvando a sessão) vive no locus (controller/run.tsx), atrás de uma
// porta — espelhando como `auto-compact.ts` (#157) separa o JUÍZO da compactação.
//
// RELAÇÃO COM OS OUTROS GUARDAS — ORTOGONAL a todos:
//   • os CAPS DE LEITURA (#164/#167/#168/#169) cercam CADA alocação individual (um
//     arquivo/fetch/tool-output gigante não é lido inteiro). Este guarda olha o
//     AGREGADO do processo (muitas leituras pequenas + histórico longo somam).
//   • a AUTO-COMPACTAÇÃO da JANELA (#157, auto-compact.ts) dispara quando a JANELA
//     do MODELO enche (razão de TOKENS). Este guarda dispara quando o HEAP do
//     PROCESSO aperta (razão de BYTES) — e REUSA a mesma compactação como 1ª reação
//     (libera o histórico → libera heap). Um pode disparar sem o outro: a janela
//     pode estar com folga (turnos curtos) enquanto o heap aperta por acúmulo de
//     buffers/strings; e a janela pode encher sem o heap apertar.
//   • o BUDGET GATE (limits.ts) cerca o CUSTO (tokens/iterações). Este cerca a RAM.
//
// SEGURANÇA (CLI-SEC-6): NÃO vê texto de conversa — só bytes/razões. A compactação
// que ele dispara reusa o MESMO caminho do `/compact` (histórico JÁ REDIGIDO), então
// segredo lido não vaza pro sumário. A mensagem de aviso/encerramento é composta de
// literais + números (MB) — nunca conteúdo do usuário.

/**
 * LIMITE de heap (bytes) usado como DENOMINADOR da razão de pressão. É o
 * `--max-old-space-size` EFETIVO do processo (em bytes) — o teto a partir do qual o
 * V8 lança o erro de heap "legível" (em vez do OS matar cego). `<=0` ⇒ guarda INERTE
 * (sem teto conhecido, não há % a medir — fail-safe baseline).
 */
// EST-1124 — barramento do Maestro (opcional). Emissão ADITIVA.
import type { SignalCollector } from './maestro/bus.js';

export interface MemPressureConfig {
  /**
   * Teto de heap (BYTES) — o `--max-old-space-size` efetivo convertido p/ bytes.
   * Denominador da razão. `<=0` ⇒ guarda inerte (sem sinal, não dispara nada).
   */
  readonly heapLimitBytes: number;
  /**
   * LIMIAR (razão 0..1 do heapLimit) que dispara a AUTO-COMPACTAÇÃO preventiva —
   * a 1ª e mais barata reação (libera o histórico). Default `DEFAULT_COMPACT_AT`.
   */
  readonly compactAt: number;
  /**
   * LIMIAR (razão 0..1) que, AINDA apertado APÓS compactar, dispara o AVISO ao
   * usuário ("memória apertada — considere /clear"). Acima do `compactAt`. Default
   * `DEFAULT_WARN_AT`.
   */
  readonly warnAt: number;
  /**
   * LIMIAR (razão 0..1) do ÚLTIMO RECURSO: encerra LIMPO (salva a sessão + mensagem
   * acionável) ANTES de o OS matar cego. O mais alto. Default `DEFAULT_SHUTDOWN_AT`.
   */
  readonly shutdownAt: number;
}

/** Default da auto-compactação preventiva: 80% do heap (antes do aperto real). */
export const DEFAULT_COMPACT_AT = 0.8;
/** Default do aviso: 88% (compactou e ainda aperta ⇒ fala com o usuário). */
export const DEFAULT_WARN_AT = 0.88;
/** Default do encerramento limpo: 95% (margem p/ salvar antes do OOM do kernel). */
export const DEFAULT_SHUTDOWN_AT = 0.95;

/** Pisos/tetos sãos dos limiares (ordem garantida por `resolveMemPressure`). */
export const MIN_PRESSURE_AT = 0.5;
export const MAX_PRESSURE_AT = 0.99;

/**
 * Default do heap-limit (MB) quando nem `--max-old-space-size` nem `ALUY_MAX_HEAP_MB`
 * foram passados E o launcher não conseguiu derivar do total de RAM. 4 GiB é um teto
 * folgado p/ uma sessão de CLI; o launcher pode subir/descer via env.
 */
export const DEFAULT_MAX_HEAP_MB = 4096;
/** Piso são do heap-limit (abaixo disso o V8 mal arranca / falso-aperto imediato). */
export const MIN_MAX_HEAP_MB = 512;
/** Teto são (acima disso o teto é cosmético; o OS mata antes — não protege de nada). */
export const MAX_MAX_HEAP_MB = 32768;

/**
 * Fração da RAM TOTAL usada como heap-limit adaptativo (quando nem flag nem env vêm).
 * Numa máquina de 32 GiB ⇒ ~22 GiB de teto (só pega runaway de verdade, não uso pesado
 * legítimo como 20 sub-agentes); numa de 4 GiB ⇒ ~2,8 GiB (deixa folga p/ o OS). O 4 GiB
 * FIXO antigo MATAVA sessões em máquinas grandes (capava em 4 GiB com 28 GiB sobrando).
 */
export const HEAP_FRACTION_OF_RAM = 0.7;

/** Knobs de env (consolidação `ALUY_*`). */
export const MAX_HEAP_MB_ENV = 'ALUY_MAX_HEAP_MB';
export const MEM_PRESSURE_AT_ENV = 'ALUY_MEM_PRESSURE_AT';
/** Desliga o MONITOR de pressão (escape hatch consciente). NÃO desliga o heap-limit. */
export const MEM_PRESSURE_DISABLE_ENV = 'ALUY_MEM_PRESSURE_OFF';

/** Config DESLIGADA (baseline) — reusada quando não há teto de heap conhecido. */
export const MEM_PRESSURE_OFF: MemPressureConfig = {
  heapLimitBytes: 0,
  compactAt: DEFAULT_COMPACT_AT,
  warnAt: DEFAULT_WARN_AT,
  shutdownAt: DEFAULT_SHUTDOWN_AT,
};

const BYTES_PER_MB = 1024 * 1024;

function procEnv(): Record<string, string | undefined> {
  return (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  );
}

/**
 * Parseia um inteiro positivo (MB) do env, clampado em `[min,max]`. Inválido/vazio/
 * ≤0 ⇒ `undefined` (cai no default do chamador). PURO.
 */
function parseMb(raw: string | undefined, min: number, max: number): number | undefined {
  if (raw === undefined) return undefined;
  const s = raw.trim();
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * Resolve o HEAP-LIMIT efetivo (MB) p/ o `--max-old-space-size`, com precedência:
 *   1) `explicitMb` (ex.: derivado de um `--max-old-space-size` JÁ presente no
 *      NODE_OPTIONS — não sobrescrever a escolha do operador);
 *   2) `ALUY_MAX_HEAP_MB` (env), clampado a `[MIN,MAX]`;
 *   3) ADAPTATIVO: `totalMemMb * HEAP_FRACTION_OF_RAM` (quando o launcher passa a RAM
 *      total) — escala com a máquina, NÃO capa em 4 GiB num host de 32 GiB;
 *   4) DEFAULT (`DEFAULT_MAX_HEAP_MB`) — só quando a RAM total é desconhecida (teste/
 *      ambiente não-Node).
 * Sempre devolve um inteiro válido em `[MIN_MAX_HEAP_MB, MAX_MAX_HEAP_MB]`. PURO (a RAM
 * total é INJETADA pelo caller, não lida aqui).
 */
export function resolveHeapLimitMb(
  env: Record<string, string | undefined> = procEnv(),
  explicitMb?: number | undefined,
  totalMemMb?: number | undefined,
): number {
  if (explicitMb !== undefined && Number.isFinite(explicitMb) && explicitMb > 0) {
    return Math.min(MAX_MAX_HEAP_MB, Math.max(MIN_MAX_HEAP_MB, Math.floor(explicitMb)));
  }
  const fromEnv = parseMb(env[MAX_HEAP_MB_ENV], MIN_MAX_HEAP_MB, MAX_MAX_HEAP_MB);
  if (fromEnv !== undefined) return fromEnv;
  // ADAPTATIVO: escala com a RAM da máquina (folga p/ OS + outros processos). O 4 GiB
  // fixo capava sessões grandes (20 sub-agentes estouram 4 GiB com 28 GiB livres).
  if (totalMemMb !== undefined && Number.isFinite(totalMemMb) && totalMemMb > 0) {
    return Math.min(
      MAX_MAX_HEAP_MB,
      Math.max(MIN_MAX_HEAP_MB, Math.floor(totalMemMb * HEAP_FRACTION_OF_RAM)),
    );
  }
  return DEFAULT_MAX_HEAP_MB;
}

/**
 * Parseia o limiar BASE de pressão (`ALUY_MEM_PRESSURE_AT`): a fração do heap em que
 * a auto-compactação preventiva (`compactAt`) dispara. Aceita razão `0..1` (`0.8`) ou
 * porcentagem `>1..100` (`80`). Inválido/vazio ⇒ `undefined` (cai no default). PURO.
 */
export function parseMemPressureAt(v: string | number | undefined): number | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim().toLowerCase();
  if (s === '') return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const ratio = n > 1 ? n / 100 : n;
  if (!Number.isFinite(ratio) || ratio <= 0) return undefined;
  return ratio;
}

/** O MONITOR de pressão está LIGADO? (default: sim; só `ALUY_MEM_PRESSURE_OFF` desliga). */
export function isMemPressureEnabled(env: Record<string, string | undefined> = procEnv()): boolean {
  const raw = (env[MEM_PRESSURE_DISABLE_ENV] ?? '').trim().toLowerCase();
  return !(raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on');
}

/** Entradas (cruas) p/ resolver a config do monitor de pressão. */
export interface MemPressureInputs {
  /** O HEAP-LIMIT efetivo (MB) — o mesmo que o launcher aplicou no `--max-old-space-size`. */
  readonly heapLimitMb: number;
  /** `ALUY_MEM_PRESSURE_AT` (env) — override do limiar BASE (`compactAt`). */
  readonly pressureAtEnv?: string | undefined;
  /**
   * ADR-0150 (balde b, Tier 2) — `config.advanced.memPressure.compactAt`
   * (~/.aluy/config.json). Nível ENTRE env e default (env > config > default);
   * MESMA forma/parse de `pressureAtEnv` (razão `0..1` ou `%` `>1..100`).
   */
  readonly pressureAtConfig?: string | number | undefined;
}

/**
 * Resolve a `MemPressureConfig` EFETIVA, determinística e pura. O limiar BASE vem do
 * env (`ALUY_MEM_PRESSURE_AT`) ou do default (`DEFAULT_COMPACT_AT`); os limiares de
 * AVISO e ENCERRAMENTO são derivados ACIMA dele, sempre ESCALONADOS e CLAMPADOS em
 * `[MIN_PRESSURE_AT, MAX_PRESSURE_AT]` — garantindo `compactAt < warnAt < shutdownAt`
 * (escalonamento monotônico: nunca avisa antes de compactar, nem encerra antes de
 * avisar). `heapLimitMb<=0` ⇒ guarda INERTE.
 */
export function resolveMemPressure(inputs: MemPressureInputs): MemPressureConfig {
  const heapLimitBytes = Math.max(0, Math.floor(inputs.heapLimitMb * BYTES_PER_MB));
  if (heapLimitBytes <= 0) return MEM_PRESSURE_OFF;

  // ADR-0150 (balde b, Tier 2) — precedência env > config > default (config "termina
  // o padrão"; o env já existia e segue vencendo).
  const base =
    parseMemPressureAt(inputs.pressureAtEnv) ??
    parseMemPressureAt(inputs.pressureAtConfig) ??
    DEFAULT_COMPACT_AT;
  // Mantém os DELTAS dos defaults (warn=+0.08, shutdown=+0.15) ao mover a base, p/ o
  // operador conseguir deslocar o conjunto inteiro com um knob só, preservando a folga.
  const warnDelta = DEFAULT_WARN_AT - DEFAULT_COMPACT_AT;
  const shutdownDelta = DEFAULT_SHUTDOWN_AT - DEFAULT_COMPACT_AT;

  // A base é clampada deixando SEMPRE espaço p/ os 2 degraus acima ficarem ESTRITAMENTE
  // abaixo de `MAX_PRESSURE_AT` (senão, base=0.99 grudaria os três no teto). Piso normal.
  const compactAt = Math.min(MAX_PRESSURE_AT - 2 * STEP, Math.max(MIN_PRESSURE_AT, base));
  // Cada degrau fica ao menos `STEP` acima do anterior (ordem ESTRITA garantida).
  const warnAt = Math.min(MAX_PRESSURE_AT - STEP, Math.max(compactAt + STEP, base + warnDelta));
  const shutdownAt = Math.min(MAX_PRESSURE_AT, Math.max(warnAt + STEP, base + shutdownDelta));
  return { heapLimitBytes, compactAt, warnAt, shutdownAt };
}

/** Degrau mínimo entre os limiares (garante ordem estrita após clamp). */
const STEP = 0.01;

/**
 * Razão de PRESSÃO de heap (0..1): heap usado / teto de heap. `heapLimitBytes<=0` ou
 * `heapUsedBytes` inválido ⇒ 0 (fail-safe: sem sinal, não dispara). Clampa em `[0,1]`.
 * PURA.
 */
export function heapPressureRatio(
  heapUsedBytes: number | undefined,
  heapLimitBytes: number,
): number {
  if (!Number.isFinite(heapUsedBytes) || heapUsedBytes === undefined || heapUsedBytes <= 0)
    return 0;
  if (!Number.isFinite(heapLimitBytes) || heapLimitBytes <= 0) return 0;
  return Math.max(0, Math.min(1, heapUsedBytes / heapLimitBytes));
}

/**
 * Estado MUTÁVEL do monitor (vive no locus, por SESSÃO). Anti-spam: NÃO re-dispara a
 * mesma ação a cada amostra enquanto a pressão fica no mesmo degrau — só re-arma
 * quando a pressão RECUOU abaixo do degrau (histerese), evitando avisar/compactar em
 * loop a cada tick. `shutdownArmed` é one-shot (encerrar é terminal).
 */
export interface MemPressureState {
  /** Já compactamos por pressão e a pressão NÃO recuou abaixo de `compactAt` ainda? */
  compactedThisEpisode: boolean;
  /** Já avisamos e a pressão NÃO recuou abaixo de `warnAt` ainda? */
  warnedThisEpisode: boolean;
  /** Disparamos o encerramento limpo (one-shot, terminal — nunca re-arma). */
  shutdownInitiated: boolean;
}

/** Estado inicial do monitor (sem episódio de pressão em curso). */
export function newMemPressureState(): MemPressureState {
  return { compactedThisEpisode: false, warnedThisEpisode: false, shutdownInitiated: false };
}

/** A AÇÃO de degradação graciosa decidida p/ a amostra corrente. */
export type MemPressureAction =
  // Heap aperta (≥compactAt): COMPACTA o histórico AGORA (libera RAM) — a reação mais
  // barata, mesmo que a JANELA do modelo ainda tenha folga (independente do %).
  | { readonly action: 'compact' }
  // AINDA aperta APÓS compactar (≥warnAt): AVISA o usuário ("memória apertada —
  // compactando / considere /clear") em vez de morrer calado.
  | { readonly action: 'warn' }
  // ÚLTIMO RECURSO (≥shutdownAt): encerra LIMPO — salva a sessão + mensagem acionável,
  // ANTES de o kernel matar cego. `firstTime` marca a transição (dispara 1× só).
  | { readonly action: 'shutdown'; readonly firstTime: boolean }
  // Folga (abaixo de compactAt), ou guarda inerte/desligada, ou ação já tomada neste
  // degrau (anti-spam): nada a fazer.
  | { readonly action: 'none' };

/**
 * JUÍZO determinístico + ESCALONADO + ANTI-SPAM da pressão de memória. PURO — NÃO
 * muta o estado (o locus aplica via `noteMemAction`/`relaxMemPressure`). A partir da
 * razão de pressão corrente e do estado de anti-spam, decide o degrau MAIS ALTO ainda
 * NÃO tomado neste episódio:
 *
 *   • `shutdown` — razão ≥ `shutdownAt` E ainda não iniciamos o encerramento. É
 *     TERMINAL: `firstTime=true` só na transição (a UI salva+encerra 1×).
 *   • `warn`     — razão ≥ `warnAt` E ainda não avisamos neste episódio.
 *   • `compact`  — razão ≥ `compactAt` E ainda não compactamos neste episódio.
 *   • `none`     — abaixo de `compactAt`, ou a ação do degrau já foi tomada (anti-
 *                  spam: não re-compacta/re-avisa a cada tick), ou guarda inerte.
 *
 * O ANTI-SPAM é por EPISÓDIO: `noteMemAction` marca a ação tomada; `relaxMemPressure`
 * (chamado quando a razão recua sob o degrau) re-arma. Assim, um pico que sobe e fica
 * dispara CADA degrau UMA vez (não a cada amostra), e um novo pico após recuo re-arma.
 */
export function decideMemPressure(
  cfg: MemPressureConfig,
  ratio: number,
  state: MemPressureState,
): MemPressureAction {
  // Inerte (sem teto conhecido) ⇒ baseline.
  if (cfg.heapLimitBytes <= 0) return { action: 'none' };
  // Já encerrando — não emite mais nada (terminal).
  if (state.shutdownInitiated) return { action: 'none' };
  // ÚLTIMO RECURSO primeiro (degrau mais alto vence).
  if (ratio >= cfg.shutdownAt) return { action: 'shutdown', firstTime: true };
  // AVISO (se ainda não avisado neste episódio).
  if (ratio >= cfg.warnAt && !state.warnedThisEpisode) return { action: 'warn' };
  // COMPACTAÇÃO preventiva (se ainda não compactado neste episódio).
  if (ratio >= cfg.compactAt && !state.compactedThisEpisode) return { action: 'compact' };
  return { action: 'none' };
}

/** Aplica (no estado MUTÁVEL) a ação que o locus EXECUTOU. */
export function noteMemAction(state: MemPressureState, action: MemPressureAction['action']): void {
  if (action === 'compact') state.compactedThisEpisode = true;
  else if (action === 'warn') state.warnedThisEpisode = true;
  else if (action === 'shutdown') state.shutdownInitiated = true;
}

/**
 * Re-arma o anti-spam quando a pressão RECUOU abaixo de um degrau (histerese): a
 * compactação/`/clear`/GC liberou RAM ⇒ um NOVO pico futuro volta a disparar a ação.
 * O encerramento (`shutdownInitiated`) NUNCA re-arma (é terminal). Muta o estado.
 */
export function relaxMemPressure(
  cfg: MemPressureConfig,
  ratio: number,
  state: MemPressureState,
): void {
  if (ratio < cfg.compactAt) state.compactedThisEpisode = false;
  if (ratio < cfg.warnAt) state.warnedThisEpisode = false;
}

/** Marcador estável do AVISO de pressão (p/ a UX e p/ asserções de teste). */
export const MEM_PRESSURE_WARN_MARKER = 'memória apertada';
/** Marcador estável do ENCERRAMENTO limpo por pressão (acionável, NÃO "Killed" cru). */
export const MEM_PRESSURE_SHUTDOWN_MARKER = 'memória esgotada';

/** Bytes → MB inteiro (p/ as mensagens acionáveis legíveis). PURO. */
export function bytesToMb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round(bytes / BYTES_PER_MB);
}

/**
 * EST-1124 (MAESTRO-EMISSORES) — emite um SupervisorSignal ao barramento quando
 * a pressão de memória dispara uma ação. ADITIVO: a ação (compact/warn/shutdown)
 * ainda é executada pelo locus normalmente — o freio DURO segue intacto.
 */
export function signalMemPressure(
  bus: SignalCollector | undefined,
  action: string,
  ratio: number,
  heapLimitBytes: number,
  ts?: number,
): void {
  if (!bus) return;
  const severity = action === 'shutdown' ? ('critical' as const) : ('warning' as const);
  bus.publish({
    origin: 'mem-pressure',
    severity,
    ts: ts ?? Date.now(),
    payload: { action, ratio, heapLimitBytes },
  });
}

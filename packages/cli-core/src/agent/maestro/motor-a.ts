// EST-1127 · ADR-0123 §2.1-bis · MAESTRO-MOTOR-A —
// Motor camada (a): regência heurística SEM LLM, sempre-disponível.
//
// O motor (a) é o PISO do Maestro: regência heurística pura que funciona
// SEMPRE, mesmo offline/provider-fora (CA-MA8). Consome o regente (EST-1123)
// + barramento (EST-1122) e compõe decisão de turno por precedência de guarda
// (Inv. I), score de salience por sinais (recência/frequência/pin) e
// roteamento por regra. NÃO chama LLM (isso é camada b, v2).
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Lógica pura.
// ZERO rede, ZERO provider — determinístico e offline-first (CA-MA8).

import type { SupervisorDecision, SupervisorSignal } from './contract.js';
import { regentDecide } from './regent.js';

// ─── Tipos de salience ──────────────────────────────────────────────────────

/**
 * Um item sujeito a score de salience (recência + frequência + pin).
 *
 * Generaliza o conceito de "importância" que o Maestro usa para decidir
 * o que manter/evictar e como pesar sinais na composição da decisão.
 * O `pin` é um override FORTE: item pinado NUNCA é evictado e seu score
 * de salience é sempre 1.0 (domina qualquer outro).
 */
export interface SalienceItem {
  /** Timestamp da última ocorrência/acesso (ms epoch). */
  readonly recency: number;
  /** Contagem de acessos/ocorrências (frequência). */
  readonly frequency: number;
  /** Se `true`, item é pinado — override forte (score = 1.0). */
  readonly pinned: boolean;
}

/** Score de salience computado (0..1). */
export interface SalienceScore {
  /** Score normalizado (0..1). Pin = 1.0 sempre. */
  readonly score: number;
  /** Componente de recência (0..1) — decaimento exponencial. */
  readonly recencyComponent: number;
  /** Componente de frequência (0..1) — normalizada. */
  readonly frequencyComponent: number;
  /** Se o item é pinado (score = 1.0). */
  readonly pinned: boolean;
}

/**
 * Configuração dos pesos do motor (a).
 *
 * Ajusta o peso de recência vs frequência no score de salience
 * e o parâmetro de decaimento temporal. Valores padrão são
 * conservadores e testados.
 */
export interface MotorAConfig {
  /** Peso da recência no score (0..1). Default 0.6. */
  readonly recencyWeight: number;
  /** Peso da frequência no score (0..1). Default 0.4. */
  readonly frequencyWeight: number;
  /**
   * Meia-vida do decaimento de recência em ms.
   * Default 300_000 (5 minutos). Após meia-vida, recencyComponent = 0.5.
   */
  readonly recencyHalfLifeMs: number;
  /**
   * Frequência máxima para normalização.
   * Default 100. Itens com frequência >= max recebem frequencyComponent = 1.0.
   */
  readonly maxFrequency: number;
}

// ─── Tipos de roteamento ────────────────────────────────────────────────────

/** Alvos de roteamento que o motor (a) pode decidir. */
export type RouteTarget =
  | 'regent' // decisão padrão via regente (precedência Q-MA1)
  | 'self-heal' // auto-recuperação de contexto (compactar/resume)
  | 'pause' // pausa o loop
  | 'stop'; // para o loop (erro irrecuperável)

/** Decisão de roteamento por regra (sem LLM). */
export interface MotorARoute {
  /** Alvo do roteamento. */
  readonly target: RouteTarget;
  /** Regra que disparou (rastro auditável). */
  readonly rule: string;
  /** Sinais que causaram o roteamento. */
  readonly signals: readonly SupervisorSignal[];
}

// ─── Tipos de resultado do motor (a) ────────────────────────────────────────

/**
 * Item de contexto com score de salience anexado.
 * Usado pelo Maestro para pesar itens na composição da decisão.
 */
export interface ScoredSignal {
  readonly signal: SupervisorSignal;
  readonly salience: SalienceScore;
}

/** Resultado completo do motor (a): decisão + salience + rota. */
export interface MotorAResult {
  /** Decisão de regência consolidada (via regente). */
  readonly decision: SupervisorDecision;
  /** Sinais com scores de salience anexados. */
  readonly scoredSignals: readonly ScoredSignal[];
  /** Rota decidida por regra (rastro auditável). */
  readonly route: MotorARoute;
}

// ─── Config padrão ──────────────────────────────────────────────────────────

export const DEFAULT_MOTOR_A_CONFIG: MotorAConfig = {
  recencyWeight: 0.6,
  frequencyWeight: 0.4,
  recencyHalfLifeMs: 300_000, // 5 min
  maxFrequency: 100,
};

// ─── Salience ───────────────────────────────────────────────────────────────

/**
 * Computa o score de salience de UM item.
 *
 * Regra:
 * - `pinned === true` ⇒ score = 1.0 (override forte — CA-MOTOR-SALIENCE).
 * - Senão: score = wR * recencyComponent + wF * frequencyComponent.
 *
 * O componente de recência usa decaimento exponencial com meia-vida
 * configurável: `recencyComponent = 0.5 ^ (age / halfLife)`.
 * O componente de frequência é `min(frequency / maxFrequency, 1)`.
 *
 * DETERMINÍSTICO (CA-MOTOR-DET): mesma entrada ⇒ mesmo score.
 */
export function computeSalience(
  item: SalienceItem,
  config: MotorAConfig = DEFAULT_MOTOR_A_CONFIG,
  now: number = Date.now(),
): SalienceScore {
  // Pin é override FORTE — domina qualquer outro sinal.
  if (item.pinned) {
    return {
      score: 1.0,
      recencyComponent: 1.0,
      frequencyComponent: 1.0,
      pinned: true,
    };
  }

  // Componente de recência: decaimento exponencial.
  const age = Math.max(0, now - item.recency);
  const recencyComponent = Math.pow(0.5, age / config.recencyHalfLifeMs);

  // Componente de frequência: normalizado.
  const frequencyComponent = Math.min(item.frequency / config.maxFrequency, 1.0);

  // Score composto: soma ponderada.
  const score =
    config.recencyWeight * recencyComponent + config.frequencyWeight * frequencyComponent;

  return {
    score: clamp01(score),
    recencyComponent: clamp01(recencyComponent),
    frequencyComponent: clamp01(frequencyComponent),
    pinned: false,
  };
}

/**
 * Computa salience para uma lista de itens.
 *
 * DETERMINÍSTICO: mesma entrada + mesmo `now` ⇒ mesmos scores.
 */
export function computeAllSaliences(
  items: readonly SalienceItem[],
  config: MotorAConfig = DEFAULT_MOTOR_A_CONFIG,
  now: number = Date.now(),
): SalienceScore[] {
  return items.map((item) => computeSalience(item, config, now));
}

// ─── Roteamento por regra ───────────────────────────────────────────────────

/**
 * Decide rota por REGRA (não semântica de LLM — CA-MOTOR-ROTA).
 *
 * Tabela de regras (ordem de precedência):
 *
 * | Origem             | Severity  | Rota     | Regra                  |
 * |--------------------|-----------|----------|------------------------|
 * | human-cancel       | critical  | stop     | cancelamento humano    |
 * | mem-pressure       | critical  | self-heal| pressão crítica de mem |
 * | mem-pressure       | warning   | self-heal| antecipa compactação   |
 * | budget             | critical  | pause    | sem orçamento          |
 * | weak-yolo          | critical  | stop     | yolo perigoso          |
 * | degeneration       | critical  | self-heal| loop degenerativo      |
 * | degeneration       | warning   | self-heal| sinais de repetição    |
 * | stuck              | critical  | self-heal| travado há muitos turns|
 * | stuck              | warning   | pause    | potencial travamento   |
 * | self-check / outro | qualquer  | regent   | decisão padrão         |
 *
 * DETERMINÍSTICO: mesmos sinais (mesma ordem) ⇒ mesma rota.
 */
export function motorARoute(signals: readonly SupervisorSignal[]): MotorARoute {
  if (signals.length === 0) {
    return {
      target: 'regent',
      rule: 'vazio: fallback para regente',
      signals: [],
    };
  }

  // Encontra o sinal mais prioritário por precedência Q-MA1.
  let bestSignal = signals[0];
  let bestPriority = priority(bestSignal.origin);

  for (let i = 1; i < signals.length; i++) {
    const p = priority(signals[i].origin);
    if (p < bestPriority) {
      bestPriority = p;
      bestSignal = signals[i];
    }
  }

  const { origin, severity } = bestSignal;

  // ── human-cancel (topo absoluto Q-MA1) ───────────────────────────────
  if (origin === 'human-cancel') {
    return {
      target: 'stop',
      rule: `R1: cancelamento humano (${severity}) → stop`,
      signals,
    };
  }

  // ── mem-pressure ─────────────────────────────────────────────────────
  if (origin === 'mem-pressure') {
    if (severity === 'critical' || severity === 'warning') {
      return {
        target: 'self-heal',
        rule: `R2: pressão de memória (${severity}) → self-heal (compactar/resume)`,
        signals,
      };
    }
  }

  // ── budget ───────────────────────────────────────────────────────────
  if (origin === 'budget') {
    if (severity === 'critical') {
      return {
        target: 'pause',
        rule: `R3: orçamento esgotado (${severity}) → pause`,
        signals,
      };
    }
    // warning/info: segue para regente
  }

  // ── weak-yolo ────────────────────────────────────────────────────────
  if (origin === 'weak-yolo') {
    if (severity === 'critical') {
      return {
        target: 'stop',
        rule: `R4: yolo perigoso (${severity}) → stop`,
        signals,
      };
    }
  }

  // ── degeneration ─────────────────────────────────────────────────────
  if (origin === 'degeneration') {
    if (severity === 'critical' || severity === 'warning') {
      return {
        target: 'self-heal',
        rule: `R5: degeneração de resposta (${severity}) → self-heal`,
        signals,
      };
    }
  }

  // ── stuck ────────────────────────────────────────────────────────────
  if (origin === 'stuck') {
    if (severity === 'critical') {
      return {
        target: 'self-heal',
        rule: `R6: loop travado (${severity}) → self-heal`,
        signals,
      };
    }
    if (severity === 'warning') {
      return {
        target: 'pause',
        rule: `R7: potencial travamento (${severity}) → pause`,
        signals,
      };
    }
  }

  // ── self-check / default ─────────────────────────────────────────────
  return {
    target: 'regent',
    rule: `R0: rota padrão via regente (${origin}/${severity})`,
    signals,
  };
}

// ─── Motor principal ────────────────────────────────────────────────────────

/**
 * Motor camada (a): regência heurística — SEM LLM, SEM rede, SEM provider.
 *
 * Pipeline determinístico:
 * 1. Pontua salience de cada sinal (recência + frequência + pin).
 * 2. Decide rota por REGRA (motorARoute).
 * 3. Delega decisão final ao regente (EST-1123, precedência Q-MA1).
 *
 * O motor (a) NÃO chama `JudgeEngine` (camada b, v2) nem faz escalada
 * ao modelo principal (camada c). É o PISO que funciona SEMPRE, mesmo
 * com o provider fora (CA-MA8 / CA-MOTOR-OFFLINE).
 *
 * DETERMINÍSTICO (CA-MOTOR-DET): mesma entrada + mesmo `ts` ⇒ mesmo resultado.
 */
export function motorADecide(
  signals: readonly SupervisorSignal[],
  salienceItems: readonly SalienceItem[] = [],
  config: MotorAConfig = DEFAULT_MOTOR_A_CONFIG,
  ts?: number,
): MotorAResult {
  const now = ts ?? Date.now();

  // 1. Salience: pontua cada sinal.
  //    Mapeia signals → SalienceItem usando os items fornecidos ou defaults.
  const scoredSignals: ScoredSignal[] = signals.map((signal, i) => {
    const item: SalienceItem = salienceItems[i] ?? defaultSalienceItem(signal);
    return {
      signal,
      salience: computeSalience(item, config, now),
    };
  });

  // 2. Roteamento por regra.
  const route = motorARoute(signals);

  // 3. Decisão consolidada via regente (precedência Q-MA1).
  const decision = regentDecide(signals, now);

  return { decision, scoredSignals, route };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Cria um SalienceItem default para um sinal sem item explícito.
 *
 * Heurística: sinais recentes (ts próximo de now) têm recência alta;
 * frequência = 1 (primeira ocorrência neste lote).
 */
function defaultSalienceItem(signal: SupervisorSignal): SalienceItem {
  return {
    recency: signal.ts,
    frequency: 1,
    pinned: false,
  };
}

/** Prioridade canônica Q-MA1: menor índice = maior prioridade. */
function priority(origin: string): number {
  const map: Record<string, number> = {
    'human-cancel': 0,
    'mem-pressure': 1,
    budget: 2,
    degeneration: 3,
    stuck: 4,
    'weak-yolo': 5,
    'self-check': 6,
    degeneração: 3, // alias PT-BR
  };
  return map[origin] ?? 99; // desconhecido → menor prioridade
}

/** Clampa valor entre 0 e 1. */
function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

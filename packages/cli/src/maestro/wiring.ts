// EST-1137 (C3) · ADR-0123 §8-emenda E1 — MAESTRO WIRING.
//
// É o ponto onde os ENGINES CONCRETOS (OllamaJudgeEngine + Mem0MemoryEngine)
// são instanciados e o `MaestroPort` é RESOLVIDO. Sem este arquivo, o seam
// C1 fica inerte para sempre — mesmo com o boot-supervisor rodando.
//
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║ TRAVAS:                                                                  ║
// ║                                                                          ║
// ║ 1. Flag ALUY_MAESTRO default ON ⇒ MaestroPort.                      ║
// ║ 2. Kill-switch ALUY_MAESTRO_OFF força OFF.                          ║
// ║    ALUY_MAESTRO=0 ou ALUY_MAESTRO=false desliga explicitamente.     ║
// ║ 3. rege = motor-a SEMPRE (camada-a heurística, CA-MA8).                  ║
// ║    Judge (camada-b) é OPCIONAL — se disponível, pondera; senão degrada.  ║
// ║ 4. rege NUNCA toca decide/permission (não é catraca).                    ║
// ║ 5. Porta EXPLÍCITA 11435 p/ Mem0 (não confia no default do cliente).     ║
// ║ 6. Egress loopback: engines já usam malha CLI-SEC-13.                    ║
// ╚══════════════════════════════════════════════════════════════════════════╝
//
// IMPL CONCRETA em @aluy/cli (I/O layer). As portas (JudgeEngine/MemoryEngine/
// MaestroPort) são puras no @aluy/cli-core (ADR-0053 §8).

import {
  PollSignalBus,
  motorADecide,
  JUDGE_MODEL,
  resolveSidecarToggles,
  type MaestroPort,
  type SignalCollector,
  type SupervisorSignal,
  type SupervisorDecision,
  type JudgeEngine,
  type MemoryEngine,
} from '@aluy/cli-core';
import { OllamaJudgeEngine } from './ollama-judge.js';
import { Mem0MemoryEngine } from '../io/mem0-memory-engine.js';
import { resolveMem0Url, resolveOllamaUrl } from './sidecar-urls.js';
import { deriveMemoryScope } from './memory-scope.js';

// ─── Opções de wiring ──────────────────────────────────────────────────────

/** Opções injetáveis para `resolveMaestro` (testes). */
export interface ResolveMaestroOptions {
  /** Env injetável (default: process.env). */
  readonly env?: Record<string, string | undefined>;

  /** Bus injetável (teste). Default: new PollSignalBus(). */
  readonly bus?: SignalCollector;

  /** JudgeEngine injetável (teste). Default: new OllamaJudgeEngine(). */
  readonly judge?: JudgeEngine;

  /** MemoryEngine injetável (teste). Default: new Mem0MemoryEngine(). */
  readonly memory?: MemoryEngine;
}

// ─── resolveMaestro ────────────────────────────────────────────────────────

/**
 * Resolve o `MaestroPort` concreto ligando a flag `ALUY_MAESTRO`.
 *
 * - Default ON: se `ALUY_MAESTRO` não está setado, retorna `MaestroPort`.
 *   `ALUY_MAESTRO_OFF` força OFF (kill-switch). `ALUY_MAESTRO=0` ou
 *   `ALUY_MAESTRO=false` desliga explicitamente.
 * - ON: instancia `PollSignalBus`, `OllamaJudgeEngine`, `Mem0MemoryEngine`
 *   (porta EXPLÍCITA 11435) e devolve o `MaestroPort` com `rege` que usa
 *   motor-a sempre + judge opcional degradando (CA-MA8).
 *
 * @returns `MaestroPort` se ligado (default ON), `undefined` se desligado.
 */
export function resolveMaestro(opts: ResolveMaestroOptions = {}): MaestroPort | undefined {
  const env = opts.env ?? process.env;

  // ── Liga/desliga ──────────────────────────────────────────────────────
  const maestroFlag = env['ALUY_MAESTRO'];
  const killSwitch = env['ALUY_MAESTRO_OFF'];

  // Kill-switch força OFF.
  if (killSwitch && killSwitch !== '0' && killSwitch !== 'false') {
    return undefined;
  }

  // Default ON. ALUY_MAESTRO=0 ou ALUY_MAESTRO=false desliga explicitamente.
  if (maestroFlag === '0' || maestroFlag === 'false') {
    return undefined;
  }

  // ── Perfil / toggles de sidecar (reusa provisioner-contract) ──────────
  const toggles = resolveSidecarToggles({
    ollama: env['ALUY_MAESTRO_OLLAMA'] !== '0',
    mem0: env['ALUY_MAESTRO_MEM0'] !== '0',
  });

  // ── Barramento ────────────────────────────────────────────────────────
  const bus: SignalCollector = opts.bus ?? new PollSignalBus();

  // ── Engines (degradam sozinhos sidecar — CA-MA8) ──────────────────────
  const judge: JudgeEngine =
    opts.judge ??
    new OllamaJudgeEngine({
      baseUrl: resolveOllamaUrl(opts.env),
      model: JUDGE_MODEL,
    });

  // ── rege: motor-a SEMPRE + judge opcional (CA-MA8) ────────────────────
  //
  // A função `rege` é o PONTO ÚNICO de decisão de regência do Maestro.
  // Ela NUNCA toca `decide()`/`permission` (não é catraca — BRIEF C3).
  //
  // Estratégia:
  //   1. motor-a (heurística pura) SEMPRE roda — piso determinístico.
  //   2. Se judge disponível E há 2+ sinais conflitantes, pondera com judge.
  //      Senão, usa só motor-a.
  //   3. Judge que falha/timeout ⇒ degrada para heurística (CA-MA8) —
  //      o próprio OllamaJudgeEngine já retorna mode:'heuristic' no fallback.
  async function rege(signals: readonly SupervisorSignal[]): Promise<SupervisorDecision> {
    // Camada (a): motor heurístico SEMPRE (CA-MA8).
    const motorResult = motorADecide(signals);

    // Camada (b): judge opcional — só se há sinais conflitantes e o judge
    // está habilitado (toggle ollama ON).
    if (toggles.has('ollama') && signals.length >= 2) {
      try {
        const judgeResult = await judge.judge({
          question: 'Dados os sinais de supervisão, qual a decisão de regência?',
          options: [
            { id: 'continuar', label: 'Continuar normalmente' },
            { id: 'pausar', label: 'Pausar o loop' },
            { id: 'recuperar', label: 'Recuperar contexto' },
            { id: 'parar', label: 'Parar o loop' },
          ],
          context: signals
            .map((s) => `${s.origin}/${s.severity}: ${JSON.stringify(s.payload)}`)
            .join('\n'),
          hint: 'Prefira segurança e continuidade.',
        });

        // Se o judge retornou com mode:'llm' (não degradou), pondera.
        if (judgeResult.mode === 'llm' && judgeResult.confidence > 0.6) {
          // F76 — Inv. I FLUIDEZ (ADR-0123): o judge (qwen2.5:0.5b) é PEQUENO e
          // OVERCONFIANTE — ao vivo escolheu `parar`/`pausar` @ conf 1.0 p/ um estado
          // SAUDÁVEL (progredindo, 0 erros). Como a wiring confiava em QUALQUER discord
          // @ >0.8, ele PARAVA um agente sadio = o LIMBO da F54 por uma porta NOVA. Como
          // a confiança de um modelo 0.5b é RUÍDO (sempre 0.8-1.0), o gate de confiança
          // não filtra. Regra: o judge SÓ pode override em direção a MAIS fluidez
          // (`continuar`), NUNCA escalar p/ pausar/parar/recuperar sobre o motor-a. Os
          // sinais CRÍTICOS já roteiam direto no motor-a (não chegam aqui), e os tetos
          // DUROS seguem cercando runaway — então restringir o judge à fluidez é seguro.
          if (
            judgeResult.chosen === 'continuar' &&
            judgeResult.chosen !== motorResult.decision.action &&
            judgeResult.confidence > 0.8
          ) {
            return {
              action: 'continuar',
              signals,
              reason: `motor-a:${motorResult.decision.action} + judge:continuar@${judgeResult.confidence.toFixed(2)} — judge preferiu FLUIR (Inv. I)`,
              ts: Date.now(),
            };
          }
          // Judge concorda, é moderado, OU tentou ESCALAR a restrição (ignorado p/ não
          // travar agente sadio): segue motor-a, anotando o que o judge achou (auditoria).
          return {
            ...motorResult.decision,
            reason: `${motorResult.decision.reason} | judge:${judgeResult.chosen}@${judgeResult.confidence.toFixed(2)}`,
          };
        }
        // Judge degradou (mode:'heuristic') → segue motor-a puro.
      } catch {
        // Judge falhou → motor-a puro (CA-MA8: nunca trava).
      }
    }

    return motorResult.decision;
  }
  return { bus, rege };
}

// ─── EST-F54 — Config de CONTINUAÇÃO ─────────────────────────────────────

/** Config de continuação. Mesmo formato de ContinuationConfig do core. */
export interface ContinuationCfg {
  readonly maxContinuations: number;
  readonly nudgeAt: number;
  readonly giveUpAt: number;
}

function floorAtLeast(v: string | undefined, floor: number, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < floor) return def;
  return n;
}

/**
 * Resolve a config de CONTINUAÇÃO do regente (Inv. I Fluidez).
 *
 * Amarra ao Maestro (default-ON). Sub-flag ALUY_CONT (default ON c/ Maestro)
 * + kill-switch ALUY_CONT_OFF.
 *
 * Env knobs:
 *   ALUY_CONT_MAX=4    — cap DURO de continuations por turno
 *   ALUY_CONT_NUDGE_AT=1 — a partir de qual o nudge é FORTE
 *   ALUY_CONT_GIVEUP_AT=3 — a partir de qual DESISTE
 *   ALUY_CONT_OFF — desliga a política (seam inerte = baseline)
 *
 * @returns config se ligado, undefined se desligado.
 */
/**
 * F-MEM (ADR-0123 §4) — resolve a MEMÓRIA (Mem0) + o escopo da caixa.
 * O loop recebe `memory`+`memoryScope` direto (recall/store), não via MaestroPort.
 * - Escopo = cwd do projeto sanitizado (`user_id` ≡ caixa §4.3) ⇒ memórias
 *   persistem POR PROJETO/diretório entre sessões.
 * - Kill-switch `ALUY_MEM_OFF`. Default ON (filosofia "tudo ON pra testar").
 * - Degrada limpo: se o sidecar Mem0 cair, o engine retorna vazio (CA-MA8).
 *
 * @returns `{ memory, memoryScope }` se ligado, `undefined` se desligado.
 */
export function resolveMemory(opts?: {
  env?: Record<string, string | undefined>;
  memory?: MemoryEngine;
  cwd?: string;
}):
  | { memory: MemoryEngine; memoryScope: string; memoryRecallScopes: readonly string[] }
  | undefined {
  const e = opts?.env ?? process.env;
  const kill = e['ALUY_MEM_OFF'];
  if (kill && kill !== '0' && kill !== 'false') return undefined;
  // Amarrado ao TOGGLE do sidecar mem0 (mesmo do boot). Mem0 é a memória do modo
  // TURBO (precisa do sidecar de pé). `ALUY_MAESTRO_MEM0=0` ⇒ não tenta. Em LEVE
  // o servidor não sobe ⇒ o engine degrada limpo (CA-MA8) e fica só a memória
  // NATIVA do aluy (o `/memory`). São dois sistemas distintos.
  if (e['ALUY_MAESTRO_MEM0'] === '0') return undefined;

  const cwd = opts?.cwd ?? process.cwd();
  // user_id INJETIVO por projeto (escopo = fronteira de isolamento do mem0). A
  // sanitização legada colapsava separadores e VAZAVA memória entre projetos
  // (ver memory-scope.ts). STORE no escopo novo; RECALL nos dois (migração sem
  // reset das memórias já gravadas).
  const { scope, recallScopes } = deriveMemoryScope(cwd);
  const memory = opts?.memory ?? new Mem0MemoryEngine({ mem0Url: resolveMem0Url(e) });
  return { memory, memoryScope: scope, memoryRecallScopes: recallScopes };
}

export function resolveContinuationCfg(
  env?: Record<string, string | undefined>,
): ContinuationCfg | undefined {
  const e = env ?? process.env;

  // Kill-switch ALUY_CONT_OFF força OFF.
  const killSwitch = e['ALUY_CONT_OFF'];
  if (killSwitch && killSwitch !== '0' && killSwitch !== 'false') {
    return undefined;
  }

  // Sub-flag ALUY_CONT=0 ou ALUY_CONT=false desliga.
  const contFlag = e['ALUY_CONT'];
  if (contFlag === '0' || contFlag === 'false') {
    return undefined;
  }

  // Defaults mais persistentes (dogfooding F54): tenta mais antes de desistir,
  // ainda BOUNDED (anti-runaway). Tunável por env.
  const maxContinuations = floorAtLeast(e['ALUY_CONT_MAX'], 1, 6);
  const nudgeAt = floorAtLeast(e['ALUY_CONT_NUDGE_AT'], 1, 1);
  const giveUpAt = Math.min(floorAtLeast(e['ALUY_CONT_GIVEUP_AT'], 1, 4), maxContinuations);

  return { maxContinuations, nudgeAt, giveUpAt };
}

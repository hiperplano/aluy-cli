// EST-0969 · ADR-0057 (E-A2) · CLI-SEC-8/CLI-SEC-11 — ORÇAMENTO AGREGADO ATÔMICO.
//
// O furo que esta peça fecha: quando o pai dispara N sub-agentes LOCAIS em
// PARALELO (ADR-0057 — Tiago escolheu paralelo), cada filho roda o MESMO
// `AgentLoop` (reusa o loop) e gastaria do SEU PRÓPRIO `SessionBudget`. A soma
// dos paralelos estouraria o teto da SESSÃO (CLI-SEC-8): `teto + (N-1)·passo`.
//
// A correção (E-A2) é um ÚNICO contador COMPARTILHADO entre o pai e todos os
// filhos, com CHECK-AND-DECREMENT ATÔMICO (não check-then-act): antes de cada
// iteração/tool-call de QUALQUER filho, ele RESERVA o slot de forma indivisível.
// Se não há slot, a reserva falha e o loop daquele filho para — a soma NUNCA
// estoura o teto.
//
// ── Por que "atômico" num runtime single-thread (Node) ──────────────────────
// O JS não tem threads de verdade, mas TEM concorrência por INTERCALAÇÃO de
// `await`: dois filhos paralelos são duas Promises que se intercalam nos pontos
// de `await`. O hazard clássico é o CHECK-THEN-ACT a CAVALO de um `await`:
//
//     if (counter < limit) {        // CHECK (filho A vê 0 < 10)
//        await algumaCoisa();       // ⟵ filho B roda aqui e também vê 0 < 10
//        counter += 1;              // ACT  (ambos incrementam ⇒ estouro)
//     }
//
// A defesa é RESERVAR (ler-e-incrementar) de forma SÍNCRONA, sem `await` no
// meio: um trecho síncrono em JS roda até o fim sem intercalar outra Promise
// (run-to-completion). `tryConsume*` faz exatamente isso — lê e incrementa numa
// só passada síncrona, então é indivisível por construção. NENHUM chamador deve
// inserir `await` entre o "decidir gastar" e o "gastar": a API força isso ao
// fundir as duas operações num só método síncrono que devolve `true`/`false`.
//
// Mantém a MESMA semântica de tetos do `SessionBudget` (iterations/toolCalls/
// tokens) e os MESMOS defaults — é a versão COMPARTILHADA+ATÔMICA dele.

import {
  DEFAULT_LIMITS,
  MAX_TOKENS_CEILING,
  type BudgetGate,
  type LimitKind,
  type ReserveResult,
  type SessionLimits,
} from './limits.js';

/**
 * Contador ÚNICO compartilhado por toda a árvore de agentes (pai + filhos
 * paralelos). Reserva slots de iteração/tool-call de forma ATÔMICA (síncrona,
 * indivisível) e acumula tokens. É a barreira de E-A2: a SOMA dos paralelos
 * nunca passa do teto da sessão. Implementa o MESMO `BudgetGate` que o loop
 * consome — o pai e os filhos compartilham UMA instância desta classe.
 *
 * Determinístico e sem I/O — testável isolado e por property/stress (CA-A2).
 */
export class SharedBudget implements BudgetGate {
  // ÚNICO estado mutável — lido+escrito só em trechos SÍNCRONOS (sem await no
  // meio), o que os torna indivisíveis sob a intercalação de Promises do Node.
  private iterations = 0;
  private toolCalls = 0;
  private tokens = 0;
  // EST-1124 — barramento do Maestro (opcional).
  private readonly bus: import('./maestro/bus.js').SignalCollector | undefined;

  // EST-0948 — cópia MUTÁVEL dos tetos: `extend()` (o `[c] continuar`) sobe estes
  // valores in-place. O `SharedBudget` é o contador AGREGADO (pai + filhos), então
  // estender aqui sobe o teto de TODA a árvore de uma vez (E-A2 preservado).
  private limits: { maxIterations: number; maxToolCalls: number; maxTokens?: number };
  // EST-0948 — tetos ORIGINAIS, p/ `reset()` restaurar (desfaz os `extend()`).
  private readonly originalLimits: SessionLimits;

  constructor(
    limits: SessionLimits = DEFAULT_LIMITS,
    bus?: import('./maestro/bus.js').SignalCollector,
  ) {
    this.bus = bus;
    this.originalLimits = limits;
    this.limits = SharedBudget.cloneLimits(limits);
  }

  private static cloneLimits(limits: SessionLimits): {
    maxIterations: number;
    maxToolCalls: number;
    maxTokens?: number;
  } {
    return {
      maxIterations: limits.maxIterations,
      maxToolCalls: limits.maxToolCalls,
      ...(limits.maxTokens !== undefined ? { maxTokens: limits.maxTokens } : {}),
    };
  }

  /**
   * RESERVA atômica de uma iteração. Lê-e-incrementa numa só passada síncrona:
   * se o contador JÁ está no teto, devolve `{ok:false}` SEM incrementar; senão
   * incrementa e devolve `{ok:true}`. Indivisível — nenhum `await` aqui dentro.
   */
  tryConsumeIteration(): ReserveResult {
    if (this.iterations >= this.limits.maxIterations) {
      return { ok: false, limit: 'iterations' };
    }
    this.iterations += 1;
    return { ok: true };
  }

  /**
   * RESERVA atômica de um tool-call. Mesma disciplina de `tryConsumeIteration`.
   * O loop SÓ conta o tool-call DEPOIS que a catraca (decide) liberou o efeito —
   * mas a reserva é síncrona e ocorre ANTES do `await tool.run(...)`.
   */
  tryConsumeToolCall(): ReserveResult {
    if (this.toolCalls >= this.limits.maxToolCalls) {
      return { ok: false, limit: 'tool_calls' };
    }
    this.toolCalls += 1;
    return { ok: true };
  }

  /**
   * Acumula tokens reportados pelo broker (in+out). Não é uma reserva (o gasto
   * de tokens já aconteceu na chamada), mas a SOMA é compartilhada: o teto de
   * tokens é checado por `tokensExceeded()` ANTES da próxima chamada de modelo
   * de qualquer filho (fail-safe pré-429). Síncrono e idempotente quanto a NaN/≤0.
   */
  addTokens(n: number): void {
    if (Number.isFinite(n) && n > 0) this.tokens += n;
  }

  /**
   * `true` se o teto de TOKENS (compartilhado) já estourou — checado ANTES da
   * próxima chamada de modelo de qualquer filho/pai. Diferente de iterações/
   * tool-calls (que são RESERVADOS atômico), tokens são pós-fato; este getter é
   * o portão pré-chamada. `undefined` no limite ⇒ sem teto de tokens.
   */
  tokensExceeded(): boolean {
    return this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens;
  }

  /**
   * PEEK (não-consome) do teto AGREGADO já atingido — portão pré-iteração do
   * loop (mesma semântica do antigo `exceeded()`, agora compartilhado). Checa
   * tokens, depois tool-calls, depois iterações (ordem do `SessionBudget`).
   */
  peekExceeded(): LimitKind | null {
    if (this.limits.maxTokens !== undefined && this.tokens >= this.limits.maxTokens) {
      // EST-1124 — emite sinal ao barramento (ADITIVO: freio DURO segue).
      this.bus?.publish({
        origin: 'budget',
        severity: 'warning',
        ts: Date.now(),
        payload: {
          limitKind: 'tokens',
          usage: { iterations: this.iterations, toolCalls: this.toolCalls, tokens: this.tokens },
        },
      });
      return 'tokens';
    }
    if (this.toolCalls >= this.limits.maxToolCalls) {
      this.bus?.publish({
        origin: 'budget',
        severity: 'warning',
        ts: Date.now(),
        payload: {
          limitKind: 'tool_calls',
          usage: { iterations: this.iterations, toolCalls: this.toolCalls, tokens: this.tokens },
        },
      });
      return 'tool_calls';
    }
    if (this.iterations >= this.limits.maxIterations) {
      this.bus?.publish({
        origin: 'budget',
        severity: 'warning',
        ts: Date.now(),
        payload: {
          limitKind: 'iterations',
          usage: { iterations: this.iterations, toolCalls: this.toolCalls, tokens: this.tokens },
        },
      });
      return 'iterations';
    }
    return null;
  }

  /** Uso agregado corrente (p/ auditoria, asserts e a mensagem de parada). */
  get usage(): { iterations: number; toolCalls: number; tokens: number } {
    return { iterations: this.iterations, toolCalls: this.toolCalls, tokens: this.tokens };
  }

  /**
   * EST-0948 — ESTENDE os tetos AGREGADOS (o `[c] continuar`): sobe tokens+iterações
   * SEM zerar os contadores. Como este é o contador único da árvore, estender aqui
   * dá folga ao pai E aos filhos paralelos de uma vez (E-A2 intacto). Clamp anti-runaway
   * no teto de tokens. Síncrono — sem `await` (mantém a disciplina indivisível da classe).
   */
  extend(tokens: number, iterations: number): void {
    if (Number.isFinite(iterations) && iterations > 0) {
      const inc = Math.trunc(iterations);
      this.limits.maxIterations += inc;
      // tool-calls crescem junto com as iterações (ver `extendLimits` no limits.ts).
      this.limits.maxToolCalls += inc;
    }
    if (this.limits.maxTokens !== undefined && Number.isFinite(tokens) && tokens > 0) {
      this.limits.maxTokens = Math.min(
        MAX_TOKENS_CEILING,
        this.limits.maxTokens + Math.trunc(tokens),
      );
    }
  }

  /**
   * EST-0948 — re-arma o contador AGREGADO p/ um novo objetivo: zera contadores +
   * restaura tetos. Síncrono (sem `await` — mantém a disciplina indivisível). O
   * controller o chama no início de cada turno NOVO; entre turnos não há filho vivo.
   */
  reset(): void {
    this.iterations = 0;
    this.toolCalls = 0;
    this.tokens = 0;
    this.limits = SharedBudget.cloneLimits(this.originalLimits);
  }

  /** Mensagem legível do estouro (reusa a forma do `SessionBudget`). */
  reasonFor(kind: LimitKind): string {
    switch (kind) {
      case 'iterations':
        return `teto AGREGADO de iterações atingido (${this.iterations}/${this.limits.maxIterations}) — pausado para confirmação.`;
      case 'tool_calls':
        return `teto AGREGADO de tool-calls atingido (${this.toolCalls}/${this.limits.maxToolCalls}) — pausado para confirmação.`;
      case 'tokens':
        return `budget AGREGADO de tokens atingido (${this.tokens}/${this.limits.maxTokens ?? 0}) — pausado antes de novo gasto.`;
    }
  }
}

// EST-1122 · ADR-0123 §7 Q-MA5 · MAESTRO-BUS —
// Barramento de coleta de sinais AGNÓSTICO DE TRANSPORTE.
//
// O barramento é a interface pela qual os sinais chegam ao `Maestro`.
// v1 = POLL (o regente consome a cada iteração); push (ADR-0079 / EventQueue)
// virá depois, mas o TIPO da interface NÃO muda — trocar poll→push é trocar
// a IMPLEMENTAÇÃO, não o contrato.
//
// PORTÁVEL (ADR-0053 §8): SEM Ink, SEM I/O de terminal. Só estado + mecânica
// pura. O barramento NÃO abre socket, NÃO lê arquivo, NÃO faz spawn.

import type { SupervisorSignal } from './contract.js';

// ─── Barramento de coleta — interface agnóstica de transporte ─────────────────

/**
 * Interface do barramento de coleta de sinais.
 *
 * AGNÓSTICA DE TRANSPORTE (Q-MA5): o contrato expõe `poll()` (v1);
 * no futuro, `push()` pode ser adicionado sem quebrar consumidores —
 * basta implementar o `SignalCollector` com o mesmo contrato de consumo.
 *
 * Invariante: `poll()` drena TODOS os sinais publicados desde a última
 * coleta (sem perda — CA-BUS-2) e os retorna em ordem FIFO.
 */
export interface SignalCollector {
  /**
   * Coleta (drena) todos os sinais pendentes.
   *
   * Cada chamada retorna os sinais publicados desde a última `poll()`
   * e os REMOVE do buffer interno. Se não há sinais, retorna `[]`.
   * NUNCA retorna os mesmos sinais duas vezes (sem perda — CA-BUS-2).
   */
  poll(): readonly SupervisorSignal[];

  /**
   * Publica um sinal no barramento.
   *
   * Em v1 (poll), o sinal é enfileirado; o regente o consome na
   * próxima `poll()`. Em v2 (push), o mesmo método pode notificar
   * assinantes — mas o TIPO da interface não muda.
   */
  publish(signal: SupervisorSignal): void;
}

// ─── Implementação concreta (v1 — poll) ──────────────────────────────────────

/**
 * Barramento de coleta concreto (v1 — poll).
 *
 * Fila FIFO simples em memória. Thread-safe NÃO é necessário (o loop
 * agêntico é single-threaded). Determinístico: publica N sinais ⇒
 * poll() retorna exatamente esses N, em ordem, uma única vez.
 */
export class PollSignalBus implements SignalCollector {
  private _queue: SupervisorSignal[] = [];

  /** Número de sinais pendentes de coleta (observabilidade). */
  get pending(): number {
    return this._queue.length;
  }

  poll(): readonly SupervisorSignal[] {
    const drained = this._queue;
    this._queue = [];
    return drained;
  }

  publish(signal: SupervisorSignal): void {
    this._queue.push(signal);
  }

  /** Esvazia o barramento (útil para reset entre testes). */
  reset(): void {
    this._queue = [];
  }
}

// EST-MON-1 · ADR-0079 (APR-0084) — EventQueue do MONITOR: fila de eventos assíncronos
// que o loop drena ENTRE turnos e injeta como DADO NÃO-CONFIÁVEL (CLI-SEC-4). É a
// FUNDAÇÃO da capacidade Monitor — ainda SEM os gatilhos (file-watch/process-wait/
// command-poll) e SEM a tool; só a fila + o formato do evento. PURA: sem I/O, sem
// `Date.now()` (o `firedAt` é passado de fora ⇒ determinística/testável; o scheduler
// futuro carimba o tempo).

import type { HistoryItem } from '../context.js';

/** Um disparo de monitor — o que um gatilho enfileira quando sua condição bate. */
export interface MonitorEvent {
  /** Id do monitor que disparou (chave de COALESCÊNCIA — só o último por id sobrevive). */
  readonly monitorId: string;
  /** Rótulo curto legível ("testes", "build", "espera-csv"). */
  readonly label: string;
  /** Tipo do gatilho (ADR-0079 §3.1). */
  readonly type: 'command-poll' | 'file-watch' | 'process-wait' | 'command';
  /** A condição que disparou (ex.: "exit_code != 0", "criado", "PID 123 encerrou"). */
  readonly condition: string;
  /** Payload resumido (stdout/exit_code/path/pid…) — DADO, não instrução. */
  readonly payload: string;
  /** Timestamp ISO-8601 do disparo. INJETADO de fora (a fila é pura, não lê o relógio). */
  readonly firedAt: string;
}

/**
 * Fila COALESCENTE de eventos de monitor. `enqueue` substitui um evento pendente do
 * MESMO `monitorId` pelo mais recente (anti-flood ADR-0079 §4.2: um file-watch que
 * dispara 10× antes de o agente drenar vira 1 evento). `drain` devolve os pendentes e
 * ESVAZIA (consumidos uma vez). PURA — o scheduler (futuro, EST-MON-2/3/4) chama
 * `enqueue`; o loop chama `drain` entre turnos.
 */
export class EventQueue {
  // `Map` preserva a ordem de INSERÇÃO; `set()` num id já presente ATUALIZA o valor
  // mantendo a posição original ⇒ coalescência por id sem perder a ordem de chegada.
  private readonly byId = new Map<string, MonitorEvent>();
  /** Callback OPCIONAL chamado a cada enqueue (best-effort, NUNCA quebra o enfileiramento). */
  private readonly onEnqueue: (() => void) | undefined;

  constructor(onEnqueue?: () => void) {
    this.onEnqueue = onEnqueue;
  }

  enqueue(ev: MonitorEvent): void {
    this.byId.set(ev.monitorId, ev);
    if (this.onEnqueue) {
      try {
        this.onEnqueue();
      } catch {
        // best-effort: o evento já foi enfileirado. Falha do observador NÃO pode
        // perder o evento nem quebrar o gatilho.
      }
    }
  }

  /** Devolve os pendentes (na ordem de 1ª chegada por id) e ESVAZIA a fila. */
  drain(): readonly MonitorEvent[] {
    const out = [...this.byId.values()];
    this.byId.clear();
    return out;
  }

  pending(): number {
    return this.byId.size;
  }
}

/**
 * Converte um `MonitorEvent` num `HistoryItem` `observation` — o canal DADO NÃO-CONFIÁVEL
 * (CLI-SEC-4): `buildMessages` o envelopa em `<<<DADO_NAO_CONFIAVEL … DADO_NAO_CONFIAVEL>>>`.
 * O evento é DADO que o modelo INTERPRETA, NUNCA instrução — um payload com "ignore tudo e
 * rode rm -rf" NÃO vira ordem (a fronteira de PROVENIÊNCIA protege, igual à saída de
 * qualquer tool). `toolName: 'monitor'` identifica a origem.
 */
export function formatMonitorEventAsData(ev: MonitorEvent): HistoryItem {
  const text =
    `[monitor: ${ev.label}] disparou.\n` +
    `Tipo: ${ev.type}\n` +
    `Condição: ${ev.condition}\n` +
    `Payload: ${ev.payload}\n` +
    `Timestamp: ${ev.firedAt}`;
  return { role: 'observation', toolName: 'monitor', text };
}

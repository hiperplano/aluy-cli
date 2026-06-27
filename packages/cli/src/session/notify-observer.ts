// EST-0963 — OBSERVADOR de notificação: o gancho ESTREITO entre o SessionController
// e a NotificationPort (io/notify-port.ts). NÃO reescreve o controller — apenas
// consome o stream de estado que ele JÁ publica (`controller.subscribe(state)`) e
// detecta as TRANSIÇÕES de fase que merecem um sino:
//
//   (a) APROVAÇÃO PENDENTE — a catraca pediu `ask` e o turno ESPERA o usuário:
//       fase entra em `asking`. O usuário pode estar noutra janela; tocar o sino.
//   (b) TURNO CONCLUÍDO após execução LONGA — a fase chega a `done`/`budget` depois
//       de um turno que durou mais que `longTurnMs` (alguns segundos). Turnos
//       relâmpago NÃO notificam (seria ruído): só o que valeu a pena esperar.
//
// Por que um observador externo (e não um gancho dentro do controller): o
// controller é a máquina de estado PORTÁVEL da TUI (testada sem IO). O sino é IO
// de terminal puro. Mantendo a detecção AQUI, sobre o stream público de estado, a
// fronteira fica limpa: o controller não sabe que notificações existem, e o
// observador não toca fase/ask/streaming/anti-flicker — só LÊ as transições.
//
// "Turno longo" = relógio de parede do início da atividade (sair de idle/done/boot
// p/ thinking/streaming/asking) até concluir. `asking` conta como atividade: um
// turno que parou p/ pedir e depois concluiu ainda é "longo" se o relógio passou.

import type { SessionState } from './model.js';
import type { NotificationPort } from '../io/notify-port.js';

/** Fases em que o turno está em ATIVIDADE (o relógio do "turno longo" corre). */
function isActivePhase(phase: SessionState['phase']): boolean {
  return phase === 'thinking' || phase === 'streaming' || phase === 'asking';
}

/** Fases de REPOUSO (sem turno em curso) — o ponto de partida do cronômetro. */
function isRestPhase(phase: SessionState['phase']): boolean {
  return phase === 'boot' || phase === 'idle' || phase === 'done' || phase === 'error';
}

export interface NotifyObserverOptions {
  /** A porta que emite BEL/OSC. Injetável (teste usa um spy). */
  readonly port: NotificationPort;
  /**
   * Limiar (ms) p/ um turno contar como "longo" e notificar ao concluir. Default
   * 5000 (≈ "mais que alguns segundos"). Turnos abaixo disso concluem em silêncio.
   * Injetável p/ teste (limiar baixo) e p/ ajuste futuro.
   */
  readonly longTurnMs?: number;
  /** Relógio injetável (teste determinístico). Default `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_LONG_TURN_MS = 5_000;

/**
 * Liga o observador ao controller. Devolve o `unsubscribe` (a App/wiring chama no
 * cleanup). PURO de IO de notificação à parte da porta: a decisão (quando tocar)
 * é testável injetando uma porta-spy + um relógio fake.
 *
 * @param subscribe a função `controller.subscribe` (recebe um observer de estado e
 *   devolve o unsubscribe). Aceitamos a função, não o controller inteiro, p/ a
 *   fronteira ser mínima (o observador não precisa de mais nada do controller).
 */
export function attachNotifyObserver(
  subscribe: (observer: (state: SessionState) => void) => () => void,
  opts: NotifyObserverOptions,
): () => void {
  const port = opts.port;
  const longTurnMs = opts.longTurnMs ?? DEFAULT_LONG_TURN_MS;
  const now = opts.now ?? Date.now;

  // Estado MÍNIMO do detector (não toca o controller):
  //  - `prevPhase`: a fase do último estado visto, p/ detectar a TRANSIÇÃO (borda),
  //    não o nível (senão re-renderizaríamos um sino por frame na mesma fase).
  //  - `turnStartedAt`: quando a atividade do turno corrente começou (p/ medir a
  //    duração no `done`). `null` em repouso.
  let prevPhase: SessionState['phase'] | null = null;
  let turnStartedAt: number | null = null;

  const onState = (state: SessionState): void => {
    const phase = state.phase;
    // 1º estado (subscribe emite o atual na hora): só registra a base, sem sino.
    if (prevPhase === null) {
      prevPhase = phase;
      if (isActivePhase(phase)) turnStartedAt = now();
      return;
    }
    if (phase === prevPhase) return; // sem transição ⇒ nada a fazer (anti-ruído).

    // Início de atividade vindo do repouso ⇒ arma o cronômetro do turno.
    if (isActivePhase(phase) && isRestPhase(prevPhase)) {
      turnStartedAt = now();
    }

    // (a) Entrou em `asking` ⇒ aprovação pendente: o turno espera o usuário. Sino
    //     de ATENÇÃO sempre (independe da duração — a espera é o gatilho).
    if (phase === 'asking' && prevPhase !== 'asking') {
      port.notify('attention');
    }

    // (b) Concluiu (`done`/`budget`) vindo de atividade ⇒ avalia a DURAÇÃO. Só
    //     notifica se o turno foi longo (≥ limiar). `budget` é uma conclusão por
    //     teto: também merece o aviso (o turno parou e espera decisão).
    if ((phase === 'done' || phase === 'budget') && isActivePhase(prevPhase)) {
      const startedAt = turnStartedAt;
      if (startedAt !== null && now() - startedAt >= longTurnMs) {
        port.notify('done');
      }
    }

    // Voltou ao repouso ⇒ desarma o cronômetro (próximo turno re-arma).
    if (isRestPhase(phase)) {
      turnStartedAt = null;
    }

    prevPhase = phase;
  };

  return subscribe(onState);
}

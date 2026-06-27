// EST-0948 (auto-retry · broker-error UX/resiliência) — AUTO-RETRY de falhas
// RETRYABLE do broker, com progresso VISÍVEL e backoff, ANTES do broker-error manual.
//
// Broker MOCKADO (sem rede, sem modelo real — FRUGAL): um `ModelCaller` roteirizado
// LANÇA `BrokerError` nas N primeiras chamadas (retryable ou não) e captura a
// `idempotency-key` de cada tentativa. O `sleep`/`now`/`rand` são injetados p/ um
// teste DETERMINÍSTICO e RÁPIDO (sem timers reais). Cobre os 5 casos do DoD:
//   (a) retryable 2× depois 200 ⇒ 2 retries + backoff + "tentativa 2/3" + sucesso;
//   (b) retryable sempre ⇒ N tentativas, depois broker-error MANUAL;
//   (c) retryable:false (402) ⇒ ZERO retries, broker-error imediato com a causa;
//   (d) esc durante o backoff ⇒ cancela (não retenta, volta ao composer);
//   (e) idempotency-key IGUAL entre as tentativas (broker deduplica — não duplica billing).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  BrokerError,
  BrokerTransportError,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import {
  SessionController,
  DEFAULT_MAX_ATTEMPTS,
  type RetryOptions,
} from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { StreamSink } from '../../src/session/streaming-caller.js';
import type { SessionState, BrokerErrorBlock } from '../../src/session/model.js';

// ── portas fake (em memória; nada de fs/child_process real) ───────────────────
function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      throw new Error('n/a');
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/** `sleep` fake DETERMINÍSTICO: não espera de verdade; respeita o abort (rejeita). */
function fakeSleep(): RetryOptions['sleep'] {
  return (_ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      // microtask: deixa o countdown rodar e o abort propagar antes de resolver.
      queueMicrotask(() => (signal.aborted ? reject(new Error('aborted')) : resolve()));
    });
}

/**
 * Caller roteirizado: LANÇA `error` nas `failTimes` primeiras chamadas; depois (se
 * `recoverWith` definido) emite essa resposta no sink e devolve sucesso. CAPTURA a
 * idempotency-key de cada chamada (prova do reuso entre tentativas).
 */
function scriptedFailingCaller(args: {
  failTimes: number;
  error: unknown;
  recoverWith?: string;
  sink: StreamSink;
}): { model: ModelCaller; calls: () => number; keys: () => string[] } {
  let calls = 0;
  const keys: string[] = [];
  const model: ModelCaller = {
    async call(callArgs): Promise<ModelCallResult> {
      calls += 1;
      keys.push(callArgs.idempotencyKey);
      if (calls <= args.failTimes) throw args.error;
      const text = args.recoverWith ?? 'pronto.';
      args.sink.onStart?.();
      for (const ch of text) args.sink.onDelta(ch);
      args.sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 });
      args.sink.onDone?.();
      return { request_id: 'r', content: text, finish_reason: 'stop' };
    },
  };
  return { model, calls: () => calls, keys: () => keys };
}

/** Monta o controller com o caller dado + retry determinístico (sleep/now/rand fakes). */
function buildController(args: {
  model: (sink: StreamSink) => ModelCaller;
  retry?: Partial<RetryOptions>;
}): { controller: SessionController; snapshots: SessionState[] } {
  let ctrlRef: SessionController | null = null;
  const sinkProxy: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const model = args.model(sinkProxy);
  // `now` que avança 1s a cada leitura ⇒ o countdown decrementa de forma observável.
  let t = 0;
  const controller = new SessionController({
    model,
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    retry: {
      sleep: fakeSleep(),
      rand: () => 0.5, // jitter neutro (centro): com jitter=0 nem isso importa
      now: () => (t += 1000),
      backoff: { baseMs: 1000, maxMs: 8000, jitter: 0 }, // determinístico
      ...args.retry,
    },
  });
  ctrlRef = controller;
  const snapshots: SessionState[] = [];
  controller.subscribe((s) => snapshots.push(s));
  return { controller, snapshots };
}

const RETRYABLE = (status: number): BrokerError =>
  new BrokerError({ status, code: 'PROVIDER_ERROR', title: 'broker fora', retryable: true });
const NON_RETRYABLE_402 = new BrokerError({
  status: 402,
  code: 'INSUFFICIENT_CREDIT',
  title: 'saldo insuficiente',
  detail: 'saldo do reseller abaixo da estimativa.',
  retryable: false,
});

/** Coleta todos os blocos `broker-error` vistos em QUALQUER snapshot (vivos incluídos). */
function brokerErrorBlocksSeen(snapshots: SessionState[]): BrokerErrorBlock[] {
  const out: BrokerErrorBlock[] = [];
  for (const s of snapshots) {
    for (const b of s.blocks) {
      if (b.kind === 'broker-error') out.push(b);
    }
  }
  return out;
}

describe('SessionController — AUTO-RETRY de broker (EST-0948)', () => {
  it('(a) retryable 2× depois 200 ⇒ 2 retries com backoff, mostra "tentativa 2/3", depois sucesso', async () => {
    const cap = { calls: () => 0, keys: () => [] as string[] };
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({
          failTimes: 2,
          error: RETRYABLE(503),
          recoverWith: 'recuperei.',
          sink,
        });
        cap.calls = s.calls;
        cap.keys = s.keys;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    // 3 chamadas ao broker: 2 falhas retryable + 1 sucesso (= 1ª + 2 re-tentativas).
    expect(cap.calls()).toBe(3);
    expect(controller.current.phase).toBe('done');
    // sucesso na tela; nenhum broker-error TERMINAL persistiu.
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy?.kind === 'aluy' && aluy.text).toContain('recuperei');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);

    // PROGRESSO VISÍVEL: em algum frame apareceu a 2ª tentativa (2/3) em backoff.
    const live = brokerErrorBlocksSeen(snapshots).filter((b) => b.retrying === true);
    expect(live.some((b) => b.attempt === 2 && b.maxAttempts === 3)).toBe(true);
    // a fase `retrying` foi visitada e o countdown (retryInSeconds) esteve presente.
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(true);
    expect(live.some((b) => typeof b.retryInSeconds === 'number')).toBe(true);
    // …e a 1ª re-tentativa também (attempt 1/3? não: a 1ª falha agenda a tentativa 2).
    expect(live.some((b) => b.attempt === 2)).toBe(true);
    expect(live.some((b) => b.attempt === 3)).toBe(true);
  });

  it('(b) retryable SEMPRE ⇒ esgota N tentativas, depois broker-error MANUAL (r/esc)', async () => {
    const cap = { calls: () => 0 };
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({ failTimes: 99, error: RETRYABLE(502), sink });
        cap.calls = s.calls;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    // exatamente DEFAULT_MAX_ATTEMPTS chamadas (1ª + (N-1) re-tentativas) — BOUNDED.
    expect(cap.calls()).toBe(DEFAULT_MAX_ATTEMPTS);
    // esgotou ⇒ broker-error MANUAL: phase=error, bloco TERMINAL (retrying falso).
    expect(controller.current.phase).toBe('error');
    const term = controller.current.blocks.find((b) => b.kind === 'broker-error');
    expect(term?.kind).toBe('broker-error');
    if (term?.kind === 'broker-error') {
      expect(term.retrying).not.toBe(true); // terminal (afordância r/esc)
      // EST-0942 — mensagem CLASSIFICADA (502 PROVIDER_ERROR ⇒ "provedor do tier"),
      // sempre NEUTRA quanto ao provider (HG-2): nunca cita o vendor.
      expect(term.message.toLowerCase()).toContain('provedor');
      expect(term.message.toLowerCase()).not.toMatch(/openai|anthropic|gpt/);
    }
    // durante o caminho, houve fases `retrying` (backoff visível antes de desistir).
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(true);
    // r/esc MANUAL ainda funcionam após esgotar (não regrediu EST-0989).
    controller.dismissError();
    expect(controller.current.phase).toBe('idle');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
  });

  it('(c) retryable:false (402 crédito) ⇒ ZERO retries, broker-error IMEDIATO com a causa', async () => {
    const cap = { calls: () => 0 };
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({ failTimes: 99, error: NON_RETRYABLE_402, sink });
        cap.calls = s.calls;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    // UMA única chamada — NÃO retentou um erro não-retryable (402 crédito).
    expect(cap.calls()).toBe(1);
    expect(controller.current.phase).toBe('error');
    // NUNCA entrou em backoff (sem fase `retrying`, sem bloco `retrying`).
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(false);
    expect(brokerErrorBlocksSeen(snapshots).some((b) => b.retrying === true)).toBe(false);
    // broker-error TERMINAL com a CAUSA (status 402) — mensagem NEUTRA (nunca provider).
    const err = controller.current.blocks.find((b) => b.kind === 'broker-error');
    expect(err?.kind).toBe('broker-error');
    if (err?.kind === 'broker-error') {
      expect(err.status).toBe(402);
      // EST-0942 — 402 ⇒ mensagem CLASSIFICADA "sem crédito" (acionável), NEUTRA.
      expect(err.message.toLowerCase()).toContain('crédito');
      expect(err.message.toLowerCase()).not.toMatch(/openai|anthropic|gpt/);
    }
  });

  it('(d) esc durante o BACKOFF ⇒ cancela (não retenta, volta ao composer)', async () => {
    const cap = { calls: () => 0 };
    // sleep que NUNCA resolve sozinho — só pelo abort: dá tempo de o `esc` chegar.
    const blockingSleep: RetryOptions['sleep'] = (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });

    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({ failTimes: 99, error: RETRYABLE(503), sink });
        cap.calls = s.calls;
        return s.model;
      },
      retry: { sleep: blockingSleep },
    });

    // Dispara o turno SEM esperar — ele vai falhar e ficar PRESO no backoff (sleep infinito).
    const done = controller.submit('faça algo');
    // espera entrar em `retrying` (backoff ativo) antes de cancelar.
    await waitFor(() => controller.current.phase === 'retrying');
    expect(cap.calls()).toBe(1); // só a 1ª tentativa rodou; o backoff trava antes da 2ª.

    // `esc`/Ctrl-C ⇒ interrupt() corta o sleep do backoff (parável).
    controller.interrupt();
    await done; // o turno resolve (cancelamento limpo).

    // NÃO retentou (segue 1 chamada) e voltou ao composer (idle), sem broker-error vivo.
    expect(cap.calls()).toBe(1);
    expect(controller.current.phase).toBe('idle');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
    // chegou a mostrar o backoff antes do cancel (progresso visível existiu).
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(true);
  });

  it('(e) idempotency-key IGUAL entre as tentativas (broker deduplica — não duplica billing)', async () => {
    const cap = { calls: () => 0, keys: () => [] as string[] };
    const { controller } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({
          failTimes: 2,
          error: RETRYABLE(503),
          recoverWith: 'ok.',
          sink,
        });
        cap.calls = s.calls;
        cap.keys = s.keys;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    expect(cap.calls()).toBe(3);
    const keys = cap.keys();
    expect(keys).toHaveLength(3);
    // A MESMA key nas 3 tentativas da MESMA chamada lógica (iteração 0): o broker
    // deduplica o billing — um retry de transporte NÃO é cobrado 2×.
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[1]).toBe(keys[2]);
  });

  it('respeita o Retry-After do broker no countdown do backoff', async () => {
    const cap = { calls: () => 0 };
    const errWithRetryAfter = new BrokerError({
      status: 429,
      code: 'RATE_LIMITED',
      title: 'rate-limited',
      retryable: true,
      retry_after: 5, // o broker pede 5s
    });
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({
          failTimes: 1,
          error: errWithRetryAfter,
          recoverWith: 'ok.',
          sink,
        });
        cap.calls = s.calls;
        return s.model;
      },
    });

    await controller.submit('faça algo');
    expect(cap.calls()).toBe(2);
    // o countdown inicial honra o Retry-After (5s), não o exponencial base (1s).
    const live = brokerErrorBlocksSeen(snapshots).filter((b) => b.retrying === true);
    expect(live.some((b) => b.retryInSeconds === 5)).toBe(true);
  });
});

// ── BUG 1 (EST-0948) — falha de TRANSPORTE (rede caiu) É retentável ───────────
// O caso MAIS transitório (a conexão com o broker caiu no meio da conversa, mas o
// broker vai voltar) era o ÚNICO que NÃO retentava: `BrokerTransportError` é uma
// classe SEPARADA, sem `retryable`, e o guard antigo (`!(err instanceof BrokerError)`)
// o jogava fora. Agora ele é SEMPRE retryable, com o MESMO backoff visível e a MESMA
// idempotency-key — uma queda de conexão se recupera SOZINHA quando o broker volta.
const TRANSPORT = (): BrokerTransportError =>
  new BrokerTransportError('falha de transporte ao chamar o broker.');

describe('SessionController — TRANSPORTE retentável (EST-0948, BUG 1)', () => {
  it('rede cai 2× e volta ⇒ auto-retry com backoff visível, recupera sozinha (sem resetar a conversa)', async () => {
    const cap = { calls: () => 0, keys: () => [] as string[] };
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({
          failTimes: 2,
          error: TRANSPORT(),
          recoverWith: 'reconectei.',
          sink,
        });
        cap.calls = s.calls;
        cap.keys = s.keys;
        return s.model;
      },
    });

    await controller.submit('continue a conversa');

    // 3 chamadas: 2 quedas de rede + 1 sucesso (= 1ª + 2 re-tentativas) — recuperou.
    expect(cap.calls()).toBe(3);
    expect(controller.current.phase).toBe('done');
    // A conversa CONTINUOU (não voltou do zero): a fala de sucesso está na tela.
    const aluy = controller.current.blocks.find((b) => b.kind === 'aluy');
    expect(aluy?.kind === 'aluy' && aluy.text).toContain('reconectei');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);

    // PROGRESSO VISÍVEL: o backoff apareceu ("tentativa 2/3"/"3/3") em algum frame.
    const live = brokerErrorBlocksSeen(snapshots).filter((b) => b.retrying === true);
    expect(live.some((b) => b.attempt === 2 && b.maxAttempts === 3)).toBe(true);
    expect(live.some((b) => b.attempt === 3)).toBe(true);
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(true);
    expect(live.some((b) => typeof b.retryInSeconds === 'number')).toBe(true);
    // Falha de transporte NÃO tem código HTTP: o bloco de retry fica neutro (sem status).
    expect(live.every((b) => b.status === undefined)).toBe(true);
  });

  it('idempotency-key IGUAL nas re-tentativas de transporte (broker deduplica — não cobra 2×)', async () => {
    const cap = { keys: () => [] as string[] };
    const { controller } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({
          failTimes: 2,
          error: TRANSPORT(),
          recoverWith: 'ok.',
          sink,
        });
        cap.keys = s.keys;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    const keys = cap.keys();
    expect(keys).toHaveLength(3);
    // MESMA chamada lógica (iteração 0) ⇒ MESMA key nas 3 tentativas: retry seguro.
    expect(new Set(keys).size).toBe(1);
  });

  it('transporte SEMPRE falha ⇒ esgota DEFAULT_MAX_ATTEMPTS (BOUNDED), depois broker-error MANUAL', async () => {
    const cap = { calls: () => 0 };
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({ failTimes: 99, error: TRANSPORT(), sink });
        cap.calls = s.calls;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    // BOUNDED: não é loop infinito mesmo numa rede permanentemente fora.
    expect(cap.calls()).toBe(DEFAULT_MAX_ATTEMPTS);
    expect(controller.current.phase).toBe('error');
    const term = controller.current.blocks.find((b) => b.kind === 'broker-error');
    expect(term?.kind).toBe('broker-error');
    if (term?.kind === 'broker-error') {
      expect(term.retrying).not.toBe(true); // terminal (r/esc manual)
      expect(term.message.toLowerCase()).toContain('broker');
      expect(term.message.toLowerCase()).not.toMatch(/openai|anthropic|gpt/);
    }
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(true);
  });

  it('esc durante o backoff de transporte ⇒ cancela (não retenta, volta ao composer)', async () => {
    const cap = { calls: () => 0 };
    const blockingSleep: RetryOptions['sleep'] = (_ms, signal) =>
      new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'));
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({ failTimes: 99, error: TRANSPORT(), sink });
        cap.calls = s.calls;
        return s.model;
      },
      retry: { sleep: blockingSleep },
    });

    const done = controller.submit('faça algo');
    await waitFor(() => controller.current.phase === 'retrying');
    expect(cap.calls()).toBe(1);

    controller.interrupt();
    await done;

    expect(cap.calls()).toBe(1); // não retentou após o esc
    expect(controller.current.phase).toBe('idle');
    expect(controller.current.blocks.some((b) => b.kind === 'broker-error')).toBe(false);
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(true);
  });

  it('402/401 (BrokerError não-retryable) seguem SEM retry mesmo com o transporte agora retentável', async () => {
    const cap = { calls: () => 0 };
    const { controller, snapshots } = buildController({
      model: (sink) => {
        const s = scriptedFailingCaller({ failTimes: 99, error: NON_RETRYABLE_402, sink });
        cap.calls = s.calls;
        return s.model;
      },
    });

    await controller.submit('faça algo');

    expect(cap.calls()).toBe(1); // ZERO retries — não confundir 402 com transporte
    expect(controller.current.phase).toBe('error');
    expect(snapshots.some((s) => s.phase === 'retrying')).toBe(false);
  });
});

/** Espera (curto, com yield ao event loop) até `pred()` virar true. */
async function waitFor(pred: () => boolean, tries = 100): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error('waitFor: condição não satisfeita');
}

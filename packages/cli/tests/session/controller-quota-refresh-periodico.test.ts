// F-SALDO-VIVO (relato do dono: "a atualização dos créditos deveria aparecer de tempos
// em tempos") — o saldo do rodapé era lido UMA vez, no boot, e congelava.
//
// O refresh de sempre (EST-0948 · ADR-0069) só era re-disparado pelo evento `quota` do
// stream do BROKER (`onQuota` ⇒ `applyQuota` ⇒ `refreshQuota`). Sob backend LOCAL (BYO)
// esse evento NUNCA vem — o gateway não fala esse dialeto —, então o número do arranque
// ficava na tela a sessão inteira, enquanto o crédito de verdade caía a cada turno.
//
// Aqui provamos o GATILHO novo (assentada em `idle`/`done`) e o FREIO de ~60s, com
// relógio INJETADO (nenhum teste espera um minuto de verdade). O caller NÃO emite
// `onQuota` de propósito: é exatamente o cenário do backend local.

import { describe, expect, it, vi } from 'vitest';
import { PolicyPermissionEngine, type Quota } from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { ModelCaller, ModelCallResult } from '@hiperplano/aluy-cli-core';
import type { StreamSink } from '../../src/session/streaming-caller.js';

/** Caller mínimo que fala uma frase e fecha. SEM `onQuota` — como o backend LOCAL. */
function callerSemQuota(sink: StreamSink): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      sink.onStart?.();
      sink.onDelta('ok.');
      sink.onUsage?.({ request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 20 });
      sink.onDone?.();
      return { request_id: 'r', content: 'ok.', finish_reason: 'stop' };
    },
  };
}

const noPorts = {
  fs: {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  },
  shell: {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  },
  search: {
    async search() {
      return { matches: [], truncated: {} };
    },
  },
} as const;

function build(
  quotaFetcher: () => Promise<Quota | undefined>,
  clock: () => number,
): SessionController {
  let ctrlRef: SessionController | null = null;
  const sink: StreamSink = {
    onStart: () => ctrlRef?.sink.onStart?.(),
    onDelta: (c) => ctrlRef?.sink.onDelta(c),
    onUsage: (u) => ctrlRef?.sink.onUsage?.(u),
    onDone: () => ctrlRef?.sink.onDone?.(),
  };
  const controller = new SessionController({
    model: callerSemQuota(sink),
    permission: new PolicyPermissionEngine(),
    ports: noPorts,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    quotaFetcher,
    clock,
  });
  ctrlRef = controller;
  return controller;
}

/** Deixa os fire-and-forget (boot/refresh) assentarem. */
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

const saldo = (balance: string): Quota => ({ windows: {}, credit: { balance } });

describe('SessionController — refresh PERIÓDICO do saldo/quota (F-SALDO-VIVO)', () => {
  it('turno concluído DEPOIS do intervalo ⇒ o saldo do rodapé é RELIDO e muda', async () => {
    const saldos = ['4.050000', '3.980000'];
    let n = 0;
    const fetcher = vi.fn(async () => saldo(saldos[Math.min(n++, saldos.length - 1)]!));
    let agora = 1_000_000;
    const c = build(fetcher, () => agora);
    await settle();
    expect(c.current.meta.quota?.credit?.balance).toBe('4.050000'); // boot
    expect(fetcher).toHaveBeenCalledTimes(1);

    // O dono ficou lendo/pensando; o próximo turno cai bem depois da janela mínima.
    agora += 61_000;
    await c.submit('e agora?');
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(c.current.meta.quota?.credit?.balance).toBe('3.980000');
  });

  it('turnos em RAJADA dentro da janela ⇒ NÃO repete a busca (freio ~60s)', async () => {
    const fetcher = vi.fn(async () => saldo('4.050000'));
    let agora = 1_000_000;
    const c = build(fetcher, () => agora);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1); // boot

    for (let i = 0; i < 5; i += 1) {
      agora += 3_000; // cinco perguntas curtas em 15 segundos
      await c.submit(`pergunta ${i}`);
      await settle();
    }
    expect(fetcher).toHaveBeenCalledTimes(1); // nenhuma chamada extra ao provider
  });

  it('busca que FALHA ⇒ mantém o último saldo conhecido, em silêncio (sem derrubar)', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => {
      n += 1;
      if (n === 1) return saldo('4.050000');
      throw new Error('gateway fora do ar');
    });
    let agora = 1_000_000;
    const c = build(fetcher, () => agora);
    await settle();
    expect(c.current.meta.quota?.credit?.balance).toBe('4.050000');

    agora += 61_000;
    await c.submit('mais uma');
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    // O valor NÃO some nem vira lixo: o rodapé continua mostrando o último bom.
    expect(c.current.meta.quota?.credit?.balance).toBe('4.050000');
    expect(c.current.phase).not.toBe('error');
  });
});

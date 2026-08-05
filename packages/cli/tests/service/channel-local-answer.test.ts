// ADR-0158 §11 (FASE 4 — attach) — a corrida entre resposta REMOTA (Telegram) e
// resposta LOCAL (`aluy service attach`) dentro de `waitForOwnerReply`. Arquivo
// SEPARADO de `channel.test.ts` (FASE 3, "alheio" a esta fase) para não tocar os
// testes de uma fase anterior — mesma disciplina de não editar teste de outrem;
// aqui só ESTENDEMOS a cobertura do novo parâmetro opcional `localAnswer`.

import { describe, it, expect } from 'vitest';
import { waitForOwnerReply, newServiceEgressLimiter, type ServiceChannelClient } from '../../src/service/channel.js';
import type { LocalAnswerSource } from '../../src/service/channel.js';
import type { ServiceManifest, TelegramUpdate } from '@hiperplano/aluy-cli-core';

function manifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return { name: 'trader', tunables: [], ignoredFrontmatterKeys: [], orchestrator: 'Rege, não opera.', ...overrides };
}

function fakeSecretStore(token: string | null): { get(): Promise<string | null> } {
  return { get: async () => token };
}

/** Client cujo `poll` NUNCA resolve sozinho — só quando `signal` abortar (a mesma
 * disciplina de `client.poll(signal)` real: long-poll cancelável). Usado p/ provar
 * que a resposta LOCAL vence mesmo com o canal remoto "preso" à espera. */
function neverRespondingClient(): ServiceChannelClient & { readonly sent: { chatId: number; text: string }[] } {
  const sent: { chatId: number; text: string }[] = [];
  return {
    sent,
    async send(chatId, text) {
      sent.push({ chatId, text });
      return true;
    },
    poll(signal?: AbortSignal) {
      return new Promise((resolve) => {
        if (!signal) return; // nunca resolve (não deveria acontecer no runtime real).
        signal.addEventListener('abort', () => resolve([]), { once: true });
      });
    },
    safeForLog: (s) => s,
  };
}

/** Client que devolve as respostas de `pollBatches` em sequência, uma por chamada. */
function sequencedClient(
  pollBatches: readonly (readonly TelegramUpdate[])[],
): ServiceChannelClient & { readonly sent: { chatId: number; text: string }[] } {
  const sent: { chatId: number; text: string }[] = [];
  let i = 0;
  return {
    sent,
    async send(chatId, text) {
      sent.push({ chatId, text });
      return true;
    },
    async poll() {
      const batch = pollBatches[i] ?? [];
      i++;
      return batch;
    },
    safeForLog: (s) => s,
  };
}

function localAnswerThatResolvesImmediately(text: string): LocalAnswerSource {
  return {
    async waitForAnswer() {
      return text;
    },
  };
}

function localAnswerThatNeverResolves(): LocalAnswerSource {
  return {
    waitForAnswer(stop: AbortSignal) {
      return new Promise(() => {
        // nunca resolve — só existe p/ perder a corrida (o `stop` cancela via
        // Promise.race; esta implementação não precisa reagir ao abort p/ o teste).
        void stop;
      });
    },
  };
}

describe('waitForOwnerReply — corrida LOCAL × REMOTO (ADR-0158 §11)', () => {
  it('resposta LOCAL vence mesmo com o canal remoto "preso" num long-poll que nunca volta sozinho', async () => {
    const client = neverRespondingClient();
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: {
        egressLimiter: newServiceEgressLimiter(),
        log: () => {},
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      },
      localAnswer: localAnswerThatResolvesImmediately('sim, até 3 lotes (via attach)'),
    });
    expect(result).toEqual({ kind: 'answered', text: 'sim, até 3 lotes (via attach)' });
  });

  it('sem `localAnswer` (comportamento da FASE 3 intacto) — só o canal remoto decide', async () => {
    const client = sequencedClient([[{ chatId: 100, fromId: 100, text: 'Sim, até 3.' }]]);
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: {
        egressLimiter: newServiceEgressLimiter(),
        log: () => {},
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      },
      // `localAnswer` OMITIDO — a assinatura antiga continua funcionando igual.
    });
    expect(result).toEqual({ kind: 'answered', text: 'Sim, até 3.' });
  });

  it('resposta REMOTA vence quando chega antes da local (local nunca resolve)', async () => {
    const client = sequencedClient([[{ chatId: 100, fromId: 100, text: 'Sim, remoto.' }]]);
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: {
        egressLimiter: newServiceEgressLimiter(),
        log: () => {},
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      },
      localAnswer: localAnswerThatNeverResolves(),
    });
    expect(result).toEqual({ kind: 'answered', text: 'Sim, remoto.' });
  });

  it('"stop" já abortado ⇒ kind "stopped" mesmo com `localAnswer` presente (não corre p/ sempre)', async () => {
    const client = neverRespondingClient();
    const controller = new AbortController();
    controller.abort();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: {
        egressLimiter: newServiceEgressLimiter(),
        log: () => {},
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      },
      localAnswer: localAnswerThatNeverResolves(),
    });
    expect(result.kind).toBe('stopped');
  });
});

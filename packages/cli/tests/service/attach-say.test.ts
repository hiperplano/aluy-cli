// ADR-0158 §11 (FASE 4 — attach) — attach-say.ts: `LocalAnswerChannel`, a ponte
// in-process entre o socket de attach (`onSay`) e a ASK-ESPERA (`waitForOwnerReply`,
// channel.ts) — corrida entre resposta LOCAL e resposta REMOTA (Telegram).

import { describe, expect, it } from 'vitest';
import { LocalAnswerChannel } from '../../src/service/attach-say.js';

describe('LocalAnswerChannel', () => {
  it('waitForAnswer ANTES do submit — resolve quando o submit chega', async () => {
    const ch = new LocalAnswerChannel();
    const controller = new AbortController();
    const promise = ch.waitForAnswer(controller.signal);
    ch.submit('sim, até 3 lotes');
    await expect(promise).resolves.toBe('sim, até 3 lotes');
  });

  it('submit ANTES do waitForAnswer — enfileira e resolve na próxima espera', async () => {
    const ch = new LocalAnswerChannel();
    ch.submit('resposta adiantada');
    const controller = new AbortController();
    await expect(ch.waitForAnswer(controller.signal)).resolves.toBe('resposta adiantada');
  });

  it('múltiplos submits enfileirados são entregues em ORDEM', async () => {
    const ch = new LocalAnswerChannel();
    ch.submit('primeira');
    ch.submit('segunda');
    const c1 = new AbortController();
    const c2 = new AbortController();
    await expect(ch.waitForAnswer(c1.signal)).resolves.toBe('primeira');
    await expect(ch.waitForAnswer(c2.signal)).resolves.toBe('segunda');
  });

  it('`stop` já abortado ⇒ a promise NUNCA resolve (o caller descarta a perdedora da corrida)', async () => {
    const ch = new LocalAnswerChannel();
    const controller = new AbortController();
    controller.abort();
    let resolved = false;
    void ch.waitForAnswer(controller.signal).then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
  });

  it('`stop` aborta DEPOIS de começar a esperar ⇒ a promise nunca resolve; um submit POSTERIOR não a alcança (fica enfileirado)', async () => {
    const ch = new LocalAnswerChannel();
    const controller = new AbortController();
    let resolved = false;
    void ch.waitForAnswer(controller.signal).then(() => {
      resolved = true;
    });
    controller.abort();
    await new Promise((r) => setTimeout(r, 10));
    ch.submit('chegou tarde demais p/ esta espera');
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);
    // o submit ficou ENFILEIRADO — uma PRÓXIMA espera (nova corrida) o recebe.
    const c2 = new AbortController();
    await expect(ch.waitForAnswer(c2.signal)).resolves.toBe('chegou tarde demais p/ esta espera');
  });
});

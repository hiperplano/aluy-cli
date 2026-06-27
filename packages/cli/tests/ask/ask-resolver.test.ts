// EST-0948 · CLI-SEC-3/9 — o AskResolver da TUI (cravas do seguranca).
// Prova: deny em TIMEOUT, deny em ABORT (Ctrl-C), efeito EXATO entregue à UI,
// e grant de sessão SÓ p/ não-sempre-ask (sanitiza approve-session p/ sempre-ask).

import { describe, expect, it, vi } from 'vitest';
import type { AskRequest } from '@aluy/cli-core';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

function askReq(over: Partial<AskRequest> = {}): AskRequest {
  return {
    call: { name: 'run_command', input: { command: 'npm install left-pad' } },
    effect: {
      kind: 'command',
      tool: 'run_command',
      exact: '$ npm install left-pad',
    },
    category: 'always-ask:package-exec',
    reason: 'exec de pacote: npm install/exec',
    alwaysAsk: true,
    ...over,
  };
}

describe('TuiAskResolver — fail-safe deny + efeito exato', () => {
  it('TIMEOUT sem resposta ⇒ resolve DENY (nunca executa por inação)', async () => {
    vi.useFakeTimers();
    const resolver = new TuiAskResolver({ timeoutMs: 1000 });
    const p = resolver.resolve(askReq());
    // ninguém responde; avança o relógio além do teto.
    await vi.advanceTimersByTimeAsync(1001);
    const res = await p;
    expect(res.kind).toBe('deny');
    vi.useRealTimers();
  });

  it('ABORT (Ctrl-C) durante a confirmação ⇒ resolve DENY', async () => {
    const ac = new AbortController();
    const resolver = new TuiAskResolver();
    const p = resolver.resolve(askReq(), ac.signal);
    ac.abort();
    const res = await p;
    expect(res.kind).toBe('deny');
  });

  it('signal JÁ abortado antes de começar ⇒ DENY imediato', async () => {
    const ac = new AbortController();
    ac.abort();
    const resolver = new TuiAskResolver();
    const res = await resolver.resolve(askReq(), ac.signal);
    expect(res.kind).toBe('deny');
  });

  // EST-0958 — sem TTY (não-interativo) o ask NEGA de imediato (sem UI p/ aprovar),
  // sem pendurar o processo. Vale p/ o ask do agente E do `!comando`.
  it('NÃO-INTERATIVO (sem TTY) ⇒ DENY imediato (não pendura, não publica pending)', async () => {
    const resolver = new TuiAskResolver();
    resolver.setNonInteractive(true);
    let published = false;
    resolver.subscribe((pending) => {
      if (pending) published = true;
    });
    const res = await resolver.resolve(askReq());
    expect(res.kind).toBe('deny');
    expect(published).toBe(false); // nunca pediu UI
    expect(resolver.pending).toBeNull();
  });

  it('entrega o EFEITO EXATO à UI (CLI-SEC-9) e resolve com a escolha do usuário', async () => {
    const resolver = new TuiAskResolver();
    let seen: AskRequest | null = null;
    resolver.subscribe((pending) => {
      if (pending) seen = pending.request;
    });
    const p = resolver.resolve(askReq());
    expect(seen).not.toBeNull();
    expect(seen!.effect.exact).toBe('$ npm install left-pad');
    // a UI aprova:
    resolver.pending!.resolve({ kind: 'approve-once' });
    const res = await p;
    expect(res.kind).toBe('approve-once');
  });

  it('approve-session p/ categoria SEMPRE-ASK é REBAIXADO a approve-once (CLI-SEC-3)', async () => {
    const resolver = new TuiAskResolver();
    const p = resolver.resolve(askReq({ alwaysAsk: true }));
    resolver.pending!.resolve({ kind: 'approve-session' });
    const res = await p;
    // a TUI NÃO contorna a engine: vira approve-once.
    expect(res.kind).toBe('approve-once');
  });

  it('approve-session p/ NÃO-sempre-ask passa como approve-session', async () => {
    const resolver = new TuiAskResolver();
    const p = resolver.resolve(
      askReq({
        alwaysAsk: false,
        category: 'default',
        effect: { kind: 'path', tool: 'edit_file', exact: 'src/a.ts', path: 'src/a.ts' },
      }),
    );
    resolver.pending!.resolve({ kind: 'approve-session' });
    const res = await p;
    expect(res.kind).toBe('approve-session');
  });

  it('limpa o pending após resolver (uma confirmação por vez)', async () => {
    const resolver = new TuiAskResolver();
    const p = resolver.resolve(askReq());
    expect(resolver.pending).not.toBeNull();
    resolver.pending!.resolve({ kind: 'deny' });
    await p;
    expect(resolver.pending).toBeNull();
  });
});

// EST-1000 · ADR-0076 §2 — o INVARIANTE CRÍTICO: alt-screen restaurado em TODO caminho
// de término (exit/SIGINT/SIGTERM/crash/unmount). Testa a UNIT (fake process+stream);
// a prova sob PTY real está em `tests/cockpit-pty.test.ts` (e no relatório).

import { describe, expect, it } from 'vitest';
import {
  enterAltScreen,
  registerRestoreHandlers,
  ENTER_ALT_SCREEN,
  LEAVE_ALT_SCREEN,
  SHOW_CURSOR,
  HIDE_CURSOR,
  isBenignNetworkAbort,
  type AltScreenStream,
  type ProcessLike,
} from '../../src/session/alt-screen.js';

/** Stream fake que ACUMULA os bytes escritos + registra setRawMode. */
function fakeStream(): AltScreenStream & { writes: string[]; rawModes: boolean[] } {
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  return {
    writes,
    rawModes,
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
  };
}

/** Process fake que captura os listeners por evento (p/ disparar à mão). */
function fakeProcess(): ProcessLike & {
  listeners: Map<string, Array<(...a: unknown[]) => void>>;
  emit: (event: string, ...args: unknown[]) => void;
  kill?: (pid: number, sig: string) => void;
  pid: number;
  nextTick?: (cb: () => void) => void;
} {
  const listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  return {
    listeners,
    pid: 123,
    on(event: string, listener: (...a: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return this;
    },
    removeListener(event: string, listener: (...a: unknown[]) => void) {
      const arr = listeners.get(event) ?? [];
      listeners.set(
        event,
        arr.filter((l) => l !== listener),
      );
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const l of [...(listeners.get(event) ?? [])]) l(...args);
    },
  };
}

describe('enterAltScreen', () => {
  it('emite ?1049h + esconde o cursor', () => {
    const s = fakeStream();
    enterAltScreen(s);
    expect(s.writes.join('')).toBe(`${ENTER_ALT_SCREEN}${HIDE_CURSOR}`);
  });
});

describe('isBenignNetworkAbort — ESC-CRASH fix (não crashar em socket abortado)', () => {
  it('ECONNRESET / EPIPE / AbortError / "socket hang up" ⇒ true', () => {
    expect(isBenignNetworkAbort({ code: 'ECONNRESET' })).toBe(true);
    expect(isBenignNetworkAbort({ code: 'EPIPE' })).toBe(true);
    expect(isBenignNetworkAbort({ name: 'AbortError' })).toBe(true);
    expect(isBenignNetworkAbort(new Error('socket hang up'))).toBe(true);
    expect(isBenignNetworkAbort(new Error('The operation was aborted'))).toBe(true);
  });
  it('undici envelopa em `cause` (fetch failed → cause ECONNRESET) ⇒ true', () => {
    const err = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    expect(isBenignNetworkAbort(err)).toBe(true);
  });
  it('erro de LÓGICA real ⇒ false (segue crashando)', () => {
    expect(isBenignNetworkAbort(new TypeError('Cannot read properties of undefined'))).toBe(false);
    expect(isBenignNetworkAbort(new Error('boom de verdade'))).toBe(false);
    expect(isBenignNetworkAbort(null)).toBe(false);
    expect(isBenignNetworkAbort('string')).toBe(false);
  });

  it('onCrash ENGOLE erro benigno (não restaura tela, não re-lança); erro real re-lança', () => {
    // benigno: a sessão segue viva — sem LEAVE_ALT_SCREEN, sem nextTick (re-throw).
    const stream = fakeStream();
    const scheduled: Array<() => void> = [];
    const proc = Object.assign(fakeProcess(), { nextTick: (cb: () => void) => scheduled.push(cb) });
    registerRestoreHandlers(stream, proc);
    (proc as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit('uncaughtException', {
      code: 'ECONNRESET',
      message: 'socket hang up',
    });
    expect(stream.writes.join('')).not.toContain(LEAVE_ALT_SCREEN); // tela NÃO restaurada
    expect(scheduled).toHaveLength(0); // NÃO re-lançou ⇒ app segue vivo

    // real: restaura a tela + agenda o re-throw (crash limpo).
    const stream2 = fakeStream();
    const scheduled2: Array<() => void> = [];
    const proc2 = Object.assign(fakeProcess(), {
      nextTick: (cb: () => void) => scheduled2.push(cb),
    });
    registerRestoreHandlers(stream2, proc2);
    (proc2 as unknown as { emit: (e: string, ...a: unknown[]) => void }).emit(
      'uncaughtException',
      new Error('falha de verdade'),
    );
    expect(stream2.writes.join('')).toContain(LEAVE_ALT_SCREEN); // tela restaurada
    expect(scheduled2).toHaveLength(1); // re-throw agendado
  });
});

// ─── Fakes especializados p/ os cenários novos ────────────────────────────────

/** Stream cujo setRawMode LANÇA (isTTY true) — cobre o catch do setRawMode. */
function streamSetRawModeThrows(): AltScreenStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    isTTY: true,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    setRawMode() {
      throw new Error('raw-mode bang');
    },
  };
}

/** Stream cujo write LANÇA — cobre o catch do write. */
function streamWriteThrows(): AltScreenStream & { rawModes: boolean[] } {
  const rawModes: boolean[] = [];
  return {
    rawModes,
    isTTY: true,
    write() {
      throw new Error('write bang');
    },
    setRawMode(mode: boolean) {
      rawModes.push(mode);
    },
  };
}

/**
 * Process fake com kill capturado e SEM `exit` — exercita o FALLBACK do onSignal
 * (F181): quando nenhum `exit` é injetado, o handler cai no re-emit via `kill`.
 * `nextTick` roda síncrono p/ a asserção não depender do agendamento real.
 */
function procWithKill(): ProcessLike & {
  listeners: Map<string, Array<(...a: unknown[]) => void>>;
  emit: (event: string, ...args: unknown[]) => void;
  kill: (pid: number, sig: string) => void;
  nextTick: (cb: () => void) => void;
  pid: number;
  killCalls: Array<[number, string]>;
} {
  const base = fakeProcess();
  const killCalls: Array<[number, string]> = [];
  return {
    ...base,
    listeners: base.listeners,
    emit: base.emit,
    pid: base.pid,
    killCalls,
    nextTick: (cb: () => void) => cb(),
    kill(pid: number, sig: string) {
      killCalls.push([pid, sig]);
    },
  };
}

/** Process fake SEM nextTick — testa o fallback p/ globalThis.process?.nextTick. */
function procWithoutNextTick(): ProcessLike & {
  listeners: Map<string, Array<(...a: unknown[]) => void>>;
  emit: (event: string, ...args: unknown[]) => void;
} {
  return fakeProcess();
}

/** Process fake com nextTick que ENGOLO exceção (para teste de re-throw). */
function procWithSwallowingNextTick(): ProcessLike & {
  listeners: Map<string, Array<(...a: unknown[]) => void>>;
  emit: (event: string, ...args: unknown[]) => void;
  nextTick: (cb: () => void) => void;
  thrown: unknown[];
} {
  const base = fakeProcess();
  const thrown: unknown[] = [];
  return {
    ...base,
    listeners: base.listeners,
    emit: base.emit,
    nextTick: (cb: () => void) => {
      try {
        cb();
      } catch (e) {
        thrown.push(e);
      }
    },
    thrown,
  };
}

describe('registerRestoreHandlers — restauração à prova de tudo (§2)', () => {
  it('restoreScreen emite ?1049l + ?25h + raw-mode OFF', () => {
    const s = fakeStream();
    const p = fakeProcess();
    const sess = registerRestoreHandlers(s, p);
    sess.restoreScreen();
    const out = s.writes.join('');
    expect(out).toContain(LEAVE_ALT_SCREEN); // a tela primária volta
    expect(out).toContain(SHOW_CURSOR); // o cursor reaparece
    expect(s.rawModes).toContain(false); // raw-mode desligado
  });

  it('é IDEMPOTENTE — chamar 2× escreve os bytes UMA vez', () => {
    const s = fakeStream();
    const p = fakeProcess();
    const sess = registerRestoreHandlers(s, p);
    sess.restoreScreen();
    sess.restoreScreen();
    const count = s.writes.filter((w) => w.includes(LEAVE_ALT_SCREEN)).length;
    expect(count).toBe(1);
  });

  it('GATE: exit normal restaura (?1049l)', () => {
    const s = fakeStream();
    const p = fakeProcess();
    registerRestoreHandlers(s, p);
    p.emit('exit', 0);
    expect(s.writes.join('')).toContain(LEAVE_ALT_SCREEN);
  });

  it('F181 — SIGINT restaura ANTES e ENCERRA de fato (exit 130, adiado p/ nextTick)', () => {
    const s = fakeStream();
    const exits: number[] = [];
    const p = Object.assign(fakeProcess(), {
      exit: (c: number) => exits.push(c),
      nextTick: (cb: () => void) => cb(), // roda síncrono no teste
    });
    registerRestoreHandlers(s, p);
    p.emit('SIGINT');
    // restaurou a tela ANTES de encerrar…
    expect(s.writes.join('')).toContain(LEAVE_ALT_SCREEN);
    expect(s.writes.join('')).toContain(SHOW_CURSOR);
    // …e ENCERROU deterministicamente (antes só re-emitia o sinal, que o signal-reset
    // engolia ⇒ processo não morria em kill/kill -INT). 130 = 128 + SIGINT(2).
    expect(exits).toEqual([130]);
  });

  it('F181 — SIGTERM restaura e ENCERRA (exit 143)', () => {
    const s = fakeStream();
    const exits: number[] = [];
    const p = Object.assign(fakeProcess(), {
      exit: (c: number) => exits.push(c),
      nextTick: (cb: () => void) => cb(),
    });
    registerRestoreHandlers(s, p);
    p.emit('SIGTERM');
    expect(s.writes.join('')).toContain(LEAVE_ALT_SCREEN);
    expect(exits).toEqual([143]); // 128 + SIGTERM(15)
  });

  it('F181 — exit ADIADO: listeners SÍNCRONOS do mesmo sinal (reset) rodam ANTES do exit', () => {
    const s = fakeStream();
    const order: string[] = [];
    const deferred: Array<() => void> = [];
    const p = Object.assign(fakeProcess(), {
      exit: () => order.push('exit'),
      nextTick: (cb: () => void) => deferred.push(cb), // NÃO roda já
    });
    registerRestoreHandlers(s, p);
    // um 2º listener do MESMO sinal (espelha o signal-reset.ts)
    p.on('SIGTERM', () => order.push('reset'));
    p.emit('SIGTERM');
    // o exit foi ADIADO ⇒ o reset síncrono correu, exit ainda não.
    expect(order).toEqual(['reset']);
    deferred.forEach((cb) => cb());
    expect(order).toEqual(['reset', 'exit']); // exit por último
  });

  it('GATE: crash (uncaughtException) restaura e RE-LANÇA o erro', () => {
    const s = fakeStream();
    const p = fakeProcess();
    const thrown: unknown[] = [];
    p.nextTick = (cb) => {
      try {
        cb();
      } catch (e) {
        thrown.push(e); // captura o re-throw (em prod iria p/ o crash do processo).
      }
    };
    registerRestoreHandlers(s, p);
    const err = new Error('boom no meio do cockpit');
    p.emit('uncaughtException', err);
    // a tela voltou ANTES de propagar o crash.
    expect(s.writes.join('')).toContain(LEAVE_ALT_SCREEN);
    expect(s.writes.join('')).toContain(SHOW_CURSOR);
    // o erro NÃO foi silenciado — re-lançado.
    expect(thrown[0]).toBe(err);
  });

  it('dispose solta os listeners E garante uma última restauração (unmount limpo)', () => {
    const s = fakeStream();
    const p = fakeProcess();
    const sess = registerRestoreHandlers(s, p);
    sess.dispose();
    // os handlers foram removidos (sem vazar entre sessões).
    for (const [, arr] of p.listeners) expect(arr.length).toBe(0);
    // e a tela foi restaurada no dispose.
    expect(s.writes.join('')).toContain(LEAVE_ALT_SCREEN);
  });

  it('não escreve cru se já restaurou por um sinal (dispose após SIGINT é no-op nos bytes)', () => {
    const s = fakeStream();
    const p = fakeProcess();
    p.kill = () => {};
    const sess = registerRestoreHandlers(s, p);
    p.emit('SIGINT');
    const before = s.writes.length;
    sess.dispose();
    // dispose após o sinal não re-escreve os bytes de restauração (idempotente).
    const after = s.writes.filter((w) => w.includes(LEAVE_ALT_SCREEN)).length;
    expect(after).toBe(1);
    expect(s.writes.length).toBe(before);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TESTES DE ENDURECIMENTO — EST-1013
  // ═══════════════════════════════════════════════════════════════════════════

  describe('(EST-1013) — catches de restore (best-effort) + idempotência', () => {
    it('A — restoreScreen é IDEMPOTENTE: 2ª chamada não re-escreve bytes', () => {
      const s = fakeStream();
      const p = fakeProcess();
      const sess = registerRestoreHandlers(s, p);
      sess.restoreScreen();
      const writesA = s.writes.join('');
      expect(writesA).toContain(LEAVE_ALT_SCREEN);
      expect(writesA).toContain(SHOW_CURSOR);
      sess.restoreScreen();
      // mesmos bytes — idempotente
      expect(s.writes.join('')).toBe(writesA);
    });

    it('B — catch de setRawMode: setRawMode lança, restoreScreen não propaga', () => {
      const s = streamSetRawModeThrows();
      const p = fakeProcess();
      const sess = registerRestoreHandlers(s, p);
      // setRawMode vai lançar (catch do try) — mas os bytes devem sair.
      expect(() => sess.restoreScreen()).not.toThrow();
      const out = s.writes.join('');
      expect(out).toContain(LEAVE_ALT_SCREEN);
      expect(out).toContain(SHOW_CURSOR);
    });

    it('B — catch de write: write lança, restoreScreen não propaga', () => {
      const s = streamWriteThrows();
      const p = fakeProcess();
      const sess = registerRestoreHandlers(s, p);
      // write vai lançar (catch do try) — a restauração é best-effort.
      expect(() => sess.restoreScreen()).not.toThrow();
      // raw-mode foi desligado ANTES do write (setRawMode ok, write quebrou).
      expect(s.rawModes).toContain(false);
    });

    it('B — setRawMode + write ambos lançam, restoreScreen não propaga', () => {
      // Stream que lança em AMBOS: isTTY true, setRawMode e write quebram.
      const writes: string[] = [];
      const rawModes: boolean[] = [];
      const s: AltScreenStream & { writes: string[]; rawModes: boolean[] } = {
        writes,
        rawModes,
        isTTY: true,
        setRawMode() {
          rawModes.push(false);
          throw new Error('raw bang');
        },
        write() {
          throw new Error('write bang');
        },
      };
      const p = fakeProcess();
      const sess = registerRestoreHandlers(s, p);
      expect(() => sess.restoreScreen()).not.toThrow();
      // rawMode foi chamado (setRawMode entrou, apesar de lançar)
      expect(rawModes).toContain(false);
    });

    it('B — isTTY false (main): NEM setRawMode NEM escape de tela (non-TTY = sem terminal; não polui o stdout do headless -p)', () => {
      const writes: string[] = [];
      const rawModes: boolean[] = [];
      const s: AltScreenStream = {
        writes,
        rawModes,
        isTTY: false,
        setRawMode(mode: boolean) {
          rawModes.push(mode);
        },
        write(chunk: string) {
          writes.push(chunk);
          return true;
        },
      } as AltScreenStream & { writes: string[]; rawModes: boolean[] };
      const p = fakeProcess();
      const sess = registerRestoreHandlers(s, p);
      sess.restoreScreen();
      // isTTY false ⇒ NENHUMA operação de terminal: nem raw-mode nem os bytes de tela
      // (`?1049l`/`?25h`). Num caminho NÃO-TTY (headless `-p`, stdout em pipe) esses
      // escapes VAZARIAM no stream de dados (regressão EST-1007). Consistente com o
      // guard de raw-mode (que sempre foi por isTTY).
      expect(rawModes).toHaveLength(0);
      expect(writes.join('')).not.toContain(LEAVE_ALT_SCREEN);
      expect(writes.join('')).not.toContain(SHOW_CURSOR);
    });
  });

  describe('(EST-1013) — handlers de sinal (SIGINT/SIGTERM)', () => {
    it('C — SIGINT: handler restaura, chama kill com pid e sinal, e faz cleanup', () => {
      const s = fakeStream();
      const p = procWithKill();
      registerRestoreHandlers(s, p);
      // Captura o listener de SIGINT
      const sigintListeners = p.listeners.get('SIGINT')!;
      expect(sigintListeners).toHaveLength(1);
      // Invoca o handler
      sigintListeners[0]();
      // Restaurou a tela
      const out = s.writes.join('');
      expect(out).toContain(LEAVE_ALT_SCREEN);
      expect(out).toContain(SHOW_CURSOR);
      // kill foi chamado com pid e sinal
      expect(p.killCalls).toHaveLength(1);
      expect(p.killCalls[0]).toEqual([123, 'SIGINT']);
      // cleanup: listener removido
      expect(p.listeners.get('SIGINT') ?? []).toHaveLength(0);
    });

    it('C — SIGTERM: handler restaura, chama kill com pid e sinal', () => {
      const s = fakeStream();
      const p = procWithKill();
      registerRestoreHandlers(s, p);
      const sigtermListeners = p.listeners.get('SIGTERM')!;
      expect(sigtermListeners).toHaveLength(1);
      sigtermListeners[0]();
      const out = s.writes.join('');
      expect(out).toContain(LEAVE_ALT_SCREEN);
      expect(out).toContain(SHOW_CURSOR);
      expect(p.killCalls).toHaveLength(1);
      expect(p.killCalls[0]).toEqual([123, 'SIGTERM']);
      // cleanup: listener removido
      expect(p.listeners.get('SIGTERM') ?? []).toHaveLength(0);
    });

    it('C — sinal seguido de exit: restoreScreen idempotente (1× bytes)', () => {
      const s = fakeStream();
      const p = procWithKill();
      registerRestoreHandlers(s, p);
      // Emite SIGINT primeiro
      p.emit('SIGINT');
      const afterSigint = s.writes.filter((w) => w.includes(LEAVE_ALT_SCREEN)).length;
      expect(afterSigint).toBe(1);
      // Depois exit — não re-escreve
      p.emit('exit', 0);
      const total = s.writes.filter((w) => w.includes(LEAVE_ALT_SCREEN)).length;
      expect(total).toBe(1);
    });
  });

  describe('(EST-1013) — onCrash (uncaughtException / unhandledRejection)', () => {
    it('D — uncaughtException: restaura e RE-LANÇA o erro (via nextTick do proc)', () => {
      const s = fakeStream();
      const p = procWithSwallowingNextTick();
      registerRestoreHandlers(s, p);
      const err = new Error('crash-no-cockpit');
      p.emit('uncaughtException', err);
      // Restaurou
      const out = s.writes.join('');
      expect(out).toContain(LEAVE_ALT_SCREEN);
      expect(out).toContain(SHOW_CURSOR);
      // Re-lançou (capturado pelo nextTick que engole)
      expect(p.thrown).toHaveLength(1);
      expect(p.thrown[0]).toBe(err);
    });

    it('D — unhandledRejection: restaura e RE-LANÇA o erro', () => {
      const s = fakeStream();
      const p = procWithSwallowingNextTick();
      registerRestoreHandlers(s, p);
      const err = new Error('rejeicao-sem-handler');
      p.emit('unhandledRejection', err);
      const out = s.writes.join('');
      expect(out).toContain(LEAVE_ALT_SCREEN);
      expect(out).toContain(SHOW_CURSOR);
      expect(p.thrown).toHaveLength(1);
      expect(p.thrown[0]).toBe(err);
    });

    it('D — uncaughtException sem nextTick no proc: fallback p/ globalThis.process.nextTick', () => {
      const s = fakeStream();
      const p = procWithoutNextTick();
      const captured: unknown[] = [];
      const origNextTick = globalThis.process.nextTick;
      globalThis.process.nextTick = (cb: () => void) => {
        try {
          cb();
        } catch (e) {
          captured.push(e);
        }
      };
      try {
        registerRestoreHandlers(s, p);
        const err = new Error('sem-next-tick');
        p.emit('uncaughtException', err);
        // O fallback globalThis.process.nextTick foi usado e o erro re-lançado
        expect(captured).toHaveLength(1);
        expect(captured[0]).toBe(err);
        // Restaurou ANTES de lançar
        const out = s.writes.join('');
        expect(out).toContain(LEAVE_ALT_SCREEN);
        expect(out).toContain(SHOW_CURSOR);
      } finally {
        globalThis.process.nextTick = origNextTick;
      }
    });

    it('D — crash com string (não-Error) é re-lançado como Error', () => {
      const s = fakeStream();
      const p = procWithSwallowingNextTick();
      registerRestoreHandlers(s, p);
      const errStr = 'string-error';
      p.emit('uncaughtException', errStr);
      expect(p.thrown).toHaveLength(1);
      expect(p.thrown[0]).toBeInstanceOf(Error);
      expect((p.thrown[0] as Error).message).toBe('string-error');
      const out = s.writes.join('');
      expect(out).toContain(LEAVE_ALT_SCREEN);
    });
  });

  describe('(EST-1013) — dispose', () => {
    it('E — dispose: solta listeners, restaura e é idempotente', () => {
      const s = fakeStream();
      const p = fakeProcess();
      const sess = registerRestoreHandlers(s, p);
      sess.dispose();
      // Listeners foram removidos
      for (const [, arr] of p.listeners) {
        expect(arr).toHaveLength(0);
      }
      // Restaurou no dispose
      expect(s.writes.join('')).toContain(LEAVE_ALT_SCREEN);
      // 2º dispose: NO-OP — não re-escreve bytes nem lança
      const beforeCount = s.writes.length;
      expect(() => sess.dispose()).not.toThrow();
      expect(s.writes.length).toBe(beforeCount);
    });

    it('E — dispose remove listeners de TODOS os eventos de restauração', () => {
      const p = fakeProcess();
      const sess = registerRestoreHandlers(fakeStream(), p);
      // Antes de dispose: TODOS os eventos têm listener
      for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
        expect(p.listeners.get(ev) ?? []).toHaveLength(1);
      }
      sess.dispose();
      // Depois de dispose: ZERO listeners
      for (const ev of ['exit', 'SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection']) {
        expect(p.listeners.get(ev) ?? []).toHaveLength(0);
      }
    });
  });
});

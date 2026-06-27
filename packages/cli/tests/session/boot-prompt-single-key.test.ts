// EST-0972 — o prompt de auto-retomar a conversa no boot (`↻ retomar a conversa
// anterior? [S/n]`) é SINGLE-KEY, consistente com o resto da TUI ([s/n], [c]/[n]):
// o 1º char já decide, SEM exigir Enter. Antes ele acumulava até `\r`/`\n` e o
// usuário que apertava "s" ficava preso esperando o Enter (Tiago bloqueado).
//
// Provas (FRUGAL — sem modelo, sem rede; injeta chunks no `onData` via stdin mock):
//  · só `'s'`  (sem `\r`)  ⇒ resolve true  (retoma na hora)
//  · só `'y'`              ⇒ true
//  · só `'n'`              ⇒ false (nova, na hora)
//  · Enter vazio (`'\r'`)  ⇒ true  (default mantido)
//  · lote xrdp `'s\r'`     ⇒ true  (o 's' já decide; o '\r' não importa)
//  · Ctrl-C (`'\x03'`)     ⇒ false (segue p/ sessão nova)
//  · NÃO-TTY               ⇒ false (fail-safe: nova; nunca pendura)

import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { defaultBootPrompt } from '../../src/session/run.js';

/** stdout fake mínimo (coletor de escritas). */
function captureStdout(): NodeJS.WriteStream & { text: () => string } {
  let buf = '';
  const stub = {
    write(chunk: string | Uint8Array): boolean {
      buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    },
    text: () => buf,
  };
  return stub as unknown as NodeJS.WriteStream & { text: () => string };
}

/**
 * stdin fake: EventEmitter com `isTTY` + os métodos que o prompt usa
 * (`setRawMode`/`resume`/`pause`). `feed(s)` injeta um chunk em `onData`.
 */
function fakeStdin(isTTY: boolean): NodeJS.ReadStream & { feed: (s: string) => void } {
  const ee = new EventEmitter() as EventEmitter & {
    isTTY?: boolean;
    setRawMode?: (m: boolean) => unknown;
    resume?: () => unknown;
    pause?: () => unknown;
    feed: (s: string) => void;
  };
  ee.isTTY = isTTY;
  ee.setRawMode = () => ee;
  ee.resume = () => ee;
  ee.pause = () => ee;
  ee.feed = (s: string) => ee.emit('data', Buffer.from(s, 'utf8'));
  return ee as unknown as NodeJS.ReadStream & { feed: (s: string) => void };
}

/** Roda o prompt c/ stdin TTY mockado, injeta os chunks, devolve a Promise. */
function runPrompt(chunks: string[]): Promise<boolean> {
  const stdin = fakeStdin(true);
  const ask = defaultBootPrompt(captureStdout(), stdin);
  const p = ask('↻ retomar a conversa anterior? [S/n] ');
  // os listeners já estão registrados (síncrono dentro da Promise); injeta agora.
  for (const c of chunks) stdin.feed(c);
  return p;
}

describe('defaultBootPrompt — single-key no boot (EST-0972)', () => {
  it("só 's' (SEM Enter) ⇒ retoma (true)", async () => {
    await expect(runPrompt(['s'])).resolves.toBe(true);
  });

  it("só 'y' (SEM Enter) ⇒ retoma (true)", async () => {
    await expect(runPrompt(['y'])).resolves.toBe(true);
  });

  it("'S' maiúsculo (SEM Enter) ⇒ retoma (true)", async () => {
    await expect(runPrompt(['S'])).resolves.toBe(true);
  });

  it("só 'n' (SEM Enter) ⇒ nova (false)", async () => {
    await expect(runPrompt(['n'])).resolves.toBe(false);
  });

  it('Enter vazio ⇒ retoma (true) — default mantido', async () => {
    await expect(runPrompt(['\r'])).resolves.toBe(true);
    await expect(runPrompt(['\n'])).resolves.toBe(true);
  });

  it("lote xrdp 's\\r' (um chunk) ⇒ retoma (true) — o 's' já decide", async () => {
    await expect(runPrompt(['s\r'])).resolves.toBe(true);
  });

  it("lote xrdp 's' e '\\r' (chunks separados) ⇒ retoma (true)", async () => {
    await expect(runPrompt(['s', '\r'])).resolves.toBe(true);
  });

  it('Ctrl-C (\\x03) ⇒ nova (false)', async () => {
    await expect(runPrompt(['\x03'])).resolves.toBe(false);
  });

  it('Ctrl-D (\\x04) ⇒ nova (false)', async () => {
    await expect(runPrompt(['\x04'])).resolves.toBe(false);
  });

  it('NÃO-TTY (stdin sem isTTY) ⇒ fail-safe nova (false), sem pendurar', async () => {
    const stdin = fakeStdin(false);
    const ask = defaultBootPrompt(captureStdout(), stdin);
    await expect(ask('↻ retomar? ')).resolves.toBe(false);
  });
});

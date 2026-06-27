// EST-0948 — BOOT numa tela LIMPA. Ao ABRIR a sessão INTERATIVA (TTY), o startup emite
// o MESMO clear de TELA + SCROLLBACK do `/clear` (`\x1b[2J\x1b[3J\x1b[H`) ANTES de montar
// o Ink, p/ o splash/boot começar do zero (sem o lixo do terminal anterior).
//
// Provas:
//  · `emitBootClear` (a unidade): emite o clear quando TTY; é NO-OP quando NÃO-TTY.
//  · `runSession` NÃO-TTY (piped/scripted, integração): NUNCA emite o clear — a saída
//    linear fica limpa p/ pipe/CI (gate de verdade no fio real, não só na unidade).
//
// O ramo TTY de `runSession` monta o Ink e ficaria pendurado em `waitUntilExit()` num
// teste headless; por isso o gate TTY é provado pela UNIDADE `emitBootClear` (idêntica
// à chamada do startup) + o NÃO-emite no `runSession` real não-TTY.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CredentialStore, StoredCredential } from '@hiperplano/aluy-cli-core';
import { runSession, emitBootClear } from '../../src/session/run.js';
import { UserAgentsLoader } from '../../src/io/index.js';

const CLEAR_SCREEN = '\x1b[2J';
const CLEAR_SCROLLBACK = '\x1b[3J';
const CURSOR_HOME = '\x1b[H';
const BOOT_CLEAR = `${CLEAR_SCREEN}${CLEAR_SCROLLBACK}${CURSOR_HOME}`;

/** Credential store em memória (sem keychain) — evita I/O de SO no teste. */
class MemoryStore implements CredentialStore {
  cred: StoredCredential | null = null;
  async get(): Promise<StoredCredential | null> {
    return this.cred;
  }
  async set(c: StoredCredential): Promise<void> {
    this.cred = c;
  }
  async clear(): Promise<void> {
    this.cred = null;
  }
}

const stubCatalog = { list: async () => [] };

/** Coletor de escritas no stdout (fake mínimo p/ a unidade). */
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

/** stdout NÃO-TTY (PassThrough não tem isTTY ⇒ ramo linear, sem ANSI). */
function nonTtyStdout(): NodeJS.WriteStream & { text: () => string } {
  const pt = new PassThrough();
  let buf = '';
  pt.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  const s = pt as unknown as NodeJS.WriteStream & { text: () => string };
  s.text = () => buf;
  return s;
}

describe('emitBootClear — boot numa tela limpa (EST-0948)', () => {
  it('TTY: emite o clear de TELA + SCROLLBACK + cursor-home (e nada além)', () => {
    const out = captureStdout();
    emitBootClear(out, true);
    expect(out.text()).toBe(BOOT_CLEAR);
    // não usa alternate-screen buffer (não esconde a conversa ao sair).
    expect(out.text()).not.toContain('\x1b[?1049h');
  });

  it('NÃO-TTY (piped/scripted): NO-OP — não emite NADA', () => {
    const out = captureStdout();
    emitBootClear(out, false);
    expect(out.text()).toBe('');
  });
});

// EST-0972 (flake #131) — 10s (não 20s): com o boot hermético (mcpTools:[] + agentes
// no tmpdir) `runSession` não lança os servers MCP reais (~2s/chamada) que estouravam
// o teto sob cobertura+contenção. Folga p/ instrumentação sem mascarar regressão.
describe('runSession — boot clear no fio real (EST-0948)', { timeout: 10000 }, () => {
  let base: string;
  let aluyDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-boot-clear-'));
    aluyDir = join(base, 'home', '.aluy');
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('NÃO-TTY (piped/scripted): NÃO emite o clear (saída linear limpa p/ pipe/CI)', async () => {
    const out = nonTtyStdout();

    await runSession({
      goal: '/model', // comando linear: lista tiers e retorna (sem loop/rede).
      stdout: out,
      env: {},
      store: new MemoryStore(),
      catalogClient: stubCatalog as never,
      workspaceRoot,
      // EST-0972 (flake #131) — boot hermético: sem spawn de MCP real nem leitura do
      // `~/.aluy/agents` da máquina. É o que tirava ~2s e estourava o teto sob cobertura.
      mcpTools: [],
      userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
    });

    const text = out.text();
    expect(text).not.toContain(CLEAR_SCREEN);
    expect(text).not.toContain(CLEAR_SCROLLBACK);
  });
});

// EST-0969 — INTEGRAÇÃO da persistência de preferências através do `runSession`
// (caminho NÃO-TTY, sem Ink). Prova que a troca via `/model <tier>` literal grava
// no `~/.aluy/config.json` (tmp) — o fio em run.tsx (não só o store isolado). E que
// o STARTUP aplica o tier salvo na sessão seguinte (precedência config > default),
// com a flag `--tier` (opts.tier) vencendo a config.
//
// Sem rede: `/model <tier>` literal NÃO chama o broker (só setTier). O credential
// store e o catálogo são injetados; o workspace é um tmpdir. NUNCA toca o `~/.aluy/`
// real (configStore com baseDir tmp).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { CredentialStore, StoredCredential } from '@aluy/cli-core';
import { runSession } from '../../src/session/run.js';
import { UserConfigStore } from '../../src/io/user-config.js';
import { UserAgentsLoader } from '../../src/io/index.js';

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

/** Catálogo stub (não é exercido pelo `/model <tier>` literal, mas o wiring o pede). */
const stubCatalog = { list: async () => [] };

/** stdout NÃO-TTY (PassThrough não tem isTTY ⇒ ramo linear). */
function nonTtyStdout(): NodeJS.WriteStream & { text: () => string } {
  const pt = new PassThrough();
  let buf = '';
  pt.on('data', (c: Buffer) => (buf += c.toString('utf8')));
  const s = pt as unknown as NodeJS.WriteStream & { text: () => string };
  s.text = () => buf;
  return s;
}

// EST-0972 (flake crônico de CI #131) — CAUSA-RAIZ comum aos testes que rodam o
// `runSession` REAL: o boot lia o `~/.aluy/mcp.json` REAL da máquina e LANÇAVA os
// servers MCP (`npx -y …`, ~2s de handshake CADA) — o que sob cobertura v8 (~3×) +
// contenção do runner estourava o teto. NÃO era "I/O de disco pesado" (a persistência
// é ~ms): era o spawn de subprocessos MCP. Fix: `mcpTools: []` (curto-circuita o
// setupMcp — estes testes cobrem PREFERÊNCIA, não MCP) + loader de agentes no tmpdir
// (ver `hermetic()`). Boot vira ~ms. Teto de 10s: folga p/ cobertura+contenção sem
// inflar a ponto de mascarar uma regressão de lentidão. Asserções intactas.
const PERSIST_TIMEOUT_MS = 10000;

describe(
  'runSession — persistência de preferências (EST-0969, não-TTY)',
  { timeout: PERSIST_TIMEOUT_MS },
  () => {
    let base: string;
    let aluyDir: string;
    let workspaceRoot: string;

    beforeEach(() => {
      base = mkdtempSync(join(tmpdir(), 'aluy-persist-'));
      aluyDir = join(base, 'home', '.aluy');
      workspaceRoot = join(base, 'project');
      mkdirSync(workspaceRoot, { recursive: true });
    });

    afterEach(() => rmSync(base, { recursive: true, force: true }));

    it('`/model <tier>` literal PERSISTE o tier no config (próxima sessão reabre nele)', async () => {
      const configStore = new UserConfigStore({ baseDir: aluyDir });
      const out = nonTtyStdout();

      await runSession({
        goal: '/model aluy-deep',
        stdout: out,
        env: {},
        store: new MemoryStore(),
        catalogClient: stubCatalog as never,
        workspaceRoot,
        configStore,
        // EST-0972 (flake #131) — boot hermético: sem spawn de MCP real nem leitura de
        // `~/.aluy/agents`. É o que tirava ~2s/chamada e estourava o teto sob cobertura.
        mcpTools: [],
        userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
      });

      // gravou a preferência pela KEY IMUTÁVEL (não só na sessão; key, nunca o display).
      expect(configStore.load()).toEqual({ tier: 'aluy-deep' });
      // EST-0962 — a saída linear confirma com o NOME DE EXIBIÇÃO (`Cortex`), não a key
      // crua `aluy-deep` (sem vazar provider — HG-2).
      expect(out.text().toLowerCase()).toContain('cortex');
      expect(out.text().toLowerCase()).not.toContain('aluy-deep');
    });

    it('STARTUP aplica o tier SALVO (precedência config > default) sem flag', async () => {
      // pré-grava a preferência (como se uma sessão anterior tivesse trocado).
      new UserConfigStore({ baseDir: aluyDir }).saveTier('aluy-strata');
      const configStore = new UserConfigStore({ baseDir: aluyDir });
      const out = nonTtyStdout();

      // `/model` sem arg LISTA marcando o ativo — o ativo deve ser o salvo (aluy-strata),
      // provando que o startup leu a config e a injetou como tier inicial.
      await runSession({
        goal: '/model',
        stdout: out,
        env: {},
        store: new MemoryStore(),
        catalogClient: stubCatalog as never, // catálogo vazio ⇒ fallback de tiers conhecidos
        workspaceRoot,
        configStore,
        // EST-0972 (flake #131) — boot hermético: sem spawn de MCP real nem leitura de
        // `~/.aluy/agents`. É o que tirava ~2s/chamada e estourava o teto sob cobertura.
        mcpTools: [],
        userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
      });

      const text = out.text();
      // a linha do tier salvo é marcada como ativo.
      const strataLine = text.split('\n').find((l) => l.includes('Strata'));
      expect(strataLine).toBeDefined();
      expect(strataLine).toContain('(ativo)');
    });

    it('flag --tier (opts.tier) VENCE a config salva no startup', async () => {
      new UserConfigStore({ baseDir: aluyDir }).saveTier('aluy-strata');
      const configStore = new UserConfigStore({ baseDir: aluyDir });
      const out = nonTtyStdout();

      await runSession({
        goal: '/model',
        tier: 'aluy-deep', // flag --tier
        stdout: out,
        env: {},
        store: new MemoryStore(),
        catalogClient: stubCatalog as never,
        workspaceRoot,
        configStore,
        // EST-0972 (flake #131) — boot hermético: sem spawn de MCP real nem leitura de
        // `~/.aluy/agents`. É o que tirava ~2s/chamada e estourava o teto sob cobertura.
        mcpTools: [],
        userAgentsLoader: new UserAgentsLoader({ baseDir: aluyDir }),
      });

      const text = out.text();
      const activeLine = text.split('\n').find((l) => l.includes('(ativo)'));
      // o ativo é o da FLAG (aluy-deep → display ATUAL "Cortex"), não o da config (Strata).
      expect(activeLine).toContain('Cortex');
    });
  },
);

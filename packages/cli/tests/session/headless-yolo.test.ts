// EST-1007 · ADR-0072 · AG-0008 — YOLO em HEADLESS alinhado ao CLAUDE CODE.
//
// Prova, no nível de INTEGRAÇÃO (`runSession`, broker STUB, sem modelo real), que a
// MUDANÇA do AG-0008 (decisão do dono — relax de gate, sinalizada ao `seguranca`)
// realmente vale:
//   · `--yolo` em HEADLESS (não-TTY) ENTRA DIRETO — sem o env `ALUY_YOLO_HEADLESS`
//     (derrubado). A flag é o consentimento, igual `claude -p
//     --dangerously-skip-permissions`.
//   · YOLO RELAXA o gate de fato: uma write_file FORA do workspace (que o modo NORMAL
//     headless NEGA fail-closed — `outside-workspace` sempre-ask sem TTY p/ confirmar)
//     EXECUTA em YOLO (cerca derrubada). É a prova de "roda a tarefa agêntica + cria o
//     arquivo".
//   · O CONTRASTE com o NORMAL (mesmo objetivo, mesmo broker) prova que não é o gate
//     que "sempre deixa": NORMAL nega ⇒ arquivo NÃO existe; YOLO permite ⇒ existe.
//
// A recusa DURA de ROOT e o `yolo-entered`/banner no STDERR são provados no
// BINÁRIO REAL em `headless-yolo-bin.test.ts` (uid 0 simulado por preload).

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrokerModelClient, CredentialStore, StoredCredential } from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/index.js';

const TIMEOUT_MS = 15000;

/**
 * Broker STUB AGÊNTICO de 2 turnos:
 *  - turno 1 ⇒ emite UMA tool_call `write_file` (path/content vindos do teste);
 *  - turno 2+ ⇒ fala final fixa (o resultado scriptável).
 * Sem rede/sem modelo. O `path`/`content` da call são parametrizados p/ apontar FORA
 * do workspace (o que separa NORMAL de YOLO).
 */
function agenticBroker(writePath: string, writeContent: string): BrokerModelClient {
  let turn = 0;
  return {
    async *stream(): AsyncGenerator<unknown> {
      turn += 1;
      yield { type: 'start', request_id: `r${turn}`, session_id: 's' };
      if (turn === 1) {
        // tool_call NATIVA agregada (shape OpenAI aninhado — `function.arguments` string).
        yield {
          type: 'tool_call',
          call: {
            id: 'call_1',
            name: 'write_file',
            input: { path: writePath, content: writeContent },
          },
        };
        yield { type: 'done', finish_reason: 'tool_calls' };
        return;
      }
      yield { type: 'delta', content: 'feito.' };
      yield { type: 'done', finish_reason: 'stop' };
    },
  } as unknown as BrokerModelClient;
}

class MemoryStore implements CredentialStore {
  cred: StoredCredential | null = {
    token: 'pat_test',
    org: 'org_test',
  } as unknown as StoredCredential;
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

function ttyStdout(): NodeJS.WriteStream & { text: string } {
  const out = {
    text: '',
    isTTY: true, // TTY de propósito: o headless (`-p`) deve IGNORAR e rodar não-TTY.
    write(chunk: string) {
      (out as { text: string }).text += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream & { text: string };
  return out;
}

describe(
  'runSession — YOLO headless `-p --yolo` (EST-1007 · AG-0008)',
  { timeout: TIMEOUT_MS },
  () => {
    let homeDir: string;
    let workspaceRoot: string;
    let outsideDir: string;

    beforeEach(() => {
      homeDir = mkdtempSync(join(tmpdir(), 'yh-home-'));
      workspaceRoot = mkdtempSync(join(tmpdir(), 'yh-ws-'));
      // Diretório FORA do workspace confinado — a cerca o NEGA no normal, o YOLO o libera.
      outsideDir = mkdtempSync(join(tmpdir(), 'yh-outside-'));
    });
    afterEach(() => {
      for (const d of [homeDir, workspaceRoot, outsideDir]) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    const baseOpts = (writePath: string) => ({
      env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1' },
      workspaceRoot,
      journalBaseDir: join(homeDir, '.aluy'),
      memoryBaseDir: join(homeDir, '.aluy'),
      // ISOLA o auto-save da sessão no tmpdir do teste (o `SessionStore` default usa
      // `os.homedir()`, que IGNORA o `env.HOME` injetado ⇒ poluiria o `~/.aluy/` REAL).
      sessionStore: new SessionStore({ baseDir: join(homeDir, '.aluy') }),
      store: new MemoryStore(),
      mcpTools: [], // boot hermético (sem spawn de MCP real).
      brokerClient: agenticBroker(writePath, 'criado em yolo'),
      stdout: ttyStdout(),
      goal: `escreva ${writePath}`,
      headless: { print: true as const },
    });

    it('YOLO: write_file FORA do workspace EXECUTA (cerca derrubada) e o arquivo é criado', async () => {
      const target = join(outsideDir, 'yolo-was-here.txt');
      let exit: number | undefined;
      await runSession({
        ...baseOpts(target),
        // EST-0959 — eixo de modo; `unsafe` = YOLO. É o que o binário resolve do `--yolo`.
        mode: 'unsafe',
        onExitCode: (c) => (exit = c),
      });
      // A PROVA: o arquivo FORA do workspace foi criado ⇒ a cerca caiu (só YOLO faz isso).
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('criado em yolo');
      expect(exit).toBe(0);
    });

    it('CONTRASTE — NORMAL: a MESMA write_file FORA do workspace é NEGADA (fail-closed) ⇒ arquivo NÃO existe', async () => {
      const target = join(outsideDir, 'normal-blocked.txt');
      await runSession({
        ...baseOpts(target),
        mode: 'normal', // sem --yolo: a cerca + fail-closed do headless NEGAM a escrita.
        onExitCode: () => {},
      });
      // A cerca segura: sem TTY p/ confirmar `outside-workspace`, o efeito é negado por
      // inação ⇒ o arquivo NUNCA é escrito. É o que torna o YOLO o diferencial REAL.
      expect(existsSync(target)).toBe(false);
    });
  },
);

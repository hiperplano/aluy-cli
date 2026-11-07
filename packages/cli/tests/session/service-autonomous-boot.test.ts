// ADR-0158 — INTEGRAÇÃO de ponta a ponta do modo AUTÔNOMO CONFINADO
// (`autonomy: yolo-scoped`) via `runSession` (o MESMO caminho headless que
// `service/runner.ts` spawna por atividade). Espelha `service-persona-boot.test.ts`.
//
// A pergunta que este arquivo prova, com o EFEITO REAL (não só a mensagem):
//   1. SEM o modo (default, `autonomy` ausente/`ask`) — um `write_file` (que hoje
//      pede aprovação) fica sem ninguém para aprovar num turno headless ⇒ NEGADO
//      por inação (fail-safe já existente) — o arquivo NUNCA é criado. Prova (a).
//   2. COM o modo — o MESMO `write_file` (dentro do workspace) EXECUTA sem pedir
//      aprovação — o arquivo É criado. Prova (b).
//   3. COM o modo — um `write_file` para um path FORA do workspace continua
//      NEGADO — a cerca de workspace (confinamento DURO, independente da
//      catraca) segue intacta. Esta é a prova que distingue o modo de `--yolo`
//      (que derruba a cerca). Prova (c) — a mais importante.
//   4. `ALUY_SERVICE_AUTONOMY` sozinha (SEM `ALUY_SERVICE_HOME`) NÃO ativa o modo
//      — dois sinais internos exigidos, nunca vaza p/ fora de um turno de
//      serviço de verdade.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BrokerModelClient,
  CredentialStore,
  ModelStreamEvent,
  StoredCredential,
} from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/index.js';

const TIMEOUT_MS = 10000;

/** Broker stub ROTEIRIZADO: 1ª resposta tenta a tool NATIVA dada; 2ª devolve texto
 * final. Mesmo padrão de `service-persona-boot.test.ts`. */
function scriptedBroker(toolCall: { id: string; name: string; input: Record<string, unknown> }): {
  client: BrokerModelClient;
} {
  let call = 0;
  const client: BrokerModelClient = {
    async *stream(): AsyncGenerator<ModelStreamEvent> {
      call += 1;
      if (call === 1) {
        yield { type: 'start', request_id: 'r1' } as never;
        yield { type: 'tool_call', call: toolCall } as never;
        yield { type: 'done', finish_reason: 'tool_calls' } as never;
        return;
      }
      yield { type: 'start', request_id: 'r2' } as never;
      yield { type: 'delta', content: 'terminei.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client };
}

class MemoryStore implements CredentialStore {
  cred: StoredCredential | null = { token: 'pat_test', org: 'org_test' } as unknown as StoredCredential;
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
    isTTY: true,
    write(chunk: string) {
      (out as { text: string }).text += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream & { text: string };
  return out;
}

describe(
  'runSession — ADR-0158 modo autônomo confinado (autonomy: yolo-scoped)',
  { timeout: TIMEOUT_MS },
  () => {
    let homeDir: string;
    let workspaceRoot: string;
    let serviceDir: string;
    let outsideFile: string;

    beforeEach(() => {
      homeDir = mkdtempSync(join(tmpdir(), 'svc-auto-home-'));
      workspaceRoot = mkdtempSync(join(tmpdir(), 'svc-auto-ws-'));
      serviceDir = mkdtempSync(join(tmpdir(), 'svc-auto-svcdir-'));
      mkdirSync(serviceDir, { recursive: true });
      // Um alvo ABSOLUTO fora do workspace (mas dentro do tmpdir do teste — não é
      // a home real nem `~/.aluy`, então cai na categoria genérica
      // `outside-workspace`, não nos pisos de `~/.aluy`).
      const outsideDir = mkdtempSync(join(tmpdir(), 'svc-auto-outside-'));
      outsideFile = join(outsideDir, 'vazou.txt');
    });
    afterEach(() => {
      for (const d of [homeDir, workspaceRoot, serviceDir, dirname(outsideFile)]) {
        try {
          rmSync(d, { recursive: true, force: true });
        } catch {
          /* best-effort */
        }
      }
    });

    const baseOpts = () => ({
      workspaceRoot,
      journalBaseDir: join(homeDir, '.aluy'),
      memoryBaseDir: join(homeDir, '.aluy'),
      sessionStore: new SessionStore({ baseDir: join(homeDir, '.aluy') }),
      store: new MemoryStore(),
      mcpTools: [],
    });

    it('(a) SEM o modo — write_file (ask) fica sem quem aprove num turno headless ⇒ NEGADO, arquivo nunca criado', async () => {
      const { client } = scriptedBroker({
        id: 'c1',
        name: 'write_file',
        input: { path: 'ordem.txt', content: 'dado', overwrite: true },
      });
      const out = ttyStdout();
      let exit: number | undefined;
      await runSession({
        ...baseOpts(),
        env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1' },
        brokerClient: client,
        stdout: out,
        goal: 'grave um arquivo.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: (c) => (exit = c),
      });

      expect(existsSync(join(workspaceRoot, 'ordem.txt'))).toBe(false);
      expect(exit).toBe(0);
      const parsed = JSON.parse(out.text.trim()) as { ok: boolean; result: string };
      expect(parsed.ok).toBe(true);
    });

    it('(b) COM ALUY_SERVICE_HOME + ALUY_SERVICE_AUTONOMY=yolo-scoped — write_file DENTRO do workspace EXECUTA sem pedir aprovação', async () => {
      const { client } = scriptedBroker({
        id: 'c1',
        name: 'write_file',
        input: { path: 'ordem.txt', content: 'EXECUTAR AGORA', overwrite: true },
      });
      const out = ttyStdout();
      let exit: number | undefined;
      await runSession({
        ...baseOpts(),
        env: {
          HOME: homeDir,
          USERPROFILE: homeDir,
          NO_COLOR: '1',
          ALUY_SERVICE_HOME: serviceDir,
          ALUY_SERVICE_AUTONOMY: 'yolo-scoped',
        },
        brokerClient: client,
        stdout: out,
        goal: 'grave a ordem em ordem.txt.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: (c) => (exit = c),
      });

      expect(existsSync(join(workspaceRoot, 'ordem.txt'))).toBe(true);
      expect(readFileSync(join(workspaceRoot, 'ordem.txt'), 'utf8')).toBe('EXECUTAR AGORA');
      expect(exit).toBe(0);
      const parsed = JSON.parse(out.text.trim()) as { ok: boolean; result: string };
      expect(parsed.ok).toBe(true);
    });

    it('(c) — A PROVA MAIS IMPORTANTE — COM o modo ativo, write_file FORA do workspace continua NEGADO (cerca intacta, não é --yolo)', async () => {
      const { client } = scriptedBroker({
        id: 'c1',
        name: 'write_file',
        input: { path: outsideFile, content: 'vazamento', overwrite: true },
      });
      const out = ttyStdout();
      let exit: number | undefined;
      await runSession({
        ...baseOpts(),
        env: {
          HOME: homeDir,
          USERPROFILE: homeDir,
          NO_COLOR: '1',
          ALUY_SERVICE_HOME: serviceDir,
          ALUY_SERVICE_AUTONOMY: 'yolo-scoped',
        },
        brokerClient: client,
        stdout: out,
        goal: `grave um arquivo em ${outsideFile}.`,
        headless: { print: true, outputFormat: 'json' },
        onExitCode: (c) => (exit = c),
      });

      // O EFEITO REAL nunca aconteceu FORA do workspace — a cerca de confinamento
      // (`resolveInside`) bloqueou a escrita mesmo com a catraca dizendo "allow"
      // (o modo converte ask→allow, mas NUNCA toca a cerca de workspace).
      expect(existsSync(outsideFile)).toBe(false);
      // O turno ainda completa normalmente — o modelo foi informado da recusa.
      expect(exit).toBe(0);
      const parsed = JSON.parse(out.text.trim()) as { ok: boolean; result: string };
      expect(parsed.ok).toBe(true);
    });

    it('(d) ALUY_SERVICE_AUTONOMY sozinha (SEM ALUY_SERVICE_HOME) NÃO ativa o modo — nunca vaza p/ fora de um turno de serviço', async () => {
      const { client } = scriptedBroker({
        id: 'c1',
        name: 'write_file',
        input: { path: 'ordem.txt', content: 'dado', overwrite: true },
      });
      const out = ttyStdout();
      let exit: number | undefined;
      await runSession({
        ...baseOpts(),
        env: {
          HOME: homeDir,
          USERPROFILE: homeDir,
          NO_COLOR: '1',
          // SEM ALUY_SERVICE_HOME — só o segundo sinal, sozinho, não basta.
          ALUY_SERVICE_AUTONOMY: 'yolo-scoped',
        },
        brokerClient: client,
        stdout: out,
        goal: 'grave um arquivo.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: (c) => (exit = c),
      });

      expect(existsSync(join(workspaceRoot, 'ordem.txt'))).toBe(false);
      expect(exit).toBe(0);
    });
  },
);

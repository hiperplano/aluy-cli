// ADR-0158 §4.1 (FUNIL — fecha o DEGRADE #3 da rc.113) — INTEGRAÇÃO de ponta a ponta
// do enforcement de persona no BOOT headless via `runSession` (o MESMO caminho que
// `service/runner.ts` spawna por atividade `[agente]`, `aluy -p <goal>`). Sem rede/
// sem modelo real (broker STUB), HOME/workspace/serviceDir em tmpdirs — espelha
// `cli-headless.test.ts`.
//
// Prova o funil PELO BINÁRIO/BOOT DE VERDADE (não só a mecânica isolada do
// controller, já coberta em `persona-lock.test.ts`):
//   1. `ALUY_SERVICE_PERSONA=<persona sem a tool de execução>` ⇒ o turno headless
//      nasce TRAVADO nela: a tool fora do `tools:` é RECUSADA — o EFEITO REAL não
//      ocorre no disco (prova mais forte que checar só a mensagem: o arquivo
//      simplesmente NÃO existe no workspace depois do turno);
//   2. `ALUY_SERVICE_PERSONA=<nome desconhecido>` ⇒ FALHA FECHADA: `runSession`
//      REJEITA antes de sequer montar a sessão — o broker NUNCA é chamado (nenhum
//      turno chega a abrir com o toolset completo do orquestrador).

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BrokerModelClient,
  ChatMessage,
  CredentialStore,
  ModelStreamEvent,
  StoredCredential,
} from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/index.js';

const TIMEOUT_MS = 10000;

/** Broker stub ROTEIRIZADO: 1ª resposta tenta uma tool-call NATIVA; 2ª devolve texto
 * final. Captura os REQUESTS (p/ inspecionar o canal `system` recebido). */
function scriptedBroker(toolCall: { id: string; name: string; input: Record<string, unknown> }): {
  client: BrokerModelClient;
  requests: Array<{ messages: readonly ChatMessage[] }>;
} {
  const requests: Array<{ messages: readonly ChatMessage[] }> = [];
  let call = 0;
  const client: BrokerModelClient = {
    async *stream(args: { request: { messages: readonly ChatMessage[] } }): AsyncGenerator<ModelStreamEvent> {
      requests.push({ messages: args.request.messages });
      call += 1;
      if (call === 1) {
        yield { type: 'start', request_id: 'r1' } as never;
        yield { type: 'tool_call', call: toolCall } as never;
        yield { type: 'done', finish_reason: 'tool_calls' } as never;
        return;
      }
      yield { type: 'start', request_id: 'r2' } as never;
      yield { type: 'delta', content: 'terminei a análise.' } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, requests };
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

describe('runSession — ADR-0158 §4.1 enforcement de persona no boot headless de serviço', { timeout: TIMEOUT_MS }, () => {
  let homeDir: string;
  let workspaceRoot: string;
  let serviceDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'svc-persona-home-'));
    workspaceRoot = mkdtempSync(join(tmpdir(), 'svc-persona-ws-'));
    serviceDir = mkdtempSync(join(tmpdir(), 'svc-persona-svcdir-'));
    // ADR-0158 §4.1 exemplo do funil: um ESTUDO analisa mas não executa — a skill
    // de execução (aqui, `write_file`) NÃO está no `tools:` dele.
    mkdirSync(join(serviceDir, 'agents'), { recursive: true });
    writeFileSync(
      join(serviceDir, 'agents', 'estudo.md'),
      [
        '---',
        'name: estudo',
        'description: Analisa o mercado, não executa.',
        'tools: read_file',
        '---',
        'Você é o ESTUDO. PERSONA_ESTUDO_XYZ. Você NUNCA executa ordens — só analisa.',
      ].join('\n'),
    );
  });
  afterEach(() => {
    for (const d of [homeDir, workspaceRoot, serviceDir]) {
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

  it('persona SEM a tool de execução ⇒ o EFEITO REAL não ocorre no disco (recusada na catraca)', async () => {
    const { client, requests } = scriptedBroker({
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
        ALUY_SERVICE_PERSONA: 'estudo',
      },
      brokerClient: client,
      stdout: out,
      goal: 'Analise o mercado e, se convencido, grave a ordem de execução em ordem.txt.',
      // Simula o preâmbulo do orquestrador (corpo do service.md) que o runner passaria
      // como AGENT.md/projectInstructions do turno PRINCIPAL — deve ser SUBSTITUÍDO
      // pela persona (a atividade É da persona, não do orquestrador).
      projectInstructions: 'CORPO-DO-ORQUESTRADOR-SERVICE-MD — rege, não opera.',
      headless: { print: true, outputFormat: 'json' },
      onExitCode: (c) => (exit = c),
    });

    // O EFEITO REAL nunca aconteceu — prova mais forte que checar só a mensagem.
    expect(existsSync(join(workspaceRoot, 'ordem.txt'))).toBe(false);
    // O turno terminou normalmente (o modelo foi informado da recusa e concluiu).
    expect(exit).toBe(0);
    const parsed = JSON.parse(out.text.trim()) as { ok: boolean; result: string };
    expect(parsed.ok).toBe(true);

    // A persona chegou ao canal `system`; o preâmbulo do orquestrador NÃO.
    const firstReq = requests[0];
    expect(firstReq).toBeDefined();
    const sys = firstReq!.messages.find((m) => m.role === 'system')?.content ?? '';
    expect(sys).toContain('PERSONA_ESTUDO_XYZ');
    expect(sys).not.toContain('CORPO-DO-ORQUESTRADOR-SERVICE-MD');
  });

  it('persona DESCONHECIDA ⇒ FALHA FECHADA: runSession rejeita ANTES de chamar o broker', async () => {
    const { client, requests } = scriptedBroker({ id: 'c1', name: 'read_file', input: { path: 'a' } });
    const out = ttyStdout();
    await expect(
      runSession({
        ...baseOpts(),
        env: {
          HOME: homeDir,
          USERPROFILE: homeDir,
          NO_COLOR: '1',
          ALUY_SERVICE_HOME: serviceDir,
          ALUY_SERVICE_PERSONA: 'fantasma', // não existe em agents/.
        },
        brokerClient: client,
        stdout: out,
        goal: 'faça algo',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: () => {},
      }),
    ).rejects.toThrow(/persona|fantasma|ADR-0158/i);

    // NENHUM turno chegou a abrir — o broker nunca foi tocado (nunca "cai" no
    // toolset completo do orquestrador por trás das costas).
    expect(requests).toHaveLength(0);
    expect(out.text).toBe('');
  });
});

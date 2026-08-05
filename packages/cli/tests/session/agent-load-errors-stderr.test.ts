// EST-0977 — diagnóstico de BOOT que hoje só vira NOTA da TUI (`pushNote('agentes',
// …)`) precisa chegar ao STDERR no caminho HEADLESS/sem-TTY — senão um agente `.md`
// rejeitado (RES-MD-3, fail-closed) fica INVISÍVEL: `spawn_agent` falha, a atividade
// volta vazia ("0 chars/err"), e nada aponta o motivo (achado reproduzido: serviço com
// agentes malformados travando sem pista nenhuma, nem no `runner.log`).
//
// Precedente EXATO seguido aqui: `resolved.notes` de anexo em `runHeadlessPrint`/
// `runHeadlessStreamJson` (linear.ts) — mesma disciplina de escrever
// `process.stderr.write(...)` para cada nota, no caminho headless.
//
// Bateria:
//   (a) agente `.md` REJEITADO (sem "name") ⇒ a razão aparece no STDERR do turno
//       headless — e o STDOUT continua JSON parseável (`--output-format json`);
//   (b) sem erro nenhum de agente ⇒ STDERR limpo (zero ruído);
//   (c) `--output-format text` (o formato usado pelo runner de serviço via `aluy -p
//       ... --output-format json --quiet`, mas provando também o formato default) —
//       o STDOUT permanece só o resultado, nunca o diagnóstico.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrokerModelClient, CredentialStore, StoredCredential } from '@hiperplano/aluy-cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/index.js';

const TIMEOUT_MS = 10000;

function stubBroker(reply = 'ok.'): BrokerModelClient {
  return {
    async *stream() {
      yield { type: 'start', request_id: 'r' } as never;
      yield { type: 'delta', content: reply } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
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

/** Espiona `process.stderr.write` durante o `fn` — devolve tudo que foi escrito. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  let captured = '';
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return captured;
}

describe('runSession — headless: erros de carga de agente chegam ao STDERR (EST-0977)', { timeout: TIMEOUT_MS }, () => {
  let homeDir: string;
  let workspaceRoot: string;
  let serviceDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'agt-err-home-'));
    workspaceRoot = mkdtempSync(join(tmpdir(), 'agt-err-ws-'));
    serviceDir = mkdtempSync(join(tmpdir(), 'agt-err-svcdir-'));
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

  it('agente .md SEM "name" ⇒ a razão do fail-closed aparece no STDERR; STDOUT continua JSON parseável', async () => {
    mkdirSync(join(serviceDir, 'agents'), { recursive: true });
    // Malformado de propósito — sem "name:" (RES-MD-3, rejeitado pelo loader).
    writeFileSync(
      join(serviceDir, 'agents', 'macro.md'),
      ['---', 'description: Analisa macro.', 'tools: web_search', '---', 'Você é o macro.'].join('\n'),
    );

    const out = ttyStdout();
    let exit: number | undefined;
    const stderrText = await captureStderr(() =>
      runSession({
        ...baseOpts(),
        env: {
          HOME: homeDir,
          USERPROFILE: homeDir,
          NO_COLOR: '1',
          ALUY_SERVICE_HOME: serviceDir,
        },
        brokerClient: stubBroker('turno concluído.'),
        stdout: out,
        goal: 'abra o turno.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: (c) => (exit = c),
      }),
    );

    // (a) STDERR carrega o motivo da rejeição do agente — visível, não silencioso.
    expect(stderrText).toContain('aluy: ⚠');
    expect(stderrText).toMatch(/name/i);

    // STDOUT continua SÓ o JSON do turno (contrato que o runner de serviço depende:
    // `parseActivityTurnOutput` lê a ÚLTIMA linha como JSON) — nunca poluído pelo
    // diagnóstico de boot.
    expect(exit).toBe(0);
    const parsed = JSON.parse(out.text.trim()) as { ok: boolean; result: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toBe('turno concluído.');
  });

  // Fecha o laço com o item da lista YAML em bloco (agent-profile.ts): o caso REAL
  // reproduzido tinha `tools:` escrito como lista em bloco (a forma "natural" que o
  // MODELO escreveu a partir do prompt-guia do `/service create`) — ANTES da
  // correção, isso rejeitava o agente (mesma classe de erro do teste acima). Depois
  // da correção, a lista em bloco é aceita — o agente carrega, e o STDERR fica limpo.
  it('agente .md com "tools:" em LISTA YAML EM BLOCO (a forma que o modelo escreveu de verdade) ⇒ carrega OK, STDERR limpo', async () => {
    mkdirSync(join(serviceDir, 'agents'), { recursive: true });
    writeFileSync(
      join(serviceDir, 'agents', 'macro.md'),
      ['---', 'name: macro', 'description: Analisa macro.', 'tools:', '  - web_search', '  - web_fetch', '---', 'Você é o macro.'].join(
        '\n',
      ),
    );

    const out = ttyStdout();
    const stderrText = await captureStderr(() =>
      runSession({
        ...baseOpts(),
        env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1', ALUY_SERVICE_HOME: serviceDir },
        brokerClient: stubBroker('ok.'),
        stdout: out,
        goal: 'faça algo.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: () => {},
      }),
    );

    expect(stderrText).not.toContain('aluy: ⚠');
    const parsed = JSON.parse(out.text.trim()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('sem "agents/" nenhum (nenhum erro de carga) ⇒ STDERR limpo — zero ruído', async () => {
    const out = ttyStdout();
    const stderrText = await captureStderr(() =>
      runSession({
        ...baseOpts(),
        env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1' },
        brokerClient: stubBroker('ok.'),
        stdout: out,
        goal: 'faça algo simples.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: () => {},
      }),
    );

    expect(stderrText).not.toContain('aluy: ⚠');
    const parsed = JSON.parse(out.text.trim()) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  it('agente .md com CORPO VAZIO (sem system prompt) ⇒ também aparece no STDERR (mesma classe RES-MD-3)', async () => {
    mkdirSync(join(serviceDir, 'agents'), { recursive: true });
    writeFileSync(join(serviceDir, 'agents', 'backtest.md'), ['---', 'name: backtest', '---', ''].join('\n'));

    const out = ttyStdout();
    const stderrText = await captureStderr(() =>
      runSession({
        ...baseOpts(),
        env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1', ALUY_SERVICE_HOME: serviceDir },
        brokerClient: stubBroker('ok.'),
        stdout: out,
        goal: 'faça algo.',
        headless: { print: true, outputFormat: 'json' },
        onExitCode: () => {},
      }),
    );

    expect(stderrText).toContain('aluy: ⚠');
    expect(stderrText).toMatch(/corpo vazio|system prompt/i);
    // STDOUT continua parseável mesmo com o diagnóstico no stderr.
    expect(() => JSON.parse(out.text.trim())).not.toThrow();
  });

  it('--output-format text (default) — STDOUT permanece só o resultado; diagnóstico só no STDERR', async () => {
    mkdirSync(join(serviceDir, 'agents'), { recursive: true });
    writeFileSync(join(serviceDir, 'agents', 'quant.md'), ['---', 'description: sem name.', '---', 'corpo.'].join('\n'));

    const out = ttyStdout();
    const stderrText = await captureStderr(() =>
      runSession({
        ...baseOpts(),
        env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1', ALUY_SERVICE_HOME: serviceDir },
        brokerClient: stubBroker('Paris.'),
        stdout: out,
        goal: 'capital?',
        headless: { print: true },
        onExitCode: () => {},
      }),
    );

    expect(stderrText).toContain('aluy: ⚠');
    expect(out.text).toBe('Paris.\n');
    expect(out.text).not.toContain('⚠');
  });
});

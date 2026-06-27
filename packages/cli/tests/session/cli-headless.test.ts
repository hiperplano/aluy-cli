// EST-1007 — INTEGRAÇÃO do MODO HEADLESS (`aluy -p "prompt"`) através do `runSession`.
//
// Prova o fio completo do `-p`/`--print`/`--exec`: força o caminho não-TTY MESMO num
// stdout TTY (explícito), roda o objetivo pelo loop REAL com broker STUB, e imprime SÓ
// o resultado final do assistente — sem o chrome rotulado do `runLinear` (`[aluy]`/
// `[tool]`/notas) — respeitando NO_COLOR, com exit code 0/≠0 conforme sucesso/falha.
// Cobre também o `--model <slug>` (HG-2: tier:custom + só o slug no body do broker, sem
// vazar credencial) e o FAIL-CLOSED do headless (ask sempre nega sem --yolo).
//
// Sem rede/sem modelo real: o `brokerClient` é STUB. O `~/.aluy/`/workspace são tmpdirs.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  BrokerModelClient,
  ChatMessage,
  CredentialStore,
  StoredCredential,
} from '@aluy/cli-core';
import { runSession } from '../../src/session/run.js';
import { SessionStore } from '../../src/io/index.js';

const HEADLESS_TIMEOUT_MS = 10000;

/** Broker stub: yields uma fala final fixa e CAPTURA o body (p/ checar tier/model). */
function stubBroker(reply = 'Paris é a capital da França.'): {
  client: BrokerModelClient;
  bodies: Array<{ tier?: string; model?: string; messages: readonly ChatMessage[] }>;
} {
  const bodies: Array<{ tier?: string; model?: string; messages: readonly ChatMessage[] }> = [];
  const client: BrokerModelClient = {
    async *stream(args: {
      request: { tier?: string; model?: string; messages: readonly ChatMessage[] };
    }) {
      bodies.push({
        tier: args.request.tier,
        model: args.request.model,
        messages: args.request.messages,
      });
      yield { type: 'start', request_id: 'r', session_id: 's' } as never;
      yield { type: 'delta', content: reply } as never;
      yield { type: 'done', finish_reason: 'stop' } as never;
    },
  } as unknown as BrokerModelClient;
  return { client, bodies };
}

/** Broker stub que FALHA (broker fora) — força o caminho de broker-error / exit≠0. */
function failingBroker(): BrokerModelClient {
  return {
    // eslint-disable-next-line require-yield
    async *stream(): AsyncGenerator<never> {
      throw new Error('broker indisponível');
    },
  } as unknown as BrokerModelClient;
}

/** Credential store em memória (com credencial — evita a nota de "sem login"). */
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

/** stdout que FINGE ser TTY — prova que o `-p` força o caminho não-TTY mesmo assim. */
function ttyStdout(): NodeJS.WriteStream & { text: string } {
  const out = {
    text: '',
    isTTY: true, // <- TTY de propósito: o headless deve IGNORAR e rodar não-TTY.
    write(chunk: string) {
      (out as { text: string }).text += chunk;
      return true;
    },
  } as unknown as NodeJS.WriteStream & { text: string };
  return out;
}

describe('runSession — modo HEADLESS `-p` (EST-1007)', { timeout: HEADLESS_TIMEOUT_MS }, () => {
  let homeDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'hl-home-'));
    workspaceRoot = mkdtempSync(join(tmpdir(), 'hl-ws-'));
  });
  afterEach(() => {
    for (const d of [homeDir, workspaceRoot]) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });

  const baseOpts = () => ({
    env: { HOME: homeDir, USERPROFILE: homeDir, NO_COLOR: '1' },
    workspaceRoot,
    journalBaseDir: join(homeDir, '.aluy'),
    memoryBaseDir: join(homeDir, '.aluy'),
    // ISOLA o auto-save da sessão no tmpdir do teste — senão o `SessionStore`
    // default cai no `~/.aluy/sessions/` REAL do dev (usa `os.homedir()`, que IGNORA
    // o `env.HOME` injetado), poluindo o `/history` do usuário (e fonte de contenção).
    sessionStore: new SessionStore({ baseDir: join(homeDir, '.aluy') }),
    store: new MemoryStore(),
    mcpTools: [], // boot hermético (sem spawn de MCP real) — flake #131.
  });

  it('imprime SÓ o resultado final no stdout (sem chrome [aluy]/[tool]/[você]) e exit 0', async () => {
    const { client } = stubBroker('Paris.');
    const out = ttyStdout();
    let exit: number | undefined;
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'capital da França?',
      headless: { print: true },
      onExitCode: (c) => (exit = c),
    });
    // SÓ o resultado, sem rótulos de chrome.
    expect(out.text).toBe('Paris.\n');
    expect(out.text).not.toMatch(/\[aluy\]|\[tool\]|\[você\]/);
    expect(exit).toBe(0);
  });

  it('NO_COLOR respeitado: a saída não tem nenhuma sequência ANSI', async () => {
    const { client } = stubBroker('resposta sem cor');
    const out = ttyStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'oi',
      headless: { print: true },
      onExitCode: () => {},
    });
    // eslint-disable-next-line no-control-regex
    expect(out.text).not.toMatch(/\x1b\[[0-9;]*[A-Za-z]/);
  });

  it('broker FORA ⇒ exit≠0 e stdout LIMPO (diagnóstico vai p/ outro canal)', async () => {
    const out = ttyStdout();
    let exit: number | undefined;
    await runSession({
      ...baseOpts(),
      brokerClient: failingBroker(),
      stdout: out,
      goal: 'faça x',
      headless: { print: true },
      onExitCode: (c) => (exit = c),
    });
    expect(exit).not.toBe(0);
    // o stdout (text) NÃO recebe o diagnóstico — fica limpo p/ script (vazio ou só \n).
    expect(out.text.trim()).toBe('');
  });

  it('--output-format json emite {result, ok, tier} parseável', async () => {
    const { client } = stubBroker('Paris.');
    const out = ttyStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'capital?',
      tier: 'aluy-deep',
      headless: { print: true, outputFormat: 'json' },
      onExitCode: () => {},
    });
    const parsed = JSON.parse(out.text.trim());
    expect(parsed.result).toBe('Paris.');
    expect(parsed.ok).toBe(true);
    expect(parsed.tier).toBe('aluy-deep');
  });

  // EST-1017 / BUG-0018 — em `--output-format stream-json` o stdout deve ser APENAS NDJSON
  // válido (contrato `session/linear.ts:228`). O bug original (`run.tsx:758`) reimprimia a
  // resposta final CRUA depois dos eventos — uma linha extra não-JSON que quebra o parser de
  // stream. Este teste roda o caminho REAL `runHeadlessStreamJson` via `runSession` com uma
  // resposta NÃO-VAZIA e prova: (a) TODA linha não-vazia parseia como JSON; (b) existe
  // EXATAMENTE 1 evento `type:'result'` carregando a resposta — nenhuma linha crua.
  //
  // NÃO-TAUTOLOGIA (CA-4): reverter o guard p/ `} else if (res.result !== '')` reintroduz a
  // 6ª linha crua `Olá!` ⇒ `JSON.parse` lança nessa linha ⇒ o `expect(() => parse).not.toThrow`
  // reprova. O fix é o que torna o teste verde.
  it('--output-format stream-json: stdout é SÓ NDJSON válido — resposta só no evento result (BUG-0018)', async () => {
    const { client } = stubBroker('Olá!');
    // No binário REAL o `out` do ramo headless cai em `process.stdout` (opts.stdout não é
    // passado): tanto os eventos NDJSON live (run.tsx, write→process.stdout) quanto a linha
    // CRUA do bug (run.tsx:758, write→out=process.stdout) convergem no MESMO stream. Para
    // reproduzir fielmente o BUG-0018, espionamos `process.stdout.write` (captura AMBOS) e
    // NÃO passamos `stdout` — assim `out` resolve p/ `process.stdout`, como em produção.
    let captured = '';
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    }) as typeof process.stdout.write;
    let exit: number | undefined;
    try {
      await runSession({
        ...baseOpts(),
        brokerClient: client,
        goal: 'Diga olá em uma palavra.',
        headless: { print: true, outputFormat: 'stream-json' },
        onExitCode: (c) => (exit = c),
      });
    } finally {
      process.stdout.write = orig;
    }

    const lines = captured.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThan(0);
    // CA-1/CA-2: CADA linha não-vazia é JSON válido — ZERO linha crua.
    const events = lines.map((line) => {
      expect(() => JSON.parse(line), `linha não-JSON contamina o NDJSON: ${line}`).not.toThrow();
      return JSON.parse(line) as { type?: string; result?: string };
    });
    // CA-2: EXATAMENTE 1 evento `result` carregando a resposta.
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe('Olá!');
    // E a resposta crua NÃO aparece como linha solta fora de um JSON (não-contaminação).
    expect(captured).not.toMatch(/^Olá!$/m);
    expect(exit).toBe(0);
  });

  // EST-1017 — não-regressão (CA-3): o modo `text` (default) SEGUE imprimindo a resposta crua,
  // sem rótulo/ANSI. O guard mais estrito (`format === 'text'`) não altera o `text`.
  it('--output-format text (default): SEGUE imprimindo a resposta crua — não-regressão (CA-3)', async () => {
    const { client } = stubBroker('Olá!');
    const out = ttyStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'Diga olá em uma palavra.',
      headless: { print: true, outputFormat: 'text' },
      onExitCode: () => {},
    });
    // A resposta crua é a única coisa no stdout (igual hoje); NÃO é JSON.
    expect(out.text).toBe('Olá!\n');
    expect(() => JSON.parse(out.text.trim())).toThrow();
  });

  it('--model <slug> ⇒ o body do broker leva tier:custom + o SLUG (HG-2: sem credencial)', async () => {
    const { client, bodies } = stubBroker('ok.');
    const out = ttyStdout();
    await runSession({
      ...baseOpts(),
      brokerClient: client,
      stdout: out,
      goal: 'faça x',
      tier: 'custom', // o binário resolve --model ⇒ tier:custom
      model: 'xiaomi/mimo-v2.5', // o SLUG do --model
      headless: { print: true },
      onExitCode: () => {},
    });
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]!.tier).toBe('custom');
    expect(bodies[0]!.model).toBe('xiaomi/mimo-v2.5');
    // HG-2/CLI-SEC-7 — só o SLUG sai; o ENVELOPE DE CONTROLE não carrega api-key/provider/
    // credencial. F148: o escopo é o controle (tier/model/provider-field), NÃO o CONTEÚDO das
    // mensagens — o system prompt cita o comando `/provider` legitimamente (EST-1149), e isso
    // não é vazamento de config. Excluímos `messages` antes de varrer.
    const control: Record<string, unknown> = { ...bodies[0]! };
    delete control.messages;
    const controlJson = JSON.stringify(control);
    expect(controlJson).not.toMatch(/api[_-]?key|pat_test|provider|secret/i);
  });
});

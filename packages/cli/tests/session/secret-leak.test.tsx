// ADR 0005 — TESTE DE VAZAMENTO ponta a ponta. Um segredo-canário é entregue pelo fluxo
// MASCARADO real da <App> (digitado e colado com bracketed paste); depois um comando o
// imprime, PARTIDO em chunks pequenos, e o modelo recebe um turno. Em seguida procuramos o
// canário em tudo o que persiste ou sai: arquivo de sessão, export, histórico ↑↓, frames
// da tela, journal e cada corpo de requisição ao modelo. Esperado: ZERO ocorrências.
//
// Nada toca o ~/.aluy real (store/journal/cofre apontam para um diretório temporário).

import React from 'react';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  BrokerModelClient,
  PolicyPermissionEngine,
  secretVault,
  type ChatMessage,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import { PASTE_START, PASTE_END } from '../../src/session/bracketed-paste.js';
import { SecretsService } from '../../src/session/secrets.js';
import { SessionStore, NodeJournalStore } from '../../src/io/index.js';
import { autoSaveSession } from '../../src/session/session-persist.js';
import { buildTranscript } from '../../src/session/export-transcript.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';
const CANARY_PASTED = 'COLADO-canario-5b2d44e0a1';
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;?]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const fim = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > fim) throw new Error('waitFor: não assentou no prazo');
    await new Promise((r) => setTimeout(r, 10));
  }
}
const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aluy-leak-'));
});
afterEach(() => {
  secretVault.clear();
  rmSync(dir, { recursive: true, force: true });
});

function everyFile(root: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) out.push(...everyFile(p));
    else out.push(p);
  }
  return out;
}

describe('segredo: ZERO ocorrências do canário em tudo que persiste ou sai', () => {
  it('fluxo mascarado real (digitado + colado) → comando imprime o valor → turno do modelo', async () => {
    // ── montagem ───────────────────────────────────────────────────────────────
    const envVisto: Record<string, string>[] = [];
    const ports = {
      fs: {
        async readFile() {
          return '';
        },
        async writeFile() {},
        async exists() {
          return false;
        },
      },
      shell: {
        async exec(
          _c: string,
          o?: {
            env?: Record<string, string>;
            onChunk?: (c: { stream: 'stdout'; text: string }) => void;
          },
        ) {
          envVisto.push({ ...(o?.env ?? {}) });
          // o comando "imprime" o valor, em pedaços de 3 chars (partido entre chunks)
          const saida = `${o?.env?.API_KEY ?? 'SEM-ENV'}\n`;
          for (let i = 0; i < saida.length; i += 3)
            o?.onChunk?.({ stream: 'stdout', text: saida.slice(i, i + 3) });
          return { stdout: saida, stderr: '', exitCode: 0 };
        },
      },
      search: {
        async search() {
          return { matches: [], truncated: {} };
        },
      },
    } as unknown as ToolPorts;

    const corposDoModelo: string[] = [];
    const model: ModelCaller = {
      async call(args: { messages: readonly ChatMessage[] }): Promise<ModelCallResult> {
        corposDoModelo.push(JSON.stringify(args.messages));
        return { request_id: 'r', content: 'entendi.', finish_reason: 'stop' };
      },
    };
    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine(),
      ports,
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      watchdogEnv: { ALUY_STUCK_OFF: '1' },
      flush: { intervalMs: 0 },
    });
    const secrets = new SecretsService({
      projectDir: '/proj',
      fileVault: {
        vaultPath: join(dir, 'credentials.enc'),
        machineId: { reader: () => 'maquina-de-teste' },
        username: 'u',
      },
    });
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    const { stdin, lastFrame, frames, unmount } = render(
      <ThemeProvider theme={theme}>
        <App controller={controller} secrets={secrets} animate={false} bootMs={0} />
      </ThemeProvider>,
    );
    controller.dismissBoot();
    await waitFor(() => plain(lastFrame() ?? '').length > 0);
    await tick(200); // deixa o useInput montar

    // uma entrada comum ANTES dos /secret: é a mais antiga do histórico ↑↓ e prova, no fim, que o
    // recall atravessa o lugar onde as linhas /secret estariam se tivessem sido guardadas.
    stdin.write('!echo antes-dos-segredos');
    await waitFor(() => plain(lastFrame() ?? '').includes('!echo antes-dos-segredos'));
    stdin.write('\r');
    await waitFor(() =>
      controller.current.blocks.some((b) => b.kind === 'bang' && b.status !== 'running'),
    );

    // ── 1) /secret API_KEY → campo mascarado; digita o valor ─────────────────────
    stdin.write('/secret API_KEY');
    await waitFor(() => plain(lastFrame() ?? '').includes('/secret API_KEY'));
    stdin.write('\r');
    await waitFor(() => plain(lastFrame() ?? '').includes('segredo $API_KEY'));
    const idxMascara = frames.length;
    stdin.write(CANARY);
    await waitFor(() => plain(lastFrame() ?? '').includes(`(${CANARY.length})`));
    const tela = plain(lastFrame() ?? '');
    expect(tela).not.toContain(CANARY); // a tela só tem •
    expect(tela).toContain('•'.repeat(10));
    stdin.write('\r');
    await waitFor(() => secretVault.has('API_KEY'));
    expect(secretVault.valueOf('API_KEY')).toBe(CANARY);

    // ── 2) 2º segredo COLADO (bracketed paste, com \n final de "copiar") ─────────
    await waitFor(() => !plain(lastFrame() ?? '').includes('segredo $'));
    stdin.write('/secret DB_PASS');
    await waitFor(() => plain(lastFrame() ?? '').includes('/secret DB_PASS'));
    stdin.write('\r');
    await waitFor(() => plain(lastFrame() ?? '').includes('segredo $DB_PASS'));
    stdin.write(`${PASTE_START}${CANARY_PASTED}\n${PASTE_END}`);
    await waitFor(() => plain(lastFrame() ?? '').includes(`(${CANARY_PASTED.length})`));
    expect(plain(lastFrame() ?? '')).not.toContain(CANARY_PASTED);
    stdin.write('\r');
    await waitFor(() => secretVault.has('DB_PASS'));
    expect(secretVault.valueOf('DB_PASS')).toBe(CANARY_PASTED); // sem o \n

    // ── 3) linha com valor INLINE: não guarda, não vai ao histórico ──────────────
    await waitFor(() => !plain(lastFrame() ?? '').includes('segredo $'));
    const f3a = frames.length; // enquanto DIGITA em aberto o composer mostra o texto (esperado)
    stdin.write(`/secret TOKEN_X ${CANARY}`);
    await waitFor(() => plain(lastFrame() ?? '').includes('/secret TOKEN_X'));
    stdin.write('\r');
    await waitFor(() =>
      controller.current.blocks.some(
        (b) => b.kind === 'note' && b.lines.some((l) => l.includes('digitado em aberto')),
      ),
    );
    expect(secretVault.has('TOKEN_X')).toBe(false);
    await tick(100);
    const f3b = frames.length;

    // ── 4) um comando do dono imprime o valor (env exportado; saída partida) ─────
    stdin.write('!echo $API_KEY');
    await waitFor(() => plain(lastFrame() ?? '').includes('!echo $API_KEY'));
    stdin.write('\r');
    await waitFor(
      () =>
        controller.current.blocks.filter((b) => b.kind === 'bang' && b.status !== 'running')
          .length >= 2,
    );
    expect(envVisto[envVisto.length - 1]?.API_KEY).toBe(CANARY); // exportado ao shell
    const bang = controller.current.blocks.filter((b) => b.kind === 'bang').at(-1);
    expect(bang?.kind === 'bang' && bang.output).toBe('‹redigido›');

    // ── 5) turno do modelo com o `!` no contexto ─────────────────────────────────
    stdin.write('resuma o que saiu');
    await waitFor(() => plain(lastFrame() ?? '').includes('resuma o que saiu'));
    stdin.write('\r');
    await waitFor(() => corposDoModelo.length >= 1);
    await waitFor(() => !['thinking', 'streaming'].includes(controller.current.phase));

    // ── 6) histórico ↑↓: recalca tudo; nenhuma linha /secret nem valor ───────────
    const antes = frames.length;
    for (let i = 0; i < 8; i++) {
      stdin.write(`${ESC}[A`);
      await tick(80);
    }
    const recall = frames.slice(antes).map(plain).join('\n');
    // (as notas do transcript citam `/secret NOME` como instrução; o que NUNCA pode voltar é a
    // linha DIGITADA, com nome ou valor)
    for (const l of ['/secret API_KEY', '/secret DB_PASS', '/secret TOKEN_X']) {
      expect(recall).not.toContain(l);
    }
    // sanidade: o recall funciona e ATRAVESSA o ponto onde as linhas /secret estariam
    expect(recall).toContain('resuma o que saiu');
    expect(recall).toContain('!echo antes-dos-segredos');
    expect(recall).not.toContain(CANARY);

    // ── varredura final ──────────────────────────────────────────────────────────
    const blocks = controller.current.blocks;
    // (a) arquivo de sessão (store real, em tmp)
    const store = new SessionStore({ baseDir: dir });
    expect(autoSaveSession(store, { id: 'leak', cwd: '/proj', tier: 'aluy-flux', blocks })).toBe(
      true,
    );
    for (const f of everyFile(store.sessionsDir)) {
      const conteudo = readFileSync(f, 'utf8');
      expect(conteudo).not.toContain(CANARY);
      expect(conteudo).not.toContain(CANARY_PASTED);
    }
    // (b) export
    const exportado = buildTranscript(blocks);
    expect(exportado).not.toContain(CANARY);
    expect(exportado).not.toContain(CANARY_PASTED);
    // (c) journal (linha de comando com o valor literal)
    const journal = new NodeJournalStore({ sessionId: 'leak', baseDir: dir });
    await journal.appendEntry({
      kind: 'barrier',
      seq: 0,
      ts: 1,
      tool: 'run_command',
      targets: [],
      command: `echo ${CANARY}`,
    } as never);
    for (const f of everyFile(join(dir, 'undo'))) {
      expect(readFileSync(f, 'utf8')).not.toContain(CANARY);
    }
    // (d) todos os frames já pintados na tela
    // (o trecho em que o dono DIGITOU a linha inline, em aberto, fica de fora — é o que o
    // aviso diz; depois do Enter o valor não pode reaparecer em frame nenhum)
    frames.forEach((fr, i) => {
      if (i >= f3a && i < f3b - 1) return;
      expect(plain(fr)).not.toContain(CANARY);
      expect(plain(fr)).not.toContain(CANARY_PASTED);
    });
    expect(plain(frames[f3b - 1] ?? '')).not.toContain(CANARY);
    // (e) cada requisição ao modelo (mensagens do loop)
    expect(corposDoModelo.length).toBeGreaterThan(0);
    for (const c of corposDoModelo) {
      expect(c).not.toContain(CANARY);
      expect(c).not.toContain(CANARY_PASTED);
    }
    // o `!` chegou ao modelo (redigido) e o prompt traz os NOMES
    expect(corposDoModelo[0]).toContain('echo $API_KEY');
    expect(corposDoModelo[0]).toContain('$DB_PASS');
    expect(frames.slice(idxMascara).length).toBeGreaterThan(0);
    unmount();

    // (f) o corpo REAL no fio, mesmo que alguém cole o valor no chat
    const calls: string[] = [];
    const client = new BrokerModelClient({
      baseUrl: 'https://broker.test',
      getAccessToken: async () => 't',
      fetch: (async (_u: string, init: { body: string }) => {
        calls.push(init.body);
        return { ok: true, status: 200, headers: new Headers(), body: null };
      }) as never,
    });
    try {
      for await (const _ of client.stream({
        request: { tier: 'aluy-strata', messages: [{ role: 'user', content: `isto: ${CANARY}` }] },
      }))
        void _;
    } catch {
      /* resposta sem corpo: só interessa o body enviado */
    }
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).not.toContain(CANARY);
  }, 30_000);
});

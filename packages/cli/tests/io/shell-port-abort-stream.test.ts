// EST-0982 — ShellPort ABORTÁVEL + STREAMING (esta estória).
//
// Prova, com comandos REAIS de shell (sem modelo), as travas/garantias:
//   (a) signal JÁ abortado ⇒ NÃO roda (curto-circuito), reporta `aborted`.
//   (b) `sleep 30` + abort no meio ⇒ processo MORTO em < ~2s (não espera o timeout).
//   (c) server/filho que faz `setsid`/spawn ⇒ o GRUPO é morto (o neto SOME — sem órfão).
//   (d) streaming: stdout chega em chunks AO VIVO (onChunk chamado N× antes do done).
//   (e) o timeout AINDA mata o processo (anti-hang da EST-0948 intacto).
//
// FRUGAL: nada de LLM — dirige o ShellPort direto com comandos sintéticos.

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import type { ShellChunk } from '@hiperplano/aluy-cli-core';

function tmpWorkspace(): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'aluy-sh-0982-'));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** `true` se o PID ainda existe (kill -0 não lança). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false; // o PID não existe mais ⇒ morto.
  }
  // DEFLAKE — `kill(pid,0)` considera um ZUMBI (defunct, já terminou mas ainda não foi
  // reaped) como "vivo" (o PID persiste até o reap). Após o SIGKILL do grupo, o neto vira
  // zumbi e é re-parentado ao init, que o reapa — mas sob CARGA do runner self-hosted esse
  // reap atrasa, e o loop de espera estourava com o zumbi ainda "vivo" (a falha intermitente
  // "expected true to be false"). Em Linux lemos /proc/<pid>/stat e tratamos estado 'Z'
  // (zombie) como MORTO — o processo JÁ não roda. Degrada gracioso em não-Linux (sem /proc).
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // O 3º campo é o ESTADO. O comm (2º campo, entre parênteses) pode conter espaços/`)`,
    // então cortamos após o ÚLTIMO `)` e pegamos o 1º char não-espaço — esse é o estado.
    const state = stat.slice(stat.lastIndexOf(')') + 1).trim()[0];
    if (state === 'Z') return false; // zumbi ⇒ não está mais executando.
  } catch {
    /* sem /proc (não-Linux/macOS) ⇒ confia no kill(pid,0) acima. */
  }
  return true;
}

describe('EST-0982 — ShellPort abortável (kill do processo/grupo)', () => {
  it('(a) signal JÁ abortado ⇒ NÃO roda nada e reporta aborted', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const ac = new AbortController();
      ac.abort(); // já abortado ANTES do exec
      // Um comando com efeito visível (criar arquivo): se rodasse, o arquivo existiria.
      const marker = join(root, 'should-not-exist');
      const r = await shell.exec(`touch ${marker}`, { signal: ac.signal });
      expect(r.aborted).toBe(true);
      expect(r.exitCode).toBe(130); // convenção SIGINT
      expect(existsSync(marker)).toBe(false); // não spawnou ⇒ nenhum efeito
    } finally {
      cleanup();
    }
  });

  it('(b) sleep longo + abort no meio ⇒ MORTO em < ~2s (não espera o timeout)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      // timeout GRANDE (30s): se o abort não matasse, o teste penduraria até lá.
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root }),
        timeoutMs: 30_000,
        killGraceMs: 500, // grace curto p/ o teste (SIGKILL rápido se teimar)
      });
      const ac = new AbortController();
      const start = Date.now();
      const p = shell.exec('sleep 30', { signal: ac.signal });
      // Aborta "no meio" (logo depois de começar).
      setTimeout(() => ac.abort(), 150);
      const r = await p;
      const elapsed = Date.now() - start;
      expect(r.aborted).toBe(true);
      expect(r.exitCode).toBe(130);
      // Morto BEM antes do timeout de 30s — e abaixo de ~2s (DoD).
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      cleanup();
    }
  });

  it('(c) filho que faz setsid/spawn ⇒ o GRUPO é morto (neto SOME — sem órfão)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root }),
        timeoutMs: 30_000,
        killGraceMs: 500,
      });
      const pidFile = join(root, 'grandchild.pid');
      const ac = new AbortController();
      // Inicia um NETO em background (server/processo de longa duração) e grava o PID.
      // O `sh` é o líder do grupo (detached); o `sleep &` é um neto no MESMO grupo.
      const cmd = `sleep 30 & echo $! > ${pidFile}; wait`;
      const p = shell.exec(cmd, { signal: ac.signal });
      // Espera o pidFile aparecer (o neto já está vivo), então aborta.
      for (let i = 0; i < 100 && !existsSync(pidFile); i++) {
        await new Promise((res) => setTimeout(res, 20));
      }
      expect(existsSync(pidFile)).toBe(true);
      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(pidAlive(grandchildPid)).toBe(true); // vivo antes do abort
      ac.abort();
      const r = await p;
      expect(r.aborted).toBe(true);
      // Dá um instante p/ o SIGTERM/SIGKILL do GRUPO derrubar o neto.
      for (let i = 0; i < 200 && pidAlive(grandchildPid); i++) {
        await new Promise((res) => setTimeout(res, 20));
      }
      // O NETO sumiu — o kill foi do GRUPO inteiro (sem órfão).
      expect(pidAlive(grandchildPid)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('(e) timeout AINDA mata o processo (anti-hang intacto, com kill do grupo)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root }),
        timeoutMs: 150,
        killGraceMs: 500,
      });
      const pidFile = join(root, 'gc-timeout.pid');
      const start = Date.now();
      // Mesmo padrão do (c): um neto que só morre se o GRUPO for morto.
      const r = await shell.exec(`sleep 30 & echo $! > ${pidFile}; wait`);
      const elapsed = Date.now() - start;
      expect(r.exitCode).toBe(124); // convenção de timeout
      expect(r.aborted).toBeUndefined(); // timeout != abort
      expect(elapsed).toBeLessThan(5_000);
      const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
      for (let i = 0; i < 200 && pidAlive(grandchildPid); i++) {
        await new Promise((res) => setTimeout(res, 20));
      }
      expect(pidAlive(grandchildPid)).toBe(false); // o timeout matou o GRUPO
    } finally {
      cleanup();
    }
  });

  it('(f) BUG-0027 — neto destacado segura o stdout ⇒ exec RESOLVE no exit (não pendura no close)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      // timeout GRANDE: se o exec pendurasse no `close`, só o timeout o salvaria —
      // e o fix tem de resolver MUITO antes disso (pelo `exit` + drain curto).
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root }),
        timeoutMs: 30_000,
      });
      // `sleep 3 &` backgrounda um NETO que HERDA o stdout e o SEGURA por 3s; o `sh`
      // sai na hora (`exit 0`). Sem o fix, o `close` (EOF do pipe) só viria em ~3s ⇒
      // o exec penduraria até lá (e o abort/timeout ficariam inócuos). Com o fix, ele
      // resolve no `exit` + drain (~250ms). Reproduz o footgun real do `start <GUI>`.
      const start = Date.now();
      const r = await shell.exec('sleep 3 & exit 0');
      const elapsed = Date.now() - start;
      expect(r.exitCode).toBe(0); // o `sh` saiu 0 — saída limpa, não abort/timeout
      expect(r.aborted).toBeUndefined();
      // Resolveu pelo exit-drain, BEM antes dos ~3s que o `close` levaria.
      expect(elapsed).toBeLessThan(2_000);
    } finally {
      cleanup();
    }
  });
});

describe('EST-0982 — ShellPort streaming (saída ao vivo)', () => {
  it('(d) stdout chega em CHUNKS ao vivo (onChunk N× antes do resultado)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const chunks: ShellChunk[] = [];
      // 5 linhas com um respiro entre elas: garante múltiplos eventos `data`.
      const cmd = 'for i in 1 2 3 4 5; do echo "linha-$i"; sleep 0.02; done';
      const r = await shell.exec(cmd, { onChunk: (c) => chunks.push(c) });
      expect(r.exitCode).toBe(0);
      // Chegou AO VIVO em mais de um chunk (não só no fim).
      expect(chunks.length).toBeGreaterThan(1);
      // Todos os chunks de stdout; o conteúdo acumulado bate com o stdout final.
      expect(chunks.every((c) => c.stream === 'stdout')).toBe(true);
      const streamed = chunks.map((c) => c.text).join('');
      for (let i = 1; i <= 5; i++) expect(streamed).toContain(`linha-${i}`);
      expect(r.stdout).toContain('linha-5');
    } finally {
      cleanup();
    }
  });

  it('streaming por LINHA (chunk termina em \\n; parcial flushado no close)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const chunks: ShellChunk[] = [];
      // `printf` sem \n final: a última "linha" é parcial — tem de ser flushada no close.
      const r = await shell.exec(`printf 'a\\nb\\nc'`, { onChunk: (c) => chunks.push(c) });
      expect(r.exitCode).toBe(0);
      const joined = chunks.map((c) => c.text).join('');
      expect(joined).toBe('a\nb\nc');
      // As linhas completas terminam em \n; o parcial final (`c`) é o flush do close.
      const complete = chunks.filter((c) => c.text.endsWith('\n'));
      expect(complete.length).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });

  it('stderr também streama (stream rotulado)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const chunks: ShellChunk[] = [];
      const r = await shell.exec(`echo erro 1>&2`, { onChunk: (c) => chunks.push(c) });
      expect(r.exitCode).toBe(0);
      expect(chunks.some((c) => c.stream === 'stderr' && c.text.includes('erro'))).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('sem onChunk/sem signal ⇒ comportamento IDÊNTICO (não-regressão da EST-0948)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const r = await shell.exec('echo ola-aluy'); // sem options
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ola-aluy');
      expect(r.aborted).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  // REGRESSÃO (hunt "recurso sem teto", streaming) — uma ÚNICA "linha" GIGANTE SEM
  // newline (`cat /dev/urandom | base64 -w0`, `yes | tr -d '\n'`, JSON minificado de
  // centenas de MiB) NÃO pode balonar o buffer de linha parcial do emitter. O streaming
  // é por LINHA: o parcial acumula em `pending` até achar `\n`. Sem o teto, `pending`
  // crescia até o TAMANHO TOTAL da saída (a busca por `\n` nunca casa) ⇒ OOM, mesmo com
  // o buffer agregado capado em MAX_OUTPUT_BYTES. O fix flusha o parcial em pedaços de no
  // máx. MAX_LINE_BYTES (64 KiB). PROVA: o MAIOR chunk entregue ao vivo fica ≤ teto.
  // SEM o fix, a saída inteira sai num ÚNICO chunk no close (≫ teto) ⇒ este teste FALHA.
  it('linha ÚNICA gigante SEM newline ⇒ chunks ao vivo BOUNDED (não balona pending)', async () => {
    const { root, cleanup } = tmpWorkspace();
    const MAX_LINE_BYTES = 64_000; // espelha o teto interno do shell-port
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      // ~2 MiB de 'A' num ÚNICO write, SEM nenhum '\n'. Bounded (não é `yes` infinito)
      // mas BEM acima do teto de linha ⇒ exercita o caminho do parcial gigante.
      const N = 2_000_000;
      const gen = `process.stdout.write('A'.repeat(${N}))`;
      let maxChunk = 0;
      let totalStreamed = 0;
      const r = await shell.exec(`node -e "${gen}"`, {
        onChunk: (c) => {
          if (c.stream !== 'stdout') return;
          maxChunk = Math.max(maxChunk, c.text.length);
          totalStreamed += c.text.length;
        },
      });
      expect(r.exitCode).toBe(0);
      // O fix mantém CADA chunk ao vivo dentro do teto (o `pending` nunca virou a saída
      // inteira). SEM o fix, maxChunk seria ~2_000_000 (o flush único do close).
      expect(maxChunk).toBeLessThanOrEqual(MAX_LINE_BYTES);
      // HONESTO: nada se perde no streaming — a soma dos chunks é a saída inteira.
      expect(totalStreamed).toBe(N);
      // O buffer AGREGADO continua capado (honesto, com marcador) — invariante intacto.
      expect(r.stdout.length).toBeLessThanOrEqual(1_000_000 + 200);
      expect(r.stdout).toContain('[saída truncada');
    } finally {
      cleanup();
    }
  });
});

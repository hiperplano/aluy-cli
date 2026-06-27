// EST-0982 — PROVA real (sem modelo) do `run_command` abortável + streaming, pela
// MESMA wiring de produção do `!comando`: SessionController.runBang → BangExecutor →
// runCommandTool → NodeShellPort REAL (cwd preso + timeout + kill do grupo).
//
// Demonstra o DoD operacional:
//   (1) `!sleep 20` + interrupt() (esc/Ctrl-C) ⇒ o processo é MORTO em < ~2s (não
//       espera os 20s nem o timeout), e o GRUPO some (sem órfão).
//   (2) `!seq 1 100000 | head -50` ⇒ a saída STREAMA ao vivo (liveOutput cresce em
//       múltiplos frames antes do resultado).
//
// Rodar:  npm run build  &&  node scripts/smoke-run-command-abort.mjs

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionController } from '../packages/cli/dist/session/controller.js';
import { TuiAskResolver } from '../packages/cli/dist/ask/ask-resolver.js';
import { NodeShellPort } from '../packages/cli/dist/io/shell-port.js';
import { NodeWorkspace } from '../packages/cli/dist/io/workspace.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';

const base = mkdtempSync(join(tmpdir(), 'aluy-0982-smoke-'));
const root = join(base, 'project');
mkdirSync(root, { recursive: true });

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildController() {
  const workspace = new NodeWorkspace({ root });
  // timeout GRANDE (30s): se o abort não matasse, o sleep penduraria até lá.
  const shell = new NodeShellPort({ workspace, timeoutMs: 30_000 });
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
    shell,
    search: {
      async search() {
        return [];
      },
    },
  };
  // política allow p/ run_command (o foco é abort/stream, não o veredito).
  const permission = new PolicyPermissionEngine({
    policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
  });
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: '', finish_reason: 'stop' };
      },
    },
    permission,
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: root, tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'OK ' : 'FAIL'}  ${label}`);
  if (!cond) failures++;
}

// ── (1) `!sleep 20` + interrupt ⇒ morto em < ~2s, GRUPO some ──────────────────
{
  const controller = buildController();
  controller.dismissBoot();
  // Grava o PID do neto (sleep) p/ provar que o GRUPO morreu (sem órfão).
  const pidFile = join(root, 'sleep.pid');
  const t0 = Date.now();
  const p = controller.runBang(`sleep 20 & echo $! > ${pidFile}; wait`);
  // espera o neto nascer
  for (let i = 0; i < 100 && !existsSync(pidFile); i++) await sleep(20);
  const gcPid = Number(readFileSync(pidFile, 'utf8').trim());
  check('(1) neto (sleep) vivo antes do abort', pidAlive(gcPid));
  controller.interrupt(); // esc/Ctrl-C
  await p;
  const elapsed = Date.now() - t0;
  check(`(1) turno cessou em ${elapsed}ms (< 2000)`, elapsed < 2_000);
  // dá um instante p/ o SIGTERM/SIGKILL do grupo derrubar o neto
  for (let i = 0; i < 100 && pidAlive(gcPid); i++) await sleep(20);
  check('(1) neto MORTO (grupo morto, sem órfão)', !pidAlive(gcPid));
  const bang = controller.current.blocks.find((b) => b.kind === 'bang');
  check(
    '(1) bloco bang reporta interrupção',
    /interrompido pelo usuário/i.test(bang?.output ?? ''),
  );
}

// ── (2) `!seq 1 100000 | head -50` ⇒ saída STREAMA ao vivo ────────────────────
{
  const controller = buildController();
  controller.dismissBoot();
  let maxLiveLen = 0;
  let liveFrames = 0;
  controller.subscribe((s) => {
    const b = s.blocks.find((x) => x.kind === 'bang');
    if (b?.kind === 'bang' && b.status === 'running' && (b.liveOutput?.length ?? 0) > 0) {
      liveFrames++;
      maxLiveLen = Math.max(maxLiveLen, b.liveOutput.length);
    }
  });
  // Comando com RESPIRO entre as linhas ⇒ múltiplos eventos `data` ⇒ a saída chega
  // EM CHUNKS ao vivo (não de uma vez no fim) — a prova do streaming.
  await controller.runBang('for i in $(seq 1 6); do echo "linha-$i"; sleep 0.05; done');
  check(`(2) saída streamou ao vivo em VÁRIOS frames (${liveFrames})`, liveFrames > 1);
  check(`(2) liveOutput cresceu (maxLen=${maxLiveLen})`, maxLiveLen > 0);
  const bang = controller.current.blocks.find((b) => b.kind === 'bang');
  check(
    '(2) resultado final ok com a saída completa',
    bang?.status === 'ok' && /linha-6/.test(bang?.output ?? ''),
  );
}

rmSync(base, { recursive: true, force: true });
console.log(failures === 0 ? '\nSMOKE OK' : `\nSMOKE FALHOU (${failures})`);
process.exit(failures === 0 ? 0 : 1);

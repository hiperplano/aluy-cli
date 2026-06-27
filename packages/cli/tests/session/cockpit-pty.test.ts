// EST-1000 · ADR-0076 §2 — O GATE DE ROBUSTEZ SOB PTY (o teste obrigatório do ADR):
// num PTY REAL, entrar no alt-screen (`?1049h`) + matar o processo (SIGINT/SIGTERM) ⇒ a
// sequência de restauração `?1049l` + `?25h` é EMITIDA e o terminal volta limpo. Sem PTY
// o ramo de boot/alt-screen do produto sequer entra; aqui exercemos o módulo
// `alt-screen` (a mesma fonte que o run.tsx registra) sob um TTY de verdade (`script`).
//
// Mecânica: `script -qec '<cmd>' /dev/null` roda `<cmd>` com um PTY anexado (stdin/stdout
// viram TTY). O `<cmd>` é um nodezinho que importa o módulo COMPILADO, ENTRA no
// alt-screen e fica vivo; nós o matamos com o sinal e capturamos TUDO que ele escreveu no
// PTY (redirecionado a um arquivo) — provando o `?1049l` na saída.

import { describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HAS_SCRIPT = spawnSync('script', ['--version'], { encoding: 'utf8' }).status === 0;
const ALT_DIST = fileURLToPath(new URL('../../dist/session/alt-screen.js', import.meta.url));

/**
 * Driver node: importa o alt-screen COMPILADO (a mesma fonte do produto), ENTRA no
 * alt-screen sob o PTY, registra a restauração (gate §2) e, após um curto delay,
 * AUTO-DISPARA o `kind` (SIGINT/SIGTERM/crash) NO PRÓPRIO processo — provando que o
 * handler emite `?1049l`+`?25h` ANTES de o processo morrer, num TTY de verdade. (O
 * auto-disparo evita a fragilidade de entregar o sinal através do wrapper `script`.)
 */
function driverSource(kind: 'SIGINT' | 'SIGTERM' | 'crash'): string {
  const trigger =
    kind === 'crash'
      ? `setTimeout(() => { throw new Error('boom-no-cockpit'); }, 300);`
      : `setTimeout(() => { process.kill(process.pid, ${JSON.stringify(kind)}); }, 300);`;
  return `
import { enterAltScreen, registerRestoreHandlers } from ${JSON.stringify(ALT_DIST)};
enterAltScreen(process.stdout);
registerRestoreHandlers(process.stdout, process);
process.stdout.write('READY\\n');
${trigger}
setInterval(() => {}, 1000);
`;
}

/**
 * Roda o driver sob um PTY (`script`), espera o `READY`, manda o `signal`, e devolve o
 * que o processo escreveu no PTY (capturado pelo `script` num arquivo). Resolve com o
 * conteúdo. Timeout defensivo.
 */
async function runUnderPty(kind: 'SIGINT' | 'SIGTERM' | 'crash'): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-pty-'));
  const driver = join(dir, 'driver.mjs');
  const capture = join(dir, 'capture.txt');
  writeFileSync(driver, driverSource(kind));
  // `script -qec '<cmd>' <file>`: roda <cmd> num PTY e grava a saída do PTY em <file>.
  const cmd = `${process.execPath} ${driver}`;
  return await new Promise<string>((resolve, reject) => {
    const child = spawn('script', ['-qec', cmd, capture], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('PTY timeout'));
    }, 15000);
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString('utf8');
    });
    child.on('close', () => {
      clearTimeout(timer);
      const captured = existsSync(capture) ? readFileSync(capture, 'utf8') : '';
      resolve(captured + out);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

const LEAVE = '\x1b[?1049l';
const SHOW = '\x1b[?25h';
const ENTER = '\x1b[?1049h';

describe.skipIf(!HAS_SCRIPT)('GATE PTY (§2) — restauração do alt-screen em sinal', () => {
  it('pré-condição: o módulo alt-screen foi compilado (dist)', () => {
    expect(existsSync(ALT_DIST), 'dist/session/alt-screen.js ausente — rode `npm run build`').toBe(
      true,
    );
  });

  it('SIGINT no cockpit ⇒ ?1049l + ?25h emitidos (terminal volta limpo)', async () => {
    const captured = await runUnderPty('SIGINT');
    expect(captured).toContain(ENTER); // entrou no alt-screen…
    expect(captured).toContain(LEAVE); // …e RESTAUROU a tela primária (o gate).
    expect(captured).toContain(SHOW); // cursor visível de novo.
  }, 20000);

  it('SIGTERM no cockpit ⇒ ?1049l emitido (restauração à prova de tudo)', async () => {
    const captured = await runUnderPty('SIGTERM');
    expect(captured).toContain(LEAVE);
    expect(captured).toContain(SHOW);
  }, 20000);

  it('CRASH (uncaughtException) no cockpit ⇒ ?1049l emitido ANTES de propagar', async () => {
    const captured = await runUnderPty('crash');
    expect(captured).toContain(ENTER);
    expect(captured).toContain(LEAVE);
    expect(captured).toContain(SHOW);
  }, 20000);
});

// EST-1015 — A PROVA não-tautológica do FIX "tela EM BRANCO na RE-ENTRADA do cockpit".
//
// BUG (repro em PTY/tmux real): em `--fullscreen`, ENCOLHER a janela abaixo de 80 col faz o
// cockpit DEGRADAR p/ inline (sai do alt-screen); CRESCER de volta deveria RE-ENTRAR no
// cockpit — mas a tela ficava EM BRANCO até a próxima tecla/resize. Causa: o frame do resize
// é pintado contra o `prevLines` STALE do differ ANTES do effect rodar; o effect chama
// `enter()` (alt-screen vazio + reseta o differ) DEPOIS, e em REPOUSO nenhum render novo
// dispara ⇒ alt-screen preto. FIX (App.tsx): o effect FORÇA um repaint após o `enter()`
// (bumpResize) ⇒ o differ recém-resetado FAZ O FULL-PAINT.
//
// Por que PTY: o bug é de ORDENAÇÃO do DIFFER REAL — invisível com mock (ver a nota em
// `cockpit-resize-leak.test.tsx`). Aqui dirigimos o BINÁRIO sob um PTY real, RESIZE via
// TIOCSWINSZ+SIGWINCH (narrow→wide), e provamos que o ÚLTIMO alt-screen (a re-entrada) tem
// os GLIFOS do cockpit — não fica em branco. Espera-por-condição (anti-flake, ver #134/#149):
// scrub de CI (senão o Ink suprime o render), NO_COLOR (boot determinístico), HOME isolado.
//
// ESCOPO: só leitura de bytes do terminal; sessão idle (sem objetivo ⇒ nenhuma chamada ao
// modelo). Espelha o driver/anti-flake de `cockpit-paint-pty.test.ts`.

import { describe, expect, it } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../dist/bin/aluy.js', import.meta.url));
const HAS_PY = spawnSync('python3', ['-c', 'import pty'], { encoding: 'utf8' }).status === 0;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ENTER = `${ESC}[?1049h`;
const LEAVE = `${ESC}[?1049l`;
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, 'g');
const ESC_RE = new RegExp(`${ESC}.`, 'g');

function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '').replace(OSC_RE, '').replace(ESC_RE, '');
}

// Driver Python: fork PTY 100×30, exec do binário em --fullscreen. ESPERA-POR-CONDIÇÃO em 4
// fases: (1) entra no alt-screen + pinta o cockpit; (2) ENCOLHE p/ 50col (SIGWINCH) e espera
// SAIR (LEAVE após o ponto); (3) CRESCE de volta p/ 100col (SIGWINCH) e espera o cockpit
// RE-PINTAR no NOVO alt-screen; (4) settle + SIGINT + dump. Sem sleeps fixos (anti-flake).
function pyResizeDriver(out: string): string {
  return `
import os, sys, pty, select, struct, fcntl, termios, time, signal, re
out = ${JSON.stringify(out)}
cmd = ${JSON.stringify([process.execPath, BIN, '--fullscreen', '--new'])}
ENTER = b"\\x1b[?1049h"
LEAVE = b"\\x1b[?1049l"
wordmark = re.compile("luy")
region = re.compile("conversa|log")
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd); os._exit(127)
def winsz(rows, cols):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    try: os.kill(pid, signal.SIGWINCH)
    except ProcessLookupError: pass
winsz(30, 100)
buf = bytearray()
_csi = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]")
_osc = re.compile(rb"\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)")
_esc = re.compile(rb"\\x1b.")
def pump(secs):
    end = time.time() + secs
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try: d = os.read(fd, 65536)
            except OSError: return
            if not d: return
            buf.extend(d)
def alt_visible_from(idx):
    # reconstrói o alt-screen a partir do ÚLTIMO ?1049h >= idx (a re-entrada).
    i = buf.rfind(ENTER)
    if i < 0 or i < idx: return ""
    start = i + len(ENTER)
    j = buf.find(LEAVE, start)
    chunk = bytes(buf[start:]) if j < 0 else bytes(buf[start:j])
    chunk = _osc.sub(b"", chunk); chunk = _csi.sub(b"", chunk); chunk = _esc.sub(b"", chunk)
    return chunk.decode("utf-8", "replace")
def waitfor(pred, timeout):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.2)
        if pred(): return True
    return False
# (1) entra no alt-screen e PINTA o cockpit (boot).
waitfor(lambda: ENTER in buf, 12)
def glyphs(v):
    return sum(1 for c in v if not c.isspace())
def painted0():
    # SUBSTANCIALMENTE pintado: wordmark + rótulo + >50 glifos (não um frame a meio). Isto é o
    # gate ANTI-FLAKE: sob contenção paralela o repaint chega em pedaços; só prosseguimos com a
    # tela cheia, então a medição final NUNCA pega um alt-screen parcial.
    v = alt_visible_from(0)
    return bool(wordmark.search(v) and region.search(v)) and glyphs(v) > 50
waitfor(painted0, 12)
# (2) ENCOLHE p/ 50col ⇒ degrada p/ inline (SAI do alt-screen). Espera o LEAVE depois daqui.
mark_leave = len(buf)
winsz(30, 50)
waitfor(lambda: buf.find(LEAVE, mark_leave) >= 0, 8)
pump(0.4)
# (3) CRESCE de volta p/ 100col ⇒ RE-ENTRA no cockpit. Marca o ponto e espera RE-PINTAR.
mark_reentry = len(buf)
winsz(30, 100)
# espera um ?1049h NOVO (re-entrada) E os glifos do cockpit no alt-screen reconstruído.
def repainted():
    return buf.find(ENTER, mark_reentry) >= 0 and painted0()
waitfor(repainted, 16)
# SETTLE generoso: deixa o full-paint forçado ASSENTAR (Ink coalesce + runner saturado)
# antes de medir/derrubar — o gate é a condição acima; este só evita medir um frame a meio.
pump(1.2)
try: os.kill(pid, signal.SIGINT)
except ProcessLookupError: pass
pump(1.0)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass
# grava o buffer + o offset da re-entrada (p/ o teste recortar só o alt-screen pós-resize).
open(out, "wb").write(struct.pack("<I", mark_reentry) + bytes(buf))
`;
}

async function captureReentry(): Promise<{ reentryOffset: number; buf: Buffer }> {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-reentry-'));
  const driver = join(dir, 'drive.py');
  const capture = join(dir, 'cap.bin');
  const home = mkdtempSync(join(tmpdir(), 'aluy-home-'));
  writeFileSync(driver, pyResizeDriver(capture));
  // scrub das marcas de CI (senão o Ink suprime o render ⇒ tela preta DETERMINÍSTICA — não é
  // flake, é detecção-de-CI do `is-in-ci`; ver cockpit-paint-pty). NO_COLOR ⇒ boot determinístico.
  const scrubbedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(scrubbedEnv)) {
    if (k === 'CI' || k === 'CONTINUOUS_INTEGRATION' || k.startsWith('CI_')) delete scrubbedEnv[k];
  }
  return await new Promise((resolve, reject) => {
    const child = spawn('python3', [driver], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...scrubbedEnv, HOME: home, NO_COLOR: '1', ALUY_TOKEN: '', ALUY_FULLSCREEN: '1' },
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('PTY reentry timeout'));
    }, 50000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const raw = existsSync(capture) ? readFileSync(capture) : Buffer.alloc(0);
        if (raw.length < 4) return resolve({ reentryOffset: 0, buf: Buffer.alloc(0) });
        const reentryOffset = raw.readUInt32LE(0);
        resolve({ reentryOffset, buf: raw.subarray(4) });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe.skipIf(!HAS_PY)(
  'EST-1015 — cockpit RE-PINTA na re-entrada por resize (não fica em branco)',
  () => {
    it('pré-condição: o binário foi compilado (dist)', () => {
      expect(existsSync(BIN), 'dist/bin/aluy.js ausente — rode `npm run build`').toBe(true);
    });

    it('fullscreen → encolhe <80col → cresce de volta ⇒ o ÚLTIMO alt-screen tem os GLIFOS do cockpit', async () => {
      const { reentryOffset, buf } = await captureReentry();
      const text = buf.toString('latin1');

      // houve uma RE-ENTRADA (um ?1049h DEPOIS do resize-de-volta).
      const reentryEnter = text.indexOf(ENTER, reentryOffset);
      expect(
        reentryEnter,
        'não houve re-entrada no alt-screen após crescer de volta (?1049h)',
      ).toBeGreaterThanOrEqual(0);

      // recorta o alt-screen da RE-ENTRADA (último ?1049h) e prova que PINTOU (não ficou em branco).
      const ent = text.lastIndexOf(ENTER);
      const altStart = ent + ENTER.length;
      const lv = text.indexOf(LEAVE, altStart);
      const altEnd = lv === -1 ? buf.length : lv;
      const visible = stripAnsi(buf.subarray(altStart, altEnd).toString('utf8'));
      const glyphs = [...visible].filter((c) => c.trim() !== '').length;

      // SEM o fix: o alt-screen da re-entrada fica VAZIO (poucos/zero glifos) — a tela preta.
      // COM o fix: o repaint forçado pinta o cockpit inteiro (wordmark + rótulo de região + dezenas
      // de glifos). Barra robusta: >30 glifos + wordmark + um rótulo de região.
      expect(glyphs, `re-entrada quase vazia (${glyphs} glifos) ⇒ tela em branco`).toBeGreaterThan(
        30,
      );
      expect(visible.includes('luy'), 'wordmark ausente no alt-screen da re-entrada').toBe(true);
      expect(/conversa|log/.test(visible), 'rótulo de região ausente na re-entrada').toBe(true);
    }, 60000); // PTY real (boot + 2 resizes + settle); teto generoso p/ o runner saturado (≠ default 5s).
  },
);

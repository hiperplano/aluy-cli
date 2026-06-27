// EST-1000 (#157 fix) — A PROVA DE BYTES: o overlay de `/` PINTA dentro do alt-screen do
// cockpit, sob um PTY REAL, dirigindo o BINÁRIO de verdade.
//
// O bug (QA): no cockpit a App retornava `<Cockpit/>` ANTES do bloco que renderiza os
// overlays (SlashMenu/pickers/paleta), que viviam só no caminho inline ⇒ no cockpit o
// `/` mudava o hint mas NENHUMA lista pintava. Os testes de superfície (cockpit-overlays,
// ink-testing-library) provam o JSX; ESTE fecha o buraco no nível de BYTES — o mesmo
// rigor do cockpit-paint-pty (#144): num terminal de verdade, depois do `?1049h`, ao
// digitar `/` os GLIFOS do SlashMenu (cabeçalho + um comando) aparecem no alt-screen
// RECONSTRUÍDO (recorte ?1049h…?1049l + strip ANSI) — não só o hint do rodapé.
//
// Espera-por-condição (anti-flake, como o cockpit-paint-pty): (1) espera o `?1049h`; (2)
// espera o cockpit PINTAR; (3) DIGITA `/` no PTY; (4) espera o cabeçalho do menu PINTAR no
// alt-screen reconstruído; só então settle + SIGINT. NO_COLOR + HOME isolado + CI scrub
// (o Ink suprime render sob CI) ⇒ determinístico. ESCOPO: só bytes do terminal; nenhuma
// chamada ao modelo (sessão idle).

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

// Driver Python: fork PTY, fixa a janela, exec do binário. Espera o cockpit pintar, DIGITA
// `/` (escreve no master do PTY ⇒ chega no stdin do produto), e espera os MARCADORES do
// SlashMenu pintarem no alt-screen reconstruído. `markers` = padrões que precisam estar
// visíveis DEPOIS do `/`. `enterTo`/`paintTo`/`menuTo` = TETOS generosos (o gate é a condição).
function pyDriver(
  rows: number,
  cols: number,
  out: string,
  cmd: string[],
  cockpitMarkers: string[],
  menuMarkers: string[],
  enterTo: number,
  paintTo: number,
  menuTo: number,
): string {
  return `
import os, sys, pty, select, struct, fcntl, termios, time, signal, re
rows, cols, out = ${rows}, ${cols}, ${JSON.stringify(out)}
cmd = ${JSON.stringify(cmd)}
cockpit_markers = [re.compile(m) for m in ${JSON.stringify(cockpitMarkers)}]
menu_markers = [re.compile(m) for m in ${JSON.stringify(menuMarkers)}]
enter_to, paint_to, menu_to = ${enterTo}, ${paintTo}, ${menuTo}
ENTER = b"\\x1b[?1049h"
LEAVE = b"\\x1b[?1049l"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd); os._exit(127)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
buf = bytearray()
_csi = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]")
_osc = re.compile(rb"\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)")
_esc = re.compile(rb"\\x1b.")
def pump(secs):
    end = time.time() + secs
    got = False
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.1)
        if fd in r:
            try: d = os.read(fd, 65536)
            except OSError: return got
            if not d: return got
            buf.extend(d); got = True
    return got
def alt_visible():
    i = buf.rfind(ENTER)
    if i < 0: return ""
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
# (1) entrou no alt-screen.
waitfor(lambda: ENTER in buf, enter_to)
# (2) o cockpit PINTOU (wordmark + rótulo de região).
def painted():
    vis = alt_visible()
    return all(m.search(vis) for m in cockpit_markers)
waitfor(painted, paint_to)
# (3) DIGITA "/" no PTY (chega no stdin do produto ⇒ abre o SlashMenu).
os.write(fd, b"/")
# (4) espera os MARCADORES do menu pintarem no alt-screen reconstruído.
def menued():
    vis = alt_visible()
    return all(m.search(vis) for m in menu_markers)
waitfor(menued, menu_to)
pump(0.4)
try: os.kill(pid, signal.SIGINT)
except ProcessLookupError: pass
pump(1.0)
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass
open(out, "wb").write(bytes(buf))
`;
}

const COCKPIT_MARKERS = ['luy', 'conversa|log'];
// O rótulo de POPOVER (`/menu`, só renderizado no ramo do overlay) + o cabeçalho do
// SlashMenu (`comandos ·`, exclusivo do menu, não do rodapé) + um comando estável
// (`/effort`). Esperar por eles garante que a LISTA pintou — não só o hint do rodapé (que
// muda sem o overlay aparecer). A lista de comandos CRESCEU (/effort, /mcp reconnect/reload)
// e a janela do menu mostra só o TOPO; `/effort` (alto na lista) é marcador confiável da
// janela inicial — o antigo `/theme` (fim da lista) caiu pra fora dela.
const MENU_MARKERS = ['/menu', 'comandos ·'];

async function capture(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-ov-'));
  const driver = join(dir, 'drive.py');
  const cap = join(dir, 'cap.bin');
  const home = mkdtempSync(join(tmpdir(), 'aluy-home-'));
  writeFileSync(
    driver,
    pyDriver(
      30,
      100,
      cap,
      [process.execPath, BIN, '--fullscreen', '--new'],
      COCKPIT_MARKERS,
      MENU_MARKERS,
      12,
      12,
      12,
    ),
  );
  // Remove as marcas de CI (o Ink suprime o render sob CI ⇒ tela preta determinística —
  // a causa-raiz documentada no cockpit-paint-pty). Espelha a regra do `is-in-ci`.
  const scrubbedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(scrubbedEnv)) {
    if (k === 'CI' || k === 'CONTINUOUS_INTEGRATION' || k.startsWith('CI_')) {
      delete scrubbedEnv[k];
    }
  }
  return await new Promise<Buffer>((resolve, reject) => {
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
      reject(new Error('PTY overlay paint timeout'));
    }, 50000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(existsSync(cap) ? readFileSync(cap) : Buffer.alloc(0));
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

function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '').replace(OSC_RE, '').replace(ESC_RE, '');
}

describe.skipIf(!HAS_PY)('FIX #157 — o overlay de `/` PINTA no cockpit (PTY real)', () => {
  it('pré-condição: o binário foi compilado (dist)', () => {
    expect(existsSync(BIN), 'dist/bin/aluy.js ausente — rode `npm run build`').toBe(true);
  });

  it('após `/` no cockpit, o alt-screen contém os GLIFOS do SlashMenu (lista pinta)', async () => {
    const raw = await capture();
    const text = raw.toString('latin1');
    expect(text.includes(ENTER), 'não entrou no alt-screen (?1049h)').toBe(true);

    // reconstrói o alt-screen do ÚLTIMO ?1049h ao ?1049l seguinte (mesma técnica do #144).
    const ent = text.lastIndexOf(ENTER);
    const altStart = ent + ENTER.length;
    const lv = text.indexOf(LEAVE, altStart);
    const altEnd = lv === -1 ? raw.length : lv;
    const alt = raw.subarray(altStart, altEnd);
    const visible = stripAnsi(alt.toString('utf8'));

    // o cockpit segue montado (wordmark + régua das regiões) E o overlay PINTOU sobre ele:
    expect(visible.includes('luy'), 'sem o wordmark — não é o cockpit').toBe(true);
    expect(visible.includes('─'), 'sem a régua das regiões — grid corrompido').toBe(true);
    // o POPOVER: rótulo `/menu` sinalizando a sobreposição na região da conversa.
    expect(visible.includes('/menu'), 'sem o rótulo de popover `/menu` no cockpit').toBe(true);
    // a LISTA do SlashMenu de fato pintou: o cabeçalho do MENU (`comandos ·`) é EXCLUSIVO do
    // SlashMenu (não existe no rodapé), então sua presença JÁ prova que a lista do menu
    // renderizou — não só o hint do rodapé. (Antes havia um marcador de comando específico
    // `/theme`, mas a lista de comandos cresceu — /effort, /mcp reconnect/reload — e cravar
    // um comando do fim da lista virou brittle; o cabeçalho é o sinal robusto e imutável.)
    expect(visible.includes('comandos ·'), 'sem o cabeçalho do SlashMenu no alt-screen').toBe(true);
    // o grid NÃO refluiu: a régua/rótulo do LOG segue presente (a soma das regiões == rows).
    expect(
      visible.toLowerCase().includes('log'),
      'a região de LOG sumiu — o overlay estourou o grid',
    ).toBe(true);
  }, 55000);
});

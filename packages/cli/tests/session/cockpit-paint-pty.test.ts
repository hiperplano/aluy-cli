// EST-1000 · ADR-0076 §2/§5 (FIX do #144) — A PROVA QUE FALTAVA: o cockpit PINTA dentro
// do alt-screen, sob um PTY REAL, dirigindo o BINÁRIO de verdade.
//
// O bug #144 era "tela TODA PRETA" ao entrar no `--fullscreen`: o `?1049h` era emitido,
// mas NADA pintava no alt-screen (o frame ia pra tela PRIMÁRIA antes do `?1049h`, e o Ink
// — frame == lastOutput — nunca repintava no buffer novo). Os testes do merge usavam
// ink-testing-library / exercitavam só o MÓDULO alt-screen — NUNCA um TTY real com render
// (mock≠realidade, a mesma classe do #115/#123). Por isso passavam com a tela preta.
//
// Este teste fecha o buraco: usa o `pty` do Python (PTY real + janela 30×100 via TIOCSWINSZ,
// já que o cockpit RECUSA <80 col) p/ rodar `node dist/bin/aluy.js --fullscreen --new`,
// captura TODOS os bytes do PTY, e prova que DEPOIS do `?1049h` há os GLIFOS do frame do
// cockpit (wordmark, régua, rótulos das regiões, composer, hints) — não só escapes seguidos
// de vazio. `NO_COLOR=1` torna o boot DETERMINÍSTICO (sem a espera variável do OSC 11).
//
// ── DETERMINISMO (EST-1000, fix do FLAKE no runner self-hosted) ──────────────────────────
// O 1º driver DRENAVA o PTY por um número FIXO de segundos e SÓ ENTÃO checava o conteúdo. No
// runner saturado o boot (broker/MCP discovery + splash → cockpit + 1º frame do Ink) CORRE
// COM o relógio: o timer estoura ANTES do cockpit pintar ⇒ "alt-screen quase vazio" intermi-
// tente (mesma classe do flake do resume antes do #134 — sleep fixo vs. boot variável). O
// driver agora é ESPERA-POR-CONDIÇÃO, não sleep: (1) espera o `?1049h` APARECER (entrou no
// alt-screen); (2) DEPOIS dele, espera os GLIFOS DO COCKPIT aparecerem no buffer já-pintado
// (wordmark Λluy + um rótulo de região), reconstruindo o alt-screen do MESMO jeito que a
// asserção (recorte ?1049h…?1049l + strip ANSI) — sem pyte (o runner não tem pyte); (3) só
// então um SETTLE curto e o SIGINT. Timeouts GENEROSOS, mas a barra é a CONDIÇÃO, não o
// tempo: máquina rápida termina rápido, runner lento ESPERA o que precisar — nunca corre com
// o boot. A asserção NÃO foi enfraquecida (continua exigindo >50 glifos + wordmark + régua +
// rótulo no alt-screen reconstruído); só deixamos a CAPTURA aguardar o frame existir.
//
// ESCOPO: só leitura de bytes do terminal; nenhuma chamada ao modelo (sessão idle, sem
// objetivo ⇒ o loop nem dispara). HOME isolado (tmpdir) ⇒ não toca o `~/.aluy/` do dev.

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
// Regex de limpeza ANSI/OSC montados via `new RegExp` (sem control-char LITERAL no fonte
// do regex ⇒ satisfaz `no-control-regex`, como app-cockpit/cockpit-bytes já fazem).
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC_RE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(${BEL}|${ESC}\\\\)`, 'g');
const ESC_RE = new RegExp(`${ESC}.`, 'g');

// Driver Python: fork PTY, fixa a janela (rows×cols), exec do binário e — em vez de drenar
// por um tempo FIXO — ESPERA POR CONDIÇÃO (anti-flake, ver cabeçalho): espera o `?1049h`
// (entrou no alt-screen) e, DEPOIS dele, espera os MARCADORES do cockpit aparecerem no
// alt-screen JÁ-RECONSTRUÍDO (recorte ?1049h…?1049l + strip ANSI, igual à asserção — sem
// pyte). Só então um SETTLE curto + SIGINT (produto restaura + sai), drena a restauração e
// dumpa os bytes CRUS em <out>. `markers` = TODOS os padrões que precisam estar visíveis
// (regex). `enter_to`/`paint_to` = TETOS generosos de espera (o gate real é a condição).
// Inline (string) p/ não depender de arquivo de fixture versionado.
function pyDriver(
  rows: number,
  cols: number,
  out: string,
  cmd: string[],
  markers: string[],
  enterTo: number,
  paintTo: number,
): string {
  return `
import os, sys, pty, select, struct, fcntl, termios, time, signal, re
rows, cols, out = ${rows}, ${cols}, ${JSON.stringify(out)}
cmd = ${JSON.stringify(cmd)}
markers = [re.compile(m) for m in ${JSON.stringify(markers)}]
enter_to, paint_to = ${enterTo}, ${paintTo}
ENTER = b"\\x1b[?1049h"
LEAVE = b"\\x1b[?1049l"
pid, fd = pty.fork()
if pid == 0:
    os.execvp(cmd[0], cmd); os._exit(127)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
buf = bytearray()
# strip ANSI/OSC/escapes ⇒ só os GLIFOS visíveis (mesma classe do stripAnsi do teste, p/
# casar a CONDIÇÃO de espera com a ASSERÇÃO; sem pyte, que o runner não tem).
_csi = re.compile(rb"\\x1b\\[[0-9;?]*[ -/]*[@-~]")
_osc = re.compile(rb"\\x1b\\][^\\x07\\x1b]*(\\x07|\\x1b\\\\)")
_esc = re.compile(rb"\\x1b.")
def pump(secs):
    # bombeia o PTY por até 'secs'; retorna assim que houver bytes novos (responsivo)
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
    # reconstrói o alt-screen do ÚLTIMO ?1049h ao ?1049l seguinte e tira o ANSI
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
# (1) espera ENTRAR no alt-screen (?1049h) — não corre com o boot.
waitfor(lambda: ENTER in buf, enter_to)
# (2) DEPOIS do ?1049h, espera os MARCADORES do cockpit PINTAREM no alt-screen reconstruído.
def painted():
    vis = alt_visible()
    return all(m.search(vis) for m in markers)
waitfor(painted, paint_to)
# (3) SETTLE curto: deixa o frame assentar (Ink coalesce) antes de medir/derrubar.
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

// MARCADORES do cockpit que a CAPTURA espera pintar antes de medir (regex Python). São um
// SUBCONJUNTO do que a asserção exige (wordmark + um rótulo de região) ⇒ esperar por eles
// garante que o frame existe sem acoplar a condição a cada glifo cobrado pelo assert.
const COCKPIT_MARKERS = ['luy', 'conversa|log'];

/** Roda o binário sob PTY (30×100, NO_COLOR) e devolve TODOS os bytes capturados. */
async function captureCockpit(): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), 'aluy-paint-'));
  const driver = join(dir, 'drive.py');
  const capture = join(dir, 'cap.bin');
  const home = mkdtempSync(join(tmpdir(), 'aluy-home-'));
  writeFileSync(
    driver,
    // espera-por-condição: até 12s p/ entrar no alt-screen, +12s p/ o cockpit PINTAR. Tetos
    // generosos (runner lento) — o gate é a condição, não o tempo; máquina rápida sai cedo.
    pyDriver(
      30,
      100,
      capture,
      [process.execPath, BIN, '--fullscreen', '--new'],
      COCKPIT_MARKERS,
      12,
      12,
    ),
  );
  // ── A CAUSA-RAIZ REAL (o porquê de 0 glifos na CI, não só timing) ────────────────────────
  // O Ink DESLIGA o loop de render quando detecta CI (via `is-in-ci`): com `CI` setado o
  // cockpit ENTRA no alt-screen (`?1049h`, escape NOSSO) mas o Ink NUNCA pinta frame ⇒ 0
  // glifos DETERMINÍSTICO na CI (a main estava VERMELHA desde que o teste entrou — não era
  // flake, era detecção-de-CI). Reproduzido 1:1 local: CI=true ⇒ 0 glifos/72 bytes; CI limpo
  // ⇒ 1134 glifos/4360 bytes. Aqui dirigimos um PTY REAL p/ provar "o cockpit PINTA num
  // terminal de verdade" — as vars de CI são ARTEFATO do host de teste, não do terminal do
  // usuário; as REMOVEMOS p/ o Ink renderizar como renderiza pro usuário. Não enfraquece nada.
  // A regra do `is-in-ci` é EXATAMENTE: CI∉{'0','false'} && ('CI'∈env || 'CONTINUOUS_INTEGRATION'
  // ∈env || alguma chave começa com 'CI_'). Espelhamos essa regra removendo TODAS essas marcas
  // (cobre GitHub Actions `CI`, GitLab `CI_*`, etc.) — robusto a qualquer host de CI.
  const scrubbedEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(scrubbedEnv)) {
    if (k === 'CI' || k === 'CONTINUOUS_INTEGRATION' || k.startsWith('CI_')) {
      delete scrubbedEnv[k];
    }
  }
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn('python3', [driver], {
      stdio: ['ignore', 'ignore', 'ignore'],
      // NO_COLOR ⇒ boot determinístico (sem a espera do OSC 11). HOME isolado. Sem marcas de
      // CI ⇒ o Ink PINTA (senão suprime o render e dá tela preta — a causa-raiz acima).
      // ALUY_FULLSCREEN=1 religa o cockpit (desativado p/ o usuário por default) p/ testar o render.
      env: { ...scrubbedEnv, HOME: home, NO_COLOR: '1', ALUY_TOKEN: '', ALUY_FULLSCREEN: '1' },
    });
    // Rede de segurança DURA: mata o driver se ele PENDURAR. Folgada o bastante p/ NÃO
    // cortar o caminho feliz LENTO (enter_to 12s + paint_to 12s + settle/SIGINT ~1.5s ≈ 25s
    // no pior caso de um runner saturado) — só dispara em travamento real, não em lentidão.
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error('PTY paint timeout'));
    }, 45000);
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(existsSync(capture) ? readFileSync(capture) : Buffer.alloc(0));
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

/** Tira ANSI/OSC/controle de uma string já decodificada ⇒ só os GLIFOS visíveis. */
function stripAnsi(s: string): string {
  return s.replace(CSI_RE, '').replace(OSC_RE, '').replace(ESC_RE, '');
}

describe.skipIf(!HAS_PY)('FIX #144 — o cockpit PINTA no alt-screen (PTY real)', () => {
  it('pré-condição: o binário foi compilado (dist)', () => {
    expect(existsSync(BIN), 'dist/bin/aluy.js ausente — rode `npm run build`').toBe(true);
  });

  it('após ?1049h o alt-screen contém os GLIFOS do cockpit (não só escapes ⇒ não é tela preta)', async () => {
    const raw = await captureCockpit();
    const text = raw.toString('latin1'); // p/ achar os escapes byte-a-byte
    // entrou no alt-screen…
    expect(text.includes(ENTER), 'o cockpit não emitiu ?1049h (não entrou no alt-screen)').toBe(
      true,
    );
    // …e RESTAUROU ao sair (não regride o invariante §2: ?1049l em todo caminho de saída).
    expect(text.includes(LEAVE), 'o ?1049l (restauração) sumiu — regressão do §2').toBe(true);

    // recorta os bytes DENTRO do alt-screen (do ÚLTIMO ?1049h ao ?1049l seguinte). Em
    // latin1 cada byte é 1 char ⇒ os índices casam byte-a-byte; recortamos no Buffer e
    // RE-decodificamos o pedaço como UTF-8 (a TUI é UTF-8) p/ os glifos (›/─/Λ) sobreviverem.
    const ent = text.lastIndexOf(ENTER);
    const altStart = ent + ENTER.length;
    const lv = text.indexOf(LEAVE, altStart);
    const altEnd = lv === -1 ? raw.length : lv;
    const alt = raw.subarray(altStart, altEnd);

    const visible = stripAnsi(alt.toString('utf8'));
    const glyphs = [...visible].filter((c) => c.trim() !== '').length;

    // O CRITÉRIO OBJETIVO do DoD: há conteúdo VISÍVEL pintado no alt-screen — não só
    // `?1049h` seguido de vazio (a "tela preta" do bug, que dava ~0 glifos aqui).
    expect(
      glyphs,
      `alt-screen quase vazio (${glyphs} glifos) — tela preta do #144`,
    ).toBeGreaterThan(50);
    // E são os glifos DO COCKPIT: wordmark, régua entre regiões, rótulo de região, hints.
    expect(visible.includes('luy'), 'sem o wordmark Λluy no alt-screen').toBe(true);
    expect(visible.includes('─'), 'sem a régua das regiões no alt-screen').toBe(true);
    expect(
      visible.toLowerCase().includes('conversa') || visible.toLowerCase().includes('log'),
      'sem rótulo de região (conversa/log) no alt-screen',
    ).toBe(true);
  }, 50000);
});

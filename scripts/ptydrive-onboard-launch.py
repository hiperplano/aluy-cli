#!/usr/bin/env python3
# F-ONB — prova em TTY REAL de que `aluy onboard` CUMPRE o `enter p/ entrar no aluy` da
# tela final, e que as três teclas têm intenções DISTINTAS.
#
# O bug (dogfood do Tiago: "quando rodo o aluy onboard, ele não abre no final"): no passo
# `done` o handler era `if (key.return || key.escape || input) app.exit()` — Enter, Esc e
# QUALQUER tecla só fechavam o Ink, o processo morria e a sessão nunca abria. A tela
# prometia abrir; nada abria. E não havia como recusar.
#
# Roda com HOME FALSO: o onboard ESCREVE config (`~/.aluy/config.json`), então jamais
# apontar p/ o HOME real. Não precisa de credencial nem de rede: a prova é o HANDOFF
# (aparece o splash da sessão), não um turno completo.
import os, pty, select, time, re, sys, shutil, tempfile, fcntl, termios, struct

ALUY = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "packages/cli/dist/bin/aluy.js")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-B]")
DONE = "enter p/ entrar no aluy"
SPLASH = "aquecendo"  # marca do splash da SESSÃO (o handoff)


def strip(b):
    return ANSI.sub(b"", b).decode("utf-8", "replace")


def spawn(home):
    pid, fd = pty.fork()
    if pid == 0:
        os.environ["HOME"] = home
        os.environ["TERM"] = "xterm-256color"
        os.environ["LANG"] = "pt_BR.UTF-8"
        os.chdir(tempfile.gettempdir())
        os.execvp("node", ["node", ALUY, "onboard"])
        os._exit(127)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    return pid, fd


class Session:
    def __init__(self, home):
        self.pid, self.fd = spawn(home)
        self.buf = b""

    def drain(self, t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.05)
            if r:
                try:
                    c = os.read(self.fd, 65536)
                except OSError:
                    return
                if not c:
                    return
                self.buf += c

    def to_done(self):
        """Aceita os defaults de cada passo até a tela final."""
        self.drain(3.0)
        for _ in range(8):
            if DONE in strip(self.buf):
                return True
            os.write(self.fd, b"\r")
            time.sleep(0.3)
            self.drain(1.5)
        return DONE in strip(self.buf)

    def press(self, keys, wait=3.0):
        mark = len(self.buf)
        os.write(self.fd, keys)
        self.drain(wait)
        return strip(self.buf[mark:])

    def close(self):
        try:
            os.write(self.fd, b"\x03")
            os.close(self.fd)
        except OSError:
            pass
        try:
            os.waitpid(self.pid, os.WNOHANG)
        except OSError:
            pass


ok = True


def check(label, cond):
    global ok
    ok = ok and cond
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}")


print("PTY onboard → launch — prova (TTY real, HOME falso):")
root = tempfile.mkdtemp(prefix="aluy-onb-")
try:
    # ── caso 1: ENTER abre a sessão ────────────────────────────────────────────────
    h1 = os.path.join(root, "h1")
    os.makedirs(h1)
    s1 = Session(h1)
    reached = s1.to_done()
    check("o onboard chega na tela final", reached)
    stray = s1.press(b"x", 1.5)
    check("tecla SOLTA não abre nem encerra (antes: qualquer tecla saía)", SPLASH not in stray)
    after_enter = s1.press(b"\r", 4.0)
    check("ENTER faz o handoff p/ a sessão (o splash aparece)", SPLASH in after_enter)
    s1.close()

    # ── caso 2: ESC recusa ────────────────────────────────────────────────────────
    h2 = os.path.join(root, "h2")
    os.makedirs(h2)
    s2 = Session(h2)
    check("o onboard chega na tela final (2º caso)", s2.to_done())
    after_esc = s2.press(b"\x1b", 3.0)
    check("ESC NÃO abre a sessão (recusa explícita)", SPLASH not in after_esc)
    s2.close()
finally:
    shutil.rmtree(root, ignore_errors=True)

print(f"\n{'PROVA OK' if ok else 'PROVA FALHOU'}")
sys.exit(0 if ok else 1)

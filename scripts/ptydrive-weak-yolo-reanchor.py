#!/usr/bin/env python3
# F21-bis — DIRIGE o harness `pty-weak-yolo-reanchor.mjs` num PTY REAL e prova que o
# reforço `FRONTEIRA DE DADOS` entra UMA vez por SESSÃO, não a cada turno.
#
# O bug (dogfood do Tiago: "toda hora aparece FRONTEIRA DE DADOS"): o one-shot do
# guardrail era uma variável LOCAL do `runLoop` ⇒ one-shot POR EXECUÇÃO. A TUI faz UM
# `run`/`resume` POR TURNO, então a flag renascia `false` a cada turno e os reforços
# ACUMULAVAM no histórico re-semeado (turno N com N cópias).
#
# Digita EM LOTE (texto + Enter GRUDADO num único write) — a técnica do
# `ptydrive-type-ahead.py`, que é o caso xrdp/SSH e o único que o composer aceita.
import os, pty, select, time, re, sys, fcntl, termios, struct

HARNESS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pty-weak-yolo-reanchor.mjs")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-B]")
TURNS = ["leia dados.txt", "e agora resuma", "confirme o resumo"]


def strip(b):
    return ANSI.sub(b"", b).decode("utf-8", "replace")


pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.environ["LANG"] = "en_US.UTF-8"
    os.execvp("node", ["node", HARNESS])
    os._exit(127)

fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

buf = b""


def drain(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk


# 1) espera o harness montar
drain(1.5)
deadline = time.time() + 20
while "__READY__" not in strip(buf) and time.time() < deadline:
    drain(0.3)

marks = []  # (turno, [contagens de reanchor observadas nas chamadas daquele turno])
for i, goal in enumerate(TURNS, 1):
    before = len(buf)
    os.write(fd, goal.encode("utf-8") + b"\r")  # LOTE: texto + Enter num único write
    # cada turno = 2 chamadas ao modelo (tool-call + final); espera as duas
    end = time.time() + 12
    while time.time() < end:
        drain(0.3)
        seg = strip(buf[before:])
        if len(re.findall(r"__REANCHOR__ call=\d+ n=\d+", seg)) >= 2:
            break
    seg = strip(buf[before:])
    counts = [int(m) for m in re.findall(r"__REANCHOR__ call=\d+ n=(\d+)", seg)]
    typed_ok = goal in seg
    marks.append((i, counts, typed_ok))
    print(f"  turno {i}: reanchor por chamada = {counts} · texto digitado apareceu = {typed_ok}")

drain(0.5)
final = strip(buf)
try:
    os.write(fd, b"\x03")
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass

print("\nPTY weak-yolo reanchor — prova (TTY real, input EM LOTE):")
ok = True


def check(label, cond):
    global ok
    ok = ok and cond
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}")


all_counts = [c for _, cs, _ in marks for c in cs]
check("o harness dirigiu 3 turnos (2 chamadas cada)", sum(len(cs) for _, cs, _ in marks) >= 6)
check("o texto digitado chegou ao composer nos 3 turnos", all(t for _, _, t in marks))
check("turno 1 comeca SEM reforco no prompt (nada a reancorar ainda)", marks[0][1][:1] == [0])
check("o reforco ENTRA (o guardrail dispara de fato)", max(all_counts) >= 1)
check("NUNCA acumula: nenhum prompt levou 2+ copias", max(all_counts) <= 1)
check("turno 3 ainda com no maximo 1 copia (one-shot de SESSAO)", max(marks[2][1]) <= 1)
check("a TUI nao renderiza o reforco (nao vaza p/ a tela)", "FRONTEIRA DE DADOS" not in final)

print(f"\n{'PROVA OK' if ok else 'PROVA FALHOU'}")
sys.exit(0 if ok else 1)

#!/usr/bin/env python3
# EST-0948 — DIRIGE o harness Ink num PTY REAL, escrevendo CHAR-A-CHAR (um byte por
# write, com atraso), com o Enter (\r) num write SEPARADO. É exatamente o caminho onde
# o bug vivia (NÃO um write em lote com \r grudado). Para cada caso imprime se o handler
# recebeu o comando (__CMD__) com os args certos.
import os, pty, select, time, sys, re

HARNESS = os.path.join(os.path.dirname(__file__), "ptyharness-slashargs.mjs")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]")

def strip(b): return ANSI.sub(b"", b).decode("utf-8", "replace")

def run_case(label, keys, expect_cmd):
    pid, fd = pty.fork()
    if pid == 0:  # child: real TTY on stdin/stdout
        os.execvp("node", ["node", HARNESS])
        os._exit(127)
    buf = b""
    def drain(t=0.25):
        nonlocal buf
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try: buf += os.read(fd, 65536)
                except OSError: break
    drain(0.6)  # boot + composer ready
    # type CHAR-A-CHAR: one byte per write, separate writes, with a gap.
    for ch in keys:
        os.write(fd, ch.encode("utf-8"))
        time.sleep(0.05)
        drain(0.04)
    # ENTER as its OWN separate write (the crux: does the menu eat it, or submit?).
    time.sleep(0.05)
    os.write(fd, b"\r")
    drain(0.5)
    text = strip(buf)
    got = None
    m = re.search(r"__CMD__ id=(\S+) args=(.*)", text)
    if m:
        got = (m.group(1), m.group(2).strip())
    os.write(fd, b"\x03")  # ctrl-c to quit
    try: os.close(fd)
    except OSError: pass
    try: os.waitpid(pid, 0)
    except OSError: pass

    ok = (got == expect_cmd) if expect_cmd is not None else (got is None)
    print(f"[{'PASS' if ok else 'FAIL'}] {label}")
    print(f"        digitado (char-a-char): {keys!r} + <Enter separado>")
    print(f"        handler recebeu       : {got}")
    print(f"        esperado              : {expect_cmd}")
    # menu state hint from last frame
    menu = "enter executa · esc fecha" in text
    print(f"        (slash-menu visível no fim do frame: {menu})")
    return ok

cases = [
    # REPRO DO BUG: slash COM args digitado char-a-char + Enter ⇒ submete COM args.
    ("/cycle --max-iter 2 responda OK  (com args)", "/cycle --max-iter 2 responda OK", ("cycle", '"--max-iter 2 responda OK"')),
    # /cycle sozinho ⇒ menu confirma seleção, args vazios.
    ("/cycle  (sozinho)", "/cycle", ("cycle", '""')),
    # sem teto, mas COM args ⇒ chega ao handler (recusa é downstream).
    ("/cycle rode pra sempre  (sem teto, com args)", "/cycle rode pra sempre", ("cycle", '"rode pra sempre"')),
    # /memory editar <id> texto.
    ("/memory editar abc texto novo", "/memory editar abc texto novo", ("memory", '"editar abc texto novo"')),
]

allok = True
for label, keys, exp in cases:
    allok = run_case(label, keys, exp) and allok
    print()

sys.exit(0 if allok else 1)

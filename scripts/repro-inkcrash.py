#!/usr/bin/env python3
# DIRIGE o harness `repro-inkcrash.mjs` num PTY REAL e escreve a sequência CSI-u de tecla
# FUNCIONAL (`\x1b[57414u`, kitty kbd proto) no stdin do filho — o caminho EXATO do crash.
# O harness escreve marcadores num ARQUIVO de log (REPRO_LOG) p/ não disputar com o repaint
# do Ink no stdout. Lemos esse log: BOOT / ALIVE n / INKCRASH / EXIT code ⇒ VIVO ou MORTO.
#
# Uso: GUARD=off python3 scripts/repro-inkcrash.py   (baseline: deve crashar)
#      python3 scripts/repro-inkcrash.py             (fix:      deve sobreviver)
import os, pty, select, time, sys, re, tempfile

HARNESS = os.path.join(os.path.dirname(__file__), "repro-inkcrash.mjs")
SEQ = b"\x1b[57414u"  # CSI 57414 u — kitty functional key (o byte que crasha o Ink)
NODE = os.environ.get("NODE_BIN", "node")


def run():
    logf = tempfile.NamedTemporaryFile(prefix="repro-inkcrash-", suffix=".log", delete=False)
    logpath = logf.name
    logf.close()
    open(logpath, "w").close()  # zera

    pid, fd = pty.fork()
    if pid == 0:  # filho: TTY real no stdin/stdout
        os.environ["REPRO_LOG"] = logpath
        os.execvp(NODE, [NODE, HARNESS])
        os._exit(127)

    def read_log():
        try:
            with open(logpath) as f:
                return f.read()
        except OSError:
            return ""

    def drain_pty(t):
        end = time.time() + t
        while time.time() < end:
            r, _, _ = select.select([fd], [], [], 0.05)
            if r:
                try:
                    os.read(fd, 65536)
                except OSError:
                    return

    # 1) espera o boot (marcador BOOT no log).
    booted = False
    end = time.time() + 3.0
    while time.time() < end:
        drain_pty(0.1)
        if "BOOT" in read_log():
            booted = True
            break
    print(f"[boot]    montou (marcador BOOT): {booted}")

    log_before = read_log()
    ticks_before = len(re.findall(r"ALIVE \d+", log_before))

    # 2) ENVIA a sequência perigosa pelo PTY real (vai pro stdin do Ink).
    os.write(fd, SEQ)
    print(f"[send]    sequencia escrita no PTY: {SEQ!r}")

    # 3) observa ~2s: VIVO (heartbeats novos) ou MORTO (crash)?
    drain_pty(2.0)
    log_after = read_log()

    crashed = "INKCRASH" in log_after
    ticks_after_total = len(re.findall(r"ALIVE \d+", log_after))
    new_ticks = ticks_after_total - ticks_before

    # 4) colhe o exit-code do filho.
    try:
        os.close(fd)
    except OSError:
        pass
    code = None
    try:
        _, status = os.waitpid(pid, 0)
        code = os.waitstatus_to_exitcode(status)
    except OSError:
        pass

    m = re.search(r"INKCRASH (.*)", log_after)
    if m:
        print(f"[crash]   mensagem: {m.group(1).strip()}")
    print(f"[observe] heartbeats ALIVE NOVOS apos a sequencia: {new_ticks}")
    print(f"[observe] INKCRASH no log: {crashed}")
    print(f"[observe] exit-code do filho: {code}")
    print(f"[observe] log final: {read_log().strip().splitlines()[-4:]!r}")

    try:
        os.unlink(logpath)
    except OSError:
        pass

    survived = (not crashed) and new_ticks >= 1
    print()
    print("RESULTADO:", "SOBREVIVEU (fix OK)" if survived else "CRASHOU/MORREU (baseline)")
    return 0 if survived else 1


if __name__ == "__main__":
    sys.exit(run())

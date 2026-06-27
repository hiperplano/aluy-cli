#!/usr/bin/env python3
# EST-0982 (type-ahead) — DIRIGE o harness Ink num PTY REAL. Enquanto o agente
# "trabalha" (streaming mock), digita EM LOTE (texto + Enter num ÚNICO write — o caso
# xrdp/SSH que ENGOLE o Enter se mal tratado) e PROVA:
#   (1) a mensagem entra na FILA (o frame mostra "na fila" + o texto enfileirado);
#   (2) o trabalho NÃO foi interrompido (a fase segue streaming — nunca volta a idle);
#   (3) ao terminar o turno, a fila AUTO-SUBMETE (novo streaming) — a fila some.
import os, pty, select, time, sys, re

HARNESS = os.path.join(os.path.dirname(__file__), "pty-type-ahead.mjs")
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]")


def strip(b):
    return ANSI.sub(b"", b).decode("utf-8", "replace")


pid, fd = pty.fork()
if pid == 0:  # filho: TTY real em stdin/stdout
    os.execvp("node", ["node", HARNESS])
    os._exit(127)

buf = b""


def drain(t):
    global buf
    end = time.time() + t
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if r:
            try:
                buf += os.read(fd, 65536)
            except OSError:
                break


# 1) Deixa o boot + o 1º render assentarem e o stream COMEÇAR (espera o streaming).
drain(1.0)
while "streaming" not in re.findall(r"__PHASE__ (\w+)", strip(buf)):
    drain(0.3)
    if time.time() > 0 and len(buf) > 4_000_000:
        break
buf_at_streaming = buf  # marca: daqui pra frente NÃO pode aparecer idle (=interrupção)

# 2) Digita EM LOTE (texto + Enter GRUDADO num único write) — o caso xrdp.
os.write(fd, b"minha proxima ideia\r")
drain(0.6)
frame_after_enqueue = strip(buf)

# 3) Mais uma na fila (FIFO).
os.write(fd, b"segunda tarefa\r")
drain(0.6)
frame_two = strip(buf)

# As fases EMITIDAS desde que o streaming começou (p/ o teste de não-interrupção):
phases_since_streaming = re.findall(r"__PHASE__ (\w+)", strip(buf[len(buf_at_streaming):]))

# 4) Espera o 1º turno terminar + o auto-submit consumir a fila (próximo turno).
drain(3.2)
final = strip(buf)

os.write(fd, b"\x03")  # ctrl-c p/ encerrar
try:
    os.close(fd)
except OSError:
    pass
try:
    os.waitpid(pid, 0)
except OSError:
    pass

allphases = re.findall(r"__PHASE__ (\w+)", final)

# ── asserções da prova ───────────────────────────────────────────────────────────
ok = True


def check(label, cond):
    global ok
    ok = ok and cond
    print(f"  [{'PASS' if cond else 'FAIL'}] {label}")


print("PTY type-ahead — prova (TTY real, input EM LOTE):")
check("entrou em streaming (trabalhando)", "streaming" in allphases)
check("a mensagem digitada aparece no frame", "minha proxima ideia" in frame_after_enqueue)
check("o chrome da FILA aparece ('na fila')", "na fila" in frame_after_enqueue)
check("a 2ª mensagem também enfileira ('segunda tarefa')", "segunda tarefa" in frame_two)
check("mostra '2 na fila' (FIFO acumula)", "2 na fila" in frame_two)
# NÃO interrompeu: DESDE que o streaming começou e enquanto digitávamos, a fase nunca
# caiu p/ idle (um interrupt/esc levaria a idle). O idle INICIAL (pré-submit) é excluído.
no_idle_while_typing = "idle" not in phases_since_streaming
check("NÃO interrompeu enquanto digitava (sem voltar a idle)", no_idle_while_typing)
# auto-submit: depois do turno, houve um SEGUNDO streaming (a fila virou objetivo).
streaming_count = allphases.count("streaming")
check("auto-submit: um 2º streaming após o turno (fila consumida)", streaming_count >= 2)

print(f"\n  fases observadas: {allphases}")
print("\n  --- recorte do frame com a fila ---")
for l in frame_two.split("\n"):
    if re.search(r"na fila|minha proxima|segunda tarefa|^\s*›|objetivo inicial", l):
        ls = l.rstrip()
        if ls.strip():
            print("   |", ls)

sys.exit(0 if ok else 1)

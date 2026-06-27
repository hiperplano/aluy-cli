// EST-1009 · ADR-0065 §1 / CLI-SEC-H1 — POLÍTICA seccomp-bpf (geração PURA do filtro).
//
// O sandbox confina o FS por mount namespace e a rede por net namespace, mas um
// sub-processo confinado ainda poderia, via SYSCALL, tentar RE-CRIAR um namespace
// (escapar do confinamento), remontar FS, ou LER A MEMÓRIA DA MÃE. O filtro
// seccomp-bpf NEGA o conjunto perigoso de syscalls com EPERM, DENTRO do namespace
// já confinado (defesa em profundidade no eixo de syscalls — alt. D do ADR,
// adotada EM COMBINAÇÃO com mount/net namespace).
//
// Critério (c) do gate `seguranca`: NEGAR `unshare`, `setns`, `mount`,
// `pivot_root`, `ptrace`, `process_vm_readv`, `keyctl` (senão o filho re-cria
// namespace, remonta, ou lê a memória da mãe). Cada um DEVE falhar com EPERM.
//
// ESTE MÓDULO É PURO E PORTÁVEL: gera o PROGRAMA BPF (bytes) que o lançador
// concreto (`@hiperplano/aluy-cli`) entrega ao `bwrap --seccomp <fd>`. Não toca o SO; é
// determinístico e testável byte-a-byte. A aplicação (instalar o filtro / passar
// o fd) é do locus concreto.
//
// Estrutura do filtro (clássica, validada contra `bwrap --seccomp`):
//   1. carrega `arch` de seccomp_data; se != arch-alvo ⇒ KILL_PROCESS (anti-bypass
//      por ABI x32/i386 — um syscall com o MESMO número em outra ABI faria coisa
//      diferente; matar é a postura segura recomendada pelo kernel).
//   2. carrega `nr` (número do syscall); para cada syscall NEGADO ⇒ RET ERRNO(EPERM).
//   3. default ⇒ RET ALLOW (o sandbox já confina FS/rede; aqui só barramos o
//      conjunto de fuga/leitura-de-memória — não é um allowlist-total, que
//      quebraria binários legítimos do usuário).

/** Um `sock_filter` BPF: { u16 code; u8 jt; u8 jf; u32 k } = 8 bytes LE. */
interface SockFilter {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
}

// ── opcodes BPF clássico (uapi/linux/bpf_common.h + filter.h) ────────────────
const BPF_LD = 0x00;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JMP = 0x05;
const BPF_JEQ = 0x10;
const BPF_K = 0x00;
const BPF_RET = 0x06;

// ── offsets em `struct seccomp_data` (uapi/linux/seccomp.h) ──────────────────
//   int nr; __u32 arch; __u64 instruction_pointer; __u64 args[6];
const OFF_NR = 0;
const OFF_ARCH = 4;

// ── ações SECCOMP_RET_* (uapi/linux/seccomp.h) ───────────────────────────────
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_DATA = 0x0000ffff; // máscara dos 16 bits baixos (errno)

/** AUDIT_ARCH_* (uapi/linux/audit.h) — identifica a ABI em `seccomp_data.arch`. */
export const AUDIT_ARCH = Object.freeze({
  x86_64: 0xc000003e,
  aarch64: 0xc00000b7,
} as const);

export type SeccompArch = keyof typeof AUDIT_ARCH;

const EPERM = 1;

/**
 * NÚMEROS de syscall por arquitetura, SÓ dos que negamos. Os números são estáveis
 * por ABI (uapi). Mantemos o conjunto MÍNIMO e EXATO do critério (c) do gate.
 *
 * - `unshare`/`setns`: criar/entrar em namespace ⇒ escapar do confinamento.
 * - `mount`/`pivot_root`: remontar/trocar a raiz ⇒ furar a fronteira de FS.
 * - `ptrace`/`process_vm_readv`/`process_vm_writev`: LER **ou ESCREVER** a memória de
 *   outro processo (a MÃE = TCB, ou um irmão confinado). `ptrace` já cobre leitura E
 *   escrita; `process_vm_readv` é o caminho de LEITURA sem ptrace e `process_vm_writev`
 *   o de ESCRITA sem ptrace — negar um sem o outro deixa metade do vetor de adulteração
 *   de memória aberto (injeção no TCB/irmão). Negamos os DOIS, por simetria.
 * - `keyctl`: mexer no keyring do kernel (credenciais/keys da sessão do usuário).
 */
const DENIED_SYSCALLS: Record<SeccompArch, Readonly<Record<string, number>>> = {
  x86_64: Object.freeze({
    unshare: 272,
    setns: 308,
    mount: 165,
    pivot_root: 155,
    ptrace: 101,
    process_vm_readv: 310,
    process_vm_writev: 311,
    keyctl: 250,
  }),
  aarch64: Object.freeze({
    unshare: 97,
    setns: 268,
    mount: 40,
    pivot_root: 41,
    ptrace: 117,
    process_vm_readv: 270,
    process_vm_writev: 271,
    keyctl: 219,
  }),
};

/** Os NOMES dos syscalls negados (p/ o teste/`/doctor` enumerarem o conjunto). */
export const DENIED_SYSCALL_NAMES: readonly string[] = Object.freeze([
  'unshare',
  'setns',
  'mount',
  'pivot_root',
  'ptrace',
  'process_vm_readv',
  'process_vm_writev',
  'keyctl',
]);

/** Mapa arch-do-Node (`process.arch`) → arch-do-seccomp suportado. */
export function seccompArchOf(nodeArch: string): SeccompArch | undefined {
  if (nodeArch === 'x64') return 'x86_64';
  if (nodeArch === 'arm64') return 'aarch64';
  return undefined;
}

function stmt(code: number, k: number): SockFilter {
  return { code, jt: 0, jf: 0, k: k >>> 0 };
}
function jump(code: number, k: number, jt: number, jf: number): SockFilter {
  return { code, jt, jf, k: k >>> 0 };
}

/**
 * MONTA o programa BPF (lista de `sock_filter`) p/ negar o conjunto perigoso na
 * arch dada. PURO. A lista é o que o lançador serializa e entrega ao kernel via
 * `bwrap --seccomp`.
 */
export function buildSeccompProgram(arch: SeccompArch): readonly SockFilter[] {
  const archId = AUDIT_ARCH[arch];
  const denied = DENIED_SYSCALLS[arch];
  const prog: SockFilter[] = [];

  // 1. valida a ABI: carrega arch; se == alvo, pula o KILL; senão MATA o processo
  //    (postura segura do kernel contra bypass por número de syscall de outra ABI).
  prog.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_ARCH));
  prog.push(jump(BPF_JMP | BPF_JEQ | BPF_K, archId, 1, 0));
  prog.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS));

  // 2. carrega o nº do syscall; p/ cada negado, se igual ⇒ ERRNO(EPERM).
  prog.push(stmt(BPF_LD | BPF_W | BPF_ABS, OFF_NR));
  for (const nr of Object.values(denied)) {
    // se nr == este ⇒ cai na PRÓXIMA instrução (ERRNO); senão pula-a (jf:1).
    prog.push(jump(BPF_JMP | BPF_JEQ | BPF_K, nr, 0, 1));
    prog.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)));
  }

  // 3. default: ALLOW (o confinamento de FS/rede já é dos namespaces; aqui só
  //    barramos o conjunto de fuga/leitura-de-memória — não um allowlist-total).
  prog.push(stmt(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

  return prog;
}

/**
 * SERIALIZA o programa em bytes (cada `sock_filter` = 8 bytes little-endian:
 * u16 code, u8 jt, u8 jf, u32 k). É EXATAMENTE o que `struct sock_fprog.filter`
 * espera e o que o `bwrap --seccomp <fd>` lê do fd. PURO.
 */
export function serializeSeccompProgram(prog: readonly SockFilter[]): Buffer {
  const buf = Buffer.allocUnsafe(prog.length * 8);
  let off = 0;
  for (const insn of prog) {
    buf.writeUInt16LE(insn.code & 0xffff, off);
    buf.writeUInt8(insn.jt & 0xff, off + 2);
    buf.writeUInt8(insn.jf & 0xff, off + 3);
    buf.writeUInt32LE(insn.k >>> 0, off + 4);
    off += 8;
  }
  return buf;
}

/**
 * Conveniência: o programa serializado p/ a arch do Node corrente (ou `undefined`
 * se a arch não é suportada — o lançador então degrada/avisa, sem fingir filtro).
 */
export function seccompFilterBytes(nodeArch: string): Buffer | undefined {
  const arch = seccompArchOf(nodeArch);
  if (!arch) return undefined;
  return serializeSeccompProgram(buildSeccompProgram(arch));
}

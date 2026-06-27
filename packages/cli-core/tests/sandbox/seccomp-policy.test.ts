// EST-1009 · ADR-0065 §1 / CLI-SEC-H1 — POLÍTICA seccomp-bpf (geração PURA do filtro).
//
// Critério (c): o filtro NEGA `unshare`/`setns`/`mount`/`pivot_root`/`ptrace`/
// `process_vm_readv`/`process_vm_writev`/`keyctl`. Aqui provamos a GERAÇÃO
// (estrutura/bytes do BPF) — a prova de SO (EPERM real dentro do bwrap) está em
// packages/cli (integração).

import { describe, expect, it } from 'vitest';
import {
  AUDIT_ARCH,
  DENIED_SYSCALL_NAMES,
  buildSeccompProgram,
  seccompArchOf,
  seccompFilterBytes,
  serializeSeccompProgram,
} from '../../src/index.js';

// Números de syscall (uapi) p/ x86_64 — DEVEM bater com os do filtro.
const X64_NR: Record<string, number> = {
  unshare: 272,
  setns: 308,
  mount: 165,
  pivot_root: 155,
  ptrace: 101,
  process_vm_readv: 310,
  process_vm_writev: 311,
  keyctl: 250,
};

// Opcodes/constantes que o filtro usa (espelham o módulo, p/ a asserção ser real).
const BPF_RET = 0x06;
const BPF_K = 0x00;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const EPERM = 1;

describe('seccompArchOf — mapeia a arch do Node ⇒ seccomp', () => {
  it('x64 ⇒ x86_64; arm64 ⇒ aarch64; o resto ⇒ undefined (NÃO finge filtro)', () => {
    expect(seccompArchOf('x64')).toBe('x86_64');
    expect(seccompArchOf('arm64')).toBe('aarch64');
    expect(seccompArchOf('ia32')).toBeUndefined();
    expect(seccompArchOf('mips')).toBeUndefined();
  });
});

describe('buildSeccompProgram (x86_64) — nega o conjunto perigoso (c)', () => {
  const prog = buildSeccompProgram('x86_64');

  it('valida a ABI primeiro (KILL_PROCESS se arch != alvo — anti-bypass x32/i386)', () => {
    // 1ª instrução carrega arch; a 3ª (índice 2) é o RET KILL se a arch não bate.
    const killInsn = prog[2]!;
    expect(killInsn.code).toBe(BPF_RET | BPF_K);
    expect(killInsn.k >>> 0).toBe(SECCOMP_RET_KILL_PROCESS >>> 0);
  });

  it('contém um RET ERRNO(EPERM) p/ CADA syscall negado, e o nº correto', () => {
    // Para cada syscall negado, deve existir um par (JEQ nr) seguido de RET ERRNO.
    for (const [name, nr] of Object.entries(X64_NR)) {
      const jeqIdx = prog.findIndex((i) => (i.code & 0x07) === 0x05 && i.k === nr);
      expect(jeqIdx, `JEQ p/ ${name} (nr ${nr}) ausente`).toBeGreaterThanOrEqual(0);
      const next = prog[jeqIdx + 1]!;
      expect(next.code, `${name}: instrução seguinte deve ser RET`).toBe(BPF_RET | BPF_K);
      expect(next.k >>> 0, `${name}: deve retornar ERRNO(EPERM)`).toBe(
        (SECCOMP_RET_ERRNO | EPERM) >>> 0,
      );
    }
  });

  it('termina em RET ALLOW (default: não é allowlist-total — não quebra binários)', () => {
    const last = prog[prog.length - 1]!;
    expect(last.code).toBe(BPF_RET | BPF_K);
    expect(last.k >>> 0).toBe(SECCOMP_RET_ALLOW >>> 0);
  });

  it('cobre EXATAMENTE os 8 syscalls do critério (c) — nem mais, nem menos', () => {
    const errnoRets = prog.filter(
      (i) => i.code === (BPF_RET | BPF_K) && i.k >>> 0 === (SECCOMP_RET_ERRNO | EPERM) >>> 0,
    );
    expect(errnoRets).toHaveLength(8);
    expect([...DENIED_SYSCALL_NAMES].sort()).toEqual(
      [
        'keyctl',
        'mount',
        'pivot_root',
        'process_vm_readv',
        'process_vm_writev',
        'ptrace',
        'setns',
        'unshare',
      ].sort(),
    );
  });
});

describe('serializeSeccompProgram — 8 bytes LE por instrução (sock_filter)', () => {
  it('serializa { u16 code; u8 jt; u8 jf; u32 k } little-endian', () => {
    const prog = buildSeccompProgram('x86_64');
    const buf = serializeSeccompProgram(prog);
    expect(buf.length).toBe(prog.length * 8);
    // Confere a 1ª instrução byte-a-byte.
    const i0 = prog[0]!;
    expect(buf.readUInt16LE(0)).toBe(i0.code & 0xffff);
    expect(buf.readUInt8(2)).toBe(i0.jt & 0xff);
    expect(buf.readUInt8(3)).toBe(i0.jf & 0xff);
    expect(buf.readUInt32LE(4)).toBe(i0.k >>> 0);
  });

  it('aarch64 também gera um filtro válido (multi-arch)', () => {
    const prog = buildSeccompProgram('aarch64');
    // valida a ABI da aarch64.
    expect(prog[1]!.k >>> 0).toBe(AUDIT_ARCH.aarch64 >>> 0);
    const buf = serializeSeccompProgram(prog);
    expect(buf.length).toBe(prog.length * 8);
  });
});

describe('seccompFilterBytes — bytes prontos p/ a arch do Node (ou undefined)', () => {
  it('x64 ⇒ Buffer não-vazio; arch desconhecida ⇒ undefined (não finge)', () => {
    const x = seccompFilterBytes('x64');
    expect(x).toBeInstanceOf(Buffer);
    expect((x as Buffer).length).toBeGreaterThan(0);
    expect(seccompFilterBytes('ia32')).toBeUndefined();
  });
});

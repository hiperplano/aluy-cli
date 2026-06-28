import { describe, expect, it } from 'vitest';
import { runUninstall } from '../../src/commands/uninstall.js';
import type { TerminalIO } from '../../src/auth/io.js';

function fakeIO() {
  const out: string[] = [];
  const err: string[] = [];
  const io: TerminalIO = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    prompt: async () => '',
  };
  return { io, out, err };
}

const BASE = '/tmp/__aluy_uninstall_test';

describe('runUninstall — remove os complementos gerenciados (~/.aluy)', () => {
  it('remove os dirs que existem (mem-venv/hr-venv/ollama) e reporta', () => {
    const removed: string[] = [];
    const present = new Set([`${BASE}/mem-venv`, `${BASE}/hr-venv`, `${BASE}/ollama`]);
    const { io, out } = fakeIO();
    const code = runUninstall(
      {},
      {
        io,
        baseDir: BASE,
        exists: (p) => present.has(p),
        remove: (p) => removed.push(p),
      },
    );
    expect(code).toBe(0);
    expect(removed.sort()).toEqual([`${BASE}/hr-venv`, `${BASE}/mem-venv`, `${BASE}/ollama`]);
    expect(out.join('\n')).toMatch(/mem0.*removido/);
    expect(out.join('\n')).toMatch(/headroom.*removido/);
  });

  it('idempotente: dir ausente ⇒ "não estava instalado", não tenta remover, exit 0', () => {
    const removed: string[] = [];
    const { io, out } = fakeIO();
    const code = runUninstall(
      {},
      { io, baseDir: BASE, exists: () => false, remove: (p) => removed.push(p) },
    );
    expect(code).toBe(0);
    expect(removed).toEqual([]);
    expect(out.join('\n')).toMatch(/não estava instalado/);
  });

  it('falha ao remover um dir ⇒ erro reportado, segue os outros (não quebra)', () => {
    const { io, err } = fakeIO();
    const code = runUninstall(
      {},
      {
        io,
        baseDir: BASE,
        exists: () => true,
        remove: (p) => {
          if (p.endsWith('mem-venv')) throw new Error('EACCES');
        },
      },
    );
    expect(code).toBe(0); // idempotente/best-effort
    expect(err.join('\n')).toMatch(/mem0.*falha/);
  });

  it('sem --agent ⇒ aponta que o ollama de SISTEMA continua (instrui --agent)', () => {
    const { io, out } = fakeIO();
    runUninstall({}, { io, baseDir: BASE, exists: () => false, remove: () => {} });
    const text = out.join('\n');
    expect(text).toMatch(/SISTEMA/);
    expect(text).toMatch(/aluy uninstall --agent/);
    expect(text).toMatch(/npm uninstall -g/); // como tirar o CLI em si
  });
});

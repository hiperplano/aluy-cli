// Cobertura de leva de coverage-sweep: uninstall.test.ts já cobre o caminho
// DEFAULT (remoção dos dirs gerenciados). O caminho `--agent` (remove o Ollama de
// SISTEMA delegando ao próprio agente via subprocesso) nunca tinha teste. Mocka
// `node:child_process.spawnSync` (mesmo padrão de session-command-port-exec.test.ts)
// pra verificar a CONSTRUÇÃO do comando, sem gerar um subprocesso real. Arquivo
// SEPARADO — não edita o teste alheio existente.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({ spawnSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

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

describe('runUninstall --agent — delega a remoção do Ollama de SISTEMA ao agente', () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it('process.argv[1] ausente ⇒ erro claro, NÃO tenta spawnar, retorna 0', () => {
    const original = process.argv[1];
    process.argv[1] = '';
    try {
      const { io, err } = fakeIO();
      const code = runUninstall(
        { agent: true },
        { io, baseDir: '/tmp/__aluy_uninstall_agent', exists: () => false, remove: () => {} },
      );
      expect(code).toBe(0);
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(err.join('\n')).toMatch(/não foi possível localizar/);
    } finally {
      process.argv[1] = original;
    }
  });

  it('spawna o PRÓPRIO binário com -p/--yolo/--no-self-check e um goal mencionando Ollama', () => {
    const original = process.argv[1];
    process.argv[1] = '/caminho/pro/aluy.js';
    spawnSyncMock.mockReturnValue({ status: 0 });
    try {
      const { io, out } = fakeIO();
      const code = runUninstall(
        { agent: true },
        { io, baseDir: '/tmp/__aluy_uninstall_agent', exists: () => false, remove: () => {} },
      );
      expect(code).toBe(0);
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      const [execPath, argv, opts] = spawnSyncMock.mock.calls[0]!;
      expect(execPath).toBe(process.execPath);
      expect(argv).toEqual([
        '/caminho/pro/aluy.js',
        '-p',
        expect.stringContaining('Ollama'),
        '--yolo',
        '--no-self-check',
      ]);
      expect(opts.stdio).toBe('inherit');
      expect(opts.env.ALUY_NO_WEAK_YOLO_WARN).toBe('1');
      expect(out.join('\n')).toMatch(/Removendo o Ollama de sistema/);
    } finally {
      process.argv[1] = original;
    }
  });
});

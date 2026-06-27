// EST-1138 · C4 — testes do boot-contract (mem0 args corrigidos).
//
// Verifica que `resolveSidecarPaths` produz:
// - binary: caminho absoluto para python3 do venv
// - args: [caminho absoluto do aluy-mem0-server.py, --host, 127.0.0.1, --port, 11435]
//   (NÃO '-m mem0 serve' — o pacote OSS mem0ai é biblioteca, sem servidor).
// - porta: 11435 (MEM0_PORT, distinta do Ollama 11434).

import { describe, it, expect } from 'vitest';
import {
  resolveSidecarPaths,
  MEM0_PORT,
  OLLAMA_PORT,
} from '../../src/agent/maestro/boot-contract.js';

describe('resolveSidecarPaths — mem0 (EST-1138 C4)', () => {
  const homeDir = '/home/teste';

  it('binary é o python3 do venv', () => {
    const paths = resolveSidecarPaths({ homeDir });
    expect(paths.mem0.binary).toBe(`${homeDir}/.aluy/mem-venv/bin/python3`);
  });

  it('args usam caminho absoluto do script (não -m mem0 serve)', () => {
    const paths = resolveSidecarPaths({ homeDir });
    const args = paths.mem0.args;
    // args[0] deve ser o caminho absoluto do script, não '-m'
    expect(args[0]).toBe(`${homeDir}/.aluy/mem-venv/aluy-mem0-server.py`);
    expect(args[0]).not.toBe('-m');
    // args não contêm 'mem0' nem 'serve' (módulo que não existe)
    expect(args).not.toContain('mem0');
    expect(args).not.toContain('serve');
    // Deve ter --host e --port
    expect(args).toContain('--host');
    expect(args).toContain('127.0.0.1');
    expect(args).toContain('--port');
    expect(args).toContain(String(MEM0_PORT));
  });

  it('porta mem0 = 11435 (distinta do Ollama 11434)', () => {
    expect(MEM0_PORT).toBe(11435);
    expect(OLLAMA_PORT).toBe(11434);
    expect(MEM0_PORT).not.toBe(OLLAMA_PORT);
  });

  it('handshakeUrl usa porta 11435', () => {
    const paths = resolveSidecarPaths({ homeDir });
    expect(paths.mem0.handshakeUrl).toBe(`http://127.0.0.1:${MEM0_PORT}/health`);
    expect(paths.mem0.port).toBe(11435);
  });

  it('respeita mem0VenvDir customizado', () => {
    const customVenv = '/opt/aluy/venv';
    const paths = resolveSidecarPaths({
      homeDir,
      mem0VenvDir: customVenv,
    });
    expect(paths.mem0.binary).toBe(`${customVenv}/bin/python3`);
    expect(paths.mem0.args[0]).toBe(`${customVenv}/aluy-mem0-server.py`);
  });
});

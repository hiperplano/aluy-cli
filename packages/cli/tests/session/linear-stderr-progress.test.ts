// EST-1007 — PROGRESSO human-readable no STDERR no modo headless text/json.
//
// Testa que `runHeadlessPrint` com `quiet:false` (default) emite linhas de
// progresso no stderr (· tool…, ✓/✗ tool, » fase) e que o stdout (resultado)
// NÃO contém essas linhas. Com `quiet:true`, o stderr NÃO recebe progresso.
// Reusa o controller-fake do `linear-stream-json.test.ts`.

import { describe, expect, it, vi } from 'vitest';
import { runHeadlessPrint } from '../../src/session/linear.js';
import type { SessionController } from '../../src/session/controller.js';
import type { SessionBlock, SessionState } from '../../src/session/model.js';

function makeState(blocks: readonly SessionBlock[], phase: SessionState['phase']): SessionState {
  return {
    blocks,
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    phase,
  };
}

/**
 * Controller-fake adaptado p/ `runHeadlessPrint` (que só usa subscribe + submit + blocks).
 */
function fakeController(steps: readonly (readonly SessionBlock[])[]): SessionController {
  let observer: ((s: SessionState) => void) | null = null;
  const ctrl = {
    subscribe(obs: (s: SessionState) => void): () => void {
      observer = obs;
      // snapshot inicial (idle — não emite fase)
      obs(makeState([], 'idle'));
      return () => {
        observer = null;
      };
    },
    async submit(): Promise<void> {
      for (let i = 0; i < steps.length; i++) {
        const phase: SessionState['phase'] =
          i === 0 ? 'streaming' : i === steps.length - 1 ? 'done' : 'streaming';
        observer?.(makeState(steps[i]!, phase));
      }
    },
    get blocks(): readonly SessionBlock[] {
      return steps.length > 0 ? steps[steps.length - 1]! : [];
    },
  };
  return ctrl as unknown as SessionController;
}

describe('runHeadlessPrint — progresso human-readable no stderr', () => {
  it('com quiet=false (default), emite progresso tool + fase no stderr', async () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const controller = fakeController([
        // snapshot 1: só o turno do usuário
        [{ kind: 'you', text: 'leia o readme' }],
        // snapshot 2: tool iniciou (running)
        [
          { kind: 'you', text: 'leia o readme' },
          { kind: 'tool', verb: 'read_file', target: 'README.md', result: '', status: 'running' },
        ],
        // snapshot 3: tool concluiu + fala do assistente
        [
          { kind: 'you', text: 'leia o readme' },
          {
            kind: 'tool',
            verb: 'read_file',
            target: 'README.md',
            result: '3 linhas',
            status: 'ok',
          },
          { kind: 'aluy', text: 'O arquivo tem 3 linhas.', streaming: false },
        ],
      ]);

      const res = await runHeadlessPrint(controller, 'leia o readme', {});

      // O stderr deve ter recebido progresso
      expect(stderrLines.length).toBeGreaterThan(0);

      const stderr = stderrLines.join('');

      // Deve conter a linha de fase
      expect(stderr).toContain('» streaming');

      // Deve conter a tool running (· read_file…)
      expect(stderr).toContain('· read_file');

      // Deve conter a tool concluída (✓ read_file)
      expect(stderr).toContain('✓ read_file');

      // O resultado da função deve estar ok
      expect(res.ok).toBe(true);
      expect(res.result).toBe('O arquivo tem 3 linhas.');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('com quiet=true, stderr NÃO recebe progresso', async () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const controller = fakeController([
        [{ kind: 'you', text: 'teste' }],
        [
          { kind: 'you', text: 'teste' },
          { kind: 'tool', verb: 'bash', target: 'echo ok', result: '', status: 'running' },
        ],
        [
          { kind: 'you', text: 'teste' },
          { kind: 'tool', verb: 'bash', target: 'echo ok', result: 'ok\n', status: 'ok' },
          { kind: 'aluy', text: 'Pronto.', streaming: false },
        ],
      ]);

      const res = await runHeadlessPrint(controller, 'teste', { quiet: true });

      // NENHUMA linha de progresso no stderr
      const stderr = stderrLines.join('');
      expect(stderr).not.toContain('· bash');
      expect(stderr).not.toContain('✓ bash');
      expect(stderr).not.toContain('» streaming');

      // O resultado AINDA funciona
      expect(res.ok).toBe(true);
      expect(res.result).toBe('Pronto.');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('com quiet=false, stdout (out) NÃO contém linhas de progresso — só o resultado', async () => {
    // Nota: `runHeadlessPrint` NÃO usa argumento `out` — ele escreve no `process.stderr`
    // e devolve um HeadlessPrintResult. O resultado textual (fala final) é retornado,
    // nunca escrito no stdout pela função. O caller (run.tsx) escreve no stdout.
    // Este teste verifica que o stderr tem progresso e a função retorna o resultado certo.
    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const controller = fakeController([
        [{ kind: 'you', text: 'script' }],
        [
          { kind: 'you', text: 'script' },
          { kind: 'tool', verb: 'grep', target: 'foo', result: '', status: 'running' },
        ],
        [
          { kind: 'you', text: 'script' },
          { kind: 'tool', verb: 'grep', target: 'foo', result: '1 linha', status: 'ok' },
          { kind: 'aluy', text: 'Achou foo.', streaming: false },
        ],
      ]);

      const res = await runHeadlessPrint(controller, 'script');

      // Stderr tem progresso
      expect(stderrLines.join('')).toContain('· grep');
      expect(stderrLines.join('')).toContain('✓ grep');

      // O resultado (stdout-bound) é limpo — sem prefixo de progresso
      expect(res.result).toBe('Achou foo.');
      expect(res.result).not.toContain('· grep');
      expect(res.result).not.toContain('» streaming');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('emite tool com erro (✗) no stderr', async () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const controller = fakeController([
        [{ kind: 'you', text: 'roda' }],
        [
          { kind: 'you', text: 'roda' },
          { kind: 'tool', verb: 'bash', target: 'false', result: '', status: 'running' },
        ],
        [
          { kind: 'you', text: 'roda' },
          { kind: 'tool', verb: 'bash', target: 'false', result: 'exit 1', status: 'err' },
          { kind: 'aluy', text: 'Falhou.', streaming: false },
        ],
      ]);

      const res = await runHeadlessPrint(controller, 'roda');

      const stderr = stderrLines.join('');
      expect(stderr).toContain('· bash');
      expect(stderr).toContain('✗ bash');

      expect(res.ok).toBe(true);
      expect(res.result).toBe('Falhou.');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('emite mudança de fase (» thinking, » streaming, » done)', async () => {
    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      let observer: ((s: SessionState) => void) | null = null;
      const ctrl = {
        subscribe(obs: (s: SessionState) => void): () => void {
          observer = obs;
          obs(makeState([], 'idle'));
          return () => {
            observer = null;
          };
        },
        async submit(): Promise<void> {
          observer?.(makeState([{ kind: 'you', text: 'fase' }], 'thinking'));
          observer?.(
            makeState(
              [
                { kind: 'you', text: 'fase' },
                { kind: 'aluy', text: 'ok.', streaming: false },
              ],
              'done',
            ),
          );
        },
        get blocks(): readonly SessionBlock[] {
          return [
            { kind: 'you', text: 'fase' },
            { kind: 'aluy', text: 'ok.', streaming: false },
          ];
        },
      };

      const res = await runHeadlessPrint(ctrl as unknown as SessionController, 'fase');

      const stderr = stderrLines.join('');
      // idle NÃO emite; thinking e done sim
      expect(stderr).toContain('» thinking');
      expect(stderr).toContain('» done');

      expect(res.ok).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

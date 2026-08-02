// BUG achado em dogfooding (`--image`/`@caminho` fora do workspace): `resolved.notes`
// (a recusa de anexo — "@x — caminho fora do workspace") era calculada por
// `resolveLinearMentions` e NUNCA escrita em `runHeadlessPrint`/`runHeadlessStreamJson`
// — o usuário só via o modelo dizer "não recebi imagem nenhuma", sem NENHUM sinal do
// motivo real. `runLinear` (não-TTY interativo) já emitia (linear.ts:158); os dois
// modos headless (`-p` text/json e `-p --output-format stream-json`) não. Prova: a
// nota de recusa (ou de anexo bem-sucedido) chega ao STDERR, nunca ao stdout.

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHeadlessPrint, runHeadlessStreamJson } from '../../src/session/linear.js';
import { AttachReader } from '../../src/attach/reader.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileSystemPort } from '../../src/io/fs-port.js';
import type { SessionController } from '../../src/session/controller.js';
import type { SessionBlock } from '../../src/session/model.js';

function fakeController(finalBlocks: readonly SessionBlock[]): SessionController {
  let current: readonly SessionBlock[] = [];
  const ctrl = {
    async submit(): Promise<void> {
      current = finalBlocks;
    },
    subscribe(obs: (s: { blocks: readonly SessionBlock[]; phase: string }) => void): () => void {
      obs({ blocks: finalBlocks, phase: 'done' });
      return () => {};
    },
    get blocks(): readonly SessionBlock[] {
      return current;
    },
    get tier(): string {
      return 'aluy-flux';
    },
    get model(): string | undefined {
      return undefined;
    },
  };
  return ctrl as unknown as SessionController;
}

function withStderrCapture<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  const lines: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      lines.push(String(chunk));
      return true;
    });
  return fn()
    .then((result) => ({ result, stderr: lines.join('') }))
    .finally(() => spy.mockRestore());
}

describe('runHeadlessPrint/runHeadlessStreamJson — nota de anexo/recusa vai pro STDERR', () => {
  let base: string;
  let root: string;

  function reader(): AttachReader {
    const workspace = new NodeWorkspace({ root });
    return new AttachReader({ workspace, fs: new NodeFileSystemPort({ workspace }) });
  }

  function setup(): void {
    base = mkdtempSync(join(tmpdir(), 'aluy-headless-attach-'));
    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(base, 'fora.txt'), 'FORA DO WORKSPACE\n');
    writeFileSync(join(root, 'dentro.txt'), 'DENTRO DO WORKSPACE\n');
  }
  function teardown(): void {
    rmSync(base, { recursive: true, force: true });
  }

  it('runHeadlessPrint: @caminho FORA do workspace ⇒ nota de recusa no stderr (não no stdout/result)', async () => {
    setup();
    try {
      const ctrl = fakeController([{ kind: 'aluy', text: 'não recebi imagem nenhuma', streaming: false }]);
      const { result, stderr } = await withStderrCapture(() =>
        runHeadlessPrint(ctrl, 'descreva @../fora.txt', { attachReader: reader() }),
      );
      expect(stderr).toContain('[anexo recusado]');
      expect(stderr).toContain('fora do workspace');
      expect(result.result).not.toContain('[anexo recusado]');
    } finally {
      teardown();
    }
  });

  it('runHeadlessPrint: @caminho DENTRO do workspace ⇒ nota de SUCESSO no stderr', async () => {
    setup();
    try {
      const ctrl = fakeController([{ kind: 'aluy', text: 'ok', streaming: false }]);
      const { stderr } = await withStderrCapture(() =>
        runHeadlessPrint(ctrl, 'leia @dentro.txt', { attachReader: reader() }),
      );
      expect(stderr).toContain('[anexo] @dentro.txt');
      expect(stderr).not.toContain('recusado');
    } finally {
      teardown();
    }
  });

  it('runHeadlessStreamJson: @caminho FORA do workspace ⇒ nota de recusa no stderr, stdout NDJSON limpo', async () => {
    setup();
    try {
      const ctrl = fakeController([{ kind: 'aluy', text: 'x', streaming: false }]);
      const stdoutLines: string[] = [];
      const { stderr } = await withStderrCapture(() =>
        runHeadlessStreamJson(
          ctrl,
          'descreva @../fora.txt',
          { write: (c) => stdoutLines.push(c) },
          { attachReader: reader() },
        ),
      );
      expect(stderr).toContain('[anexo recusado]');
      expect(stderr).toContain('fora do workspace');
      // stdout é só NDJSON — nenhuma linha deve conter o texto da nota de recusa.
      expect(stdoutLines.join('')).not.toContain('[anexo recusado]');
    } finally {
      teardown();
    }
  });
});

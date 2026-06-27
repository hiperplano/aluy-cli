// EST-0982 — SessionController: STREAMING + ABORT do `!comando` (sem modelo).
//
// Prova a costura UI ↔ tool ↔ porta no controlador:
//   • a saída AO VIVO da porta atualiza `liveOutput` do BLOCO `bang` em `running`;
//   • ao resolver, o `output` final substitui a prévia (liveOutput zera);
//   • `interrupt()` durante o bang ABORTA — a porta vê o signal abortado (kill);
//   • a saída ao vivo passa pela REDAÇÃO (CLI-SEC-6) antes de virar liveOutput.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  REDACTED,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type ShellExecOptions,
  type SearchPort,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

const inertCaller: ModelCaller = {
  async call(): Promise<ModelCallResult> {
    return { request_id: 'r', content: '', finish_reason: 'stop' };
  },
};

const noFs: FileSystemPort = {
  async readFile() {
    throw new Error('n/a');
  },
  async writeFile() {},
  async exists() {
    return false;
  },
};
const noSearch: SearchPort = {
  async search() {
    return { matches: [], truncated: {} };
  },
};

function controllerWith(shell: ShellPort): SessionController {
  const ports: ToolPorts = { fs: noFs, shell, search: noSearch };
  const engine = new PolicyPermissionEngine({
    policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
  });
  return new SessionController({
    model: inertCaller,
    permission: engine,
    ports,
    askResolver: new TuiAskResolver(),
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    // throttle OFF (intervalMs: 0): cada chunk notifica na hora — teste determinístico.
    flush: { intervalMs: 0 },
  });
}

describe('EST-0982 · controller — streaming do `!comando`', () => {
  it('a saída ao vivo (redigida) acumula em liveOutput enquanto roda; some ao resolver', async () => {
    // Shell que streama 3 linhas (uma com segredo) e PAUSA antes de resolver — o teste
    // inspeciona o liveOutput DURANTE a execução, depois libera.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const shell: ShellPort = {
      async exec(
        _cmd,
        options?: ShellExecOptions,
      ): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
      }> {
        options?.onChunk?.({ stream: 'stdout', text: 'linha-1\n' });
        options?.onChunk?.({
          stream: 'stdout',
          text: 'GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123\n',
        });
        options?.onChunk?.({ stream: 'stdout', text: 'linha-3\n' });
        await gate; // pausa: o liveOutput está visível no estado AGORA
        return { stdout: 'linha-1\n…\nlinha-3\n', stderr: '', exitCode: 0 };
      },
    };
    const controller = controllerWith(shell);
    const p = controller.runBang('env');
    // Deixa os chunks (síncronos no exec) e o flush (intervalMs:0) assentarem.
    await Promise.resolve();
    await Promise.resolve();

    // DURANTE a execução: o liveOutput carregou a saída — JÁ redigida (CLI-SEC-6).
    const mid = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(mid?.kind).toBe('bang');
    if (mid?.kind === 'bang') {
      expect(mid.status).toBe('running');
      expect(mid.liveOutput ?? '').toContain('linha-1');
      expect(mid.liveOutput ?? '').toContain('linha-3');
      expect(mid.liveOutput ?? '').toContain(REDACTED);
      expect(mid.liveOutput ?? '').not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    }

    release?.();
    await p;

    // Ao resolver, o bloco vira ok e liveOutput foi descartado (output final manda).
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    expect(bang?.kind).toBe('bang');
    if (bang?.kind === 'bang') {
      expect(bang.status).toBe('ok');
      expect(bang.liveOutput).toBeUndefined();
      expect(bang.output).toContain('linha-3');
    }
  });

  it('interrupt() durante o bang ABORTA — a porta vê o signal abortado (kill)', async () => {
    let sawAbort = false;
    let release: (() => void) | undefined;
    const shell: ShellPort = {
      async exec(
        _cmd,
        options?: ShellExecOptions,
      ): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
        aborted?: boolean;
      }> {
        // "Comando longo": resolve só quando o signal abortar (simula o kill da porta).
        return await new Promise((resolve) => {
          const onAbort = (): void => {
            sawAbort = true;
            resolve({ stdout: 'parcial', stderr: '', exitCode: 130, aborted: true });
          };
          if (options?.signal?.aborted) onAbort();
          else options?.signal?.addEventListener('abort', onAbort, { once: true });
          release = () => resolve({ stdout: 'fim', stderr: '', exitCode: 0 });
        });
      },
    };
    const controller = controllerWith(shell);
    const p = controller.runBang('sleep 30');
    // Deixa o exec começar e então interrompe (esc/Ctrl-C → interrupt).
    await Promise.resolve();
    await Promise.resolve();
    controller.interrupt();
    await p;
    expect(sawAbort).toBe(true);
    const bang = controller.current.blocks.find((b) => b.kind === 'bang');
    if (bang?.kind === 'bang') {
      // exit 130 ⇒ status err (não-zero), com o parcial coletado.
      expect(bang.status).toBe('err');
      expect(bang.output).toMatch(/interrompido pelo usuário/i);
    }
    void release; // (não usado: o abort resolve antes)
  });
});

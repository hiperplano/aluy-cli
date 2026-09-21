// F-BG (21/09/2026) — o CANAL entre o Ctrl+B e a tool de shell em execução.
//
// O problema de fio que o `DetachHub` resolve: quem decide soltar é o dono, na TUI; quem
// precisa do sinal é a porta de shell, lá embaixo; entre os dois está o loop, que monta o
// contexto de cada tool. Estes testes cobrem a parte do loop — que ele ARMA um sinal NOVO
// por tool-call e repassa o `onDetached`.
//
// A REGRESSÃO que guardam: reusar o mesmo sinal entre tool-calls. Se isso acontecer,
// soltar um comando solta também o PRÓXIMO — que ninguém pediu para soltar.
import { describe, expect, it, vi } from 'vitest';
import { runCommandTool } from '../../src/agent/tools/native.js';
import type { DetachedShellInfo, ShellPort, ToolPorts } from '../../src/agent/tools/types.js';

/** Porta de shell que obedece ao `detachSignal` como a concreta obedece. */
function shellQueSolta(): ShellPort {
  return {
    exec: vi.fn(async (command, options) => {
      if (options?.detachSignal?.aborted) {
        const info: DetachedShellInfo = {
          logPath: '/tmp/bg-1.log',
          command,
          handle: { onExit: () => {}, kill: () => {} },
        };
        options.onDetached?.(info);
        return { stdout: '', stderr: '', exitCode: 0, detached: true, logPath: info.logPath };
      }
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    }),
  };
}

const portas = (shell: ShellPort): ToolPorts => ({ shell }) as unknown as ToolPorts;

describe('F-BG · run_command — o desfecho SOLTO', () => {
  it('solto ⇒ observação diz que segue rodando e manda NÃO esperar', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await runCommandTool.run({ command: 'npm run dev' }, portas(shellQueSolta()), {
      detachSignal: ctl.signal,
    });
    expect(r.ok).toBe(true);
    expect(r.observation).toContain('segundo plano');
    expect(r.observation).toContain('/tmp/bg-1.log');
    // O modelo precisa saber que NÃO deve repetir o comando nem ficar esperando —
    // sem isto ele reexecuta um `npm run dev` que já está de pé.
    expect(r.observation).toContain('NÃO rode o mesmo comando de novo');
  });

  it('solto NÃO vira exit=0 na observação (seria mentira: o comando pode falhar depois)', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const r = await runCommandTool.run({ command: 'sleep 999' }, portas(shellQueSolta()), {
      detachSignal: ctl.signal,
    });
    expect(r.observation).not.toContain('exit=0');
  });

  it('o handle do processo vivo chega ao `onDetached` (é ele que o monitor adota)', async () => {
    const ctl = new AbortController();
    ctl.abort();
    let recebido: DetachedShellInfo | undefined;
    await runCommandTool.run({ command: 'tail -f x' }, portas(shellQueSolta()), {
      detachSignal: ctl.signal,
      onDetached: (i) => {
        recebido = i;
      },
    });
    expect(recebido).toBeDefined();
    expect(recebido!.command).toBe('tail -f x');
    expect(typeof recebido!.handle.onExit).toBe('function');
    expect(typeof recebido!.handle.kill).toBe('function');
  });

  it('SEM soltar, o caminho é o de sempre — não-regressão', async () => {
    const r = await runCommandTool.run({ command: 'echo oi' }, portas(shellQueSolta()), {});
    expect(r.observation).toContain('exit=0');
    expect(r.observation).not.toContain('segundo plano');
  });

  it('o sinal é REPASSADO à porta (sem isso, o Ctrl+B não chega em lugar nenhum)', async () => {
    const shell = shellQueSolta();
    const ctl = new AbortController();
    await runCommandTool.run({ command: 'x' }, portas(shell), { detachSignal: ctl.signal });
    const opts = (shell.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(opts.detachSignal).toBe(ctl.signal);
  });
});

// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — INTEGRAÇÃO no
// SessionController: quando o loop detecta travamento (mesma tool 4×), o controller
// PAUSA (fase `stuck` + `pendingStuck`) e ESPERA a decisão do usuário. As 3 opções
// ([r] redirecionar / [c] continuar / [n] encerrar) cumprem a promise e o loop
// retoma — SEM matar o turno seco. SEM modelo real (model roteirizado) e SEM Ink (só
// o controller + um observador de estado que resolve a pausa).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

/** Modelo roteirizado por TURNO (idempotency-key `sess:iter`). */
function scriptModel(turns: readonly string[]): ModelCaller {
  let i = 0;
  return {
    async call(): Promise<ModelCallResult> {
      const content = turns[i] ?? 'pronto.';
      i += 1;
      return {
        request_id: 'r',
        content,
        finish_reason: 'stop',
        usage: { request_id: 'r', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
      };
    },
  };
}

const approveAll = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};
const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

function makeController(turns: readonly string[]): SessionController {
  return new SessionController({
    model: scriptModel(turns),
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: approveAll,
    meta,
  });
}

/** Repete a MESMA tool-call N vezes (default do watchdog: 4 ⇒ dispara). */
function sameCall(n: number): string[] {
  return Array.from({ length: n }, () => toolCall('run_command', { command: 'ls' }));
}

describe('EST-0969 · SessionController — pausa-pede-direção (PAUSA, não mata)', () => {
  it('mesma tool 4× ⇒ entra na fase `stuck` com pendingStuck (o que travou)', async () => {
    const controller = makeController([...sameCall(4), 'pronto.']);
    // Observa o estado: na 1ª vez que entrar em `stuck`, captura e resolve com [c].
    let sawStuck = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && s.pendingStuck && !sawStuck) {
        sawStuck = true;
        expect(s.pendingStuck.kind).toBe('same-tool-call');
        expect(s.pendingStuck.count).toBeGreaterThanOrEqual(4);
        expect(s.pendingStuck.sample).toBe('run_command');
        controller.continueAfterStuck(); // segue mesmo assim
      }
    });
    await controller.submit('faça');
    unsub();
    expect(sawStuck).toBe(true);
    // NÃO matou: o turno seguiu e terminou (fase final, não `stuck` preso).
    expect(controller.current.phase).not.toBe('stuck');
  });

  it('[r] redirecionar ⇒ injeta a direção e o turno RETOMA (volta a thinking)', async () => {
    const controller = makeController([...sameCall(4), 'segui a direção.']);
    const phases: string[] = [];
    let redirected = false;
    const unsub = controller.subscribe((s) => {
      phases.push(s.phase);
      if (s.phase === 'stuck' && !redirected) {
        redirected = true;
        controller.redirectAfterStuck('pare e leia o README');
      }
    });
    await controller.submit('faça');
    unsub();
    expect(redirected).toBe(true);
    // após o [r], a sessão voltou a `thinking` (retomou o turno) antes de concluir.
    const stuckIdx = phases.indexOf('stuck');
    expect(stuckIdx).toBeGreaterThanOrEqual(0);
    expect(phases.slice(stuckIdx + 1)).toContain('thinking');
  });

  it('[n] encerrar ⇒ ENCERRA o turno (não fica preso em `stuck`)', async () => {
    const controller = makeController(sameCall(8));
    let ended = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && !ended) {
        ended = true;
        controller.endAfterStuck();
      }
    });
    await controller.submit('faça');
    unsub();
    expect(ended).toBe(true);
    expect(controller.current.phase).toBe('done'); // turno encerrado limpo
  });

  it('[c] continuar RESETA o detector — só UMA pausa, não re-dispara logo', async () => {
    // 7 calls iguais: dispara na 4ª; [c] reseta; as 3 seguintes não cruzam o limiar 4.
    const controller = makeController([...sameCall(7), 'pronto.']);
    let stuckCount = 0;
    let prevPhase = '';
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && prevPhase !== 'stuck') {
        stuckCount += 1;
        controller.continueAfterStuck();
      }
      prevPhase = s.phase;
    });
    await controller.submit('faça');
    unsub();
    expect(stuckCount).toBe(1);
  });

  it('tarefa com tools DIFERENTES avançando NÃO dispara (anti-falso-positivo)', async () => {
    const controller = makeController([
      toolCall('read_file', { path: 'a.ts' }),
      toolCall('read_file', { path: 'b.ts' }),
      toolCall('run_command', { command: 'ls' }),
      toolCall('read_file', { path: 'c.ts' }),
      toolCall('grep', { pattern: 'x' }),
      'pronto.',
    ]);
    let sawStuck = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck') sawStuck = true;
    });
    await controller.submit('faça');
    unsub();
    expect(sawStuck).toBe(false);
    expect(controller.current.phase).toBe('done');
  });

  it('interrupt() durante a pausa resolve `end` (não fica pendurado)', async () => {
    const controller = makeController(sameCall(8));
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck') controller.interrupt(); // esc durante a pausa
    });
    // não deve travar: o interrupt resolve a promise da pausa como `end`.
    await controller.submit('faça');
    unsub();
    expect(controller.current.phase).not.toBe('stuck');
  });

  // EST-1007 (HANG) — sem TTY (headless `-p`/posicional piped) NÃO há quem responda
  // `[r]/[c]/[n]`. Com `setNonInteractive(true)` a pausa de travamento resolve `end`
  // de IMEDIATO (sem sequer abrir a fase `stuck` — não há UI a mostrar) ⇒ o turno
  // ENCERRA em vez de PENDURAR o processo à espera de uma tecla impossível (o bug
  // "criava 2/3 arquivos e travava"). NINGUÉM resolve a pausa: sem o fix, a promise
  // nunca seria cumprida e o `submit` jamais resolveria (timeout do teste).
  it('NÃO-INTERATIVO: o travamento ENCERRA o turno sozinho (não pendura, não abre `stuck`)', async () => {
    const controller = makeController(sameCall(8));
    controller.setNonInteractive(true);
    // observador PASSIVO: NÃO resolve nada (não há TTY). Só registra se a pausa abriu.
    let openedStuckPause = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck') openedStuckPause = true;
    });
    // sem o fix isto pendura para sempre ⇒ o teste estouraria o timeout.
    await controller.submit('faça');
    unsub();
    // encerrou LIMPO (deny-por-inação) e NÃO ficou preso na pausa interativa.
    expect(controller.current.phase).toBe('done');
    expect(openedStuckPause).toBe(false);
  });

  // CONTRA-PROVA: SEM o não-interativo, com NINGUÉM resolvendo, a pausa fica ABERTA
  // (`stuck`) — é justamente o caminho que PENDURAVA no headless. Aqui resolvemos via
  // timer p/ não travar o próprio teste, mas confirmamos que a pausa CHEGOU a abrir.
  it('INTERATIVO sem resolver: a pausa ABRE `stuck` (o caminho que pendurava sem o fix)', async () => {
    const controller = makeController(sameCall(8));
    // NÃO chama setNonInteractive ⇒ default interativo.
    let openedStuckPause = false;
    const unsub = controller.subscribe((s) => {
      if (s.phase === 'stuck' && !openedStuckPause) {
        openedStuckPause = true;
        // resolve só p/ destravar o teste (no headless real ninguém resolveria ⇒ hang).
        controller.endAfterStuck();
      }
    });
    await controller.submit('faça');
    unsub();
    expect(openedStuckPause).toBe(true);
  });
});

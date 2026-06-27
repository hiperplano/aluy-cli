// EST-1103 · ADR-0079 — idle-wake do monitor: integração real
// (SessionController + AgentLoop + catraca + trigger). O modelo arma um
// `process-wait` num PID morto (2147483647). Após o 1º turno terminar
// (phase idle), o trigger dispara e o agente ACORDA com um turno-wake.
//
// Espelha o harness de controller-cycle.test.ts (fakePorts, scriptedModel,
// SessionController, controller.dispose()).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type AskResolver,
} from '@aluy/cli-core';
import { SessionController } from '../../src/session/controller.js';

const TOOL_OPEN = '<<<ALUY_TOOL_CALL';
const TOOL_CLOSE = 'ALUY_TOOL_CALL>>>';
function toolCall(name: string, input: Record<string, unknown>): string {
  return `${TOOL_OPEN}\n${JSON.stringify({ name, input })}\n${TOOL_CLOSE}`;
}

function fakePorts(): { ports: ToolPorts; ran: string[]; reads: string[] } {
  const ran: string[] = [];
  const reads: string[] = [];
  const fs: FileSystemPort = {
    async readFile(p: string) {
      reads.push(p);
      return 'conteúdo';
    },
    async writeFile() {},
    async exists() {
      return true;
    },
  };
  const shell: ShellPort = {
    async exec(c) {
      ran.push(c);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { ports: { fs, shell, search }, ran, reads };
}

const meta = { cwd: '/proj', tier: 'aluy-strata', tokens: 0, windowPct: 0 };

const approveAll: AskResolver = {
  async resolve() {
    return { kind: 'approve-once' as const };
  },
};

/** Acha uma nota pelo título no estado corrente. */
function findNote(
  controller: SessionController,
  title: string,
): { title: string; lines: readonly string[] } | undefined {
  const blocks = controller.current.blocks;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b && b.kind === 'note' && b.title === title) return { title: b.title, lines: b.lines };
  }
  return undefined;
}

/**
 * Atraso em ms que resolve via setTimeout. Usado para aguardar o trigger
 * do monitor disparar após o turno terminar.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('EST-1103 · idle-wake do monitor', () => {
  it('arma process-wait num PID morto, turno termina, trigger dispara ~1s depois e o agente ACORDA', async () => {
    const { ports } = fakePorts();

    // Contador GLOBAL de chamadas ao modelo. O wake é um `run()` novo (3ª chamada).
    let modelCalls = 0;

    const model: ModelCaller = {
      async call(args): Promise<ModelCallResult> {
        void args; // mantido p/ compatibilidade de interface
        modelCalls++;
        const callN = modelCalls;

        if (callN === 1) {
          // 1ª chamada: arma um process-wait num PID que não existe.
          return {
            request_id: 'r1',
            content: toolCall('monitor', {
              type: 'process-wait',
              label: 'pid-test',
              pid: 2147483647,
            }),
            finish_reason: 'stop',
            usage: { request_id: 'r1', tier: 'aluy-flux', tokens_in: 40, tokens_out: 60 },
          };
        }
        if (callN === 2) {
          // 2ª chamada: o agente confirma que armou o monitor.
          return {
            request_id: 'r2',
            content: 'Monitor armado. Aguardando o PID encerrar.',
            finish_reason: 'stop',
            usage: { request_id: 'r2', tier: 'aluy-flux', tokens_in: 30, tokens_out: 30 },
          };
        }
        if (callN === 3) {
          // 3ª chamada (wake turn): o agente recebeu o nudge + observação.
          return {
            request_id: 'r3',
            content: 'O PID 2147483647 disparou (processo encerrado). Nada a fazer.',
            finish_reason: 'stop',
            usage: { request_id: 'r3', tier: 'aluy-flux', tokens_in: 50, tokens_out: 40 },
          };
        }
        // Fallback.
        return {
          request_id: 'rf',
          content: 'pronto.',
          finish_reason: 'stop',
          usage: { request_id: 'rf', tier: 'aluy-flux', tokens_in: 10, tokens_out: 10 },
        };
      },
    };

    const controller = new SessionController({
      model,
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports,
      askResolver: approveAll,
      meta,
      // watchdog desligado para o teste (evita interferência da pausa-pede-direção).
      watchdogEnv: { ALUY_STUCK_OFF: '1' },
    });

    try {
      // Inicia o 1º turno.
      await controller.submit('monitore o PID 2147483647');

      // Após o submit, o modelo foi chamado 2x (turn0=armar monitor, turn1=confirmar).
      expect(modelCalls).toBeGreaterThanOrEqual(2);

      // A sessão deve estar em repouso (done) agora.
      expect(controller.current.phase).toBe('done');

      // Aguarda o trigger do monitor disparar (~1s). O ProcessWaitTrigger
      // para um PID inexistente deve disparar rapidamente.
      await delay(1500);

      // O agente DEVE ter acordado: o modelo foi chamado uma 3ª vez (wake turn).
      expect(modelCalls).toBeGreaterThanOrEqual(3);

      // Deve haver uma nota `monitor` nos blocos.
      const note = findNote(controller, 'monitor');
      expect(note).toBeDefined();
      expect(note!.lines.some((l) => l.includes('pid-test'))).toBe(true);

      // Aguarda o turno-wake processar completamente (runResolvedTurn é async).
      await delay(100);

      // O wake aconteceu (modelCalls ≥ 3) e a nota `monitor` foi empurrada.
      // Isso basta para verificar o idle-wake: o agente acordou, drenou a fila,
      // e reagiu (o modelo foi consultado com os eventos como observação).
      expect(note!.lines.some((l) => l.includes('disparou'))).toBe(true);
    } finally {
      controller.dispose();
    }
  });
});

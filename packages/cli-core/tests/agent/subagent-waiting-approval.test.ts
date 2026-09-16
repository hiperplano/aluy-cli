// SUB-AGENTE ESPERANDO APROVAÇÃO NÃO ESTÁ TRAVADO.
//
// Visto pelo dono em 16/09: três agentes, o `pesquisador-web` morreu com "timeout · 14.6k
// tokens · 5m4s" e ZERO tools. `web_search` é sempre-ask, e o contador de tools só sobe DEPOIS
// da aprovação: ele pediu a busca, o pedido ficou na fila enquanto o dono aprovava as 28 tools
// do irmão, e o heartbeat — que não sabia de espera por humano — o matou como travado. O pai
// ainda leu isso como "provavelmente o modelo ficou em loop".
import { describe, expect, it } from 'vitest';
import {
  NATIVE_TOOLS,
  PolicyPermissionEngine,
  SubAgentSpawner,
  type AskRequest,
  type AskResolution,
  type AskResolver,
  type ModelCaller,
  type ToolPorts,
} from '../../src/index.js';
import { MemoryFs, MemorySearch, RecordingShell, toolCallBlock } from './helpers.js';

class FakeClock {
  private now = 0;
  private pending: Array<{ deadline: number; resolve: () => void }> = [];
  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const entry = { deadline: this.now + ms, resolve };
      this.pending.push(entry);
      signal?.addEventListener(
        'abort',
        () => {
          this.pending = this.pending.filter((p) => p !== entry);
          resolve();
        },
        { once: true },
      );
    });
  advance(ms: number): void {
    this.now += ms;
    const due = this.pending.filter((p) => p.deadline <= this.now);
    this.pending = this.pending.filter((p) => p.deadline > this.now);
    for (const p of due) p.resolve();
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 } as const;
const IDLE = 120_000;
const STEP = 30_000;

/** 1ª chamada pede um comando (ask); a 2ª conclui. */
function model(): ModelCaller {
  let n = 0;
  return {
    async call() {
      n += 1;
      const content = n === 1 ? toolCallBlock('run_command', { command: 'ls' }) : 'concluído.';
      return { request_id: 'r', content, finish_reason: 'stop', usage };
    },
  };
}

/** O dono responde só depois de `delayMs` de relógio (fila de aprovações cheia). */
function slowHuman(clock: FakeClock, delayMs: number, kind: 'approve-once' | 'deny'): AskResolver {
  return {
    async resolve(_req: AskRequest, signal?: AbortSignal): Promise<AskResolution> {
      await clock.sleep(delayMs, signal);
      if (signal?.aborted) return { kind: 'deny', reason: 'cancelado' } as AskResolution;
      return (
        kind === 'deny' ? { kind: 'deny', reason: 'negado' } : { kind: 'approve-once' }
      ) as AskResolution;
    },
  };
}

async function run(clock: FakeClock, askResolver: AskResolver | undefined, model_: ModelCaller) {
  const ports: ToolPorts = {
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    search: new MemorySearch(),
  };
  const spawner = new SubAgentSpawner({
    model: model_,
    permission: new PolicyPermissionEngine(),
    ports,
    baseTools: [...NATIVE_TOOLS],
    ...(askResolver ? { askResolver } : {}),
    idleTimeoutMs: IDLE,
    sleep: clock.sleep,
  });
  const out = spawner.spawn([{ label: 'pesquisador', goal: 'busca algo' }]);
  for (let t = 0; t <= 900_000; t += STEP) {
    await flush();
    clock.advance(STEP);
    await flush();
  }
  return out;
}

describe('heartbeat do sub-agente × espera por aprovação do dono', () => {
  it('aprovação que demora 10min (limite de 2min) NÃO mata o filho', async () => {
    const clock = new FakeClock();
    const out = await run(clock, slowHuman(clock, 600_000, 'approve-once'), model());
    expect(out[0]!.stop).toBe('final');
    expect(out[0]!.result).toBe('concluído.');
  });

  it('negar depois de 10min também não vira timeout — o filho segue com a negação', async () => {
    const clock = new FakeClock();
    const out = await run(clock, slowHuman(clock, 600_000, 'deny'), model());
    expect(out[0]!.stop).not.toBe('timeout');
  });

  it('depois da resposta o relógio volta a contar: um modelo que trava em seguida morre', async () => {
    const clock = new FakeClock();
    let n = 0;
    const hangsAfter: ModelCaller = {
      call() {
        n += 1;
        if (n === 1) {
          return Promise.resolve({
            request_id: 'r',
            content: toolCallBlock('run_command', { command: 'ls' }),
            finish_reason: 'stop',
            usage,
          });
        }
        return new Promise(() => {}); // trava de vez depois da aprovação
      },
    };
    const out = await run(clock, slowHuman(clock, 600_000, 'approve-once'), hangsAfter);
    expect(out[0]!.stop).toBe('timeout');
  });
});

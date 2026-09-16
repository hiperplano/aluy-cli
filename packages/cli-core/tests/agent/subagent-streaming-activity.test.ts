// SUB-AGENTE GERANDO DEVAGAR NÃO É SUB-AGENTE TRAVADO.
//
// Relato do dono (16/09): "em outra máquina ele disparou um sub-agente que rodou quase meia hora
// e estourou timeout no final; com modelos piores os agentes estouram com mais frequência".
//
// O heartbeat só era zerado ao FIM de cada chamada ao modelo (`onProgress` kind `model`) — nunca
// durante o stream. Uma única resposta mais longa que o limite de inatividade (tipicamente a
// última, o relatório com o contexto cheio; ou qualquer uma num modelo lento) matava o filho como
// "travado" mesmo com tokens chegando. Agora cada evento do stream conta como atividade.
import { describe, expect, it } from 'vitest';
import {
  NATIVE_TOOLS,
  PolicyPermissionEngine,
  SubAgentSpawner,
  DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS,
  type ModelCaller,
  type ToolPorts,
} from '../../src/index.js';
import { MemoryFs, MemorySearch, RecordingShell } from './helpers.js';

class FakeClock {
  private now = 0;
  private pending: Array<{ deadline: number; resolve: () => void }> = [];
  armed = 0;
  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    this.armed += 1;
    return new Promise<void>((resolve) => {
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
  };
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

const ports = (): ToolPorts => ({
  fs: new MemoryFs(),
  shell: new RecordingShell(),
  search: new MemorySearch(),
});

const usage = { request_id: 'r', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 } as const;
const IDLE = 120_000;
const STEP = 30_000;

/**
 * Uma única chamada ao modelo que dura `totalMs` de relógio. `streaming` = emite atividade a
 * cada STEP (como tokens chegando); sem ela, a chamada fica muda o tempo todo.
 */
function slowModel(clock: FakeClock, totalMs: number, streaming: boolean): ModelCaller {
  return {
    async call(args) {
      for (let t = 0; t < totalMs; t += STEP) {
        await clock.sleep(STEP);
        if (streaming) args.onActivity?.();
      }
      return { request_id: 'r', content: 'relatório final.', finish_reason: 'stop', usage };
    },
  };
}

async function runFor(clock: FakeClock, model: ModelCaller, virtualMs: number) {
  const spawner = new SubAgentSpawner({
    model,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: ports(),
    baseTools: [...NATIVE_TOOLS],
    idleTimeoutMs: IDLE,
    sleep: clock.sleep,
  });
  const out = spawner.spawn([{ label: 'lento', goal: 'escreve o relatório' }]);
  for (let t = 0; t <= virtualMs; t += STEP) {
    await flush();
    clock.advance(STEP);
    await flush();
  }
  return out;
}

describe('heartbeat do sub-agente × stream do modelo', () => {
  it('uma resposta de 10min COM tokens chegando não é morta (limite de 2min no teste)', async () => {
    const clock = new FakeClock();
    const out = await runFor(clock, slowModel(clock, 600_000, true), 660_000);
    expect(out[0]!.stop).toBe('final');
    expect(out[0]!.result).toBe('relatório final.');
  });

  it('a mesma chamada MUDA (sem nenhum evento) segue sendo morta como travada', async () => {
    const clock = new FakeClock();
    const out = await runFor(clock, slowModel(clock, 600_000, false), 660_000);
    expect(out[0]!.stop).toBe('timeout');
  });

  it('atividade de stream não cria um timer por evento (no máximo um por janela)', async () => {
    const clock = new FakeClock();
    let calls = 0;
    const chatty: ModelCaller = {
      async call(args) {
        calls += 1;
        // 1000 eventos, 3s de relógio no total: um provider rápido "falando muito".
        for (let i = 0; i < 1000; i += 1) {
          args.onActivity?.();
          if (i % 100 === 0) await clock.sleep(300);
        }
        return { request_id: 'r', content: 'ok.', finish_reason: 'stop', usage };
      },
    };
    const out = await runFor(clock, chatty, 600_000);
    expect(calls).toBe(1);
    expect(out[0]!.stop).toBe('final');
    // Os `sleep`s do próprio modelo (10) + os do heartbeat: nada perto de 1000.
    expect(clock.armed).toBeLessThan(40);
  });

  it('o limite padrão de inatividade é 5 minutos', () => {
    expect(DEFAULT_SUBAGENT_IDLE_TIMEOUT_MS).toBe(5 * 60 * 1000);
  });
});

// CANCELAMENTO VELHO NO BARRAMENTO DO MAESTRO não pode matar o turno seguinte.
//
// Visto pelo dono em 16/09 (tmux): três agentes, ESC, "ola" — a fala apareceu e nenhum turno
// respondeu; só o segundo "ola" teve resposta. Instrumentado com um provider falso: o turno do
// primeiro "ola" nem chegou à rede e terminou com `final` = "Turno encerrado pelo Maestro
// (regência de fluxo)…".
//
// A causa: ao ver o signal abortado, o loop PUBLICA `human-cancel` no barramento e lança — o
// turno cancelado nunca volta a consultar o Maestro, então o sinal fica lá. O turno SEGUINTE
// faz o primeiro `poll()`, recebe o cancelamento de outro turno e o regente decide `parar`
// (human-cancel é o topo absoluto da precedência).

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import type { MaestroPort } from '../../src/agent/loop.js';
import { PollSignalBus } from '../../src/agent/maestro/bus.js';
import { createSignal } from '../../src/agent/maestro/contract.js';
import { regentDecide } from '../../src/agent/maestro/regent.js';
import { ModelCallAbortedError } from '../../src/model/errors.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

/** O Maestro com o regente REAL (a mesma tabela de precedência de produção). */
function realMaestro(bus: PollSignalBus): MaestroPort {
  return { bus, rege: async (signals) => regentDecide(signals ?? []) };
}

function loop(model: ScriptedModelCaller, bus: PollSignalBus): AgentLoop {
  const { ports } = makePorts();
  return new AgentLoop({
    model,
    permission: allowAllEngine,
    tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
    ports,
    maestro: realMaestro(bus),
  });
}

describe('Maestro — cancelamento de um turno não vaza para o seguinte', () => {
  it('turno cancelado (ESC) e depois um turno novo: o novo chama o modelo e responde', async () => {
    const bus = new PollSignalBus();
    const model = new ScriptedModelCaller([{ text: 'olá! tudo bem?' }]);
    const l = loop(model, bus);

    await expect(l.run('dispara agentes', AbortSignal.abort())).rejects.toThrow(
      ModelCallAbortedError,
    );

    const r = await l.run('ola');
    expect(model.calls, 'o turno novo nem chegou ao modelo').toHaveLength(1);
    expect(r.stop.kind).toBe('final');
    expect(r.stop.kind === 'final' && r.stop.answer).toBe('olá! tudo bem?');
  });

  it('idem no `resume` (continuação do mesmo histórico)', async () => {
    const bus = new PollSignalBus();
    const model = new ScriptedModelCaller([{ text: 'retomei.' }]);
    const l = loop(model, bus);

    await expect(l.run('tarefa', AbortSignal.abort())).rejects.toThrow(ModelCallAbortedError);
    const r = await l.resume([{ role: 'user', text: 'continua' }] as never);
    expect(model.calls).toHaveLength(1);
    expect(r.stop.kind === 'final' && r.stop.answer).toBe('retomei.');
  });

  it('sinais de OUTRAS origens publicados entre turnos NÃO são descartados', async () => {
    const bus = new PollSignalBus();
    const seenOrigins: string[] = [];
    const model = new ScriptedModelCaller([{ text: 'ok.' }]);
    const { ports } = makePorts();
    const l = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
      maestro: {
        bus,
        rege: async (signals) => {
          for (const s of signals ?? []) seenOrigins.push(s.origin);
          return regentDecide(signals ?? []);
        },
      },
    });

    await expect(l.run('t1', AbortSignal.abort())).rejects.toThrow(ModelCallAbortedError);
    bus.publish(createSignal('budget', 'warning', Date.now(), { reason: 'entre turnos' }));
    await l.run('t2');

    expect(seenOrigins).toContain('budget');
    expect(seenOrigins).not.toContain('human-cancel');
  });

  it('um cancelamento DESTE turno continua parando o turno (o freio não enfraquece)', async () => {
    const bus = new PollSignalBus();
    const model = new ScriptedModelCaller([{ text: 'não deveria chegar.' }]);
    const l = loop(model, bus);
    const ac = new AbortController();
    ac.abort();
    await expect(l.run('tarefa', ac.signal)).rejects.toThrow(ModelCallAbortedError);
    expect(model.calls).toHaveLength(0);
  });
});

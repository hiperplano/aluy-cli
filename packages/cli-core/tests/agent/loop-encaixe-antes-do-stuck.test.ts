// Auditoria — ENCAIXE FLUIDO: a mensagem que chega durante a ÚLTIMA tool (batch nativo) ou a
// tool de texto é drenada IMEDIATAMENTE após a tool — ANTES do checkpoint de travamento, que
// pode pausar esperando o dono. Se a drenagem só ocorresse no topo da próxima volta, o "btw"
// ficaria preso atrás da pausa (o dono falou e o aviso de travamento não o mostra/usa).
// Observável: a ordem [drenou, pausou]. Também: o hard-abort concomitante a um expedite PARA.

import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  ExpediteSignal,
  type InjectedInputPort,
  type ModelCaller,
} from '../../src/agent/loop.js';
import { ModelCallAbortedError } from '../../src/model/errors.js';
import { injectedInputItem } from '../../src/agent/input-injection.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { HistoryItem } from '../../src/agent/context.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { StuckAlert, StuckResolution, StuckResolver } from '../../src/agent/stuck-watchdog.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

const registry = (): ToolRegistry<ToolPorts> => new ToolRegistry(NATIVE_TOOLS);

/** Fila que só entrega o item DEPOIS que `liberar()` for chamado; registra a ordem dos eventos. */
function fila(eventos: string[]): { port: InjectedInputPort; liberar: () => void } {
  let pronto = false;
  let entregue = false;
  return {
    liberar: () => {
      pronto = true;
    },
    port: () => {
      if (!pronto || entregue) return [];
      entregue = true;
      eventos.push('drenou');
      return [injectedInputItem('mude o rumo')!] as HistoryItem[];
    },
  };
}

function resolverQueRegistra(eventos: string[]): StuckResolver {
  return {
    async resolve(_alerta: StuckAlert): Promise<StuckResolution> {
      eventos.push('pausou');
      return { kind: 'end' };
    },
  };
}

describe('encaixe fluido · a drenagem precede (e evita) a pausa de travamento', () => {
  it('batch nativo: msg chegada na ÚLTIMA tool é drenada antes do checkpoint (sem pausa)', async () => {
    const eventos: string[] = [];
    const q = fila(eventos);
    const base = makePorts({ fs: new MemoryFs(new Map([['a.md', 'A']])) }).ports;
    let leituras = 0;
    const ports: ToolPorts = {
      ...base,
      fs: {
        readFile: async (p: string) => {
          leituras += 1;
          if (leituras === 4) q.liberar();
          return base.fs.readFile(p);
        },
        writeFile: base.fs.writeFile.bind(base.fs),
        exists: base.fs.exists.bind(base.fs),
      } as ToolPorts['fs'],
    };
    const quatro = ['c1', 'c2', 'c3', 'c4'].map((id) => ({
      id,
      name: 'read_file',
      input: { path: 'a.md' },
    }));
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([{ toolCalls: quatro }, { text: 'fim.' }]),
      permission: allowAllEngine,
      tools: registry(),
      ports,
      pollInjected: q.port,
      stuckResolver: resolverQueRegistra(eventos),
      env: {},
    });
    await loop.run('tarefa');
    // input fresco do dono zera as séries do watchdog: drenar ANTES do checkpoint evita a pausa.
    expect(eventos).toEqual(['drenou']);
  });

  it('tool de texto: msg chegada durante a tool é drenada antes do checkpoint (sem pausa)', async () => {
    const eventos: string[] = [];
    const q = fila(eventos);
    const base = makePorts({ fs: new MemoryFs(new Map([['a.md', 'A']])) }).ports;
    let leituras = 0;
    const ports: ToolPorts = {
      ...base,
      fs: {
        readFile: async (p: string) => {
          leituras += 1;
          if (leituras === 4) q.liberar();
          return base.fs.readFile(p);
        },
        writeFile: base.fs.writeFile.bind(base.fs),
        exists: base.fs.exists.bind(base.fs),
      } as ToolPorts['fs'],
    };
    const chamada = { text: toolCallBlock('read_file', { path: 'a.md' }) };
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([chamada, chamada, chamada, chamada, { text: 'fim.' }]),
      permission: allowAllEngine,
      tools: registry(),
      ports,
      pollInjected: q.port,
      stuckResolver: resolverQueRegistra(eventos),
      env: {},
    });
    await loop.run('tarefa');
    // input fresco do dono zera as séries do watchdog: drenar ANTES do checkpoint evita a pausa.
    expect(eventos).toEqual(['drenou']);
  });
});

describe('expedite concorrente com hard-abort', () => {
  it('Ctrl-C junto de um ESC-expedite PARA o loop (o hard-abort tem precedência)', async () => {
    const { ports } = makePorts();
    const expedite = new ExpediteSignal();
    let chamadas = 0;
    let comecou!: () => void;
    const iniciou = new Promise<void>((r) => {
      comecou = r;
    });
    const model: ModelCaller = {
      async call(args) {
        chamadas += 1;
        if (chamadas > 1) {
          return { request_id: 'r', content: 'não devia chegar', finish_reason: 'stop' };
        }
        comecou();
        return new Promise((_ok, falha) => {
          args.signal?.addEventListener('abort', () => falha(new ModelCallAbortedError()), {
            once: true,
          });
        });
      },
    };
    const ctrl = new AbortController();
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      expedite,
    });
    const rodando = loop.run('tarefa', ctrl.signal);
    await iniciou;
    // os dois freios ao mesmo tempo: o duro vence, o loop NÃO re-planeja.
    expedite.fire();
    ctrl.abort();
    await expect(rodando).rejects.toBeInstanceOf(ModelCallAbortedError);
    expect(chamadas).toBe(1);
  });
});

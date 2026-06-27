// EST-MON-1 · ADR-0079 (APR-0084) — DRENAGEM dos eventos de MONITOR no loop.
//
// Um monitor que disparou ENQUANTO o agente rodava entra no histórico do turno como
// `observation` (DADO NÃO-CONFIÁVEL, CLI-SEC-4) — drenado no MESMO ponto do "btw", logo
// após ele. PROVAS (caller roteirizado, sem modelo real):
//  1. o evento aparece na chamada do modelo ENVELOPADO como DADO_NAO_CONFIAVEL (não como
//     instrução do dono);
//  2. o loop emite `onProgress({ kind: 'monitor', count })`;
//  3. sem a porta `monitorQueue` ⇒ baseline (zero regressão — nada injetado).

import { describe, expect, it } from 'vitest';
import { AgentLoop, type ProgressSignal } from '../../src/agent/loop.js';
import { EventQueue, type MonitorEvent } from '../../src/agent/monitor/event-queue.js';
import type { StuckAlert, StuckResolution, StuckResolver } from '../../src/agent/stuck-watchdog.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { MemoryFs, ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

const EV: MonitorEvent = {
  monitorId: 'm1',
  label: 'testes',
  type: 'command-poll',
  condition: 'exit_code != 0',
  payload: 'npm test falhou (exit 1)',
  firedAt: '2026-06-11T03:10:00Z',
};

describe('EST-MON-1 — drenagem de eventos de monitor no loop', () => {
  it('o evento entra na chamada do modelo ENVELOPADO como DADO (observation, não instrução)', async () => {
    const { ports } = makePorts();
    const captured: Array<{ role: string; content: string }> = [];
    const model = new (class extends ScriptedModelCaller {
      override async call(args: Parameters<ScriptedModelCaller['call']>[0]) {
        for (const m of args.messages) captured.push({ role: m.role, content: m.content });
        return super.call(args);
      }
    })([{ text: 'vi o disparo do monitor; pronto.' }]);

    const monitorQueue = new EventQueue();
    monitorQueue.enqueue(EV);

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      monitorQueue,
    });
    await loop.run('faça a tarefa');

    // O texto do evento chegou ao modelo, ENVELOPADO como DADO NÃO-CONFIÁVEL.
    const data = captured.find(
      (m) =>
        m.content.includes('[monitor: testes] disparou.') &&
        m.content.includes('DADO_NAO_CONFIAVEL'),
    );
    expect(data).toBeDefined();
    // É DADO de AMBIENTE (canal `user` envelopado, igual a uma observação de tool), NUNCA
    // `system` (não é instrução privilegiada).
    const inSystem = captured.some(
      (m) => m.role === 'system' && m.content.includes('[monitor: testes]'),
    );
    expect(inSystem).toBe(false);
    // A fila foi consumida.
    expect(monitorQueue.pending()).toBe(0);
  });

  it('emite onProgress({ kind: "monitor", count })', async () => {
    const { ports } = makePorts();
    const signals: ProgressSignal[] = [];
    const monitorQueue = new EventQueue();
    monitorQueue.enqueue(EV);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([{ text: 'ok.' }]),
      permission: allowAllEngine,
      tools: registry(),
      ports,
      monitorQueue,
      onProgress: (s) => signals.push(s),
    });
    await loop.run('tarefa');
    const mon = signals.find((s) => s.kind === 'monitor');
    expect(mon).toBeDefined();
    if (mon?.kind === 'monitor') expect(mon.count).toBe(1);
  });

  it('SEM monitorQueue ⇒ baseline (nenhum texto de monitor no contexto — zero regressão)', async () => {
    const { ports } = makePorts();
    const captured: string[] = [];
    const model = new (class extends ScriptedModelCaller {
      override async call(args: Parameters<ScriptedModelCaller['call']>[0]) {
        for (const m of args.messages) captured.push(m.content);
        return super.call(args);
      }
    })([{ text: 'pronto.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      // sem monitorQueue
    });
    await loop.run('tarefa');
    expect(captured.some((c) => c.includes('[monitor:'))).toBe(false);
  });
});

// EST-0969 (watchdog) × EST-MON-1 — a drenagem de eventos de monitor NÃO pode contar
// a volta como uma 2ª iteração ESTÉRIL (achado #1 do hunt do watchdog #267). A volta
// JÁ é contada no topo da iteração (`noteIteration`); o evento de monitor que chega é
// PROGRESSO (algo do mundo entrou no contexto), não esterilidade. ANTES do fix, o
// `noteIteration` DUPLICADO no caminho de monitor (a) contava o `staleIterations` em
// DOBRO e (b) marcava como estéril uma volta que representa progresso — empurrando o
// `no-progress` a disparar CEDO demais.
describe('EST-0969 — monitor drain NÃO conta volta estéril em dobro (no-progress não dispara cedo)', () => {
  // Captura quantas vezes (e com qual padrão) o watchdog pediu direção.
  class RecordingResolver implements StuckResolver {
    readonly alerts: StuckAlert[] = [];
    async resolve(alert: StuckAlert): Promise<StuckResolution> {
      this.alerts.push(alert);
      return { kind: 'continue' }; // ignora e segue (reseta o detector)
    }
  }

  it('UMA iteração com evento de monitor NÃO dispara no-progress (sem dobro de stale)', async () => {
    // FS com um arquivo p/ a tool read_file ter sucesso (caminho feliz do loop).
    const fs = new MemoryFs(new Map([['a.ts', 'export const x = 1;']]));
    const { ports } = makePorts({ fs });
    const monitorQueue = new EventQueue();
    monitorQueue.enqueue(EV);
    const resolver = new RecordingResolver();

    // 1ª resposta: uma tool-call nativa (faz o loop seguir ATÉ o checkStuck pós-tool,
    // onde um alerta pendente seria drenado/disparado); 2ª: final.
    const model = new ScriptedModelCaller([
      { toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }], text: '' },
      { text: 'pronto.' },
    ]);

    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      monitorQueue,
      stuckResolver: resolver,
      // Limiar de no-progress = 2: o DOBRO de uma única volta JÁ cruzaria (bug);
      // com o fix, a drenagem é PROGRESSO (zera o stale) ⇒ NÃO cruza.
      env: { ALUY_STUCK_STALE_ITERS: '2' },
    });
    await loop.run('faça a tarefa');

    // O evento foi de fato drenado (caminho de monitor executou).
    expect(monitorQueue.pending()).toBe(0);
    // E o watchdog NÃO pediu direção por no-progress — a volta com evento-do-mundo
    // não é estéril, e não foi contada em dobro.
    expect(resolver.alerts.some((a) => a.kind === 'no-progress')).toBe(false);
  });
});

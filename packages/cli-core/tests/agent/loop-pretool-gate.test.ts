// EST-0980 · CLI-SEC-3/H1 — GATE de PRE-TOOL no LOOP: composição MONOTÔNICA com a catraca.
//
// PROVA (sem modelo real — caller roteirizado):
//  1. catraca PERMITE + gate VETA ⇒ a tool NÃO roda (a observação é o veto, não o efeito);
//  2. catraca NEGA ⇒ o gate NEM é consultado (um hook não pode "salvar" o que a catraca
//     barrou — CLI-SEC-3 não-relaxável). `executa = decide()==allow AND gate!=blocked`;
//  3. catraca permite + gate NÃO veta ⇒ a tool roda normal;
//  4. sem gate ⇒ baseline (o loop roda idêntico).
//
// O gate é um AND lógico: ele só pode SOMAR um veto, NUNCA aprovar/relaxar.

import { describe, expect, it } from 'vitest';
import { AgentLoop, type PreToolGate } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { ToolCall } from '../../src/permission/gate.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  allowReadOnlyEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

/** Gate que VETA toda chamada de uma tool nomeada; o resto passa. Registra o que viu. */
function vetoGateFor(toolName: string): { gate: PreToolGate; seen: string[] } {
  const seen: string[] = [];
  const gate: PreToolGate = (call: ToolCall) => {
    seen.push(call.name);
    return call.name === toolName
      ? { blocked: true, observation: `VETADO pelo hook: ${call.name}` }
      : { blocked: false };
  };
  return { gate, seen };
}

describe('EST-0980 · PreToolGate no loop — AND com a catraca (só REFORÇA, nunca relaxa)', () => {
  it('catraca ALLOW + gate VETA ⇒ a tool NÃO roda; a observação é o veto', async () => {
    const fs = new MemoryFs(new Map([['secrets.txt', 'CONTEUDO-SECRETO']]));
    const { ports } = makePorts({ fs });
    const { gate, seen } = vetoGateFor('read_file');
    const model = new ScriptedModelCaller([
      { text: `vou ler.\n${toolCallBlock('read_file', { path: 'secrets.txt' })}` },
      { text: 'ok, segui sem ler — pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine, // a CATRACA libera; o veto vem SÓ do gate.
      tools: registry(),
      ports,
      preToolGate: gate,
    });
    await loop.run('leia o arquivo');
    // O gate foi consultado (catraca permitiu) e a tool NÃO executou: a próxima chamada
    // do modelo recebeu a OBSERVAÇÃO de veto, não o conteúdo do arquivo.
    expect(seen).toContain('read_file');
    const sawVeto = model.calls.some((c) => (c.lastUserContent ?? '').includes('VETADO pelo hook'));
    const sawSecret = model.calls.some((c) =>
      (c.lastUserContent ?? '').includes('CONTEUDO-SECRETO'),
    );
    expect(sawVeto).toBe(true);
    expect(sawSecret).toBe(false); // a tool não rodou ⇒ o conteúdo nunca voltou.
  });

  it('catraca DENY ⇒ o gate NEM é consultado (não pode salvar o que a catraca negou)', async () => {
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const { gate, seen } = vetoGateFor('__nunca__');
    // allowReadOnlyEngine NEGA write_file (efeito) ⇒ a tool é bloqueada pela CATRACA,
    // ANTES do gate. O gate não é chamado p/ uma tool que a catraca já negou.
    const model = new ScriptedModelCaller([
      { text: `vou escrever.\n${toolCallBlock('write_file', { path: 'b.txt', content: 'y' })}` },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowReadOnlyEngine,
      tools: registry(),
      ports,
      preToolGate: gate,
    });
    await loop.run('escreva b.txt');
    // O gate NUNCA viu o write_file: a catraca o barrou antes (composição correta).
    expect(seen).not.toContain('write_file');
  });

  it('catraca ALLOW + gate NÃO veta ⇒ a tool roda normal', async () => {
    const fs = new MemoryFs(new Map([['ok.txt', 'VALOR-VISIVEL']]));
    const { ports } = makePorts({ fs });
    const { gate } = vetoGateFor('__outra__'); // não veta read_file
    const model = new ScriptedModelCaller([
      { text: `lendo.\n${toolCallBlock('read_file', { path: 'ok.txt' })}` },
      { text: 'li, pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports,
      preToolGate: gate,
    });
    await loop.run('leia ok.txt');
    const sawValue = model.calls.some((c) => (c.lastUserContent ?? '').includes('VALOR-VISIVEL'));
    expect(sawValue).toBe(true); // a tool rodou: o conteúdo voltou ao modelo.
  });

  it('sem gate ⇒ baseline (a tool roda igual)', async () => {
    const fs = new MemoryFs(new Map([['c.txt', 'BASELINE']]));
    const { ports } = makePorts({ fs });
    const model = new ScriptedModelCaller([
      { text: `lendo.\n${toolCallBlock('read_file', { path: 'c.txt' })}` },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({ model, permission: allowAllEngine, tools: registry(), ports });
    await loop.run('leia c.txt');
    expect(model.calls.some((c) => (c.lastUserContent ?? '').includes('BASELINE'))).toBe(true);
  });
});

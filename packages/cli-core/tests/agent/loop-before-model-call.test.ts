// PROMPT-ENXUTO — gancho `beforeModelCall`: o loop o AGUARDA antes de listar as tools e
// montar o prompt de CADA chamada ao modelo (o controller o usa p/ esperar o boot MCP).
// Antes só o registry (`awaitMcpSettled`) era testado; aqui provamos a COSTURA no loop.

import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { NativeTool, ToolPorts } from '../../src/agent/tools/types.js';
import { ScriptedModelCaller, allowAllEngine, makePorts, toolCallBlock } from './helpers.js';

const toolTardia: NativeTool<ToolPorts> = {
  name: 'mcp__tardio__ferramenta_unica',
  description: 'descricao-da-tool-tardia',
  effect: 'read',
  run: async () => ({ content: 'ok' }),
};

describe('AgentLoop · beforeModelCall (espera o boot MCP antes da 1ª chamada)', () => {
  it('aguarda o gancho ANTES da chamada ao modelo: a tool registrada durante a espera já está no prompt', async () => {
    const registry = new ToolRegistry<ToolPorts>(NATIVE_TOOLS);
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'pronto.' }]);
    const ordem: string[] = [];
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry,
      ports,
      beforeModelCall: async () => {
        ordem.push('gancho-inicio');
        // Simula o handshake MCP terminando DURANTE a espera (assíncrono).
        await new Promise((r) => setTimeout(r, 5));
        registry.register(toolTardia);
        ordem.push('gancho-fim');
      },
    });
    await loop.run('oi');
    expect(ordem).toEqual(['gancho-inicio', 'gancho-fim']);
    // Sem o `await` do gancho, o prompt da 1ª chamada sairia SEM a tool tardia.
    expect(model.calls[0]!.systemContent).toContain('mcp__tardio__ferramenta_unica');
  });

  it('é consultado a CADA chamada ao modelo (uma por iteração)', async () => {
    const registry = new ToolRegistry<ToolPorts>(NATIVE_TOOLS);
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([
      { text: `vou listar.\n${toolCallBlock('list_dir', { path: '.' })}` },
      { text: 'pronto.' },
    ]);
    let chamadas = 0;
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry,
      ports,
      beforeModelCall: async () => {
        chamadas += 1;
      },
    });
    await loop.run('oi');
    expect(chamadas).toBe(model.calls.length);
    expect(chamadas).toBeGreaterThanOrEqual(2);
  });

  it('um gancho que REJEITA nunca derruba o turno (best-effort)', async () => {
    const { ports } = makePorts();
    const model = new ScriptedModelCaller([{ text: 'segui em frente.' }]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
      beforeModelCall: async () => {
        throw new Error('boom');
      },
    });
    const res = await loop.run('oi');
    expect(res.stop.kind).toBe('final');
  });
});

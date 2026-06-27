// EST-0970 — teste unitário do `replaceMcpTools` do ToolRegistry: substituição AO VIVO
// das tools MCP sem reiniciar a sessão. Cobre:
//   (1) replaceMcpTools SEM scope → remove TODAS as `mcp__*` e registra as novas;
//   (2) replaceMcpTools COM scope → remove só `mcp__${scope}__*`, mantém as outras;
//   (3) unregister básico.

import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../../../src/agent/tools/registry.js';
import type { NativeTool, ToolEffect } from '../../../src/agent/tools/types.js';

/** Tool nativa fake (não executa ferramenta real, só existe no registro). */
function fake(name: string): NativeTool {
  return {
    name,
    description: `fake ${name}`,
    effect: 'read' as ToolEffect,
    run: async () => ({ content: 'ok' }),
  };
}

describe('ToolRegistry.replaceMcpTools', () => {
  it('SEM scope: remove TODAS as mcp__* e registra as novas', () => {
    const reg = new ToolRegistry([fake('read'), fake('mcp__a__x'), fake('mcp__b__y')]);

    reg.replaceMcpTools([fake('mcp__a__z')]);

    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['mcp__a__z', 'read']);
  });

  it('COM scope "a": remove só mcp__a__*, mantém mcp__b__* + nativas', () => {
    const reg = new ToolRegistry([fake('read'), fake('mcp__a__x'), fake('mcp__b__y')]);

    reg.replaceMcpTools([fake('mcp__a__z')], 'a');

    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['mcp__a__z', 'mcp__b__y', 'read']);
  });

  it('scope "b": remove só mcp__b__*, mantém mcp__a__* + nativas', () => {
    const reg = new ToolRegistry([fake('read'), fake('mcp__a__x'), fake('mcp__b__y')]);

    reg.replaceMcpTools([fake('mcp__b__w')], 'b');

    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['mcp__a__x', 'mcp__b__w', 'read']);
  });

  it('scope inexistente: não remove nada, só adiciona novas', () => {
    const reg = new ToolRegistry([fake('read'), fake('mcp__a__x')]);

    reg.replaceMcpTools([fake('mcp__c__v')], 'c');

    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['mcp__a__x', 'mcp__c__v', 'read']);
  });

  it('newTools vazio SEM scope: remove TODAS mcp__* e só sobram nativas', () => {
    const reg = new ToolRegistry([fake('read'), fake('mcp__a__x'), fake('mcp__b__y')]);

    reg.replaceMcpTools([]);

    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['read']);
  });

  it('newTools vazio COM scope "a": remove só mcp__a__*, mantém as outras', () => {
    const reg = new ToolRegistry([fake('read'), fake('mcp__a__x'), fake('mcp__b__y')]);

    reg.replaceMcpTools([], 'a');

    const names = reg
      .list()
      .map((t) => t.name)
      .sort();
    expect(names).toEqual(['mcp__b__y', 'read']);
  });
});

describe('ToolRegistry.unregister', () => {
  it('remove tool existente → true', () => {
    const reg = new ToolRegistry([fake('read')]);
    expect(reg.unregister('read')).toBe(true);
    expect(reg.has('read')).toBe(false);
  });

  it('remove tool inexistente → false', () => {
    const reg = new ToolRegistry([fake('read')]);
    expect(reg.unregister('ghost')).toBe(false);
  });
});

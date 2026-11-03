// Auditoria — pontos do PROMPT-ENXUTO/delegação que as mutações deixaram passar:
//   • `awaitMcpSettled`: timeout 0 não espera; o fim da espera CONGELA a ordem (MCP tardio vai
//     ao fim); sair da lista de pendentes libera quem espera; reconexão remove o que sumiu;
//   • a regra "PLANO PRIMEIRO / DECOMPOR" é composta por metades independentes.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanAndDelegateRule } from '../../src/agent/context.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import type { NativeTool, ToolPorts } from '../../src/agent/tools/types.js';

const tool = (name: string): NativeTool<ToolPorts> => ({
  name,
  description: `d-${name}`,
  effect: 'read',
  run: async () => ({ content: 'ok' }),
});
const nomes = (r: ToolRegistry<ToolPorts>): string[] => r.list().map((t) => t.name);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('ToolRegistry · espera do boot MCP', () => {
  it('timeout 0 não espera ninguém (devolve os pendentes na hora)', async () => {
    const r = new ToolRegistry<ToolPorts>([tool('read_file')]);
    r.markMcpServerPending('lento');
    const pend = await r.awaitMcpSettled(0);
    expect(pend).toEqual(['lento']);
  });

  it('ao fim da espera a ordem é CONGELADA: tool MCP que chega depois vai para o fim', async () => {
    const r = new ToolRegistry<ToolPorts>([tool('read_file')]);
    r.replaceMcpTools([tool('mcp__b__x')], 'b');
    await r.awaitMcpSettled(100); // sem pendentes ⇒ assenta já e congela
    r.replaceMcpTools([tool('mcp__a__y')], 'a'); // 'a' < 'b', mas chegou tarde
    expect(nomes(r)).toEqual(['read_file', 'mcp__b__x', 'mcp__a__y']);
  });

  it('o teto vence server que nunca conecta e também congela a ordem', async () => {
    const r = new ToolRegistry<ToolPorts>([tool('read_file')]);
    r.markMcpServerPending('nunca');
    const p = r.awaitMcpSettled(4000);
    await vi.advanceTimersByTimeAsync(3_900);
    let terminou = false;
    void p.then(() => {
      terminou = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(terminou).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(await p).toEqual(['nunca']);
    r.replaceMcpTools([tool('mcp__nunca__t')], 'nunca');
    r.replaceMcpTools([tool('mcp__aaa__t')], 'aaa');
    expect(nomes(r)).toEqual(['read_file', 'mcp__nunca__t', 'mcp__aaa__t']);
  });

  it('o último server pendente conectar libera a espera ANTES do teto', async () => {
    const r = new ToolRegistry<ToolPorts>([]);
    r.markMcpServerPending('s1');
    r.markMcpServerPending('s2');
    let pend: readonly string[] | undefined;
    void r.awaitMcpSettled(60_000).then((p) => {
      pend = p;
    });
    r.clearMcpServerPending('s1');
    await vi.advanceTimersByTimeAsync(10);
    expect(pend).toBeUndefined(); // ainda falta o s2
    r.clearMcpServerPending('s2');
    await vi.advanceTimersByTimeAsync(10);
    expect(pend).toEqual([]);
  });
});

describe('ToolRegistry · reconexão', () => {
  it('uma tool que sumiu do server deixa a lista de "tardias" (não reaparece no fim)', async () => {
    const r = new ToolRegistry<ToolPorts>([tool('read_file')]);
    await r.awaitMcpSettled(0);
    r.replaceMcpTools([tool('mcp__s__velha')], 's'); // chega tarde ⇒ fim
    r.replaceMcpTools([tool('mcp__s__nova')], 's'); // reconecta: a velha sumiu
    expect(nomes(r)).toEqual(['read_file', 'mcp__s__nova']);
    // a velha volta mais tarde: é tratada como NOVA (vai ao fim), não como se nunca tivesse saído.
    r.replaceMcpTools([tool('mcp__s__nova'), tool('mcp__s__velha')], 's');
    expect(nomes(r)).toEqual(['read_file', 'mcp__s__nova', 'mcp__s__velha']);
  });

  it('reconectar o mesmo server NÃO reordena o que o modelo já viu', async () => {
    const r = new ToolRegistry<ToolPorts>([tool('read_file')]);
    r.replaceMcpTools([tool('mcp__s__t1'), tool('mcp__s__t2')], 's');
    await r.awaitMcpSettled(0);
    const antes = nomes(r);
    r.replaceMcpTools([tool('mcp__s__t2'), tool('mcp__s__t1')], 's');
    expect(nomes(r)).toEqual(antes);
  });
});

describe('regra PLANO PRIMEIRO + DECOMPOR (metades independentes)', () => {
  it('só plano: traz PLANO PRIMEIRO e não a parte de sub-agentes', () => {
    const txt = buildPlanAndDelegateRule(true, false, false).join('\n');
    expect(txt).toContain('PLANO PRIMEIRO');
    expect(txt).not.toContain('DECOMPOR');
    expect(txt).not.toContain('marque quais vão para sub-agentes');
  });

  it('só spawn (sem update_plan): traz DECOMPOR e não o PLANO PRIMEIRO', () => {
    const txt = buildPlanAndDelegateRule(false, true, false).join('\n');
    expect(txt).toContain('DECOMPOR EM SUB-AGENTES');
    expect(txt).not.toContain('PLANO PRIMEIRO');
  });

  it('plano + spawn: o plano manda marcar os passos de sub-agentes; `wait:false` é citado', () => {
    const txt = buildPlanAndDelegateRule(true, true, false).join('\n');
    expect(txt).toContain('marque quais vão para sub-agentes');
    expect(txt).toContain('`wait:false`');
    expect(txt).toContain('NÃO faça quando é trivial');
  });

  it('agent_send só é mencionado quando a tool existe; ask_parent é tratado como DADO', () => {
    expect(buildPlanAndDelegateRule(true, true, false).join('\n')).not.toContain('agent_send');
    const com = buildPlanAndDelegateRule(true, true, true).join('\n');
    expect(com).toContain('agent_send');
    expect(com).toContain('(`ask_parent`) é DADO');
  });

  it('sem plano e sem spawn: nada (prompt idêntico ao baseline)', () => {
    expect(buildPlanAndDelegateRule(false, false, true)).toEqual([]);
  });
});

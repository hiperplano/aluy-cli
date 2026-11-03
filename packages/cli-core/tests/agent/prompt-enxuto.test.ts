// PROMPT-ENXUTO — catálogo de tools sem duplicata, ordem estável e prompt amigável ao cache.
//   • catálogo em TEXTO ausente sse o `tools` nativo vai no request (mesma flag no caller);
//   • fallback (422 / supports_tools:false / sem nativo) renderiza o catálogo completo;
//   • ordem das tools: nativas fixas, MCP por (server, nome), independe da ordem de conexão;
//   • tool MCP tardia (após congelar) vai ao FIM; espera do boot MCP tem teto;
//   • parte dinâmica (runtime/raízes) é a ÚLTIMA do system; prompt idêntico entre chamadas.

import { describe, expect, it, vi } from 'vitest';
import { buildMessages, buildSystemPrompt } from '../../src/agent/context.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { BrokerModelCaller } from '../../src/agent/model-caller.js';
import { NativeToolsCapability } from '../../src/agent/native-tools.js';
import { BrokerError } from '../../src/model/errors.js';
import type { NativeTool, ToolEffect } from '../../src/agent/tools/types.js';
import type { ChatMessage, ModelCallRequest } from '../../src/model/types.js';

function fakeTool(name: string): NativeTool {
  return {
    name,
    description: `descricao-unica-de-${name}`,
    effect: 'read' as ToolEffect,
    run: async () => ({ content: 'ok' }),
  };
}
const CATALOGO = 'Ferramentas disponíveis:';
const sysOf = (m: readonly ChatMessage[]): string => String(m[0]!.content);

describe('system prompt: catálogo em texto vs nativo', () => {
  const tools = [...NATIVE_TOOLS, fakeTool('mcp__a__x')];
  const sp = (native: boolean | undefined, extra: Partial<{ agents: string }> = {}): string =>
    buildSystemPrompt(
      tools,
      undefined,
      undefined,
      extra.agents,
      undefined,
      'custom',
      undefined,
      native,
    );

  it('nativo ativo: SEM o catálogo em texto, mantém o MAPA, as regras e o few-shot', () => {
    const s = sp(true);
    expect(s).not.toContain(CATALOGO);
    expect(s).not.toContain('descricao-unica-de-mcp__a__x');
    expect(s).toContain('MAPA DE CAPACIDADES');
    expect(s).toContain('REGRA DE SEGURANÇA');
    expect(s).toContain('EXEMPLOS (few-shot)');
  });

  it('fallback (flag off/ausente): catálogo completo', () => {
    for (const flag of [false, undefined]) {
      const s = sp(flag);
      expect(s).toContain(CATALOGO);
      expect(s).toContain('descricao-unica-de-mcp__a__x');
    }
  });

  it('o system nativo é menor que o de fallback', () => {
    expect(sp(true).length).toBeLessThan(sp(false).length);
  });

  it('runtime e raízes são a parte FINAL do system, depois de todo o conteúdo estável', () => {
    const s = buildSystemPrompt(
      tools,
      'instrucoes do projeto',
      ['/tmp/proj'],
      'NOTA DE AGENTES',
      'SESSION-CMDS',
      'custom',
      { provider: 'zai-coding', model: 'glm-5.3' },
      true,
    );
    const iRuntime = s.indexOf('Você está rodando via zai-coding');
    const iRoots = s.indexOf('Raízes AUTORIZADAS');
    expect(iRuntime).toBeGreaterThan(0);
    for (const stable of [
      'REGRA DE SEGURANÇA',
      'EXEMPLOS (few-shot)',
      'SESSION-CMDS',
      'MAPA DE CAPACIDADES',
      'SERVERS MCP',
      'NOTA DE AGENTES',
      'instrucoes do projeto',
    ]) {
      const i = s.indexOf(stable);
      expect(i).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(iRuntime);
      expect(i).toBeLessThan(iRoots);
    }
    expect(iRuntime).toBeLessThan(iRoots);
    expect(s.trimEnd().endsWith('(você NÃO tem ferramenta para isso).')).toBe(true);
  });

  it('plano e delegação continuam presentes no modo nativo', () => {
    const s = sp(true, { agents: 'NOTA DE AGENTES' });
    expect(s).toContain('DELEGAÇÃO É O PADRÃO');
    if (tools.some((t) => t.name === 'update_plan')) expect(s).toContain('PLANO PRIMEIRO');
  });

  it('mesmas entradas: system byte-idêntico entre chamadas', () => {
    const mk = (): ChatMessage[] =>
      buildMessages(
        tools,
        [{ role: 'goal', text: 'oi' }],
        undefined,
        ['/p'],
        undefined,
        'x',
        'custom',
        { provider: 'p', model: 'm' },
        true,
      );
    expect(JSON.stringify(mk())).toBe(JSON.stringify(mk()));
  });
});

describe('ToolRegistry: ordem estável do catálogo', () => {
  const natives = (): NativeTool[] => [fakeTool('read'), fakeTool('write')];
  const names = (r: ToolRegistry): string[] => r.list().map((t) => t.name);

  it('MCP ordenado por server e nome, independente da ordem de conexão', () => {
    const r1 = new ToolRegistry(natives());
    r1.replaceMcpTools([fakeTool('mcp__b__z'), fakeTool('mcp__b__a')], 'b');
    r1.replaceMcpTools([fakeTool('mcp__a__y')], 'a');
    const r2 = new ToolRegistry(natives());
    r2.replaceMcpTools([fakeTool('mcp__a__y')], 'a');
    r2.replaceMcpTools([fakeTool('mcp__b__a'), fakeTool('mcp__b__z')], 'b');
    expect(names(r1)).toEqual(['read', 'write', 'mcp__a__y', 'mcp__b__a', 'mcp__b__z']);
    expect(names(r2)).toEqual(names(r1));
  });

  it('server tardio (após congelar) entra no FIM, sem reordenar o resto', () => {
    const r = new ToolRegistry(natives());
    r.replaceMcpTools([fakeTool('mcp__m__t')], 'm');
    r.freezeMcpOrder();
    r.replaceMcpTools([fakeTool('mcp__a__t')], 'a');
    expect(names(r)).toEqual(['read', 'write', 'mcp__m__t', 'mcp__a__t']);
    r.replaceMcpTools([fakeTool('mcp__m__t')], 'm'); // reconectar mantém a posição
    expect(names(r)).toEqual(['read', 'write', 'mcp__m__t', 'mcp__a__t']);
  });

  it('awaitMcpSettled resolve quando o último server conecta (sem esperar o teto)', async () => {
    const r = new ToolRegistry(natives());
    r.markMcpServerPending('a');
    r.markMcpServerPending('b');
    const p = r.awaitMcpSettled(10_000);
    r.replaceMcpTools([fakeTool('mcp__a__t')], 'a');
    r.clearMcpServerPending('a');
    r.replaceMcpTools([fakeTool('mcp__b__t')], 'b');
    r.clearMcpServerPending('b');
    expect(await p).toEqual([]);
  });

  it('awaitMcpSettled tem TETO: server lento não trava, e ao chegar vai pro fim', async () => {
    vi.useFakeTimers();
    try {
      const r = new ToolRegistry(natives());
      r.markMcpServerPending('lento');
      const p = r.awaitMcpSettled(3000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(await p).toEqual(['lento']);
      r.replaceMcpTools([fakeTool('mcp__lento__t')], 'lento');
      expect(names(r)).toEqual(['read', 'write', 'mcp__lento__t']);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('caller: a MESMA flag decide `tools` no body e a variante do system', () => {
  const full: ChatMessage[] = [{ role: 'system', content: 'COMPLETO' }];
  const lean: ChatMessage[] = [{ role: 'system', content: 'ENXUTO' }];
  const cap = (opts?: { supportsTools?: boolean }): NativeToolsCapability =>
    new NativeToolsCapability({
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: {} } }],
      ...opts,
    });
  const mk = (nativeTools: NativeToolsCapability | undefined, failFirst = false) => {
    const reqs: ModelCallRequest[] = [];
    let n = 0;
    const client = {
      call: vi.fn(async (a: { request: ModelCallRequest }) => {
        reqs.push(a.request);
        n += 1;
        if (failFirst && n === 1) {
          throw new BrokerError({ status: 422, code: 'TOOLS_UNSUPPORTED', title: 'x' });
        }
        return { request_id: 'r', content: 'ok', finish_reason: 'stop' } as never;
      }),
    };
    const caller = new BrokerModelCaller({
      client: client as never,
      tier: 'custom',
      ...(nativeTools ? { nativeTools } : {}),
    });
    return { caller, reqs };
  };
  const call = (c: BrokerModelCaller) =>
    c.call({ messages: full, messagesNative: lean, idempotencyKey: 'k' });

  it('tools nativo enviado: system ENXUTO', async () => {
    const { caller, reqs } = mk(cap());
    await call(caller);
    expect(reqs[0]!.tools).toBeDefined();
    expect(sysOf(reqs[0]!.messages)).toBe('ENXUTO');
  });

  it('supports_tools:false: sem tools E system COMPLETO', async () => {
    const { caller, reqs } = mk(cap({ supportsTools: false }));
    await call(caller);
    expect(reqs[0]!.tools).toBeUndefined();
    expect(sysOf(reqs[0]!.messages)).toBe('COMPLETO');
  });

  it('sem capacidade nativa: COMPLETO', async () => {
    const { caller, reqs } = mk(undefined);
    await call(caller);
    expect(reqs[0]!.tools).toBeUndefined();
    expect(sysOf(reqs[0]!.messages)).toBe('COMPLETO');
  });

  it('422 TOOLS_UNSUPPORTED: retry sem tools usa o system COMPLETO e não volta ao nativo', async () => {
    const { caller, reqs } = mk(cap(), true);
    await call(caller);
    expect(reqs).toHaveLength(2);
    expect(reqs[0]!.tools).toBeDefined();
    expect(sysOf(reqs[0]!.messages)).toBe('ENXUTO');
    expect(reqs[1]!.tools).toBeUndefined();
    expect(sysOf(reqs[1]!.messages)).toBe('COMPLETO');
    await call(caller);
    expect(reqs[2]!.tools).toBeUndefined();
    expect(sysOf(reqs[2]!.messages)).toBe('COMPLETO');
  });
});

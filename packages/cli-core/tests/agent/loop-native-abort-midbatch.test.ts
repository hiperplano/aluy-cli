// HUNT-LOOP — bug-hunt: abort (esc/Ctrl-C) a MEIO de um batch de tool_calls
// NATIVO não era checado ENTRE as calls ⇒ tools de EFEITO seguiam rodando depois
// do usuário já ter cancelado. O loop só reavaliava o signal no topo da PRÓXIMA
// iteração. Tools rápidas (write_file) não observam o cancelamento por si.
import { describe, it, expect } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { ModelCallAbortedError } from '../../src/model/errors.js';
import type { NativeToolCall } from '../../src/model/types.js';
import { ScriptedModelCaller, MemoryFs, makePorts, allowAllEngine } from './helpers.js';

function tc(id: string, name: string, input: Record<string, unknown>): NativeToolCall {
  return { id, name, input };
}
const tools = () => new ToolRegistry(NATIVE_TOOLS);

describe('HUNT-LOOP — abort a meio do batch nativo', () => {
  it('aborta ENTRE calls: tools de efeito posteriores NÃO rodam', async () => {
    const fs = new MemoryFs();
    const { ports } = makePorts({ fs });
    const ctrl = new AbortController();

    // FS que dispara o abort logo após a 1ª escrita: simula o usuário apertando
    // esc enquanto o batch corre. As escritas seguintes NÃO devem ocorrer.
    const origWrite = fs.writeFile.bind(fs);
    let writes = 0;
    fs.writeFile = async (p: string, c: string): Promise<void> => {
      writes += 1;
      await origWrite(p, c);
      if (writes === 1) ctrl.abort();
    };

    const model = new ScriptedModelCaller([
      {
        toolCalls: [
          tc('c1', 'write_file', { path: 'a.txt', content: 'a' }),
          tc('c2', 'write_file', { path: 'b.txt', content: 'b' }),
          tc('c3', 'write_file', { path: 'c.txt', content: 'c' }),
        ],
      },
      { text: 'pronto' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: tools(),
      ports,
      sessionId: 'sess-abort',
    });

    await expect(loop.run('escreva 3 arquivos', ctrl.signal)).rejects.toBeInstanceOf(
      ModelCallAbortedError,
    );

    const snap = fs.snapshot();
    // a.txt foi escrito (1ª call, antes do abort). b/c NÃO — o loop checou o
    // cancelamento entre as calls e parou.
    expect(snap.get('a.txt')).toBe('a');
    expect(snap.has('b.txt')).toBe(false);
    expect(snap.has('c.txt')).toBe(false);
  });
});

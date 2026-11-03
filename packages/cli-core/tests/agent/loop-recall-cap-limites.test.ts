// Auditoria — teto do recall de memória: limites exatos e a COSTURA no loop (antes só a função
// pura era testada; trocar `capRecallLines` por identidade no loop passava despercebido).

import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  capRecallLines,
  RECALL_MAX_CHARS_PER_ITEM,
  RECALL_MAX_CHARS_TOTAL,
} from '../../src/agent/loop.js';
import type { MemoryEngine, MemorySearchHit } from '../../src/agent/maestro/memory-engine.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { ScriptedModelCaller, allowAllEngine, makePorts } from './helpers.js';

describe('capRecallLines · limites exatos', () => {
  it('item com EXATAMENTE o teto por item passa intacto; um a mais é cortado com reticências', () => {
    const exato = 'x'.repeat(RECALL_MAX_CHARS_PER_ITEM);
    expect(capRecallLines([exato])).toEqual([exato]);
    const [cortado] = capRecallLines([exato + 'y']);
    expect(cortado!.length).toBe(RECALL_MAX_CHARS_PER_ITEM);
    expect(cortado!.endsWith('…')).toBe(true);
  });

  it('a ordem de relevância é preservada e o corte do total é no FIM (nunca pula e pega um menor depois)', () => {
    const grande = 'g'.repeat(RECALL_MAX_CHARS_PER_ITEM);
    const lines = [grande, grande, grande, grande, 'curto-no-fim'];
    const out = capRecallLines(lines);
    // 4 grandes (4*600 + 3 separadores) estouram 2400 ⇒ só 3 entram; o "curto" NÃO é puxado.
    expect(out).toEqual([grande, grande, grande]);
    expect(out).not.toContain('curto-no-fim');
  });

  it('lista vazia ⇒ vazia', () => {
    expect(capRecallLines([])).toEqual([]);
  });
});

describe('recall no loop respeita o teto', () => {
  it('hits gigantes viram observação limitada (item e total)', async () => {
    const hits: MemorySearchHit[] = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      text: `memoria-${String(i)}-` + 'z'.repeat(5000),
      score: 0.9,
      metadata: { sessionId: 'outra' },
    }));
    const engine: MemoryEngine = {
      async search() {
        return { hits };
      },
      async add() {
        return { ids: [] };
      },
      async scope() {
        return {};
      },
    };
    const { ports } = makePorts();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([{ text: 'ok.' }]),
      permission: allowAllEngine,
      tools: new ToolRegistry<ToolPorts>(NATIVE_TOOLS),
      ports,
      sessionId: 'atual',
      memory: engine,
      memoryScope: 'proj',
    });
    const res = await loop.run('pergunta');
    const obs = res.history.find((h) => h.role === 'observation' && h.toolName === 'memory');
    const texto = obs && 'text' in obs ? obs.text : '';
    const linhas = texto.split('\n').filter((l) => l.startsWith('- memoria-'));
    expect(linhas.length).toBeGreaterThan(0);
    expect(linhas.length).toBeLessThan(5);
    for (const l of linhas) expect(l.length).toBeLessThanOrEqual(RECALL_MAX_CHARS_PER_ITEM);
    expect(linhas.join('\n').length).toBeLessThanOrEqual(RECALL_MAX_CHARS_TOTAL);
    expect(linhas[0]).toContain('memoria-0-');
  });
});

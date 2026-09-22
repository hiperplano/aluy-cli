// ADR aluy-cli 0001 — `spawn_agent` com `wait:false` (despacha e segue), na TOOL.
//
// O que se guarda aqui é o contrato com o modelo: o default é o comportamento de hoje
// (`wait` ausente ⇒ a porta NÃO recebe `wait:false`), o `false` chega à porta, e a
// combinação com sala é recusada ANTES de spawnar (regra 1 do ADR — despachar + sala é a
// corrida produtor-consumidor que a própria prosa da tool proíbe).
import { describe, expect, it, vi } from 'vitest';
import { spawnAgentTool, type SubAgentPort } from '../../src/agent/tools/spawn-agent.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';

function portaQueRegistra(): { port: SubAgentPort; chamadas: unknown[][] } {
  const chamadas: unknown[][] = [];
  const port: SubAgentPort = {
    spawn: vi.fn(async (profiles, signal, opts) => {
      chamadas.push([profiles, signal, opts]);
      return profiles.map((p) => ({
        label: p.label,
        ok: true,
        result: 'feito',
        stop: 'final' as const,
        usage: { iterations: 1, toolCalls: 0, tokens: 1 },
      }));
    }),
  };
  return { port, chamadas };
}

const ports = (subAgents: SubAgentPort): ToolPorts => ({ subAgents }) as unknown as ToolPorts;
const agentes = [{ goal: 'a' }, { goal: 'b' }];

describe('spawn_agent · wait', () => {
  it('ausente ⇒ a porta NÃO recebe wait:false (o default é o contrato de hoje)', async () => {
    const { port, chamadas } = portaQueRegistra();
    const r = await spawnAgentTool.run({ agents: agentes }, ports(port));
    expect(r.ok).toBe(true);
    const opts = chamadas[0]![2] as Record<string, unknown>;
    expect(opts.wait).toBeUndefined();
  });

  it('wait:false chega à porta', async () => {
    const { port, chamadas } = portaQueRegistra();
    await spawnAgentTool.run({ agents: agentes, wait: false }, ports(port));
    const opts = chamadas[0]![2] as Record<string, unknown>;
    expect(opts.wait).toBe(false);
  });

  it('wait:true explícito equivale ao default', async () => {
    const { port, chamadas } = portaQueRegistra();
    await spawnAgentTool.run({ agents: agentes, wait: true }, ports(port));
    const opts = chamadas[0]![2] as Record<string, unknown>;
    expect(opts.wait).toBeUndefined();
  });

  it('wait:false + room:true ⇒ recusa ANTES de spawnar (regra 1 do ADR)', async () => {
    const { port, chamadas } = portaQueRegistra();
    const r = await spawnAgentTool.run({ agents: agentes, wait: false, room: true }, ports(port));
    expect(r.ok).toBe(false);
    expect(r.observation).toContain('não combina');
    expect(chamadas).toHaveLength(0);
  });

  it('o schema e a prosa anunciam o modo (o modelo lê a prosa, não o `?`)', () => {
    const props = (spawnAgentTool.parameters as { properties: Record<string, unknown> }).properties;
    expect(props.wait).toBeDefined();
    expect(spawnAgentTool.description).toContain('"wait": false');
    expect(spawnAgentTool.description).toContain('NÃO espere');
  });
});

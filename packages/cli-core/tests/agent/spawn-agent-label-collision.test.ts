// HUNT-SUBAGENT — anti-colisão de IDENTIDADE do sub-agente (label).
//
// O `label` é a CHAVE ÚNICA do filho rio-abaixo: a FlowTree o usa como nodeId
// (`root/<label>`), o sinal de PARADA por-filho é resolvido por ele
// (`childSignalOf(label)`), a linha da UI (`upsertSubAgentChild`) e os writers da
// SALA também. Dois filhos com o MESMO label COLIDEM:
//   • parar UM (`p`) abortaria o OUTRO (mesmo AbortSignal do mesmo nó);
//   • a UI sobrescreveria a linha de um pela do outro;
//   • a policy da sala teria writer DUPLICADO.
// O input vem do MODELO (não-confiável) e pode repetir/omitir labels à vontade —
// então a desambiguação tem de ocorrer no BOUNDARY (`asProfiles`).
//
// Por que o verde não pegava: os testes existentes spawnam labels DISTINTOS
// (`a`, `b`); nenhum exercita labels REPETIDOS num só lote.

import { describe, expect, it } from 'vitest';
import {
  spawnAgentTool,
  type SubAgentPort,
  type ToolPorts,
} from '../../src/agent/tools/spawn-agent.js';
import { MemoryFs, RecordingShell, MemorySearch } from './helpers.js';

function capturingSpawner(): { port: SubAgentPort; captured: { labels: string[] } } {
  const captured: { labels: string[] } = { labels: [] };
  const port: SubAgentPort = {
    async spawn(profiles) {
      captured.labels = profiles.map((p) => p.label);
      return profiles.map((p) => ({
        label: p.label,
        ok: true,
        result: `r-${p.label}`,
        stop: 'final' as const,
        usage: { iterations: 1, toolCalls: 0, tokens: 1 },
      }));
    },
  };
  return { port, captured };
}

function makePorts(spawner: SubAgentPort): ToolPorts {
  return {
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    search: new MemorySearch(),
    subAgents: spawner,
  };
}

describe('HUNT-SUBAGENT — labels duplicados são desambiguados (anti-colisão)', () => {
  it('dois agents com o MESMO label ⇒ o spawner recebe labels ÚNICOS', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      {
        agents: [
          { label: 'pesquisa', goal: 'parte 1' },
          { label: 'pesquisa', goal: 'parte 2' },
        ],
      },
      makePorts(port),
    );
    expect(captured.labels).toHaveLength(2);
    // SEM o fix, ambos seriam "pesquisa" (colisão de nodeId/sinal/UI/writer).
    expect(new Set(captured.labels).size).toBe(2);
    expect(captured.labels[0]).toBe('pesquisa');
    expect(captured.labels[1]).toBe('pesquisa#2');
  });

  it('TRÊS labels iguais ⇒ base, base#2, base#3 (determinístico)', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      {
        agents: [
          { label: 'x', goal: 'g1' },
          { label: 'x', goal: 'g2' },
          { label: 'x', goal: 'g3' },
        ],
      },
      makePorts(port),
    );
    expect(captured.labels).toEqual(['x', 'x#2', 'x#3']);
  });

  it('labels AUSENTES caem em sub-N (já únicos) e não colidem com um label literal "sub-2"', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      {
        agents: [
          { goal: 'g1' }, // ⇒ sub-1
          { label: 'sub-2', goal: 'g2' }, // literal sub-2
          { goal: 'g3' }, // ⇒ sub-3 (índice), NÃO recolide com o literal
        ],
      },
      makePorts(port),
    );
    expect(new Set(captured.labels).size).toBe(3);
    expect(captured.labels).toEqual(['sub-1', 'sub-2', 'sub-3']);
  });

  it('colisão entre um label EXPLÍCITO e um fallback de NOME de agente é resolvida', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      {
        agents: [
          { agent: 'revisor', goal: 'g1' }, // label vira "revisor"
          { label: 'revisor', goal: 'g2' }, // explícito homônimo
        ],
      },
      makePorts(port),
    );
    expect(new Set(captured.labels).size).toBe(2);
    expect(captured.labels).toEqual(['revisor', 'revisor#2']);
  });
});

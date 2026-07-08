// ADR-0146 (D1) — o parâmetro `model` do `spawn_agent`: o USUÁRIO pede, no prompt,
// "spawna um agente com o modelo X"; o principal RELAIA essa escolha via o campo
// `model` de cada item de `agents[]`. `asProfiles` (o boundary — input do modelo é
// NÃO-CONFIÁVEL) copia (trim) a string CRUA p/ `SubAgentProfile.model`; a resolução
// (probe/roteamento de tier) acontece rio-abaixo (`resolveModelTier`/`childCallerFor`/
// o probe do controller) — aqui só provamos que o boundary TRANSPORTA o campo.

import { describe, expect, it } from 'vitest';
import { spawnAgentTool, type SubAgentPort, type ToolPorts } from '../../src/agent/tools/spawn-agent.js';
import type { SubAgentProfile } from '../../src/agent/subagent.js';
import { MemoryFs, RecordingShell, MemorySearch } from './helpers.js';

function makePorts(spawner: SubAgentPort): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch(), subAgents: spawner };
}

function capturingSpawner(): { port: SubAgentPort; captured: { profiles: readonly SubAgentProfile[] } } {
  const captured: { profiles: readonly SubAgentProfile[] } = { profiles: [] };
  const port: SubAgentPort = {
    async spawn(profiles) {
      captured.profiles = profiles;
      return profiles.map((p) => ({
        label: p.label,
        ok: true,
        result: `resultado de ${p.label}`,
        stop: 'final' as const,
        usage: { iterations: 1, toolCalls: 0, tokens: 10 },
      }));
    },
  };
  return { port, captured };
}

describe('ADR-0146 (D1) — spawn_agent aceita "model" e o boundary o copia p/ o perfil', () => {
  it('agents[].model (string não-vazia) ⇒ vira SubAgentProfile.model (trim)', async () => {
    const { port, captured } = capturingSpawner();
    const res = await spawnAgentTool.run(
      { agents: [{ label: 'x', goal: 'pesquise algo', model: '  opus  ' }] },
      makePorts(port),
    );
    expect(res.ok).toBe(true);
    expect(captured.profiles).toHaveLength(1);
    expect(captured.profiles[0]!.model).toBe('opus');
  });

  it('agents[].model AUSENTE ⇒ SubAgentProfile.model fica undefined (back-compat)', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run({ agents: [{ label: 'x', goal: 'g' }] }, makePorts(port));
    expect(captured.profiles[0]!.model).toBeUndefined();
  });

  it('agents[].model vazio/só-espaço ⇒ tratado como AUSENTE (não vira string vazia)', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      { agents: [{ label: 'x', goal: 'g', model: '   ' }] },
      makePorts(port),
    );
    expect(captured.profiles[0]!.model).toBeUndefined();
  });

  it('aceita os sentinelas de herança/BYO (D3) como strings CRUAS, sem interpretar aqui', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      {
        agents: [
          { label: 'a', goal: 'g1', model: 'same-as-parent' },
          { label: 'b', goal: 'g2', model: 'custom:meu-slug' },
        ],
      },
      makePorts(port),
    );
    expect(captured.profiles.map((p) => p.model)).toEqual(['same-as-parent', 'custom:meu-slug']);
  });

  it('model NÃO é injetado em provider/base_url/api_key — só string transportada como dado', async () => {
    const { port, captured } = capturingSpawner();
    await spawnAgentTool.run(
      { agents: [{ label: 'x', goal: 'g', model: 'sonnet' }] },
      makePorts(port),
    );
    const profile = captured.profiles[0]! as unknown as Record<string, unknown>;
    expect(profile.provider).toBeUndefined();
    expect(profile.base_url).toBeUndefined();
    expect(profile.api_key).toBeUndefined();
    expect(profile.token).toBeUndefined();
  });

  it('o schema documenta "model" como OPCIONAL (não entra em required)', () => {
    const items = (
      (spawnAgentTool.parameters as Record<string, unknown>).properties as Record<
        string,
        Record<string, unknown>
      >
    ).agents.items as Record<string, unknown>;
    expect((items.required as string[]).includes('model')).toBe(false);
    const props = items.properties as Record<string, unknown>;
    expect(props.model).toBeDefined();
  });
});

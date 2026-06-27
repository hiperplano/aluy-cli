// EST-1014 — endurecimento da cobertura de spawn-agent.ts:
//   guards de validação, label fallback, formatSubAgentResults (truncamento),
//   catch do spawn, e sem-spawner.
//
// Reusa o padrão dos testes irmãos (agent-named-spawn.test.ts,
// spawn-agent-maxitems.test.ts): invoca spawnAgentTool.run(input, ports)
// com um `ports` fake (incluindo o port de spawn de sub-agentes).

import { describe, expect, it } from 'vitest';
import {
  spawnAgentTool,
  formatSubAgentResults,
  type SubAgentPort,
  type ToolPorts,
} from '../../src/agent/tools/spawn-agent.js';
import type { SubAgentOutcome } from '../../src/agent/subagent.js';
import { MemoryFs, RecordingShell, MemorySearch } from './helpers.js';

/** Constrói um ToolPorts fake com um spawner injetado (ou não). */
function makePorts(spawner?: SubAgentPort): ToolPorts {
  return {
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    search: new MemorySearch(),
    ...(spawner !== undefined ? { subAgents: spawner } : {}),
  };
}

/** Cria um spawner fake que captura os perfis recebidos. */
function capturingSpawner(): {
  port: SubAgentPort;
  captured: { profiles: unknown[] };
} {
  const captured: { profiles: unknown[] } = { profiles: [] };
  const port: SubAgentPort = {
    async spawn(profiles) {
      captured.profiles = profiles as unknown[];
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

// ── (1) GUARDS de input inválido ─────────────────────────────────────────────

describe('spawnAgentTool — guards de validação (EST-1014)', () => {
  it('(1a) agents NAO-array ⇒ observation menciona "um array"', async () => {
    const { port } = capturingSpawner();
    const result = await spawnAgentTool.run({ agents: 'x' }, makePorts(port));
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/um array/i);
  });

  it('(1b) item NAO-objeto ⇒ observation menciona "deve ser um objeto"', async () => {
    const { port } = capturingSpawner();
    const result = await spawnAgentTool.run({ agents: [42] }, makePorts(port));
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/deve ser um objeto/i);
  });

  it('(1c) goal vazio/ausente ⇒ observation menciona "goal"', async () => {
    const { port } = capturingSpawner();
    const result = await spawnAgentTool.run(
      { agents: [{ label: 'a', goal: '' }] },
      makePorts(port),
    );
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/goal/i);
  });
});

// ── (2) LABEL FALLBACK (linhas 72-74) ────────────────────────────────────────

describe('spawnAgentTool — label fallback (EST-1014)', () => {
  it('(2) agent SEM label mas com goal válido ⇒ label derivado (nome do agent)', async () => {
    const { port, captured } = capturingSpawner();
    const result = await spawnAgentTool.run(
      { agents: [{ goal: 'faça algo', agent: 'revisor' }] },
      makePorts(port),
    );
    expect(result.ok).toBe(true);
    expect(captured.profiles).toHaveLength(1);
    const profile = captured.profiles[0] as Record<string, unknown>;
    expect(profile.label).toBe('revisor');
  });

  it('(2b) SEM label e SEM agent ⇒ label derivado "sub-N"', async () => {
    const { port, captured } = capturingSpawner();
    const result = await spawnAgentTool.run({ agents: [{ goal: 'faça algo' }] }, makePorts(port));
    expect(result.ok).toBe(true);
    expect(captured.profiles).toHaveLength(1);
    const profile = captured.profiles[0] as Record<string, unknown>;
    expect(profile.label).toBe('sub-1');
  });
});

// ── (2c) CONTRATO room/pattern no BOUNDARY (HUNT-SUBAGENT) ───────────────────
// `pattern` é convenção SOBRE a sala — sem `room:true` não tem significado. O
// boundary só deve encaminhá-lo à porta quando `room` está ON (o schema já diz
// "OPCIONAL quando room:true"). Antes o tool repassava `pattern` solto e dependia
// do spawner ignorá-lo; agora o contrato é EXPLÍCITO aqui. (Caso antes não-coberto.)

describe('spawnAgentTool — contrato room/pattern no boundary', () => {
  /** Spawner que captura o 3º argumento (opts: { room?, pattern? }). */
  function optsCapturingSpawner(): { port: SubAgentPort; captured: { opts: unknown } } {
    const captured: { opts: unknown } = { opts: undefined };
    const port: SubAgentPort = {
      async spawn(profiles, _signal, opts) {
        captured.opts = opts;
        return profiles.map((p) => ({
          label: p.label,
          ok: true,
          result: 'ok',
          stop: 'final' as const,
          usage: { iterations: 1, toolCalls: 0, tokens: 1 },
        }));
      },
    };
    return { port, captured };
  }

  it('(2c-i) pattern SEM room ⇒ porta recebe { room:false } SEM pattern (não vaza lixo)', async () => {
    const { port, captured } = optsCapturingSpawner();
    const r = await spawnAgentTool.run(
      { agents: [{ goal: 'x', label: 'a' }], pattern: 'pipeline' }, // room ausente
      makePorts(port),
    );
    expect(r.ok).toBe(true);
    expect(captured.opts).toEqual({ room: false });
  });

  it('(2c-ii) pattern COM room:true ⇒ porta recebe { room:true, pattern }', async () => {
    const { port, captured } = optsCapturingSpawner();
    await spawnAgentTool.run(
      { agents: [{ goal: 'x', label: 'a' }], room: true, pattern: 'debate' },
      makePorts(port),
    );
    expect(captured.opts).toEqual({ room: true, pattern: 'debate' });
  });

  it('(2c-iii) room:true SEM pattern ⇒ porta recebe só { room:true }', async () => {
    const { port, captured } = optsCapturingSpawner();
    await spawnAgentTool.run({ agents: [{ goal: 'x', label: 'a' }], room: true }, makePorts(port));
    expect(captured.opts).toEqual({ room: true });
  });

  it('(2c-iv) pattern INVÁLIDO (mesmo com room) ⇒ ignorado: só { room:true }', async () => {
    const { port, captured } = optsCapturingSpawner();
    await spawnAgentTool.run(
      { agents: [{ goal: 'x', label: 'a' }], room: true, pattern: 'tagarela' },
      makePorts(port),
    );
    expect(captured.opts).toEqual({ room: true });
  });
});

// ── (3) CATCH do spawn (linhas 213-217) ──────────────────────────────────────

describe('spawnAgentTool — catch do spawn (EST-1014)', () => {
  it('(3) spawner que LANÇA ⇒ devolve ok:false com "spawn_agent falhou" e a mensagem', async () => {
    const throwingPort: SubAgentPort = {
      async spawn() {
        throw new Error('boom');
      },
    };
    const result = await spawnAgentTool.run(
      { agents: [{ goal: 'tarefa', label: 't' }] },
      makePorts(throwingPort),
    );
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/spawn_agent falhou/i);
    expect(result.observation).toMatch(/boom/);
  });
});

// ── (4) formatSubAgentResults — truncamento ──────────────────────────────────

describe('formatSubAgentResults — truncamento (EST-1014)', () => {
  it('(4) resultado maior que MAX_RESULT_CHARS ⇒ contém "[truncado]"', () => {
    // MAX_RESULT_CHARS = 8_000 (definido em spawn-agent.ts)
    const longResult = 'x'.repeat(10_000);
    const outcomes: readonly SubAgentOutcome[] = [
      {
        label: 'filho1',
        ok: true,
        result: longResult,
        stop: 'final',
        usage: { iterations: 1, toolCalls: 0, tokens: 10 },
      },
    ];
    const output = formatSubAgentResults(outcomes);
    expect(output).toContain('[truncado]');
    // O resultado original NÃO aparece completo (só os primeiros 8000 chars)
    expect(output.length).toBeLessThan(longResult.length + 500);
  });

  it('(4b) resultado menor que o teto ⇒ NÃO contém "[truncado]"', () => {
    const shortResult = 'resultado curto';
    const outcomes: readonly SubAgentOutcome[] = [
      {
        label: 'filho1',
        ok: true,
        result: shortResult,
        stop: 'final',
        usage: { iterations: 1, toolCalls: 0, tokens: 10 },
      },
    ];
    const output = formatSubAgentResults(outcomes);
    expect(output).toContain(shortResult);
    expect(output).not.toContain('[truncado]');
  });
});

// ── (5) SEM spawner ──────────────────────────────────────────────────────────

describe('spawnAgentTool — sem spawner (EST-1014)', () => {
  it('(5) ports SEM subAgents ⇒ devolve ok:false com "indisponível"', async () => {
    const ports = makePorts(); // sem subAgents
    const result = await spawnAgentTool.run({ agents: [{ goal: 'tarefa', label: 't' }] }, ports);
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/indispon[ií]vel/i);
  });
});

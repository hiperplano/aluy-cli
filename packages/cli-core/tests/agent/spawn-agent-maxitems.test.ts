// EST-0970 — o schema de `spawn_agent` informa o TETO de filhos por chamada (`maxItems`).
//
// O bug do Tiago: pediu 10 sub-agentes (teto = 8). O schema tinha `minItems:1` mas NÃO
// `maxItems`, então o modelo não SABIA o teto, chutava 10, e só a validação de runtime
// (`SubAgentSpawner.spawn`: `> MAX_SUBAGENTS_PER_CALL` ⇒ "excede o teto") rejeitava — o
// modelo só então dividia. Parecia "crash primeiro". Com `maxItems = MAX_SUBAGENTS_PER_CALL`,
// o tool-calling NATIVO (EST-0996) constrange a lista a ≤ teto ANTES de chutar.
//
// Provas SINTÉTICAS (sem modelo real, frugal):
//  • o schema do `agents` declara `maxItems` IGUAL a MAX_SUBAGENTS_PER_CALL (fonte única);
//  • `toToolFunctionSchema` PROPAGA esse `maxItems` (e o `minItems`) ao schema nativo;
//  • a `description` (da tool e do param) cita o teto numérico.
//
// A validação de runtime (a REDE de segurança: `> teto` ⇒ "excede o teto") NÃO é tocada
// aqui — já é coberta por subagent.test.ts ("recusa fan-out acima do teto…") e segue
// inalterada. `maxItems` é a DICA pro modelo (HG-2: capacidade, não credencial).

import { describe, expect, it } from 'vitest';
import { toToolFunctionSchema } from '../../src/agent/tools/native-schema.js';
import { spawnAgentTool } from '../../src/agent/tools/spawn-agent.js';
import { MAX_SUBAGENTS_PER_CALL } from '../../src/agent/subagent.js';

/** Acesso tipado ao sub-schema de `agents` dentro de um schema-objeto. */
function agentsSchema(params: unknown): Record<string, unknown> {
  const p = params as Record<string, unknown>;
  const props = p.properties as Record<string, Record<string, unknown>>;
  return props.agents;
}

describe('EST-0970 — spawn_agent declara o TETO (`maxItems`) no schema', () => {
  it('o schema do `agents` tem maxItems === MAX_SUBAGENTS_PER_CALL (fonte única)', () => {
    const agents = agentsSchema(spawnAgentTool.parameters);
    expect(agents.maxItems).toBe(MAX_SUBAGENTS_PER_CALL);
    // não regride o piso já existente (#136).
    expect(agents.minItems).toBe(1);
  });

  it('toToolFunctionSchema (#111) PROPAGA maxItems (e minItems) ao schema nativo', () => {
    const fn = toToolFunctionSchema(spawnAgentTool).function;
    const agents = agentsSchema(fn.parameters);
    expect(agents.maxItems).toBe(MAX_SUBAGENTS_PER_CALL);
    expect(agents.minItems).toBe(1);
    // não degradou p/ o permissivo (objeto-livre) — properties.agents segue presente.
    expect((fn.parameters as Record<string, unknown>).properties).toHaveProperty('agents');
  });

  it('a description (tool + param) cita o teto numérico', () => {
    expect(spawnAgentTool.description).toContain(String(MAX_SUBAGENTS_PER_CALL));
    expect(spawnAgentTool.description.toLowerCase()).toContain('máximo');
    const agents = agentsSchema(spawnAgentTool.parameters);
    expect(String(agents.description)).toContain(String(MAX_SUBAGENTS_PER_CALL));
  });
});

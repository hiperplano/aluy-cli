// EST-0970 — TODO built-in com input ESTRUTURADO declara `parameters` (JSON Schema).
//
// O bug do Tiago: o modelo chamava `spawn_agent` com args errados num loop
// ("spawn_agent requer 'agents': ...") porque a tool NÃO declarava `parameters`. No
// tool-calling NATIVO (EST-0996) o `native-schema` caía no PERMISSIVE_OBJECT_SCHEMA
// (objeto livre) ⇒ o modelo não recebia a forma de `agents` ⇒ chutava. O `toolDocs`
// de texto (EST-0970/ADR-0058) também não tinha o que mostrar.
//
// Estas provas SÃO SINTÉTICAS (sem modelo real, frugal):
//  • spawn_agent tem `parameters` que ESPELHA `asProfiles` (agents:array de
//    {goal req, label/agent/context opt});
//  • o native-schema (toToolFunctionSchema) gera p/ ele o schema ESTRUTURADO, NÃO o
//    permissivo (objeto livre);
//  • o toolDocs (paramsFromJsonSchema) renderiza os params do spawn_agent;
//  • AUDITORIA: nenhum built-in com input não-trivial cai no permissivo (falha se um
//    novo tool de input estruturado esquecer o `parameters`).
//
// A validação de runtime (asProfiles e cia.) NÃO é tocada aqui — é o `run` que valida;
// `parameters` é só a DICA pro modelo (HG-2: capacidade, não credencial).

import { describe, expect, it } from 'vitest';
import { toToolFunctionSchema } from '../../src/agent/tools/native-schema.js';
import { paramsFromJsonSchema } from '../../src/agent/tools/tool-param-docs.js';
import { spawnAgentTool } from '../../src/agent/tools/spawn-agent.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { WEB_TOOLS } from '../../src/agent/web/web-tools.js';
import { rememberTool } from '../../src/agent/memory/remember-tool.js';
import { recallTool } from '../../src/agent/memory/recall-tool.js';
import type { NativeTool } from '../../src/agent/tools/types.js';

/** TODOS os built-ins com input ESTRUTURADO (não-trivial) — devem ter `parameters`. */
const STRUCTURED_BUILTINS: readonly NativeTool<unknown>[] = [
  spawnAgentTool,
  rememberTool,
  recallTool,
  ...(WEB_TOOLS as readonly NativeTool<unknown>[]),
  ...(NATIVE_TOOLS as readonly NativeTool<unknown>[]),
];

describe('EST-0970 — spawn_agent declara `parameters` (espelha asProfiles)', () => {
  it('tem `parameters` com agents:array de objetos, agents obrigatório', () => {
    const p = spawnAgentTool.parameters as Record<string, unknown> | undefined;
    expect(p).toBeDefined();
    expect(p!.type).toBe('object');
    expect(p!.required).toEqual(['agents']);

    const props = p!.properties as Record<string, Record<string, unknown>>;
    const agents = props.agents;
    expect(agents.type).toBe('array');

    const items = agents.items as Record<string, unknown>;
    expect(items.type).toBe('object');
    // só `goal` é obrigatório (asProfiles rejeita item sem goal não-vazio).
    expect(items.required).toEqual(['goal']);

    const itemProps = items.properties as Record<string, unknown>;
    // os campos REAIS lidos por asProfiles: goal/label/agent/context.
    expect(Object.keys(itemProps).sort()).toEqual(['agent', 'context', 'goal', 'label']);
  });

  it('native-schema gera o schema ESTRUTURADO (NÃO o permissivo objeto-livre)', () => {
    const fn = toToolFunctionSchema(spawnAgentTool).function;
    expect(fn.name).toBe('spawn_agent');
    const params = fn.parameters as Record<string, unknown>;
    // o permissivo seria { type:'object', additionalProperties:true } SEM properties.
    expect(params).not.toMatchObject({ additionalProperties: true });
    expect(params.properties).toHaveProperty('agents');
    expect(params.required).toEqual(['agents']);
  });

  it('toolDocs (paramsFromJsonSchema) renderiza o param `agents` (obrigatório)', () => {
    const params = paramsFromJsonSchema(spawnAgentTool.parameters);
    const agents = params.find((x) => x.name === 'agents');
    expect(agents).toBeDefined();
    expect(agents!.required).toBe(true);
    expect(agents!.type).toBe('array<object>');
  });
});

describe('EST-0970 — remember/web_fetch/web_search ganham `parameters` (espelham o run)', () => {
  it('remember: fact obrigatório; scope/provenance opcionais com enum', () => {
    const p = rememberTool.parameters as Record<string, unknown>;
    expect(p.required).toEqual(['fact']);
    const props = p.properties as Record<string, Record<string, unknown>>;
    expect(props.scope.enum).toEqual(['global', 'projeto']);
    expect(props.provenance.enum).toEqual(['usuario', 'derivado']);
    // porta ESTREITA (GS-M1): NUNCA um campo de path no schema.
    expect(Object.keys(props)).not.toContain('path');
  });

  it('web_fetch: só `url` obrigatória; web_search: só `query` obrigatória', () => {
    const [fetchTool, searchTool] = WEB_TOOLS;
    expect((fetchTool!.parameters as Record<string, unknown>).required).toEqual(['url']);
    expect((searchTool!.parameters as Record<string, unknown>).required).toEqual(['query']);
  });
});

describe('EST-0970 — AUDITORIA: nenhum built-in estruturado cai no permissivo', () => {
  // EST-1108 — tools NO-ARG (ex.: list_todos, monitors) declaram `parameters` com
  // `properties: {}` (schema válido, sem parâmetros renderizáveis). O auditor PULA
  // a checagem de `toolDocs > 0` quando `properties` é vazio (não há o que renderizar).
  it.each(STRUCTURED_BUILTINS.map((t) => [t.name, t] as const))(
    '%s declara `parameters` com properties (não objeto-livre)',
    (_name, tool) => {
      // 1) declara parameters
      expect(tool.parameters, `${tool.name} sem parameters`).toBeDefined();

      // 2) o native-schema NÃO degrada p/ o permissivo (sinal: additionalProperties:true
      //    SEM properties). Um tool estruturado precisa emitir as properties pro modelo.
      const params = toToolFunctionSchema(tool).function.parameters as Record<string, unknown>;
      expect(params.type).toBe('object');
      expect(params.properties, `${tool.name} caiu no schema permissivo`).toBeDefined();

      // 3) o toolDocs deriva ≥1 parâmetro (o modelo de texto vê os campos) — a MENOS
      //    que o tool seja NO-ARG (properties vazio), caso em que 0 params é correto.
      const renderedCount = paramsFromJsonSchema(tool.parameters).length;
      const props = tool.parameters as Record<string, unknown>;
      const propsObj = (props.properties ?? {}) as Record<string, unknown>;
      if (Object.keys(propsObj).length === 0) {
        // no-arg tool: 0 parâmetros renderizados é legítimo.
        expect(renderedCount, `${tool.name} no-arg não deveria renderizar parâmetros`).toBe(0);
      } else {
        expect(
          renderedCount,
          `${tool.name} não renderiza nenhum parâmetro no toolDocs`,
        ).toBeGreaterThan(0);
      }
    },
  );
});

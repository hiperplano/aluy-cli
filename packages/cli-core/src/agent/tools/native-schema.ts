// EST-0996 — conversão do CATÁLOGO LOCAL de tools (`NativeTool[]`) p/ o schema de
// FUNÇÃO do provider (OpenAI function-calling), enviado ao broker quando o modelo
// SUPORTA tool-calling nativo.
//
// HG-2 (segurança): `tools` é o CATÁLOGO de ferramentas — nome + descrição +
// JSONSchema do input. NÃO é credencial nem pista de provider; é o MESMO conteúdo
// que já vai no prompt de texto (a `description` das tools), só num formato
// estruturado. Ok mandar (o comentário HG-2 do task).
//
// Esta conversão é PURA (sem rede/IO) e não toca a catraca: o schema só GUIA o
// modelo a emitir o input certo. A execução de QUALQUER tool extraída — venha do
// schema nativo ou do texto — passa pela MESMA `decide()` no loop (CLI-SEC-H1).

import type { ToolFunctionSchema } from '../../model/types.js';
import type { NativeTool } from './types.js';

/**
 * Schema permissivo (objeto livre) p/ uma tool SEM `parameters` declarado. O
 * provider aceita um input-objeto qualquer; a tool revalida no `run`. Mantém o
 * nativo funcional p/ tools (ex.: MCP) cujo input-schema não conhecemos a priori.
 */
const PERMISSIVE_OBJECT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: true,
});

/**
 * Converte UMA `NativeTool` num `ToolFunctionSchema` (formato de função do provider).
 * Usa `tool.parameters` quando declarado; senão, um schema permissivo (objeto livre).
 */
export function toToolFunctionSchema<P>(tool: NativeTool<P>): ToolFunctionSchema {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? PERMISSIVE_OBJECT_SCHEMA,
    },
  };
}

/**
 * Converte a LISTA de tools no catálogo de funções p/ o request. Quando vazia,
 * devolve `[]` (o `buildChatBody` então NÃO emite `tools` — chat de texto puro).
 */
export function toToolFunctionSchemas<P>(
  tools: readonly NativeTool<P>[],
): readonly ToolFunctionSchema[] {
  return tools.map((t) => toToolFunctionSchema(t));
}

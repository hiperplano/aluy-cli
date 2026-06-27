// Barrel das tools nativas (EST-0944).
export * from './types.js';

// EST-0970 (E-B2) — derivação dos PARÂMETROS de tool do `inputSchema` (JSON Schema)
// + render COMPACTO/SANITIZADO no prompt. ÚNICA fonte de verdade "schema → params",
// compartilhada com o caminho de tool-calling NATIVO (EST-0996).
export {
  MAX_PARAM_BLOCK_CHARS,
  MAX_PARAM_DESC_CHARS,
  MAX_PARAMS_PER_TOOL,
  normalizeType,
  paramsFromJsonSchema,
  renderToolParamDocs,
  sanitizeUntrustedDoc,
  type ToolParam,
} from './tool-param-docs.js';

export {
  NATIVE_TOOLS,
  readFileTool,
  editFileTool,
  writeFileTool,
  runCommandTool,
  runTestsTool,
  grepTool,
  globTool,
  changeDirTool,
  unifiedDiff,
  // EST-1108 — re-exportadas p/ o locus concreto e testes (já estão em NATIVE_TOOLS).
  addTodoTool,
  listTodosTool,
  doneTodoTool,
} from './native.js';
// EST-0944 — matcher de glob PURO (anti-ReDoS), compartilhado com a porta concreta.
export {
  compileGlob,
  expandBraces,
  GlobSyntaxError,
  MAX_GLOB_PATTERN_CHARS,
} from './glob-match.js';
export { ToolRegistry } from './registry.js';
// EST-0996 — conversão do catálogo de tools p/ o schema de função NATIVO (provider).
export { toToolFunctionSchema, toToolFunctionSchemas } from './native-schema.js';

// EST-0969 · ADR-0057 — a tool `spawn_agent` (sub-agentes locais paralelos) + a
// porta de spawn + os formatadores. A tool NÃO entra em `NATIVE_TOOLS` (baseline
// mono-agente): o locus concreto a adiciona SÓ ao toolset do PAI quando monta o
// spawner. Os FILHOS nunca a recebem (E-A1).
export {
  spawnAgentTool,
  formatSubAgentResults,
  SPAWN_AGENT_TOOL_NAME,
  SUBAGENT_SOURCE_LABEL,
  type SubAgentPort,
} from './spawn-agent.js';

// EST-1110 · ADR-0114 — `perguntar`: tipos + tool de PERGUNTA ao usuário (PORTÁVEL). A
// porta `QuestionPort` é injetada pelo @hiperplano/aluy-cli (TuiQuestionResolver); a tool entra em
// NATIVE_TOOLS (effect:'read'). Os tipos/normalizadores são consumidos pelos testes e
// pelo locus concreto (UI + resolver).
export {
  QUESTION_TOOL,
  QUESTION_TOOL_NAME,
  QUESTION_TOOL_ALIASES,
  normalizeQuestionInput,
  formatQuestionAnswer,
  MAX_OPTIONS,
  MAX_QUESTION_CHARS,
  type QuestionKind,
  type QuestionOption,
  type QuestionSpec,
  type QuestionAnswer,
  type QuestionPort,
  type QuestionParse,
} from './question.js';

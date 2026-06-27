// EST-0983 · ADR-0064 · CLI-SEC-15 — barrel da MEMÓRIA de agente (PORTÁVEL).
//
// Tool `remember` (porta de I/O PRÓPRIA, confinada a `memory/`), mecânica de recall
// COMO DADO envelopado (anti-laundering, B/GS-M3), proveniência + heurística de
// diretiva (GS-M5), e os tipos da porta ESTREITA (GS-M1). O I/O concreto
// (`~/.aluy/memory/` 0600/0700 + `.aluy/memory/` do workspace) é do @hiperplano/aluy-cli.

export {
  REMEMBER_TOOL_NAME,
  RECALL_TOOL_NAME,
  type MemoryScope,
  type MemoryProvenance,
  type MemoryFact,
  type MemoryWriteInput,
  type MemoryStorePort,
} from './contract.js';
export {
  AgentMemory,
  MEMORY_RECALL_TOOL_NAME,
  MAX_FACT_CHARS,
  MAX_RECALL_FACTS,
  MAX_RECALL_TOOL_FACTS,
  MAX_STORED_FACTS_PER_SCOPE,
  type AgentMemoryOptions,
  type RememberOutcome,
} from './memory.js';
export { rememberTool, type MemoryWritePort } from './remember-tool.js';
export { recallTool, type MemoryReadPort } from './recall-tool.js';
export { looksImperative } from './imperative.js';

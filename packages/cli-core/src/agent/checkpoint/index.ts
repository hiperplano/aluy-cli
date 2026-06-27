// Barrel dos CHECKPOINTS / REWIND (EST-XXXX).
// MECÂNICA PORTÁVEL (1 ponto por prompt, restauração de código via o journal +
// fronteira da conversa). Sem Ink/`node:*` — orquestra o `SnapshotJournal`.
export { CheckpointRegistry, normalizeLabel, DEFAULT_CHECKPOINT_MAX_AGE_MS } from './checkpoint.js';
export type {
  Checkpoint,
  CheckpointRestoreResult,
  CheckpointRegistryOptions,
} from './checkpoint.js';

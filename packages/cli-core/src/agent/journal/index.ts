// Barrel do journal de snapshot-do-antes (EST-0960a · ADR-0056).
// MECÂNICA PORTÁVEL (pilha undo/redo, captura, fronteira, concorrência,
// restauração confinada). O I/O concreto (`~/.aluy/`, `0600`/`0700`) é injetado
// por porta (concreto em @hiperplano/aluy-cli).
export { SnapshotJournal, type CaptureEditInput } from './journal.js';
export { JournalCipher } from './cipher.js';
// EST-0960b R9 / CLI-SEC-6 — redação do comando no aviso de barreira (`/undo`).
// EST-0982 — `redactOutputSecrets` redige a SAÍDA do comando (streaming/observação).
export { redactCommandSecrets, redactOutputSecrets, REDACTED } from './redact.js';
export type {
  BlobRef,
  ConcurrencyCheck,
  CurrentReaderPort,
  JournalEntry,
  JournalStorePort,
  RestoreOutcome,
  RestoreWriterPort,
  SnapshotJournalOptions,
  SnapshotTarget,
} from './types.js';
export type { WorkspacePort as JournalWorkspacePort } from './workspace-port.js';

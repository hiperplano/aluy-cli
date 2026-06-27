// EST-0999 · ADR-0078 — barrel da SALA MULTI-AGENTE (PORTÁVEL).
//
// INVARIANTE #1: mensagem entre agentes = DADO, nunca instrução.
// INVARIANTE #2: sala = feed append-only com código/TTL/revogação.
export {
  type AgentMessage,
  type AgentMessageKind,
  envelopeAsData,
  isInstructionFree,
} from './message.js';
export { postMessage, type MeshPolicy, type PostResult } from './mesh.js';

export {
  type Room,
  createRoom,
  isExpired,
  revokeRoom,
  readRoom,
  seedMessage,
  appendBounded,
  MAX_ROOM_MESSAGES,
} from './room.js';
export { type RoomStore, MemoryRoomStore } from './room-store.js';
export {
  type RoomBackend,
  ROOM_BACKENDS,
  DEFAULT_ROOM_BACKEND,
  type RoomBackendResolution,
  resolveRoomBackend,
} from './room-backend.js';
export {
  type WaitEvaluation,
  MAX_ROOM_WAIT_MS,
  DEFAULT_ROOM_WAIT_MS,
  ROOM_WAIT_POLL_MS,
  clampWaitTimeout,
  normalizeWaitFor,
  evaluateWait,
  buildWaitTimeoutNote,
  buildWaitSatisfiedNote,
} from './room-wait.js';

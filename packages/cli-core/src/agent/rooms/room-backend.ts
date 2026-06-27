// EST-1119 · ADR-0121 §5 — Seleção do backend de sala.
//
// Tipo e resolução pura (portável — ADR-0053 §8): decide o backend a partir
// de `ALUY_ROOM_BACKEND` (env) e/ou `rooms.backend` (config), com precedência
// env > config > default `memory`.
//
// Fail-closed (§5.2): valor inválido ⇒ `memory` + aviso.
// Seam ausente (§nota): `loopback`/`broker` são valores VÁLIDOS da chave,
// mas a criação do store concreto é responsabilidade do wiring (@hiperplano/aluy-cli);
// o core só devolve o nome — o wiring decide se cria ou lança erro LOUD.

/** Backends de sala reconhecidos (ADR-0121 §5.1). */
export type RoomBackend = 'memory' | 'file' | 'loopback' | 'broker';

/** Lista dos backends válidos (para validação). */
export const ROOM_BACKENDS: readonly RoomBackend[] = [
  'memory',
  'file',
  'loopback',
  'broker',
] as const;

/** Default embutido — não-regressão DURA (ADR-0121 §5.3, CA-4). */
export const DEFAULT_ROOM_BACKEND: RoomBackend = 'memory';

/** Resultado da resolução: backend + aviso opcional (fail-closed). */
export interface RoomBackendResolution {
  backend: RoomBackend;
  /** Aviso p/ stderr/log quando o valor é inválido (fail-closed). */
  warning?: string;
}

/**
 * Resolve o backend de sala com precedência env > config > default `memory`.
 *
 * PORTÁVEL (ADR-0053 §8): não faz I/O — recebe os valores já lidos.
 *
 * @param envValue Valor de `ALUY_ROOM_BACKEND` (env). `undefined` se ausente.
 * @param configValue Valor de `rooms.backend` no `~/.aluy/config.json`. `undefined` se ausente.
 * @returns O backend resolvido e um aviso opcional (fail-closed).
 */
export function resolveRoomBackend(envValue?: string, configValue?: string): RoomBackendResolution {
  // 1. env > config > default
  const raw = envValue ?? configValue;

  if (raw === undefined || raw === '') {
    return { backend: DEFAULT_ROOM_BACKEND };
  }

  const normalized = raw.trim().toLowerCase();

  if (isValidBackend(normalized)) {
    return { backend: normalized };
  }

  // fail-closed: inválido ⇒ memory + aviso (§5.2)
  return {
    backend: DEFAULT_ROOM_BACKEND,
    warning:
      `ALUY_ROOM_BACKEND/rooms.backend inválido: "${raw}". ` +
      `Usando "memory" (default). Valores aceitos: memory, file, loopback, broker.`,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidBackend(value: string): value is RoomBackend {
  return (ROOM_BACKENDS as readonly string[]).includes(value);
}

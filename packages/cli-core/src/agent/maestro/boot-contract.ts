// EST-1129 · ADR-0123 §2.2 — CONTRATO DO BOOT-SUPERVISOR (porta abstrata).
//
// Define os TIPOS e CONSTANTES do boot-supervisor que sobe os 3 sidecars
// (headroom + Mem0 + JudgeEngine/Ollama) sob travas DURAS G2.
// PORTÁVEL (ADR-0053 §8): ZERO I/O, ZERO import de `node:*`, ZERO sidecar,
// ZERO credencial (CLI-SEC-7). A implementação concreta mora no `@aluy/cli`.
//
// Invariantes (ADR-0123 §2.2 / threat-model G2 · AG-0008):
//   CA-G2-1 — Caminho absoluto: binário full path, nunca PATH/cwd.
//   CA-G2-2 — Spawn sem shell: argv array, nunca string.
//   CA-G2-3 — Recusa root: uid 0 ⇒ aborta spawn.
//   CA-G2-4 — Handshake antes de reusar porta: health-check bind/HTTP.
//   CA-G2-5 — Fail-open por sidecar: falha degrada, não trava o boot.
//   CA-G2-6 — Egress loopback-only: sidecar escuta só 127.0.0.1.
//   CA-G2-7 — Sem credencial: zero env var de credencial ao sidecar.
//   CA-G2-8 — Store Mem0: ~/.aluy/memory 0700/0600 (path-deny).
//   CA-G2-9 — Auto-spawn opt-in no nível das travas (default-ON, §2.2-bis).

import type { AgentProfileTier, SidecarTarget } from './provisioner-contract.js';

// ─── Sidecar kinds (os 3 daemons que o boot-supervisor sobe) ────────────

/** Tipos de sidecar que o boot-supervisor gerencia. */
export type SidecarKind = 'headroom' | 'mem0' | 'ollama';

// ─── Constantes de porta ─────────────────────────────────────────────────

/** Porta loopback do headroom (proxy de compressão). */
export const HEADROOM_PORT = 8787;

/** Porta loopback do Ollama (inference engine). */
export const OLLAMA_PORT = 11434;

/** Porta loopback do Mem0 (memory engine). Distinta do Ollama. */
export const MEM0_PORT = 11435;

// ─── Handshake (CA-G2-4) ─────────────────────────────────────────────────

/** Timeout do handshake HTTP para cada sidecar (ms). */
export const SIDECAR_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Intervalo entre tentativas de health-check ao subir um sidecar (ms). */
export const SIDECAR_POLL_INTERVAL_MS = 500;

/** Máximo de tentativas de health-check. */
export const SIDECAR_POLL_MAX_ATTEMPTS = Math.ceil(
  SIDECAR_HANDSHAKE_TIMEOUT_MS / SIDECAR_POLL_INTERVAL_MS,
);

// ─── Configuração de cada sidecar ────────────────────────────────────────

/** Configuração imutável de UM sidecar. */
export interface SidecarConfig {
  /** Caminho ABSOLUTO do binário. */
  readonly binary: string;
  /** Argumentos (argv array, sem shell — CA-G2-2). */
  readonly args: readonly string[];
  /** Porta loopback em que o sidecar deve escutar. */
  readonly port: number;
  /** URL base para handshake HTTP (ex.: `http://127.0.0.1:8787/health`). */
  readonly handshakeUrl: string;
  /** Timeout do handshake em ms. */
  readonly handshakeTimeoutMs: number;
  /**
   * F93 (CA-G2-4) — IDENTIDADE esperada no CORPO da resposta do handshake. O healthCheck
   * exige que o corpo CONTENHA esta substring, p/ provar que é NOSSO sidecar e não um
   * processo ESTRANHO que apenas devolve 200 na porta (segurança no box compartilhado +
   * correção quando outro serviço ocupa a porta). Ausente ⇒ só status 2xx/3xx (legado).
   */
  readonly expectedIdentity?: string;
}

// ─── Estado e resultado ──────────────────────────────────────────────────

/** Estado de UM sidecar após detecção/spawn. */
export interface SidecarState {
  /** Qual sidecar. */
  readonly kind: SidecarKind;
  /** Se está rodando e respondeu ao handshake. */
  readonly running: boolean;
  /** PID do processo spawnado (undefined se não spawnado). */
  readonly pid?: number;
  /** Mensagem de erro legível (undefined se ok). */
  readonly error?: string;
}

/** Resultado agregado do boot de todos os sidecars. */
export interface BootResult {
  /** Perfil ativo (LEVE/TURBO). */
  readonly profile: AgentProfileTier;
  /** Estados por sidecar. */
  readonly states: readonly SidecarState[];
  /** Se pelo menos um sidecar está rodando. */
  readonly anyRunning: boolean;
  /** Se TODOS os sidecars falharam. */
  readonly allFailed: boolean;
}

// ─── Interface do boot-supervisor (porta abstrata) ───────────────────────

/**
 * Porta ABSTRATA do boot-supervisor de sidecars.
 *
 * Contrato puro em `@aluy/cli-core` — ZERO I/O, ZERO sidecar.
 * A implementação concreta (spawn, health-check, handshake) mora no
 * `@aluy/cli` e injeta spawner/resolver/fetcher/fs por construtor.
 */
export interface BootSupervisor {
  /**
   * Sobe os sidecars conforme perfil e toggles.
   *
   * LEVE ⇒ zero sidecar spawnado (CA-BOOT-LEVE).
   * TURBO ⇒ sobe sidecars com toggle ON (CA-BOOT-TURBO).
   *
   * @param profile - Perfil (LEVE/TURBO).
   * @param toggles - Conjunto de sidecar targets ativos.
   * @param headroomBinaryPath - Caminho absoluto opcional do binário headroom.
   * @param ollamaBaseDir - Diretório base do Ollama (~/.aluy/ollama).
   * @param mem0VenvDir - Diretório do venv do Mem0 (~/.aluy/mem-venv).
   */
  boot(
    profile: AgentProfileTier,
    toggles: ReadonlySet<SidecarTarget>,
    headroomBinaryPath?: string,
    ollamaBaseDir?: string,
    mem0VenvDir?: string,
  ): Promise<BootResult>;

  /**
   * Verifica o estado de todos os sidecars (porta aberta + handshake).
   * Não spawna — só detecta.
   */
  checkState(
    headroomBinaryPath?: string,
    ollamaBaseDir?: string,
    mem0VenvDir?: string,
  ): Promise<readonly SidecarState[]>;

  /**
   * Para todos os sidecars spawnados por esta instância.
   * Best-effort — nunca lança.
   */
  shutdown(): Promise<void>;
}

// ─── Helpers puros ───────────────────────────────────────────────────────

/**
 * Resolve os caminhos padrão dos binários dos sidecars a partir do
 * diretório `~/.aluy/` e de configuração opcional.
 *
 * PURA — sem I/O. Retorna as configurações; a implementação concreta
 * verifica existência/executabilidade.
 */
export function resolveSidecarPaths(opts: {
  homeDir: string;
  headroomBinary?: string;
  ollamaBaseDir?: string;
  mem0VenvDir?: string;
  /**
   * SO-alvo p/ o LAYOUT do binário (EST-1129-bis). O contrato é puro (sem
   * `node:*`) ⇒ o SO é DADO injetado pelo locus (`@aluy/cli` passa
   * `process.platform`). Default `linux` (não-regressão: o caminho provado).
   * Windows tem árvore distinta: Ollama é `ollama.exe` na raiz e o venv do
   * Mem0 usa `Scripts/python.exe` (não `bin/python3`).
   */
  platform?: NodeJS.Platform;
}): {
  headroom: SidecarConfig;
  ollama: SidecarConfig;
  mem0: SidecarConfig;
} {
  const { homeDir, headroomBinary, ollamaBaseDir, mem0VenvDir, platform } = opts;
  const isWin = platform === 'win32';

  const ollamaDir = ollamaBaseDir ?? `${homeDir}/.aluy/ollama`;
  const mem0Dir = mem0VenvDir ?? `${homeDir}/.aluy/mem-venv`;

  // Layout do binário por SO (Windows tem árvore distinta de Unix).
  const headroomDefault = isWin ? 'headroom.exe' : 'headroom';
  const ollamaBin = isWin ? `${ollamaDir}/ollama.exe` : `${ollamaDir}/bin/ollama`;
  const mem0Python = isWin ? `${mem0Dir}/Scripts/python.exe` : `${mem0Dir}/bin/python3`;

  return {
    headroom: {
      binary: headroomBinary ?? headroomDefault,
      args: ['proxy', '--port', String(HEADROOM_PORT)],
      port: HEADROOM_PORT,
      handshakeUrl: `http://127.0.0.1:${HEADROOM_PORT}/health`,
      handshakeTimeoutMs: SIDECAR_HANDSHAKE_TIMEOUT_MS,
      // F93 — /health do headroom-proxy: `{"service":"headroom-proxy",...}` (identidade FORTE).
      expectedIdentity: 'headroom-proxy',
    },
    ollama: {
      binary: ollamaBin,
      args: ['serve'],
      port: OLLAMA_PORT,
      handshakeUrl: `http://127.0.0.1:${OLLAMA_PORT}/api/tags`,
      handshakeTimeoutMs: SIDECAR_HANDSHAKE_TIMEOUT_MS,
      // F93 — /api/tags do ollama devolve `{"models":[...]}` (assinatura do ollama).
      expectedIdentity: '"models"',
    },
    mem0: {
      binary: mem0Python,
      args: [`${mem0Dir}/aluy-mem0-server.py`, '--host', '127.0.0.1', '--port', String(MEM0_PORT)],
      port: MEM0_PORT,
      handshakeUrl: `http://127.0.0.1:${MEM0_PORT}/health`,
      handshakeTimeoutMs: SIDECAR_HANDSHAKE_TIMEOUT_MS,
      // F93 — /health do aluy-mem0-server: `{"ok": true}` (identidade FRACA — genérica;
      // idealmente o server devolveria um service-name próprio. Melhor que só 200).
      expectedIdentity: '"ok"',
    },
  };
}

/**
 * Mapeia um SidecarTarget (do provisioner) para o SidecarKind correspondente
 * e indica se o headroom deve ser incluído.
 */
export function targetsToKinds(
  toggles: ReadonlySet<SidecarTarget>,
  includeHeadroom: boolean = true,
): ReadonlySet<SidecarKind> {
  const kinds = new Set<SidecarKind>();
  if (includeHeadroom) kinds.add('headroom');
  if (toggles.has('ollama')) kinds.add('ollama');
  if (toggles.has('mem0')) kinds.add('mem0');
  return kinds;
}

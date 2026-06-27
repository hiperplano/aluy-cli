// EST-1129 · ADR-0123 §2.2 — BOOT-SUPERVISOR DE SIDECARS (implementação concreta).
//
// Implementa `BootSupervisor` do `@aluy/cli-core`. Sobe os 3 sidecars
// (headroom + Mem0 + JudgeEngine/Ollama) como daemons locais sob travas
// DURAS G2 (CA-G2-1..CA-G2-16). Injeta spawner/resolver/fetcher/fs por
// construtor para testabilidade — suíte nunca sobe daemon real.
//
// Travas (gate G2 · AG-0008):
//   CA-G2-1 — Binário por caminho absoluto, nunca PATH/cwd.
//   CA-G2-2 — Spawn sem shell, argv array.
//   CA-G2-3 — Recusa root (uid 0 ⇒ não spawna).
//   CA-G2-4 — Handshake de identidade antes de reusar porta.
//   CA-G2-5 — Fail-open por sidecar: falha degrada, NUNCA trava.
//   CA-G2-6 — Egress loopback-only (as URLs já são 127.0.0.1).
//   CA-G2-7 — Sem credencial no env do sidecar (CLI-SEC-7).
//   CA-G2-8 — Store Mem0 ~/.aluy/memory 0700/0600 (path-deny).
//   CA-G2-9 — Auto-spawn opt-in no nível das travas (default-ON, §2.2-bis).

import { spawn, type ChildProcess } from 'node:child_process';
import { win32 as pathWin32, posix as pathPosix } from 'node:path';
import { type PathLike } from 'node:fs';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import {
  type BootSupervisor,
  type BootResult,
  type SidecarState,
  type SidecarKind,
  type SidecarConfig,
  type AgentProfileTier,
  type SidecarTarget,
  SIDECAR_POLL_INTERVAL_MS,
  SIDECAR_POLL_MAX_ATTEMPTS,
  resolveSidecarPaths,
  targetsToKinds,
  shouldProvision,
} from '@aluy/cli-core';

// ─── Portas injetáveis ───────────────────────────────────────────────────

/** Assinatura de `spawn` (child_process.spawn). Injetável p/ teste. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SpawnFn = (...args: any[]) => ChildProcess;

/** Opções de spawn suportadas (subconjunto de child_process.SpawnOptions). */
export interface SpawnOptions {
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
  readonly stdio?: 'pipe' | 'ignore' | 'inherit' | readonly ('pipe' | 'ignore' | 'inherit')[];
  readonly detached?: boolean;
  readonly uid?: number;
}

/** Assinatura de `fetch`. Injetável p/ teste. `text()` é OPCIONAL (F93 — valida a
 * identidade do sidecar; mocks sem `text` caem no check só-de-status, retrocompat). */
export type FetchFn = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ readonly ok: boolean; text?(): Promise<string> }>;

/** Assinatura de `setTimeout`/`clearTimeout`. Injetável p/ teste. */
export interface TimerPort {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

/** Porta de filesystem mínima para o boot-supervisor. */
export interface BootFileSystem {
  existsSync(path: PathLike): boolean;
  mkdirSync(path: PathLike, options?: { mode?: number; recursive?: boolean }): void;
  chmodSync(path: PathLike, mode: number): void;
}

/** Opções do construtor do NodeBootSupervisor. */
export interface NodeBootSupervisorOptions {
  /** Spawn de processo (default: `require('child_process').spawn`). */
  readonly spawn?: SpawnFn;
  /** Fetch para handshake HTTP (default: `globalThis.fetch`). */
  readonly fetchFn?: FetchFn;
  /** Timers (default: global). */
  readonly timer?: TimerPort;
  /** FileSystem (default: `require('fs')`). */
  readonly fs?: BootFileSystem;
  /** UID do processo (default: process.getuid()). */
  readonly uid?: number;
  /**
   * SO-alvo p/ o layout do binário e a checagem de caminho absoluto
   * (EST-1129-bis). Default: `process.platform`. Injetável p/ teste
   * determinístico (sem depender do SO do runner da suíte).
   */
  readonly platform?: NodeJS.Platform;
}

// ─── Timer real ──────────────────────────────────────────────────────────

const realTimer: TimerPort = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// ─── FS real ─────────────────────────────────────────────────────────────

const realFs: BootFileSystem = {
  existsSync: (path) => existsSync(path as string),
  mkdirSync: (path, opts) => mkdirSync(path as string, opts),
  chmodSync: (path, mode) => chmodSync(path as string, mode),
};

// ─── Implementação ───────────────────────────────────────────────────────

/**
 * Boot-supervisor concreto que sobe sidecars como processos locais.
 *
 * Injeta spawner/resolver/fetcher/fs por construtor — testável sem
 * subir daemon real. Implementa `BootSupervisor` do `@aluy/cli-core`.
 */
export class NodeBootSupervisor implements BootSupervisor {
  private readonly spawn: SpawnFn;
  private readonly fetchFn: FetchFn;
  private readonly timer: TimerPort;
  private readonly fs: BootFileSystem;
  private readonly uid: number;
  private readonly platform: NodeJS.Platform;

  /** Processos spawnados por esta instância (para shutdown). */
  private readonly children = new Map<SidecarKind, ChildProcess>();

  constructor(opts: NodeBootSupervisorOptions = {}) {
    this.spawn = opts.spawn ?? spawn;
    this.fetchFn = opts.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
    this.timer = opts.timer ?? realTimer;
    this.fs = opts.fs ?? realFs;
    this.uid = opts.uid ?? (typeof process !== 'undefined' ? (process.getuid?.() ?? -1) : -1);
    this.platform = opts.platform ?? (typeof process !== 'undefined' ? process.platform : 'linux');
  }

  /** HOME do usuário (HOME no Unix, USERPROFILE no Windows). */
  private homeDir(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? '/home/unknown';
  }

  /**
   * Env MÍNIMO p/ o spawn do sidecar (CA-G2-7: zero credencial).
   * Whitelist de variáveis NÃO-segredo. No Windows, processos nativos
   * (ollama.exe, python.exe) exigem `SystemRoot`/`windir`/`TEMP`/etc. —
   * sem elas o binário nem inicia. Nenhuma dessas é credencial.
   */
  private sidecarEnv(kind?: SidecarKind): Record<string, string | undefined> {
    const e = process.env;
    const env: Record<string, string | undefined> = {
      HOME: e.HOME,
      PATH: e.PATH,
    };
    if (this.platform === 'win32') {
      for (const key of [
        'SystemRoot',
        'windir',
        'SystemDrive',
        'ComSpec',
        'PATHEXT',
        'USERPROFILE',
        'LOCALAPPDATA',
        'APPDATA',
        'ProgramData',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'TEMP',
        'TMP',
        'NUMBER_OF_PROCESSORS',
        'PROCESSOR_ARCHITECTURE',
      ]) {
        if (e[key] !== undefined) env[key] = e[key];
      }
    }
    // headroom: o core Rust (`headroom._core`) não tem wheel p/ Windows ⇒ sem este
    // opt-out o proxy ABORTA no boot. Modo Python-degradado (ainda comprime/serve
    // /health). Respeita um valor já setado pelo usuário no ambiente.
    if (kind === 'headroom' && e.HEADROOM_REQUIRE_RUST_CORE === undefined) {
      env.HEADROOM_REQUIRE_RUST_CORE = 'false';
    }
    return env;
  }

  // ─── BootSupervisor impl ─────────────────────────────────────────────

  /** @inheritdoc */
  async boot(
    profile: AgentProfileTier,
    toggles: ReadonlySet<SidecarTarget>,
    headroomBinaryPath?: string,
    ollamaBaseDir?: string,
    mem0VenvDir?: string,
  ): Promise<BootResult> {
    // LEVE ⇒ zero sidecar spawnado (CA-BOOT-LEVE).
    if (!shouldProvision(profile)) {
      return {
        profile,
        states: [],
        anyRunning: false,
        allFailed: false,
      };
    }

    const paths = resolveSidecarPaths({
      homeDir: this.homeDir(),
      platform: this.platform,
      ...(headroomBinaryPath !== undefined ? { headroomBinary: headroomBinaryPath } : {}),
      ...(ollamaBaseDir !== undefined ? { ollamaBaseDir } : {}),
      ...(mem0VenvDir !== undefined ? { mem0VenvDir } : {}),
    });

    const kinds = targetsToKinds(toggles, headroomBinaryPath !== undefined);
    const states: SidecarState[] = [];

    for (const kind of kinds) {
      const config = paths[kind];
      const state = await this.ensureSidecar(kind, config);
      states.push(state);
    }

    const anyRunning = states.some((s) => s.running);
    const allFailed = states.length > 0 && states.every((s) => !s.running);

    return { profile, states, anyRunning, allFailed };
  }

  /** @inheritdoc */
  async checkState(
    headroomBinaryPath?: string,
    ollamaBaseDir?: string,
    mem0VenvDir?: string,
  ): Promise<readonly SidecarState[]> {
    const paths = resolveSidecarPaths({
      homeDir: this.homeDir(),
      platform: this.platform,
      ...(headroomBinaryPath !== undefined ? { headroomBinary: headroomBinaryPath } : {}),
      ...(ollamaBaseDir !== undefined ? { ollamaBaseDir } : {}),
      ...(mem0VenvDir !== undefined ? { mem0VenvDir } : {}),
    });

    const states: SidecarState[] = [];
    const allKinds: SidecarKind[] = ['headroom', 'ollama', 'mem0'];

    for (const kind of allKinds) {
      const config = paths[kind];
      const running = await this.healthCheck(config);
      const childPid = this.children.get(kind)?.pid;
      const state: SidecarState = { kind, running };
      if (childPid !== undefined) (state as { pid?: number }).pid = childPid;
      states.push(state);
    }

    return states;
  }

  /** @inheritdoc */
  async shutdown(): Promise<void> {
    for (const [kind, child] of this.children) {
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      this.children.delete(kind);
    }
  }

  // ─── Spawn seguro ────────────────────────────────────────────────────

  /**
   * Garante que um sidecar está rodando: detecta porta ou spawna.
   * Sempre fail-open (CA-G2-5): erro ⇒ estado { running: false }.
   */
  private async ensureSidecar(kind: SidecarKind, config: SidecarConfig): Promise<SidecarState> {
    try {
      // 1. CA-G2-4: handshake antes de reusar porta.
      const alreadyUp = await this.healthCheck(config);
      if (alreadyUp) {
        return { kind, running: true };
      }

      // 2. CA-G2-3: recusa root.
      if (this.uid === 0) {
        return {
          kind,
          running: false,
          error: `recusa root (CA-G2-3): uid=0, sidecar "${kind}" não spawnado`,
        };
      }

      // 3. CA-G2-1: verifica caminho absoluto (cross-platform: `/usr/...` no
      //    Unix, `C:\...` no Windows). A checagem segue o SO-ALVO injetado
      //    (`this.platform`), NÃO o host: o `isAbsolute` default do `node:path`
      //    é POSIX no Linux ⇒ rejeitaria `C:\...` como "não-absoluto" rodando
      //    a suíte/CI no Linux (e seria não-determinístico entre máquinas). O
      //    intuito da trava (nunca PATH/cwd/relativo) se mantém intacto.
      const isAbsoluteForTarget =
        this.platform === 'win32' ? pathWin32.isAbsolute : pathPosix.isAbsolute;
      if (!isAbsoluteForTarget(config.binary)) {
        return {
          kind,
          running: false,
          error: `caminho não-absoluto recusado (CA-G2-1): "${config.binary}"`,
        };
      }

      // 4. Verifica permissão de execução (best-effort, não derruba).
      const binExists = this.fs.existsSync(config.binary);
      if (!binExists) {
        return {
          kind,
          running: false,
          error: `binário não encontrado: "${config.binary}"`,
        };
      }

      // 5. CA-G2-2: spawn sem shell, argv array.
      //    CA-G2-7: env mínimo, sem credencial.
      const child = this.spawn(config.binary, [...config.args], {
        detached: true,
        stdio: 'ignore',
        // No Windows, sem isto cada sidecar (ollama/python/headroom) abre uma janela
        // de console. windowsHide esconde; detached mantém o daemon vivo após o pai.
        windowsHide: true,
        env: this.sidecarEnv(kind),
      });

      child.unref?.();
      this.children.set(kind, child);

      // 6. Aguarda handshake (CA-G2-4).
      const up = await this.waitForHandshake(config);
      if (up) {
        const result: SidecarState = { kind, running: true };
        if (child.pid !== undefined) (result as { pid?: number }).pid = child.pid;
        return result;
      }

      // Handshake falhou — mata o processo órfão.
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      this.children.delete(kind);

      return {
        kind,
        running: false,
        error: `handshake falhou (timeout ${config.handshakeTimeoutMs}ms) para ${kind} em ${config.handshakeUrl}`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { kind, running: false, error: `erro inesperado: ${msg}` };
    }
  }

  // ─── Health-check ─────────────────────────────────────────────────────

  /**
   * CA-G2-4: handshake de identidade via HTTP GET.
   * Retorna `true` se o sidecar respondeu com status 2xx ou 3xx.
   */
  private async healthCheck(config: SidecarConfig): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timerId = this.timer.setTimeout(() => controller.abort(), config.handshakeTimeoutMs);

      try {
        const resp = await this.fetchFn(config.handshakeUrl, {
          signal: controller.signal,
        });
        if (!resp.ok) return false;
        // F93 (CA-G2-4) — VALIDA A IDENTIDADE: o corpo precisa conter `expectedIdentity`
        // p/ provar que é NOSSO sidecar e não um processo estranho que só devolve 200 na
        // porta. Sem identidade configurada OU sem `text()` (mock) ⇒ só status (legado).
        if (config.expectedIdentity !== undefined && typeof resp.text === 'function') {
          try {
            const body = await resp.text();
            return body.includes(config.expectedIdentity);
          } catch {
            return false; // corpo ilegível ⇒ não confia (fail-closed).
          }
        }
        return true;
      } finally {
        this.timer.clearTimeout(timerId);
      }
    } catch {
      return false;
    }
  }

  /**
   * Polling de health-check até o sidecar responder ou timeout.
   */
  private async waitForHandshake(config: SidecarConfig): Promise<boolean> {
    for (let i = 0; i < SIDECAR_POLL_MAX_ATTEMPTS; i++) {
      const ok = await this.healthCheck(config);
      if (ok) return true;
      await this.sleep(SIDECAR_POLL_INTERVAL_MS);
    }
    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timer.setTimeout(resolve as () => void, ms);
    });
  }
}

// ─── Store Mem0 (CA-G2-8) ────────────────────────────────────────────────

/** Permissões de diretório (0700). */
const DIR_MODE = 0o700;

/**
 * Garante que o diretório `~/.aluy/memory` existe com permissão 0700.
 * Idempotente, fail-safe — nunca lança.
 *
 * CA-G2-8: store Mem0 em `~/.aluy/memory` read-deny, 0700/0600.
 */
export function ensureMemoryStoreDir(base: string, fs: BootFileSystem = realFs): void {
  try {
    fs.mkdirSync(base, { recursive: true, mode: DIR_MODE });
    fs.chmodSync(base, DIR_MODE);
  } catch {
    // best-effort: store é do Mem0 (serviço externo), o dir é só
    // um path-deny anchor. Degradação continua.
  }
}

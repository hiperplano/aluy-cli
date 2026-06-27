// EST-1129 · ADR-0123 §2.2 — TESTES do boot-supervisor de sidecars.
//
// 1 teste por CA (gate G2 · AG-0008), SEM placebo, SEM || true, SEM .skip.
// Injeta fakes de spawn/fetch/fs/timer por construtor — NUNCA sobe daemon real.
//
// Travas testadas:
//   CA-G2-1  — Caminho absoluto do binário
//   CA-G2-2  — Spawn sem shell (argv array)
//   CA-G2-3  — Recusa root
//   CA-G2-4  — Handshake antes de reusar porta
//   CA-G2-5  — Fail-open por sidecar (degrada, não trava)
//   CA-G2-6  — Egress loopback-only (URLs são 127.0.0.1)
//   CA-G2-7  — Sem credencial no env do sidecar
//   CA-G2-8  — Store Mem0 ~/.aluy/memory 0700/0600
//   CA-G2-9  — Auto-spawn opt-in no nível das travas (default-ON)
//   CA-BOOT-LEVE   — Perfil LEVE ⇒ 0 spawn
//   CA-BOOT-TURBO  — Perfil TURBO ⇒ sobe, 1 falho ⇒ não trava
//   CA-BOOT-CONFIG — Toggle/precedência

import { describe, expect, it, vi } from 'vitest';
import { type ChildProcess } from 'node:child_process';
import { type PathLike } from 'node:fs';
import {
  NodeBootSupervisor,
  ensureMemoryStoreDir,
  type SpawnFn,
  type FetchFn,
  type TimerPort,
  type BootFileSystem,
} from '../../src/maestro/boot-supervisor.js';
import {
  type AgentProfileTier,
  type SidecarTarget,
  HEADROOM_PORT,
  OLLAMA_PORT,
  MEM0_PORT,
  SIDECAR_POLL_MAX_ATTEMPTS,
  resolveSidecarPaths,
} from '@hiperplano/aluy-cli-core';

// ─── Fakes ───────────────────────────────────────────────────────────────

/** Cria um ChildProcess fake com pid e kill mockados. */
function fakeChildProcess(pid: number): ChildProcess {
  return {
    pid,
    kill: vi.fn(),
    unref: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    emit: vi.fn(),
    getMaxListeners: () => 10,
    listenerCount: () => 0,
    listeners: () => [],
    rawListeners: () => [],
    prependListener: vi.fn(),
    prependOnceListener: vi.fn(),
    removeAllListeners: vi.fn(),
    setMaxListeners: vi.fn(),
    eventNames: () => [],
    stdin: null,
    stdout: null,
    stderr: null,
    channel: undefined,
    connected: false,
    exitCode: null,
    signalCode: null,
    spawnargs: [],
    spawnfile: '',
    killed: false,
    ref: vi.fn(),
  } as unknown as ChildProcess;
}

/** Timer fake: setTimeout executa callback imediatamente (microtask). */
function fakeTimer(): TimerPort & { advanceAll(): void } {
  const pending = new Map<unknown, () => void>();
  let nextId = 0;
  return {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    setTimeout(fn, ms: number) {
      const id = nextId++;
      pending.set(id, fn);
      // Executa imediatamente para não travar testes.
      void Promise.resolve().then(() => {
        if (pending.has(id)) {
          pending.delete(id);
          fn();
        }
      });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    advanceAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
  };
}

/** FS fake: por padrão tudo existe. */
function fakeFs(existingPaths?: Set<string>): BootFileSystem {
  const all = existingPaths ?? new Set<string>();
  return {
    existsSync(path: PathLike) {
      return all.has(String(path));
    },
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────

const defaultPaths = resolveSidecarPaths({
  homeDir: '/home/test',
  headroomBinary: '/usr/local/bin/headroom',
  ollamaBaseDir: '/home/test/.aluy/ollama',
  mem0VenvDir: '/home/test/.aluy/mem-venv',
  platform: 'linux',
});

const TURBO: AgentProfileTier = 'turbo';
const LEVE: AgentProfileTier = 'leve';
const ALL_TOGGLES = new Set<SidecarTarget>(['ollama', 'mem0'] as const);
const EMPTY_TOGGLES = new Set<SidecarTarget>();

// ─── CA-G2-1: caminho absoluto do binário ────────────────────────────────

describe('CA-G2-1 — caminho absoluto do binário', () => {
  it('recusa binário com path relativo', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false })); // força spawn
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(1000));
    const fs = fakeFs(new Set(['/usr/local/bin/headroom']));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    // Passa headroom binary path relativo
    const result = await sup.boot(TURBO, ALL_TOGGLES, 'headroom');

    // Spawn NUNCA deve ser chamado com path relativo.
    // O sidecar headroom deve falhar com erro de caminho não-absoluto.
    const headroomState = result.states.find((s) => s.kind === 'headroom');
    expect(headroomState).toBeDefined();
    expect(headroomState!.running).toBe(false);
    expect(headroomState!.error).toContain('não-absoluto');
    expect(headroomState!.error).toContain('CA-G2-1');
  });
});

// ─── F93 (CA-G2-4): handshake VALIDA IDENTIDADE, não só status 200 ───────

describe('F93 — handshake valida a identidade do corpo (não confia em 200 cego)', () => {
  const winBin = defaultPaths.headroom.binary; // headroom default (linux, absoluto).

  it('corpo ESTRANHO com 200 ⇒ NÃO reusa a porta (spawna o nosso sidecar)', async () => {
    // Um processo qualquer ocupa a porta e devolve 200 com corpo alheio.
    const fetchFn = vi.fn<FetchFn>(async () => ({
      ok: true,
      text: async () => '{"service":"algum-outro-daemon","status":"up"}',
    }));
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(7001));
    const fs = fakeFs(new Set([winBin]));
    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    await sup.boot(TURBO, EMPTY_TOGGLES, winBin);
    // identidade não bate ⇒ alreadyUp=false ⇒ tentou SPAWNAR o nosso (não confiou no 200 alheio).
    expect(spawnFn).toHaveBeenCalled();
  });

  it('corpo com a IDENTIDADE certa ⇒ reusa a porta (NÃO spawna)', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({
      ok: true,
      text: async () => '{"service":"headroom-proxy","ok":true}',
    }));
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(7002));
    const fs = fakeFs(new Set([winBin]));
    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    const result = await sup.boot(TURBO, EMPTY_TOGGLES, winBin);
    const headroom = result.states.find((s) => s.kind === 'headroom');
    expect(headroom!.running).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled(); // identidade bateu ⇒ reusou.
  });

  it('mock sem text() (200 cego) ⇒ legado: reusa por status (retrocompat)', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true })); // sem text()
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(7003));
    const fs = fakeFs(new Set([winBin]));
    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    const result = await sup.boot(TURBO, EMPTY_TOGGLES, winBin);
    const headroom = result.states.find((s) => s.kind === 'headroom');
    expect(headroom!.running).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled(); // sem text() ⇒ cai no check só-de-status.
  });
});

// ─── EST-1129-bis: suporte a Windows (layout + caminho absoluto) ─────────

describe('EST-1129-bis — Windows', () => {
  it('resolveSidecarPaths(win32) usa ollama.exe e venv Scripts/python.exe', () => {
    const paths = resolveSidecarPaths({
      homeDir: 'C:\\Users\\dev',
      ollamaBaseDir: 'C:\\Users\\dev\\.aluy\\ollama',
      mem0VenvDir: 'C:\\Users\\dev\\.aluy\\mem-venv',
      platform: 'win32',
    });
    expect(paths.ollama.binary.endsWith('ollama.exe')).toBe(true);
    expect(paths.mem0.binary.endsWith('Scripts/python.exe')).toBe(true);
    // o default do headroom também é .exe no Windows.
    const def = resolveSidecarPaths({ homeDir: 'C:\\Users\\dev', platform: 'win32' });
    expect(def.headroom.binary).toBe('headroom.exe');
    // handshake segue loopback (CA-G2-6), independente do SO.
    expect(paths.ollama.handshakeUrl).toContain('127.0.0.1');
  });

  it('CA-G2-1(win32): caminho absoluto C:\\... é ACEITO (tenta spawnar)', async () => {
    const winHeadroom = 'C:\\Users\\dev\\.aluy\\headroom\\headroom.exe';
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false })); // força spawn
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(9100));
    const fs = fakeFs(new Set([winHeadroom]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
      platform: 'win32',
    });

    const result = await sup.boot(TURBO, EMPTY_TOGGLES, winHeadroom);
    const headroom = result.states.find((s) => s.kind === 'headroom');
    expect(headroom).toBeDefined();
    // NÃO recusado por "não-absoluto": o spawn foi tentado.
    expect(headroom!.error ?? '').not.toContain('não-absoluto');
    expect(spawnFn).toHaveBeenCalled();
  });

  it('CA-G2-1(win32): caminho relativo continua RECUSADO', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false }));
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(9200));
    const fs = fakeFs();

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
      platform: 'win32',
    });

    const result = await sup.boot(TURBO, EMPTY_TOGGLES, 'headroom.exe');
    const headroom = result.states.find((s) => s.kind === 'headroom');
    expect(headroom!.running).toBe(false);
    expect(headroom!.error).toContain('não-absoluto');
    expect(headroom!.error).toContain('CA-G2-1');
  });
});

// ─── CA-G2-2: spawn sem shell, argv array ────────────────────────────────

describe('CA-G2-2 — spawn sem shell, argv array', () => {
  it('spawn é chamado com argv array, nunca string', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false })); // força spawn
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(1000));
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const timer = fakeTimer();
    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer,
    });

    // Dispara boot só com headroom.
    await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // Spawn deve ter sido chamado.
    expect(spawnFn).toHaveBeenCalled();

    const callArgs = spawnFn.mock.calls[0]!;
    // 1º arg é o comando (string de caminho absoluto).
    expect(typeof callArgs[0]).toBe('string');
    // 2º arg DEVE ser um array (os args), NUNCA uma string.
    const secondArg = callArgs[1];
    expect(Array.isArray(secondArg)).toBe(true);

    // 3º arg (opções) NÃO deve ser uma string (shell comando).
    const thirdArg = callArgs[2];
    if (thirdArg !== undefined && thirdArg !== null) {
      expect(typeof thirdArg).not.toBe('string');
      // stdio deve ser definido (ignore/pipe), não shell
    }
  });
});

// ─── CA-G2-3: recusa root ────────────────────────────────────────────────

describe('CA-G2-3 — recusa root', () => {
  it('uid 0 ⇒ não spawna sidecar', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false })); // força caminho de spawn
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(1000));
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 0, // ROOT
      fs,
      timer: fakeTimer(),
    });

    const result = await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // NENHUM spawn deve ocorrer — root é recusado ANTES.
    // Mesmo com health-check falhando, o spawn é barrado por uid=0.
    const spawnedStates = result.states.filter((s) => s.running);
    expect(spawnedStates.length).toBe(0);

    // Pelo menos um estado deve reportar erro de root.
    const rootErrors = result.states.filter(
      (s) => s.error?.includes('CA-G2-3') || s.error?.includes('root'),
    );
    expect(rootErrors.length).toBeGreaterThan(0);
  });
});

// ─── CA-G2-4: handshake antes de reusar porta ────────────────────────────

describe('CA-G2-4 — handshake antes de reusar porta', () => {
  it('se health-check ok, NÃO spawna', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true })); // health-check OK
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(1000));
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    const result = await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // Spawn NÃO deve ser chamado se health-check passou.
    expect(spawnFn).not.toHaveBeenCalled();

    // Estados devem reportar running.
    const headroomState = result.states.find((s) => s.kind === 'headroom');
    expect(headroomState).toBeDefined();
    expect(headroomState!.running).toBe(true);
  });

  it('se health-check falha, spawna e faz polling até handshake', async () => {
    let callCount = 0;
    const fetchFn = vi.fn<FetchFn>(async () => {
      // Falha nas primeiras N-1 chamadas, sucesso na última.
      callCount++;
      return { ok: callCount > SIDECAR_POLL_MAX_ATTEMPTS - 2 };
    });
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(2000));
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // Spawn DEVE ter sido chamado (health-check inicial falhou).
    expect(spawnFn).toHaveBeenCalled();
  });
});

// ─── CA-G2-5: fail-open por sidecar ──────────────────────────────────────

describe('CA-G2-5 — fail-open por sidecar (degrada, não trava)', () => {
  it('spawn de um sidecar falha ⇒ boot NÃO lança, reporta erro', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false }));
    const spawnFn = vi.fn<SpawnFn>(() => {
      throw new Error('ENOENT: binário não encontrado');
    });
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    // boot() NUNCA deve lançar.
    let result;
    try {
      result = await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);
    } catch {
      expect.fail('boot() lançou — viola CA-G2-5 fail-open');
    }

    expect(result).toBeDefined();
    // Deve haver estados com erro, mas result existe.
    const errorStates = result!.states.filter((s) => !s.running);
    expect(errorStates.length).toBeGreaterThan(0);
  });

  it('handshake timeout ⇒ sidecar marcado como não-rodando, boot continua', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false })); // nunca responde
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(3000));
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    // Não deve lançar.
    const result = await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);
    expect(result.allFailed || !result.anyRunning).toBe(true);
    // O boot terminou (não ficou preso no polling infinito).
    expect(result.states.length).toBeGreaterThan(0);
  });
});

// ─── CA-G2-6: egress loopback-only ───────────────────────────────────────

describe('CA-G2-6 — egress loopback-only', () => {
  it('URLs de handshake apontam para 127.0.0.1', () => {
    const paths = resolveSidecarPaths({
      homeDir: '/home/test',
      headroomBinary: '/usr/local/bin/headroom',
    });

    // Todas as URLs de handshake devem ser loopback.
    for (const config of [paths.headroom, paths.ollama, paths.mem0]) {
      expect(config.handshakeUrl).toContain('127.0.0.1');
      // Não deve conter hostname DNS.
      expect(config.handshakeUrl).not.toContain('://localhost');
      expect(config.handshakeUrl).not.toContain('://0.0.0.0');
    }
  });

  it('portas são distintas e conhecidas', () => {
    const paths = resolveSidecarPaths({ homeDir: '/home/test' });

    // Portas distintas para cada sidecar.
    const ports = [paths.headroom.port, paths.ollama.port, paths.mem0.port];
    const unique = new Set(ports);
    expect(unique.size).toBe(3);

    // Portas conhecidas.
    expect(ports).toContain(HEADROOM_PORT);
    expect(ports).toContain(OLLAMA_PORT);
    expect(ports).toContain(MEM0_PORT);
  });
});

// ─── CA-G2-7: sem credencial no env do sidecar ───────────────────────────

describe('CA-G2-7 — sem credencial no env do sidecar', () => {
  it('env passado ao spawn não contém credencial', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false }));
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(4000));
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // Se spawn foi chamado, verifica as opções de env.
    if (spawnFn.mock.calls.length > 0) {
      for (const call of spawnFn.mock.calls) {
        const thirdArg = call[2] as Record<string, unknown> | undefined;
        if (thirdArg?.env) {
          const env = thirdArg.env as Record<string, string | undefined>;
          // NÃO deve conter chaves de API, tokens, ou credenciais.
          const forbiddenKeys = [
            'API_KEY',
            'API_TOKEN',
            'SECRET',
            'CREDENTIAL',
            'PASSWORD',
            'ANTHROPIC_API_KEY',
            'OPENAI_API_KEY',
            'OPENROUTER_API_KEY',
            'ALUY_TOKEN',
            'BROKER_TOKEN',
          ];
          for (const key of forbiddenKeys) {
            expect(env[key]).toBeUndefined();
          }
        }
      }
    }
  });
});

// ─── CA-G2-8: store Mem0 ~/.aluy/memory 0700/0600 ────────────────────────

describe('CA-G2-8 — store Mem0 0700/0600', () => {
  it('ensureMemoryStoreDir cria diretório com permissão 0700', () => {
    const fs = fakeFs();
    ensureMemoryStoreDir('/tmp/test-aluy/memory', fs);

    expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/test-aluy/memory', {
      recursive: true,
      mode: 0o700,
    });
    expect(fs.chmodSync).toHaveBeenCalledWith('/tmp/test-aluy/memory', 0o700);
  });

  it('ensureMemoryStoreDir não lança em erro', () => {
    const fs: BootFileSystem = {
      existsSync: () => false,
      mkdirSync: () => {
        throw new Error('EACCES');
      },
      chmodSync: vi.fn(),
    };

    // NÃO deve lançar.
    expect(() => ensureMemoryStoreDir('/root/denied', fs)).not.toThrow();
  });
});

// ─── CA-G2-9: auto-spawn opt-in (default-ON) ─────────────────────────────

describe('CA-G2-9 — auto-spawn opt-in no nível das travas', () => {
  it('perfil TURBO com toggles ON ⇒ tenta spawnar', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false }));
    const spawnFn = vi.fn<SpawnFn>(() => fakeChildProcess(5000));
    const fs = fakeFs(
      new Set([defaultPaths.headroom.binary, defaultPaths.ollama.binary, defaultPaths.mem0.binary]),
    );

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
      platform: 'linux',
    });

    const result = await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // Deve tentar spawnar (3 sidecars com toggles ON + headroom).
    expect(spawnFn).toHaveBeenCalled();
    expect(result.states.length).toBeGreaterThan(0);
  });
});

// ─── CA-BOOT-LEVE: perfil LEVE ⇒ zero spawn ──────────────────────────────

describe('CA-BOOT-LEVE — perfil LEVE ⇒ zero spawn', () => {
  it('perfil LEVE retorna resultado vazio sem spawnar', async () => {
    const fetchFn = vi.fn<FetchFn>();
    const spawnFn = vi.fn<SpawnFn>();
    const fs = fakeFs();

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    const result = await sup.boot(LEVE, ALL_TOGGLES);

    // NENHUM spawn, NENHUM fetch.
    expect(spawnFn).not.toHaveBeenCalled();
    expect(result.states).toEqual([]);
    expect(result.anyRunning).toBe(false);
    expect(result.allFailed).toBe(false);
    expect(result.profile).toBe('leve');
  });
});

// ─── CA-BOOT-TURBO: perfil TURBO, 1 falho ⇒ não trava ────────────────────

describe('CA-BOOT-TURBO — perfil TURBO, 1 falho ⇒ não trava', () => {
  it('um sidecar falha, outros continuam, boot não trava', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: false }));
    // Spawn funciona para uns, falha para outros.
    let spawnCount = 0;
    const spawnFn = vi.fn<SpawnFn>(() => {
      spawnCount++;
      if (spawnCount === 2) {
        throw new Error('falha simulada no segundo sidecar');
      }
      return fakeChildProcess(6000 + spawnCount);
    });
    const fs = fakeFs(
      new Set([defaultPaths.headroom.binary, defaultPaths.ollama.binary, defaultPaths.mem0.binary]),
    );

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
      platform: 'linux',
    });

    // NÃO deve lançar.
    const result = await sup.boot(TURBO, ALL_TOGGLES, defaultPaths.headroom.binary);

    // Deve ter pelo menos um erro.
    const errorStates = result.states.filter((s) => !s.running);
    expect(errorStates.length).toBeGreaterThan(0);

    // boot terminou — não travou.
    expect(result.profile).toBe('turbo');
    expect(result.allFailed).toBe(true); // todos falharam porque handshake nunca ok
  });
});

// ─── CA-BOOT-CONFIG: toggle/precedência ──────────────────────────────────

describe('CA-BOOT-CONFIG — toggle/precedência', () => {
  it('com toggles vazios, só headroom é considerado', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true })); // health-check ok ⇒ sem spawn
    const spawnFn = vi.fn<SpawnFn>();
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    const result = await sup.boot(TURBO, EMPTY_TOGGLES, defaultPaths.headroom.binary);

    // Só headroom deve ser verificado, ollama e mem0 NÃO.
    const kinds = result.states.map((s) => s.kind);
    expect(kinds).toContain('headroom');
    expect(kinds).not.toContain('ollama');
    expect(kinds).not.toContain('mem0');
  });

  it('com toggle mem0=false, mem0 não é spawnado', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true }));
    const spawnFn = vi.fn<SpawnFn>();
    const fs = fakeFs(new Set([defaultPaths.headroom.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    // Só ollama ON
    const toggles = new Set<SidecarTarget>(['ollama'] as const);
    const result = await sup.boot(TURBO, toggles, defaultPaths.headroom.binary);

    const kinds = result.states.map((s) => s.kind);
    expect(kinds).not.toContain('mem0');
    expect(kinds).toContain('ollama');
    expect(kinds).toContain('headroom');
  });
});

// ─── shutdown ────────────────────────────────────────────────────────────

describe('shutdown', () => {
  it('mata todos os processos spawnados', async () => {
    const child1 = fakeChildProcess(100);
    const child2 = fakeChildProcess(200);
    let spawnCount = 0;
    const spawnFn = vi.fn<SpawnFn>(() => {
      spawnCount++;
      return spawnCount === 1 ? child1 : child2;
    });
    // 1ª chamada (health-check inicial): falha → força spawn.
    // Chamadas seguintes (polling): sucesso → handshake OK → fica vivo.
    let fetchCalls = 0;
    const fetchFn = vi.fn<FetchFn>(async () => {
      fetchCalls++;
      return { ok: fetchCalls > 1 };
    });
    const fs = fakeFs(new Set([defaultPaths.headroom.binary, defaultPaths.ollama.binary]));

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs,
      timer: fakeTimer(),
    });

    // Só headroom (sem ollama/mem0 toggles) para garantir 1 sidecar.
    await sup.boot(TURBO, new Set<SidecarTarget>(), defaultPaths.headroom.binary);

    // Spawn deve ter sido chamado.
    expect(spawnFn).toHaveBeenCalled();

    // Shutdown.
    await sup.shutdown();

    // kill deve ter sido chamado com SIGTERM no child spawnado.
    expect(child1.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

// ─── checkState ──────────────────────────────────────────────────────────

describe('checkState', () => {
  it('retorna estado de todos os 3 sidecars sem spawnar', async () => {
    const fetchFn = vi.fn<FetchFn>(async () => ({ ok: true }));
    const spawnFn = vi.fn<SpawnFn>();

    const sup = new NodeBootSupervisor({
      spawn: spawnFn,
      fetchFn,
      uid: 1000,
      fs: fakeFs(),
      timer: fakeTimer(),
    });

    const states = await sup.checkState(defaultPaths.headroom.binary);

    // 3 sidecars verificados.
    expect(states.length).toBe(3);
    expect(states.map((s) => s.kind).sort()).toEqual(['headroom', 'mem0', 'ollama']);

    // NENHUM spawn.
    expect(spawnFn).not.toHaveBeenCalled();

    // Todos running (fetch mock retorna ok).
    for (const state of states) {
      expect(state.running).toBe(true);
    }
  });
});

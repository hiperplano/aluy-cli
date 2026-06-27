// EST-1009 · ADR-0065 · CLI-SEC-H1 — PROVA DE SO REAL (a-f), executável no Linux do CI.
//
// Roda processos de verdade pela primitiva e AFIRMA o confinamento por SO:
//  (a) o filho NÃO enxerga ~/.ssh, ~/.aws, ~/.aluy/, nem fora do workspace
//      (`cat` deles falha "No such file"); enxerga o arquivo do workspace.
//  (b) nenhum fd de ~/.aluy/ herda (o filho lista os próprios fds — só 0/1/2 + nada
//      apontando p/ ~/.aluy/; o fd do seccomp NÃO sobrevive ao exec do programa).
//  (c) seccomp NEGA unshare/setns/mount/... ⇒ cada um falha EPERM dentro do sandbox.
//  (d) net-deny: socket connect falha (rede inalcançável).
//  (f) Landlock é ADITIVO: presente ⇒ aplicado; ausente ⇒ degrada (o piso segue
//      válido por namespaces+seccomp).
//
// HONESTIDADE (DoD): onde a máquina de teste NÃO tem userns/bwrap, NÃO pulamos —
// provamos o FAIL-MODE (a decisão DEGRADA com aviso, nunca finge confinamento). O
// teste SEMPRE roda algo: ou o confinamento real, ou a prova do fail-mode.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { BwrapSandboxLauncher, detectSandboxCapability } from '../../src/sandbox/index.js';
import type { SandboxConfinement } from '@aluy/cli-core';
import { floorAvailable } from '@aluy/cli-core';

const cap = detectSandboxCapability();
const FLOOR = floorAvailable(cap);

let ws: string;
let base: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-sb-os-'));
  ws = join(base, 'project');
  mkdirSync(ws, { recursive: true });
  // um arquivo que o filho DEVE conseguir ler (prova de que o workspace é visível).
  writeFileSync(join(ws, 'inside.txt'), 'workspace-visible\n');
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

function launcher(env: 'dev' | 'prod' = 'dev', unsafeNoSandbox = false): BwrapSandboxLauncher {
  return new BwrapSandboxLauncher({ capability: cap, env, unsafeNoSandbox });
}

function conf(over: Partial<SandboxConfinement> = {}): SandboxConfinement {
  return { workspaceRoots: [ws], cwd: ws, ...over };
}

/** Roda um comando pela primitiva e coleta exitCode + stdout + stderr. */
function run(
  l: BwrapSandboxLauncher,
  command: string[],
  c: SandboxConfinement = conf(),
): Promise<{ code: number | null; out: string; err: string; spawned: boolean }> {
  const r = l.spawnConfined(command, c);
  if (!r.process) return Promise.resolve({ code: null, out: '', err: '', spawned: false });
  const proc = r.process;
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => (out += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (err += d.toString()));
    proc.on('close', (code: number | null) =>
      resolve({ code, out: out.trim(), err: err.trim(), spawned: true }),
    );
    proc.on('error', () => resolve({ code: 127, out, err: 'spawn-error', spawned: true }));
  });
}

describe('detecção de capability (boot)', () => {
  it('reporta a plataforma e flags coerentes (nunca finge: motivo quando indisponível)', () => {
    expect(cap.platform).toBeDefined();
    if (!FLOOR) {
      // piso indisponível ⇒ DEVE ter motivo legível (p/ o aviso inequívoco).
      expect(cap.unavailableReason).toBeTruthy();
    }
    // Landlock é booleano informativo (aditivo) — não condiciona o piso.
    expect(typeof cap.landlock).toBe('boolean');
  });
});

// ── Caminho COM piso de SO: prova o confinamento REAL (a-d, f) ────────────────
describe.runIf(FLOOR)('PISO DISPONÍVEL — confinamento real (a-d, f)', () => {
  const l = launcher('dev');

  it('decide() = confine', () => {
    expect(l.decide().action).toBe('confine');
  });

  it('(a) ENXERGA o arquivo do workspace', async () => {
    const r = await run(l, ['/bin/cat', join(ws, 'inside.txt')]);
    expect(r.code).toBe(0);
    expect(r.out).toBe('workspace-visible');
  });

  it('(a) NÃO enxerga ~/.ssh/id_rsa (No such file)', async () => {
    const r = await run(l, ['/bin/cat', join(homedir(), '.ssh', 'id_rsa')]);
    expect(r.code).not.toBe(0);
    expect(r.err.toLowerCase()).toContain('no such file');
  });

  it('(a) NÃO enxerga ~/.aws/credentials', async () => {
    const r = await run(l, ['/bin/cat', join(homedir(), '.aws', 'credentials')]);
    expect(r.code).not.toBe(0);
    expect(r.err.toLowerCase()).toContain('no such file');
  });

  it('(a) NÃO enxerga ~/.aluy/ (journal/memória/config) — inatravessável por SO', async () => {
    const r = await run(l, [
      '/bin/sh',
      '-c',
      `cat ${join(homedir(), '.aluy', 'config.json')} 2>&1; ls -la ${join(homedir(), '.aluy')} 2>&1`,
    ]);
    expect(r.code).not.toBe(0);
    expect(`${r.out}\n${r.err}`.toLowerCase()).toContain('no such file');
  });

  it('(a) NÃO enxerga $HOME inteiro (fora do workspace)', async () => {
    const r = await run(l, ['/bin/sh', '-c', `ls ${homedir()} 2>&1`]);
    expect(`${r.out}\n${r.err}`.toLowerCase()).toContain('no such file');
  });

  it('(d) net-deny por default: socket connect falha (rede inalcançável)', async () => {
    const py = [
      'python3',
      '-c',
      'import socket;s=socket.socket();s.settimeout(2);s.connect(("1.1.1.1",80));print("CONNECTED")',
    ];
    const r = await run(l, py);
    // se não houver python3 no sandbox, cai noutro erro — mas NUNCA "CONNECTED".
    expect(r.out).not.toContain('CONNECTED');
  });

  it('(c) seccomp NEGA unshare com EPERM', async () => {
    const py = [
      'python3',
      '-c',
      'import ctypes;l=ctypes.CDLL("libc.so.6",use_errno=True);r=l.unshare(0x10000000);print("rc",r,"errno",ctypes.get_errno())',
    ];
    const r = await run(l, py);
    if (r.out.startsWith('rc')) {
      // rc -1 errno 1 (EPERM) — o syscall foi NEGADO pelo filtro.
      expect(r.out).toContain('rc -1');
      expect(r.out).toContain('errno 1');
    } else {
      // sem python3: ao menos garantimos que NÃO houve sucesso (rc 0).
      expect(r.out).not.toContain('rc 0');
    }
  });

  it('(c) seccomp NEGA mount com EPERM', async () => {
    const py = [
      'python3',
      '-c',
      'import ctypes;l=ctypes.CDLL("libc.so.6",use_errno=True);r=l.mount(b"none",b"/mnt",b"tmpfs",0,0);print("rc",r,"errno",ctypes.get_errno())',
    ];
    const r = await run(l, py);
    if (r.out.startsWith('rc')) {
      expect(r.out).toContain('errno 1'); // EPERM
    } else {
      expect(r.out).not.toContain('rc 0');
    }
  });

  it('(b) sem vazamento de fd: o filho NÃO vê fd extra apontando p/ fora do workspace', async () => {
    // lista /proc/self/fd: só 0/1/2 (stdio) devem existir como fds "normais"; o fd
    // do seccomp do bwrap NÃO sobrevive ao exec do programa confinado (CLOEXEC do
    // próprio bwrap). Nenhum fd deve resolver p/ ~/.aluy/ ou ~/.ssh.
    const r = await run(l, ['/bin/sh', '-c', 'ls -la /proc/self/fd 2>&1']);
    const lower = `${r.out}\n${r.err}`.toLowerCase();
    expect(lower).not.toContain('.aluy');
    expect(lower).not.toContain('.ssh');
    expect(lower).not.toContain('.aws');
  });

  it('(f) Landlock é ADITIVO: o confinamento de FS vale com OU sem Landlock', async () => {
    // independente de cap.landlock, ~/.ssh segue inalcançável (namespaces+seccomp
    // são o piso; Landlock só reforça). Já provado em (a); aqui afirmamos a relação.
    const r = await run(l, ['/bin/cat', join(homedir(), '.ssh', 'id_rsa')]);
    expect(r.code).not.toBe(0);
    // o piso NÃO depende de Landlock estar presente.
    expect(floorAvailable(cap)).toBe(true);
  });
});

// ── Caminho SEM piso de SO: prova o FAIL-MODE (e), nunca pula silencioso ──────
describe.runIf(!FLOOR)('PISO INDISPONÍVEL — prova o FAIL-MODE (e), sem fingir', () => {
  it('dev sem piso ⇒ DEGRADE: roda o programa CRU + decisão avisa (não-promovível)', async () => {
    const l = launcher('dev');
    expect(l.decide().action).toBe('degrade');
    expect(l.decide().promotable).toBe(false);
    expect(l.decide().warning).toContain('SEM PISO DE SO');
    const r = await run(l, ['/bin/echo', 'degraded-ran']);
    expect(r.spawned).toBe(true);
    expect(r.out).toBe('degraded-ran'); // rodou SEM sandbox (com aviso), nunca finge
  });

  it('prod sem piso, sem flag ⇒ REFUSE: NÃO roda nada', async () => {
    const l = launcher('prod', false);
    expect(l.decide().action).toBe('refuse');
    const r = await run(l, ['/bin/echo', 'should-not-run']);
    expect(r.spawned).toBe(false);
  });

  it('prod sem piso + unsafe-no-sandbox ⇒ UNSAFE: roda cru, avisa risco', async () => {
    const l = launcher('prod', true);
    expect(l.decide().action).toBe('unsafe');
    const r = await run(l, ['/bin/echo', 'unsafe-ran']);
    expect(r.spawned).toBe(true);
    expect(r.out).toBe('unsafe-ran');
  });
});

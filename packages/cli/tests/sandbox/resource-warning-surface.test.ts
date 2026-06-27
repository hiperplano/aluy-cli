// AG-0008 · FU do gate cgroups — prova DEDICADA de que o NodeShellPort SURFA o
// resourceWarning do sandbox ao stderr/onChunk quando o confinamento de RECURSO
// não está disponível (cgroupLimits:false) e o `spawnConfined` devolve o warning
// aditivo.
//
// Contexto: §13.2 adicionou confinamento de recurso (cgroups) no sandbox. Quando
// systemd-run não está disponível, o launcher devolve um `warning` no
// SandboxSpawnResult ("SEM CONFINAMENTO DE RECURSO… fork-bomb…"), e o
// NodeShellPort deve SURFAR esse aviso ao usuário (stderr/onChunk), once-per-session.
//
// Provas:
//  (a) warning aparece no stderr CAPTURADO do ShellResult após exec().
//  (b) warning aparece no onChunk capturado (stream 'stderr') na 1ª exec.
//  (c) ONCE-PER-SESSION: a 2ª exec NÃO repete o warning (nem no stderr, nem no onChunk).

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  SandboxDecision,
  SandboxSpawnResult,
  ShellChunk,
  ShellExecOptions,
} from '@hiperplano/aluy-cli-core';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { BwrapSandboxLauncher } from '../../src/sandbox/index.js';

/** AVISO EXATO que o launcher devolve no fail-mode cgroup — copiado do padrão do
 * `cgroup-limits.test.ts` (teste (c)). */
const RESOURCE_WARNING =
  '⚠ SEM CONFINAMENTO DE RECURSO (fork-bomb/RAM/CPU) — systemd-run --user indisponível. O bwrap confina FUGA mas NÃO RECURSO: um fork-bomb derruba a máquina.';

/**
 * FAKE de lançador (como em net-under-ask.test.ts) que SEMPRE decide `confine`
 * (p/ forçar o caminho de sandbox) e devolve o `warning` de recurso no
 * `SandboxSpawnResult`.
 *
 * O `onChunk` capturado receberá o aviso — provamos surfagem correta.
 */
class ResourceWarningLauncher extends BwrapSandboxLauncher {
  constructor() {
    super({
      capability: {
        platform: 'linux',
        userns: true,
        bwrap: true,
        landlock: false,
        seccomp: true,
        cgroupLimits: false,
        unavailableReason: 'systemd-run --user indisponível (sem bus de usuário?)',
      },
      env: 'dev',
    });
  }

  override decide(): SandboxDecision {
    return { action: 'confine', confined: true, allowed: true, promotable: true };
  }

  override spawnConfined(_command: readonly string[]): SandboxSpawnResult<ChildProcess> {
    // Extrai o comando literal que o shell-port passou (depois do `/bin/sh -c`).
    // Ex.: ['/bin/sh', '-c', 'echo primeiro'] ⇒ executa o comando de verdade.
    const cmdStr =
      _command.length >= 3 && _command[0] === '/bin/sh' && _command[1] === '-c'
        ? _command.slice(2).join(' ')
        : _command.join(' ');
    const child = spawn('/bin/sh', ['-c', cmdStr], { stdio: ['ignore', 'pipe', 'pipe'] });
    return {
      decision: this.decide(),
      process: child,
      // §13.2 — warning aditivo de "sem teto de RECURSO" (ortogonal ao decision.warning).
      warning: RESOURCE_WARNING,
    };
  }
}

describe('EST-1021 · AG-0008 — resourceWarning surfado pelo NodeShellPort (FU gate cgroups)', () => {
  let ws: string;

  function setup(): { ws: string; launcher: ResourceWarningLauncher } {
    ws = mkdtempSync(join(tmpdir(), 'aluy-rw-surf-'));
    return { ws, launcher: new ResourceWarningLauncher() };
  }

  function shellWith(
    ws: string,
    launcher: ResourceWarningLauncher,
    onChunk?: (chunk: ShellChunk) => void,
  ): { shell: NodeShellPort; execOpts: ShellExecOptions } {
    return {
      shell: new NodeShellPort({
        workspace: new NodeWorkspace({ root: ws }),
        sandboxLauncher: launcher,
        killGraceMs: 20,
        // Sem egressAllows (default-deny) — irrelevante p/ este teste.
      }),
      execOpts: onChunk ? { onChunk } : {},
    };
  }

  function teardown(ws: string): void {
    try {
      rmSync(ws, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // ── (a) stderr capturado ──────────────────────────────────────────────────
  it('(a) resourceWarning aparece no stderr do ShellResult após a 1ª exec', async () => {
    const { ws, launcher } = setup();
    try {
      const { shell } = shellWith(ws, launcher);
      const result = await shell.exec('echo primeiro');
      // O comando rodou — stdout tem a saída esperada.
      expect(result.stdout).toContain('primeiro');
      // O stderr contém o aviso de recurso (surfado antes do output do comando).
      expect(result.stderr).toContain(RESOURCE_WARNING);
      expect(result.exitCode).toBe(0);
    } finally {
      teardown(ws);
    }
  });

  // ── (b) onChunk capturado ─────────────────────────────────────────────────
  it('(b) resourceWarning aparece no onChunk (stream stderr) na 1ª exec', async () => {
    const { ws, launcher } = setup();
    try {
      const chunks: ShellChunk[] = [];
      const { shell, execOpts } = shellWith(ws, launcher, (chunk) => chunks.push(chunk));
      const result = await shell.exec('echo primeiro', execOpts);

      // O comando rodou com sucesso.
      expect(result.stdout).toContain('primeiro');
      // O stderr do resultado contém o warning (já provado em (a)).
      expect(result.stderr).toContain(RESOURCE_WARNING);
      // Ao menos um chunk de stderr com o aviso.
      const warningChunks = chunks.filter((c) => c.stream === 'stderr');
      expect(warningChunks.length).toBeGreaterThanOrEqual(1);
      const warningText = warningChunks.map((c) => c.text).join('');
      expect(warningText).toContain(RESOURCE_WARNING);
      expect(result.exitCode).toBe(0);
    } finally {
      teardown(ws);
    }
  });

  // ── (c) once-per-session ──────────────────────────────────────────────────
  it('(c) ONCE-PER-SESSION: 2ª exec NÃO repete o warning (stderr + onChunk)', async () => {
    const { ws, launcher } = setup();
    try {
      const chunks: ShellChunk[] = [];
      const { shell, execOpts } = shellWith(ws, launcher, (chunk) => chunks.push(chunk));

      // 1ª exec — warning aparece.
      const r1 = await shell.exec('echo primeiro', execOpts);
      expect(r1.stdout).toContain('primeiro');
      expect(r1.stderr).toContain(RESOURCE_WARNING);
      const warningChunks1 = chunks.filter((c) => c.stream === 'stderr');
      // O warning aparece nos chunks de stderr (pelo menos 1).
      expect(warningChunks1.length).toBeGreaterThanOrEqual(1);
      const warningText1 = warningChunks1.map((c) => c.text).join('');
      expect(warningText1).toContain(RESOURCE_WARNING);

      // 2ª exec — warning NÃO repete.
      const chunksBefore2 = chunks.length;
      const r2 = await shell.exec('echo segundo', execOpts);
      expect(r2.stdout).toContain('segundo');
      // stderr do ShellResult não contém o warning (só saída real do comando, se houver).
      expect(r2.stderr).not.toContain('SEM CONFINAMENTO DE RECURSO');
      // Nenhum chunk NOVO de stderr com o warning.
      const newChunks = chunks.slice(chunksBefore2);
      const warningText2 = newChunks
        .filter((c) => c.stream === 'stderr')
        .map((c) => c.text)
        .join('');
      expect(warningText2).not.toContain('SEM CONFINAMENTO DE RECURSO');
      expect(r2.exitCode).toBe(0);
    } finally {
      teardown(ws);
    }
  });

  // ── (d) 3ª exec também não repete (confirma once-per-session mesmo) ────────
  it('(d) 3ª exec também NÃO repete — confirma que o flag de sessão persiste', async () => {
    const { ws, launcher } = setup();
    try {
      const chunks: ShellChunk[] = [];
      const { shell, execOpts } = shellWith(ws, launcher, (chunk) => chunks.push(chunk));

      // 1ª exec — warning
      await shell.exec('echo a', execOpts);
      const warningCount1 = chunks.filter((c) => c.stream === 'stderr').length;
      expect(warningCount1).toBeGreaterThanOrEqual(1);
      const warningText1Total = chunks
        .filter((c) => c.stream === 'stderr')
        .map((c) => c.text)
        .join('');
      expect(warningText1Total).toContain(RESOURCE_WARNING);

      // 2ª exec — sem warning
      const before2 = chunks.length;
      await shell.exec('echo b', execOpts);
      const newChunks2 = chunks.slice(before2);
      const warningText2 = newChunks2
        .filter((c) => c.stream === 'stderr')
        .map((c) => c.text)
        .join('');
      expect(warningText2).not.toContain('SEM CONFINAMENTO DE RECURSO');

      // 3ª exec — idem
      const before3 = chunks.length;
      await shell.exec('echo c', execOpts);
      const newChunks3 = chunks.slice(before3);
      const warningText3 = newChunks3
        .filter((c) => c.stream === 'stderr')
        .map((c) => c.text)
        .join('');
      expect(warningText3).not.toContain('SEM CONFINAMENTO DE RECURSO');
    } finally {
      teardown(ws);
    }
  });
});

// EST-0991 · ADR-0072 — INTEGRAÇÃO do YOLO no wiring da sessão.
//
// Prova que, sob `mode:'unsafe'` (o `--yolo`), o `buildSession` fia a sessão com a
// cerca DERRUBADA (workspace unconfined ⇒ raiz do FS) E o anti-SSRF SUSPENSO (web
// port com `allowInternalHosts`), além da catraca em YOLO. E a NÃO-REGRESSÃO: em
// `normal`, a cerca confina ao projeto e o anti-SSRF fica DURO (sem allowInternalHosts).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import { buildSession } from '../../src/session/wiring.js';

describe('EST-0991 · ADR-0072 — YOLO fiado no buildSession', () => {
  let base: string;
  let workspaceRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-yolo-wiring-'));
    workspaceRoot = join(base, 'project');
    mkdirSync(workspaceRoot, { recursive: true });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('mode:unsafe ⇒ workspace UNCONFINED (raiz = raiz do FS) + engine em YOLO', () => {
    const s = buildSession({ workspaceRoot, mode: 'unsafe', env: {} });
    // a raiz do confinamento virou a raiz do filesystem (disco inteiro).
    expect(s.workspace.root).toBe(realpathSync(parsePath(realpathSync(workspaceRoot)).root));
    // mas o cwd de sessão arranca no projeto (não em `/`).
    expect(s.workspace.cwd).toBe(realpathSync(workspaceRoot));
    // a catraca está em YOLO (allow total).
    expect(s.engine.isUnsafe).toBe(true);
    expect(s.engine.decide({ name: 'run_command', input: { command: 'rm -rf x' } }).decision).toBe(
      'allow',
    );
  });

  it('mode:unsafe ⇒ web port com allowInternalHosts (anti-SSRF suspenso)', () => {
    const s = buildSession({ workspaceRoot, mode: 'unsafe', env: {} });
    expect(s.ports.web?.policy?.allowInternalHosts).toBe(true);
  });

  it('NÃO-REGRESSÃO — mode:normal ⇒ workspace CONFINA ao projeto + anti-SSRF DURO', () => {
    const s = buildSession({ workspaceRoot, mode: 'normal', env: {} });
    // a cerca de 1 raiz (EST-0948) está intacta: raiz = o projeto.
    expect(s.workspace.root).toBe(realpathSync(workspaceRoot));
    // o anti-SSRF fica DURO: sem allowInternalHosts.
    expect(s.ports.web?.policy?.allowInternalHosts).toBeUndefined();
    // a catraca pergunta (não YOLO).
    expect(s.engine.isUnsafe).toBe(false);
    expect(s.engine.decide({ name: 'run_command', input: { command: 'rm -rf x' } }).decision).toBe(
      'ask',
    );
  });

  it('NÃO-REGRESSÃO — sem `mode` (default) ⇒ normal (confinado, anti-SSRF duro)', () => {
    const s = buildSession({ workspaceRoot, env: {} });
    expect(s.workspace.root).toBe(realpathSync(workspaceRoot));
    expect(s.ports.web?.policy?.allowInternalHosts).toBeUndefined();
    expect(s.engine.isUnsafe).toBe(false);
  });
});

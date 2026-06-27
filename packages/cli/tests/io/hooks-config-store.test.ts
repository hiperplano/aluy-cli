// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — LEITOR CONFINADO de `~/.aluy/hooks.json`. DoD:
//   - AUSENTE ⇒ config vazia (sem hooks); JSON inválido/grande ⇒ vazia (fail-safe);
//   - SÓ-LEITURA (este store não escreve — a catraca nega que o agente escreva ~/.aluy/);
//   - parser fail-closed: entradas inválidas descartadas (testado no core; aqui ponta-a-ponta).
// Tudo sobre tmpdir (baseDir injetado) — NUNCA toca o `~/.aluy/` real do dev.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HooksConfigStore, HOOKS_CONFIG_FILENAME } from '../../src/io/hooks-config-store.js';

describe('HooksConfigStore — config de hooks de ciclo-de-vida (EST-0974)', () => {
  let base: string;
  let aluyDir: string;
  let hooksPath: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-hooks-'));
    aluyDir = join(base, 'home', '.aluy');
    hooksPath = join(aluyDir, HOOKS_CONFIG_FILENAME);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('AUSENTE ⇒ config vazia (sem hooks)', () => {
    expect(new HooksConfigStore({ baseDir: aluyDir }).load().hooks).toEqual([]);
  });

  it('configPath aponta p/ <base>/hooks.json', () => {
    expect(new HooksConfigStore({ baseDir: aluyDir }).configPath).toBe(hooksPath);
  });

  it('JSON válido ⇒ hooks parseados (forma { hooks: [...] })', () => {
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: [
          { event: 'session-start', command: 'echo boot' },
          { event: 'turn-end', command: 'notify-send done' },
        ],
      }),
    );
    const cfg = new HooksConfigStore({ baseDir: aluyDir }).load();
    expect(cfg.hooks).toHaveLength(2);
    expect(cfg.hooks[0]).toEqual({ event: 'session-start', command: 'echo boot' });
  });

  it('JSON inválido ⇒ config vazia (fail-safe, não derruba o boot)', () => {
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(hooksPath, '{ isto não é json válido ');
    expect(new HooksConfigStore({ baseDir: aluyDir }).load().hooks).toEqual([]);
  });

  it('entradas inválidas DENTRO de JSON válido ⇒ descartadas (fail-closed)', () => {
    mkdirSync(aluyDir, { recursive: true });
    writeFileSync(
      hooksPath,
      JSON.stringify({
        hooks: [
          { event: 'on-evil', command: 'rm -rf /' }, // evento fora da allow-list
          { event: 'session-start' }, // sem command
          { event: 'session-start', command: 'ok' }, // válido
        ],
      }),
    );
    const cfg = new HooksConfigStore({ baseDir: aluyDir }).load();
    expect(cfg.hooks).toEqual([{ event: 'session-start', command: 'ok' }]);
  });

  // EST-0980 — descoberta do `.claude/settings.json` do projeto (compat Claude Code).
  describe('EST-0980 · settings.json do Claude no projeto (compat)', () => {
    function writeClaudeSettings(workspace: string, content: unknown): void {
      const dir = join(workspace, '.claude');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), JSON.stringify(content));
    }

    it('FUNDE o `.claude/settings.json` (formato Claude) com o `hooks.json` nativo', () => {
      const workspace = join(base, 'proj');
      mkdirSync(aluyDir, { recursive: true });
      writeFileSync(
        hooksPath,
        JSON.stringify({ hooks: [{ event: 'session-start', command: 'nativo' }] }),
      );
      writeClaudeSettings(workspace, {
        hooks: {
          PreToolUse: [{ matcher: 'edit_file', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        },
      });
      const cfg = new HooksConfigStore({ baseDir: aluyDir, workspaceRoot: workspace }).load();
      // nativo PRIMEIRO, depois o de settings (ambos valem).
      expect(cfg.hooks.map((h) => h.command)).toEqual(['nativo', 'guard.sh']);
      const pre = cfg.hooks.find((h) => h.event === 'pre-tool')!;
      expect(pre.matcher).toBe('edit_file');
      expect(pre.gate).toBe(true); // PreToolUse do Claude bloqueia ⇒ gate.
    });

    it('settings.json AUSENTE ⇒ só o nativo (sem erro)', () => {
      const workspace = join(base, 'vazio');
      mkdirSync(aluyDir, { recursive: true });
      writeFileSync(hooksPath, JSON.stringify({ hooks: [{ event: 'turn-end', command: 'x' }] }));
      const cfg = new HooksConfigStore({ baseDir: aluyDir, workspaceRoot: workspace }).load();
      expect(cfg.hooks).toEqual([{ event: 'turn-end', command: 'x' }]);
    });

    it('settings.json com JSON inválido ⇒ contribui VAZIO (fail-safe, não derruba o boot)', () => {
      const workspace = join(base, 'corrompido');
      const dir = join(workspace, '.claude');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'settings.json'), '{ não é json ');
      const cfg = new HooksConfigStore({ baseDir: aluyDir, workspaceRoot: workspace }).load();
      expect(cfg.hooks).toEqual([]); // nativo ausente + settings inválido ⇒ vazio.
    });

    it('sem workspaceRoot ⇒ NÃO descobre settings de projeto (back-compat EST-0974)', () => {
      const workspace = join(base, 'ignorado');
      writeClaudeSettings(workspace, {
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'naoDeveAparecer' }] }] },
      });
      const cfg = new HooksConfigStore({ baseDir: aluyDir }).load(); // sem workspaceRoot
      expect(cfg.hooks).toEqual([]);
    });
  });
});

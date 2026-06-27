// EST-0979 · ADR-0053 §2.2 — comandos do PROJETO (`.claude/commands/*.md`, padrão
// Claude Code, no workspace) + merge projeto>global. Mesmo mecanismo (.md → /comando)
// da EST-0974; config de projeto = DADO confinado ao workspace, não relaxa a catraca.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { UserCommand } from '@aluy/cli-core';
import { NodeWorkspace } from '../../src/io/workspace.js';
import {
  ProjectCommandsLoader,
  PROJECT_COMMANDS_DIRNAMES,
  mergeUserCommands,
} from '../../src/io/project-commands.js';

function makeLoader(root: string): ProjectCommandsLoader {
  return new ProjectCommandsLoader({ workspace: new NodeWorkspace({ root }) });
}

describe('EST-0979 · ProjectCommandsLoader — .claude/commands/*.md + .aluy/commands/*.md confinado', () => {
  let base: string;
  let root: string;
  let claudeCmdDir: string;
  let aluyCmdDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-projcmd-'));
    root = join(base, 'project');
    claudeCmdDir = join(root, PROJECT_COMMANDS_DIRNAMES[0]);
    aluyCmdDir = join(root, PROJECT_COMMANDS_DIRNAMES[1]);
    mkdirSync(claudeCmdDir, { recursive: true });
    mkdirSync(aluyCmdDir, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function writeClaude(name: string, body: string): void {
    writeFileSync(join(claudeCmdDir, name), body);
  }
  function writeAluy(name: string, body: string): void {
    writeFileSync(join(aluyCmdDir, name), body);
  }

  it('.claude/commands/foo.md ⇒ comando /foo descoberto (igual a ~/.aluy/commands)', () => {
    writeClaude('foo.md', 'revise o diff e aponte riscos.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['foo']);
    expect(cmds[0]!.template).toContain('revise o diff');
  });

  it('pasta ausente ⇒ [] (fail-safe, sem crash)', () => {
    rmSync(claudeCmdDir, { recursive: true, force: true });
    rmSync(aluyCmdDir, { recursive: true, force: true });
    expect(makeLoader(root).load()).toEqual([]);
  });

  it('vários .md ⇒ ordenados por nome, determinístico', () => {
    writeClaude('zeta.md', 'z');
    writeClaude('alpha.md', 'a');
    const names = makeLoader(root)
      .load()
      .map((c) => c.name);
    expect(names).toEqual(['alpha', 'zeta']);
  });

  it('CONFINAMENTO — um comando symlink p/ FORA da raiz NÃO é lido', () => {
    const outside = join(base, 'evil.md');
    writeFileSync(outside, 'COMANDO DE FORA');
    symlinkSync(outside, join(claudeCmdDir, 'evil.md'));
    writeClaude('ok.md', 'comando legítimo.');
    const cmds = makeLoader(root).load();
    // só o legítimo (o symlink p/ fora não é `isFile()` em dirent ⇒ ignorado).
    expect(cmds.map((c) => c.name)).toEqual(['ok']);
  });

  it('só lê *.md DIRETOS (sem recursão em subpasta)', () => {
    mkdirSync(join(claudeCmdDir, 'sub'), { recursive: true });
    writeFileSync(join(claudeCmdDir, 'sub', 'nested.md'), 'nested');
    writeClaude('top.md', 'top');
    expect(
      makeLoader(root)
        .load()
        .map((c) => c.name),
    ).toEqual(['top']);
  });

  // ── EST-1013: endurecimento de cobertura ────────────────────────────────

  it('load() ignora .md malformado (parseUserCommand retorna null)', () => {
    writeClaude('vazio.md', '');
    writeClaude('bom.md', 'revise o código.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['bom']);
  });

  it('load() ignora .md maior que MAX_COMMAND_BYTES (64KB)', () => {
    const big = 'x'.repeat(65 * 1024);
    writeFileSync(join(claudeCmdDir, 'grande.md'), big);
    writeClaude('pequeno.md', 'comando pequeno.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['pequeno']);
  });

  it('load() com .claude/commands/ resolvendo p/ FORA ⇒ [] (catch de resolveInside)', () => {
    // Cria um symlink .claude → /tmp/fora (fora da raiz) para que
    // resolveInside('.claude/commands') detecte escape e lance.
    rmSync(claudeCmdDir, { recursive: true, force: true });
    const fora = join(base, 'fora');
    mkdirSync(fora, { recursive: true });
    // Remove .claude (era dir real) e troca por symlink p/ fora.
    const claudeDir = join(root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    rmSync(claudeDir, { recursive: true, force: true });
    symlinkSync(fora, claudeDir);
    mkdirSync(join(fora, 'commands'), { recursive: true });
    writeFileSync(join(fora, 'commands', 'evil.md'), 'fora');
    expect(makeLoader(root).load()).toEqual([]);
  });

  it('load() ignora .md cujo caminho é rejeitado por path-deny', () => {
    // `id_rsa.md` contém "id_rsa" ⇒ classifyAttachPath retorna deny.
    writeClaude('id_rsa.md', 'comando malicioso');
    writeClaude('ok.md', 'comando legítimo.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['ok']);
  });

  it('load() com .md .env (ask) também é ignorado (kind !== allow)', () => {
    // `.claude/commands/.env` → pattern .env casa ⇒ ask, readOne retorna null.
    writeClaude('.env', 'segredo');
    writeClaude('ok.md', 'comando legítimo.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['ok']);
  });

  // ── ADR-0113: .aluy/commands/ carve-out ─────────────────────────────────

  it('.aluy/commands/foo.md ⇒ comando /foo descoberto (ADR-0113 carve-out)', () => {
    rmSync(claudeCmdDir, { recursive: true, force: true });
    writeAluy('deploy.md', 'rode o deploy de produção.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['deploy']);
    expect(cmds[0]!.template).toContain('rode o deploy');
  });

  it('.claude/commands/ tem precedência sobre .aluy/commands/ em colisão', () => {
    writeClaude('shared.md', 'comando do CLAUDE vence.');
    writeAluy('shared.md', 'comando do ALUY perde.');
    const cmds = makeLoader(root).load();
    const shared = cmds.find((c) => c.name === 'shared')!;
    expect(shared.template).toContain('CLAUDE vence');
  });

  it('carrega comandos de AMBAS as pastas (união)', () => {
    writeClaude('a.md', 'a');
    writeAluy('b.md', 'b');
    const names = makeLoader(root)
      .load()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(['a', 'b']);
  });

  it('.aluy/commands/ com symlink p/ FORA ⇒ ignorado (confinamento)', () => {
    rmSync(claudeCmdDir, { recursive: true, force: true });
    const outside = join(base, 'evil.md');
    writeFileSync(outside, 'FORA');
    symlinkSync(outside, join(aluyCmdDir, 'evil.md'));
    writeAluy('ok.md', 'comando legítimo.');
    const cmds = makeLoader(root).load();
    expect(cmds.map((c) => c.name)).toEqual(['ok']);
  });
});

describe('EST-0979 · mergeUserCommands — PROJETO especializa o GLOBAL', () => {
  const mk = (name: string, template: string): UserCommand => ({
    name,
    summary: name,
    template,
  });

  it('colisão de nome ⇒ definição do PROJETO vence', () => {
    const global = [mk('deploy', 'GLOBAL-deploy'), mk('test', 'GLOBAL-test')];
    const project = [mk('deploy', 'PROJECT-deploy')];
    const merged = mergeUserCommands(global, project);
    const deploy = merged.find((c) => c.name === 'deploy')!;
    expect(deploy.template).toBe('PROJECT-deploy'); // projeto > global.
  });

  it('comandos só-global e só-projeto sobrevivem (união)', () => {
    const global = [mk('a', 'a')];
    const project = [mk('b', 'b')];
    expect(
      mergeUserCommands(global, project)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['a', 'b']);
  });

  // ── EST-1013: endurecimento de cobertura ────────────────────────────────

  it('ambas listas vazias ⇒ []', () => {
    expect(mergeUserCommands([], [])).toEqual([]);
  });

  it('global vazia, project não vazia ⇒ só project', () => {
    const project = [mk('x', 'x')];
    expect(mergeUserCommands([], project).map((c) => c.name)).toEqual(['x']);
  });

  it('project vazia, global não vazia ⇒ só global', () => {
    const global = [mk('y', 'y')];
    expect(mergeUserCommands(global, []).map((c) => c.name)).toEqual(['y']);
  });
});

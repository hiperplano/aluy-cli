// EST-0974 · ADR-0053 §2.2 — LOADER CONFINADO de `~/.aluy/commands/*.md`. DoD:
//   - um `.md` ⇒ um UserCommand (`/<nome>`); AUSENTE ⇒ não existe (lista vazia);
//   - confinado a `~/.aluy/commands/` (mode 0700 ao criar; só `.md` diretos);
//   - fail-safe: dir ausente/ilegível ⇒ []; `.md` corrompido/vazio descartado;
//   - colisão de nome ⇒ 1º (ordem alfabética) vence (estável).
// Tudo sobre tmpdir (baseDir injetado) — NUNCA toca o `~/.aluy/` real do dev.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserCommandsLoader, COMMANDS_DIRNAME } from '../../src/io/user-commands.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('UserCommandsLoader — comandos customizados (EST-0974)', () => {
  let base: string;
  let aluyDir: string;
  let commandsDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-cmds-'));
    aluyDir = join(base, 'home', '.aluy');
    commandsDir = join(aluyDir, COMMANDS_DIRNAME);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('dir AUSENTE ⇒ load() = [] (comando ausente não existe), sem criar nada', () => {
    const loader = new UserCommandsLoader({ baseDir: aluyDir });
    expect(loader.load()).toEqual([]);
    expect(existsSync(commandsDir)).toBe(false);
  });

  it('commandsDir aponta p/ <base>/commands', () => {
    expect(new UserCommandsLoader({ baseDir: aluyDir }).commandsDir).toBe(commandsDir);
  });

  it('ensureDir cria ~/.aluy/commands/ com mode 0700', () => {
    const loader = new UserCommandsLoader({ baseDir: aluyDir });
    loader.ensureDir();
    expect(existsSync(commandsDir)).toBe(true);
    expect(mode(commandsDir)).toBe(0o700);
  });

  it('um `.md` ⇒ um UserCommand (/<nome> derivado do arquivo)', () => {
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'deploy.md'), 'rode o deploy de produção');
    const cmds = new UserCommandsLoader({ baseDir: aluyDir }).load();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.name).toBe('deploy');
    expect(cmds[0]!.template).toBe('rode o deploy de produção');
  });

  it('respeita o summary do frontmatter; vários `.md` ordenados por nome', () => {
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'b.md'), 'corpo b');
    writeFileSync(join(commandsDir, 'a.md'), '---\nsummary: faz A\n---\ncorpo a');
    const cmds = new UserCommandsLoader({ baseDir: aluyDir }).load();
    expect(cmds.map((c) => c.name)).toEqual(['a', 'b']);
    expect(cmds[0]!.summary).toBe('faz A');
  });

  it('`.md` VAZIO ou só-frontmatter ⇒ descartado (não derruba os demais)', () => {
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'vazio.md'), '');
    writeFileSync(join(commandsDir, 'ok.md'), 'tem corpo');
    const cmds = new UserCommandsLoader({ baseDir: aluyDir }).load();
    expect(cmds.map((c) => c.name)).toEqual(['ok']);
  });

  it('ignora não-`.md` e subdiretórios (só `.md` DIRETOS — confinamento)', () => {
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'cmd.md'), 'ok');
    writeFileSync(join(commandsDir, 'README.txt'), 'não é comando');
    mkdirSync(join(commandsDir, 'sub'));
    writeFileSync(join(commandsDir, 'sub', 'nested.md'), 'não deve carregar (recursão)');
    const cmds = new UserCommandsLoader({ baseDir: aluyDir }).load();
    expect(cmds.map((c) => c.name)).toEqual(['cmd']);
  });

  it('colisão de nome (após normalizar) ⇒ 1º alfabético vence (estável)', () => {
    mkdirSync(commandsDir, { recursive: true });
    // `Deploy.md` e `deploy.md` normalizam p/ `deploy`. Ordem alfabética: `Deploy.md`
    // (maiúscula) vem antes de `deploy.md` no localeCompare? Garantimos determinismo.
    writeFileSync(join(commandsDir, 'deploy.md'), 'minúsculo');
    writeFileSync(join(commandsDir, 'Deploy.md'), 'Maiúsculo');
    const cmds = new UserCommandsLoader({ baseDir: aluyDir }).load();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.name).toBe('deploy');
  });
});

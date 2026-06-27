// EST-0957 · CA-2 — índice de arquivos do workspace: ignora dirs pesados, respeita
// teto, confina à raiz, não segue symlinks, RESPEITA o `.gitignore`.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { NodeFileIndexPort } from '../../src/io/file-index.js';

/** `true` se há git no PATH (o teste de `.gitignore` exige git real). */
function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('NodeFileIndexPort — varredura fs confinada (fallback não-git)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-index-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(root, '.git'), { recursive: true });
    mkdirSync(join(root, 'dist'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'a\n');
    writeFileSync(join(root, 'README.md'), 'r\n');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'noise\n');
    writeFileSync(join(root, '.git', 'config'), 'noise\n');
    writeFileSync(join(root, 'dist', 'app.js'), 'noise\n');
    writeFileSync(join(base, 'outside.txt'), 'fora\n');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('CA-2 — lista arquivos do projeto, EXCLUI node_modules/.git/dist', async () => {
    const index = new NodeFileIndexPort({ workspace: new NodeWorkspace({ root }), useGit: false });
    const files = await index.list();
    expect(files).toContain('src/app.ts');
    expect(files).toContain('README.md');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.git'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);
  });

  it('CA-2 — respeita o TETO de arquivos (sem varredura ilimitada)', async () => {
    for (let i = 0; i < 20; i++) writeFileSync(join(root, 'src', `f${i}.ts`), 'x\n');
    const index = new NodeFileIndexPort({
      workspace: new NodeWorkspace({ root }),
      maxFiles: 5,
      useGit: false,
    });
    const files = await index.list();
    expect(files.length).toBeLessThanOrEqual(5);
  });

  it('caminhos são relativos à raiz e usam `/`', async () => {
    const index = new NodeFileIndexPort({ workspace: new NodeWorkspace({ root }), useGit: false });
    const files = await index.list();
    expect(files.every((f) => !f.startsWith('/'))).toBe(true);
    expect(files).toContain('src/app.ts');
  });

  it('confinamento — NÃO inclui symlink que aponta p/ fora da raiz', async () => {
    symlinkSync(join(base, 'outside.txt'), join(root, 'escape.txt'));
    const index = new NodeFileIndexPort({ workspace: new NodeWorkspace({ root }), useGit: false });
    const files = await index.list();
    expect(files).not.toContain('escape.txt');
  });

  // ── EST-1013: endurecimento do fallback NÃO-GIT (walk) ──────────────

  it('(A) fallback NÃO-GIT (walk) — lista apenas arquivos reais, sem dirs', async () => {
    const baseA = mkdtempSync(join(tmpdir(), 'aluy-index-a-'));
    const rootA = join(baseA, 'project');
    mkdirSync(join(rootA, 'src'), { recursive: true });
    writeFileSync(join(rootA, 'src', 'a.ts'), 'a\n');
    writeFileSync(join(rootA, 'b.md'), 'b\n');

    const index = new NodeFileIndexPort({
      workspace: new NodeWorkspace({ root: rootA }),
      useGit: false,
    });
    const files = await index.list();

    expect(files).toEqual(['b.md', 'src/a.ts']);

    rmSync(baseA, { recursive: true, force: true });
  });

  it('(B) dirs ignorados — node_modules, .git, dist são excluídos no walk', async () => {
    const baseB = mkdtempSync(join(tmpdir(), 'aluy-index-b-'));
    const rootB = join(baseB, 'project');
    mkdirSync(join(rootB, 'node_modules', 'pkg'), { recursive: true });
    mkdirSync(join(rootB, '.git'), { recursive: true });
    mkdirSync(join(rootB, 'dist'), { recursive: true });
    writeFileSync(join(rootB, 'node_modules', 'pkg', 'index.js'), 'noise\n');
    writeFileSync(join(rootB, '.git', 'config'), 'noise\n');
    writeFileSync(join(rootB, 'dist', 'bundle.js'), 'noise\n');
    writeFileSync(join(rootB, 'index.ts'), 'ok\n');

    const index = new NodeFileIndexPort({
      workspace: new NodeWorkspace({ root: rootB }),
      useGit: false,
    });
    const files = await index.list();

    expect(files).toEqual(['index.ts']);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.includes('.git'))).toBe(false);
    expect(files.some((f) => f.startsWith('dist/'))).toBe(false);

    rmSync(baseB, { recursive: true, force: true });
  });

  it('(C) teto maxFiles — walk respeita o limite mesmo com mais arquivos', async () => {
    const baseC = mkdtempSync(join(tmpdir(), 'aluy-index-c-'));
    const rootC = join(baseC, 'project');
    mkdirSync(rootC, { recursive: true });
    writeFileSync(join(rootC, 'a.txt'), 'a\n');
    writeFileSync(join(rootC, 'b.txt'), 'b\n');

    const index = new NodeFileIndexPort({
      workspace: new NodeWorkspace({ root: rootC }),
      maxFiles: 1,
      useGit: false,
    });
    const files = await index.list();

    expect(files.length).toBeLessThanOrEqual(1);

    rmSync(baseC, { recursive: true, force: true });
  });
});

// CA-2 (revisor/seguranca) — quando a raiz é um repo git, o índice RESPEITA o
// `.gitignore`: arquivos ignorados (build custom, `*.log`, segredos locais) NÃO
// aparecem no índice/picker. Usa git REAL (skip se ausente).
const git = hasGit();
(git ? describe : describe.skip)('NodeFileIndexPort — respeita o .gitignore (repo git)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-index-git-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(root, 'src', 'app.ts'), 'a\n');
    writeFileSync(join(root, 'README.md'), 'r\n');
    // Arquivos que o .gitignore manda ignorar (NÃO devem entrar no índice):
    writeFileSync(join(root, '.gitignore'), 'out/\n*.log\nlocal-secret.txt\n');
    writeFileSync(join(root, 'out', 'bundle.js'), 'build\n');
    writeFileSync(join(root, 'debug.log'), 'logs\n');
    writeFileSync(join(root, 'local-secret.txt'), 'shhh\n');
    // Inicializa o repo (sem commit — `git ls-files --others` já vê os untracked).
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    execFileSync('git', ['init', '-q'], { cwd: root, env });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('arquivos ignorados pelo .gitignore NÃO aparecem no índice', async () => {
    const index = new NodeFileIndexPort({ workspace: new NodeWorkspace({ root }) });
    const files = await index.list();
    // Arquivos versionáveis aparecem…
    expect(files).toContain('src/app.ts');
    expect(files).toContain('README.md');
    // …e os ignorados NÃO (CA-2 — respeitando o .gitignore).
    expect(files).not.toContain('out/bundle.js');
    expect(files.some((f) => f.startsWith('out/'))).toBe(false);
    expect(files).not.toContain('debug.log');
    expect(files).not.toContain('local-secret.txt');
  });

  it('o próprio `.git/` nunca entra no índice (git ls-files não o lista)', async () => {
    const index = new NodeFileIndexPort({ workspace: new NodeWorkspace({ root }) });
    const files = await index.list();
    expect(files.some((f) => f.startsWith('.git/') || f === '.git')).toBe(false);
  });
});

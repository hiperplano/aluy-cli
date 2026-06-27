// EST-0944 — NodeSearchPort.glob: acha ARQUIVOS por padrão, CONFINADO ao workspace,
// respeitando o .gitignore, com tetos honestos. Espelha a disciplina do grep + file-index.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeSearchPort } from '../../src/io/search-port.js';
import { NodeWorkspace, WorkspaceEscapeError } from '../../src/io/workspace.js';

function mkPort(root: string, over: Record<string, unknown> = {}): NodeSearchPort {
  return new NodeSearchPort({ workspace: new NodeWorkspace({ root }), ...over });
}

// ── modo fs (useGit:false): isola a varredura/confinamento/tetos do git ──────────
describe('NodeSearchPort.glob — varredura fs confinada (useGit:false)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-glob-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src', 'deep'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'a.ts'), '');
    writeFileSync(join(root, 'README.md'), '');
    writeFileSync(join(root, 'src', 'b.ts'), '');
    writeFileSync(join(root, 'src', 'b.test.ts'), '');
    writeFileSync(join(root, 'src', 'deep', 'c.ts'), '');
    writeFileSync(join(root, 'src', 'deep', 'test_unit.py'), '');
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.ts'), '');
    writeFileSync(join(base, 'outside.ts'), ''); // FORA da raiz
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('`**/*.ts` casa em qualquer profundidade (e SÓ .ts)', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('**/*.ts', '.');
    expect(paths).toContain('a.ts');
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('src/deep/c.ts');
    expect(paths).toContain('src/b.test.ts');
    expect(paths).not.toContain('README.md');
  });

  it('`*.md` (um segmento) casa SÓ na raiz', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('*.md', '.');
    expect(paths).toEqual(['README.md']);
  });

  it('`src/**` casa tudo SOB src e nada fora', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('src/**', '.');
    expect(paths.every((p) => p.startsWith('src/'))).toBe(true);
    expect(paths).toContain('src/deep/c.ts');
    expect(paths).not.toContain('a.ts');
  });

  it('`src/**/test_*.py` — prefixo de segmento + profundidade', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('src/**/test_*.py', '.');
    expect(paths).toEqual(['src/deep/test_unit.py']);
  });

  it('`{a,README}.{ts,md}` — alternância (braces) casa o produto', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('{a,README}.{ts,md}', '.');
    expect(paths.sort()).toEqual(['README.md', 'a.ts']);
  });

  it('IGNORA node_modules na varredura fs', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('**/*.ts', '.');
    expect(paths.every((p) => !p.includes('node_modules'))).toBe(true);
  });

  it('CONFINAMENTO — não acha arquivo FORA da raiz (mesmo com `path=..` ⇒ lança)', async () => {
    // `**/*.ts` na raiz NÃO vê o `outside.ts` (irmão da raiz).
    const { paths } = await mkPort(root, { useGit: false }).glob('**/*.ts', '.');
    expect(paths.every((p) => !p.includes('outside'))).toBe(true);
    // E navegar p/ fora via path é rejeitado pelo confinamento (igual ao grep).
    await expect(mkPort(root, { useGit: false }).glob('*.ts', '..')).rejects.toThrow(
      WorkspaceEscapeError,
    );
  });

  it('CONFINAMENTO — symlink p/ FORA da raiz é pulado (não vaza o alvo externo)', async () => {
    symlinkSync(join(base, 'outside.ts'), join(root, 'link.ts'));
    const { paths } = await mkPort(root, { useGit: false }).glob('**/*.ts', '.');
    // o symlink não é seguido nem listado (não vaza o arquivo externo).
    expect(paths).not.toContain('link.ts');
  });

  it('`path` restringe a busca a uma subárvore (padrão relativo a ele)', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('*.ts', 'src');
    // dentro de src/, `*.ts` (um segmento) casa b.ts e b.test.ts, não os de deep/.
    expect(paths.sort()).toEqual(['b.test.ts', 'b.ts']);
  });

  it('0 acertos ⇒ lista vazia + truncated vazio (degradação honesta no tool)', async () => {
    const { paths, truncated } = await mkPort(root, { useGit: false }).glob('**/*.rs', '.');
    expect(paths).toEqual([]);
    expect(truncated.byMaxResults).toBeUndefined();
    expect(truncated.byMaxScanned).toBeUndefined();
  });

  it('padrão INVÁLIDO ⇒ lança (vira erro VISÍVEL no tool, não "0 acertos")', async () => {
    await expect(mkPort(root, { useGit: false }).glob('a[bc', '.')).rejects.toThrow();
  });

  it('resultado é ORDENADO (estável)', async () => {
    const { paths } = await mkPort(root, { useGit: false }).glob('**/*.ts', '.');
    expect([...paths]).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
  });
});

// ── tetos / truncamento HONESTO ─────────────────────────────────────────────────
describe('NodeSearchPort.glob — tetos e truncamento (anti-OOM/anti-flood)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-glob-cap-'));
    root = join(base, 'project');
    mkdirSync(root, { recursive: true });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('byMaxResults — mais arquivos casam que o teto de resultados ⇒ sinaliza', async () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.ts`), '');
    const { paths, truncated } = await mkPort(root, { useGit: false, maxMatches: 3 }).glob(
      '*.ts',
      '.',
    );
    expect(paths.length).toBe(3);
    expect(truncated.byMaxResults).toBe(true);
    expect(truncated.byMaxScanned).toBeUndefined();
  });

  it('byMaxScanned — varredura para no teto de arquivos inspecionados ⇒ sinaliza', async () => {
    for (let i = 0; i < 10; i++) writeFileSync(join(root, `f${i}.ts`), '');
    const { truncated } = await mkPort(root, { useGit: false, maxFiles: 3 }).glob('**/*.ts', '.');
    expect(truncated.byMaxScanned).toBe(true);
  });

  it('varredura completa (sem corte) ⇒ truncated vazio (zero ruído)', async () => {
    writeFileSync(join(root, 'a.ts'), '');
    const { truncated } = await mkPort(root, { useGit: false }).glob('**/*.ts', '.');
    expect(truncated.byMaxResults).toBeUndefined();
    expect(truncated.byMaxScanned).toBeUndefined();
  });
});

// ── modo git (default): respeita o .gitignore ───────────────────────────────────
describe('NodeSearchPort.glob — respeita o .gitignore (git ls-files)', () => {
  let base: string;
  let root: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-glob-git-'));
    root = join(base, 'project');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'build'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'build/\n*.log\nsecret.ts\n');
    writeFileSync(join(root, 'src', 'a.ts'), '');
    writeFileSync(join(root, 'src', 'secret.ts'), ''); // ignorado por nome
    writeFileSync(join(root, 'app.log'), ''); // ignorado por *.log
    writeFileSync(join(root, 'build', 'out.ts'), ''); // dir ignorado
    // inicializa um repo git de verdade (determinístico, sem rede).
    const opts = { cwd: root, stdio: 'ignore' as const };
    execFileSync('git', ['init', '-q'], opts);
    execFileSync('git', ['config', 'user.email', 't@t'], opts);
    execFileSync('git', ['config', 'user.name', 't'], opts);
    execFileSync('git', ['add', '-A'], opts);
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('NÃO lista arquivos ignorados pelo .gitignore (secret.ts / *.log / build/)', async () => {
    const { paths } = await mkPort(root).glob('**/*.ts', '.'); // useGit default true
    expect(paths).toContain('src/a.ts');
    expect(paths).not.toContain('src/secret.ts'); // ignorado por nome
    expect(paths).not.toContain('build/out.ts'); // dir ignorado
  });

  it('arquivo *.log ignorado também não aparece com glob amplo', async () => {
    const { paths } = await mkPort(root).glob('**/*', '.');
    expect(paths.every((p) => !p.endsWith('.log'))).toBe(true);
  });
});

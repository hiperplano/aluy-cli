// Listagem assíncrona de subpastas do seletor do `/add-dir` (árvore real em dir temporário).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { DIR_LISTING_CAP, listSubdirs, resolveDir } from '../../src/io/dir-listing.js';

let root: string;
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

beforeAll(async () => {
  root = await realpath(mkdtempSync(join(tmpdir(), 'aluy-dirlist-')));
  for (const d of ['beta', 'Alpha', 'gamma', '.oculta', 'locked']) mkdirSync(join(root, d));
  mkdirSync(join(root, 'many'));
  for (let i = 0; i < 7; i++) mkdirSync(join(root, 'many', `d${i}`));
  writeFileSync(join(root, 'arquivo.txt'), 'x');
  // laço: loop -> .  /  quebrado  /  link p/ arquivo  /  link p/ pasta boa
  symlinkSync(root, join(root, 'loop'));
  symlinkSync(join(root, 'nao-existe'), join(root, 'quebrado'));
  symlinkSync(join(root, 'arquivo.txt'), join(root, 'link-arquivo'));
  symlinkSync(join(root, 'beta'), join(root, 'atalho'));
  symlinkSync(join(root, 'ciclo-b'), join(root, 'ciclo-a'));
  symlinkSync(join(root, 'ciclo-a'), join(root, 'ciclo-b'));
  if (!isRoot) chmodSync(join(root, 'locked'), 0o000);
});

afterAll(() => {
  try {
    chmodSync(join(root, 'locked'), 0o755);
  } catch {
    /* já removida */
  }
  rmSync(root, { recursive: true, force: true });
});

describe('listSubdirs', () => {
  it('lista só pastas, ordenadas sem diferenciar maiúsculas, sem ocultas', async () => {
    const l = await listSubdirs(root);
    const names = l.entries.map((e) => e.name);
    expect(names).toEqual(
      ['Alpha', 'atalho', 'beta', 'gamma', 'loop', 'locked', 'many'].sort((a, b) =>
        a.toLowerCase().localeCompare(b.toLowerCase()),
      ),
    );
    expect(names).not.toContain('arquivo.txt');
    expect(names).not.toContain('.oculta');
    expect(l.error).toBeUndefined();
    expect(l.overflow).toBe(0);
  });

  it('showHidden inclui as ocultas', async () => {
    const l = await listSubdirs(root, { showHidden: true });
    expect(l.entries.map((e) => e.name)).toContain('.oculta');
  });

  it('symlink: resolve ao caminho real; quebrado, ciclo e link p/ arquivo somem', async () => {
    const l = await listSubdirs(root);
    const names = l.entries.map((e) => e.name);
    expect(l.entries.find((e) => e.name === 'atalho')?.path).toBe(join(root, 'beta'));
    for (const gone of ['quebrado', 'link-arquivo', 'ciclo-a', 'ciclo-b']) {
      expect(names).not.toContain(gone);
    }
  });

  it('laço de symlink é seguro: entrar no `loop` volta à mesma pasta real (sem caminho infinito)', async () => {
    const l = await listSubdirs(root);
    const loop = l.entries.find((e) => e.name === 'loop');
    expect(loop?.path).toBe(root);
    const again = await listSubdirs(loop!.path);
    expect(again.entries.find((e) => e.name === 'loop')?.path).toBe(root);
  });

  it.skipIf(isRoot)(
    'pasta sem permissão: entrada marcada e listagem com error=denied (sem lançar)',
    async () => {
      const l = await listSubdirs(root);
      expect(l.entries.find((e) => e.name === 'locked')?.unreadable).toBe(true);
      expect(l.entries.find((e) => e.name === 'beta')?.unreadable).toBe(false);
      const inside = await listSubdirs(join(root, 'locked'));
      expect(inside.error).toBe('denied');
      expect(inside.entries).toEqual([]);
    },
  );

  it('pasta inexistente ou arquivo ⇒ error=missing', async () => {
    expect((await listSubdirs(join(root, 'nada'))).error).toBe('missing');
    expect((await listSubdirs(join(root, 'arquivo.txt'))).error).toBe('missing');
  });

  it('teto: mostra `cap` entradas e conta o excedente', async () => {
    const l = await listSubdirs(join(root, 'many'), { cap: 3 });
    expect(l.entries.map((e) => e.name)).toEqual(['d0', 'd1', 'd2']);
    expect(l.overflow).toBe(4);
  });

  it('o teto padrão é 500', async () => {
    expect(DIR_LISTING_CAP).toBe(500);
    const big = join(root, 'big');
    mkdirSync(big);
    for (let i = 0; i < 503; i++) mkdirSync(join(big, `p${String(i).padStart(4, '0')}`));
    const l = await listSubdirs(big);
    expect(l.entries).toHaveLength(500);
    expect(l.overflow).toBe(3);
  });

  it('é assíncrono: devolve Promise sem bloquear', () => {
    expect(listSubdirs(root)).toBeInstanceOf(Promise);
  });
});

describe('resolveDir', () => {
  it('pasta existente ⇒ caminho canônico; arquivo/ausente ⇒ null', async () => {
    expect(await resolveDir(join(root, 'atalho'))).toBe(join(root, 'beta'));
    expect(await resolveDir(join(root, 'arquivo.txt'))).toBeNull();
    expect(await resolveDir(join(root, 'nada'))).toBeNull();
  });
});

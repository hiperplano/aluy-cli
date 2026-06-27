// EST-0949 · ADR-0053 §8 — prova do BUNDLE de publicação a cada CI: o @aluy/cli-core
// (interno) é EMBUTIDO (some do pacote) e os externals (nativo/pesados) ficam como
// import (resolvem no `npm i` do user). Detecta regressão de empacotamento.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('EST-0949 — bundle de publicação', () => {
  let bin: string;
  beforeAll(() => {
    // O bundle resolve `@aluy/cli-core` pelo dist (resolução de pacote real, não o
    // alias do vitest) — garante o dist antes (robusto à ordem de build no CI).
    const coreDist = join(pkgRoot, '..', 'cli-core', 'dist', 'index.js');
    if (!existsSync(coreDist)) {
      execFileSync('npm', ['run', 'build', '--workspace', '@aluy/cli-core'], {
        cwd: join(pkgRoot, '..', '..'),
        stdio: 'pipe',
      });
    }
    execFileSync('node', ['scripts/bundle.mjs'], { cwd: pkgRoot, stdio: 'pipe' });
    bin = readFileSync(join(pkgRoot, 'dist-bundle/bin/aluy.js'), 'utf8');
  }, 120_000);

  it('gera o binário com shebang único na linha 1', () => {
    expect(existsSync(join(pkgRoot, 'dist-bundle/bin/aluy.js'))).toBe(true);
    expect(bin.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(bin.split('\n')[1].startsWith('#!')).toBe(false); // sem shebang duplo
  });

  it('EMBUTE o @aluy/cli-core (nenhum import/require interno sobra)', () => {
    expect(/from\s*["']@aluy\/cli-core["']/.test(bin)).toBe(false);
    expect(/require\(["']@aluy\/cli-core["']\)/.test(bin)).toBe(false);
  });

  it('mantém os externals (nativo/pesados) como import', () => {
    for (const ext of ['@napi-rs/keyring', 'ink', 'react', 'lowlight']) {
      expect(bin.includes(`"${ext}"`)).toBe(true);
    }
  });

  it('o package.publish.json NÃO declara @aluy/cli-core e expõe bin/README/LICENSE', () => {
    execFileSync('node', ['scripts/make-publish-pkg.mjs'], { cwd: pkgRoot, stdio: 'pipe' });
    const pub = JSON.parse(readFileSync(join(pkgRoot, 'package.publish.json'), 'utf8'));
    expect(pub.dependencies['@aluy/cli-core']).toBeUndefined();
    // SEM prefixo `./`: npm (>=10) rejeita bin com `./` e remove a entrada no publish
    // (o binário `aluy` sumiria do pacote). Caminho relativo cru.
    expect(pub.bin.aluy).toBe('dist-bundle/bin/aluy.js');
    expect(pub.bin.aluy.startsWith('./')).toBe(false);
    // README/LICENSE entram no tarball (vivem na raiz do monorepo; sem isso o pacote
    // público sairia sem doc/licença).
    expect(pub.files).toContain('README.md');
    expect(pub.files).toContain('LICENSE');
  });
});

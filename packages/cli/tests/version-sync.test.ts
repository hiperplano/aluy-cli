// guard de release — o `src/version.ts` de cada pacote é GERADO de `package.json`
// pelo `scripts/gen-version.mjs`, disparado só pelo hook `prebuild` de `npm run build`.
// O build do release e o gate local usam `tsc -b` DIRETO, que NÃO roda npm scripts —
// então um `version.ts` commitado podia ficar congelado (rc.51) enquanto o package.json
// já era rc.59, fazendo banner/`/doctor`/`--version` mentirem a versão em builds de fonte.
// Este teste falha o gate sempre que a constante commitada divergir do package.json,
// forçando a regeneração no bump. Fonte única de verdade = package.json.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

const PACKAGES = [
  { pkg: 'packages/cli/package.json', ts: 'packages/cli/src/version.ts', constName: 'CLI_VERSION' },
  {
    pkg: 'packages/cli-core/package.json',
    ts: 'packages/cli-core/src/version.ts',
    constName: 'CORE_VERSION',
  },
] as const;

function pkgVersion(rel: string): string {
  return JSON.parse(readFileSync(resolve(ROOT, rel), 'utf-8')).version;
}

function tsVersion(rel: string, constName: string): string {
  const src = readFileSync(resolve(ROOT, rel), 'utf-8');
  const m = src.match(new RegExp(`${constName}\\s*=\\s*'([^']+)'`));
  if (!m) throw new Error(`${rel}: constante ${constName} não encontrada`);
  return m[1];
}

describe('version sync (guard de release)', () => {
  it.each(PACKAGES)(
    'o $ts commitado casa com a versão do $pkg',
    ({ pkg, ts, constName }) => {
      expect(tsVersion(ts, constName)).toBe(pkgVersion(pkg));
    },
  );

  it('cli e cli-core estão na MESMA versão (são versionados juntos)', () => {
    expect(pkgVersion('packages/cli/package.json')).toBe(
      pkgVersion('packages/cli-core/package.json'),
    );
  });

  it('o cli pina o cli-core na própria versão', () => {
    const cli = JSON.parse(readFileSync(resolve(ROOT, 'packages/cli/package.json'), 'utf-8'));
    expect(cli.dependencies['@hiperplano/aluy-cli-core']).toBe(cli.version);
  });
});

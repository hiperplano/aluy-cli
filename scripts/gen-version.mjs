#!/usr/bin/env node
/**
 * Prebuild: gera src/version.ts a partir do `version` de cada package.json.
 *
 * FONTE ÚNICA: o version do package.json → constante baked no build.
 * Zero I/O em runtime — o core mantém-se portável (ADR-0053 §8).
 *
 * Chamado automaticamente por `npm run build` via script `prebuild`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const PACKAGES = [
  {
    pkgPath: 'packages/cli-core/package.json',
    versionTs: 'packages/cli-core/src/version.ts',
    constName: 'CORE_VERSION',
  },
  {
    pkgPath: 'packages/cli/package.json',
    versionTs: 'packages/cli/src/version.ts',
    constName: 'CLI_VERSION',
  },
];

function main() {
  for (const { pkgPath, versionTs, constName } of PACKAGES) {
    const absPkg = resolve(ROOT, pkgPath);
    const absTs = resolve(ROOT, versionTs);

    const pkg = JSON.parse(readFileSync(absPkg, 'utf-8'));
    const version = pkg.version;

    if (!version || typeof version !== 'string') {
      console.error(`❌ ${pkgPath}: campo "version" ausente ou inválido`);
      process.exitCode = 1;
      continue;
    }

    const content = `// GERADO por gen-version — não editar.
// Fonte única: ${pkgPath} → version.
export const ${constName} = '${version}';
`;

    writeFileSync(absTs, content, 'utf-8');
    console.log(`✔ ${versionTs} → ${constName} = '${version}'`);
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
}

main();

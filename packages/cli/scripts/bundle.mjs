// EST-0949 · ADR-0053 §8 — bundle de PUBLICAÇÃO: embute SÓ o @aluy/cli-core (interno,
// private) no dist publicável; mantém os pesados/nativos como externals.
import { build } from 'esbuild';
import { chmodSync } from 'node:fs';

const EXTERNALS = [
  '@napi-rs/keyring',
  'ink',
  'react',
  'react/jsx-runtime',
  '@modelcontextprotocol/sdk',
  '@modelcontextprotocol/sdk/*',
  'lowlight',
];

await build({
  entryPoints: { 'bin/aluy': 'src/bin/aluy.ts', index: 'src/index.ts' },
  outdir: 'dist-bundle',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: EXTERNALS,
  logLevel: 'warning',
});

chmodSync('dist-bundle/bin/aluy.js', 0o755);
console.log('[bundle] ok');

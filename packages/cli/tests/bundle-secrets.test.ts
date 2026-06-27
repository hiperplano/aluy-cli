// EST-0949 · CLI-SEC-7 — "binário público limpo": o artefato PUBLICADO não vaza
// segredo/credencial. Scan no dist-bundle (clean) + PROVA-VERMELHO (segredo plantado
// é pego). Gate de release — trava publish de bundle com credencial.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scanForSecrets } from '../scripts/scan-bundle.mjs';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('EST-0949 · CLI-SEC-7 — binário público limpo', () => {
  let bin: string;
  let idx: string;
  beforeAll(() => {
    const coreDist = join(pkgRoot, '..', 'cli-core', 'dist', 'index.js');
    if (!existsSync(coreDist)) {
      execFileSync('npm', ['run', 'build', '--workspace', '@aluy/cli-core'], {
        cwd: join(pkgRoot, '..', '..'),
        stdio: 'pipe',
      });
    }
    execFileSync('node', ['scripts/bundle.mjs'], { cwd: pkgRoot, stdio: 'pipe' });
    bin = readFileSync(join(pkgRoot, 'dist-bundle/bin/aluy.js'), 'utf8');
    idx = readFileSync(join(pkgRoot, 'dist-bundle/index.js'), 'utf8');
  }, 120_000);

  it('o bundle publicável está LIMPO (sem segredo/credencial)', () => {
    expect(scanForSecrets(bin)).toEqual([]);
    expect(scanForSecrets(idx)).toEqual([]);
  });

  it('PROVA-VERMELHO: planta cada tipo de segredo ⇒ o scan PEGA', () => {
    const fakes: Record<string, string> = {
      'private-key': '-----BEGIN PRIVATE KEY-----\nMIIabc',
      'aws-akid': 'const k = "AKIAIOSFODNN7EXAMPLE";',
      'github-token': 'token=ghp_' + 'a'.repeat(40),
      'openai-key': 'OPENAI=sk-' + 'b'.repeat(40),
      'slack-token': 'xoxb-' + 'c'.repeat(20),
      'aluy-token-value': 'ALUY_TOKEN=' + 'd'.repeat(20),
    };
    for (const [id, secret] of Object.entries(fakes)) {
      const hits = scanForSecrets(`prefixo legítimo;\n${secret}\nsufixo`);
      expect(hits.map((h) => h.id)).toContain(id);
    }
  });

  it('não dá falso-positivo em código legítimo', () => {
    const legit = 'const re = /Bearer/; // comentário; const x = sk; password input';
    expect(scanForSecrets(legit)).toEqual([]);
  });
});

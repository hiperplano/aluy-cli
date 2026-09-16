// release.yml · passo "npm publish (idempotente)" — prova EXECUTANDO o script do workflow
// do jeito que o runner executa: `bash -e {0}` (shell default do GitHub p/ `run:`).
//
// Achado real (rc.166 → rc.179, 6 tags seguidas): o passo morria com `exit code 1` e NENHUMA
// linha de saída. O `set -uo pipefail` do script NÃO desliga o `-e` que o runner injeta, e sob
// `-e` a atribuição `out="$(npm publish …)"` com status ≠ 0 encerra o shell NA HORA — o
// `printf` do erro e o `grep EPUBLISHCONFLICT` nunca rodavam. A idempotência (rc.119) só
// existia no papel: republicar a mesma versão derrubava o job e pulava o GitHub Release.
//
// O teste lê o script DO PRÓPRIO release.yml (não uma cópia), troca as expressões `${{ }}` por
// valores e põe um `npm` falso no PATH — assim qualquer regressão no YAML reprova aqui.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STEP = 'npm publish (idempotente)';

/** Extrai o bloco `run: |` do passo `name` (dedentado) de um workflow. */
function extractRunScript(yml: string, name: string): string {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  if (start < 0) throw new Error(`passo não encontrado: ${name}`);
  const stepIndent = lines[start].indexOf('-');
  let i = start + 1;
  while (i < lines.length && lines[i].trim() !== 'run: |') i++;
  const body: string[] = [];
  for (i++; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() !== '' && l.search(/\S/) <= stepIndent) break; // próximo passo
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

interface Run {
  status: number | null;
  stdout: string;
}

describe('release.yml — npm publish idempotente sob `bash -e` (como o runner roda)', () => {
  let script: string;
  beforeAll(() => {
    const yml = readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    script = extractRunScript(yml, STEP)
      .replaceAll('${{ steps.ver.outputs.version }}', '1.0.0-rc.999')
      .replaceAll('${{ steps.ver.outputs.disttag }}', 'rc');
    expect(script).not.toContain('${{');
  });

  function runWithFakeNpm(npmBody: string): Run {
    const dir = mkdtempSync(join(tmpdir(), 'aluy-release-step-'));
    const npm = join(dir, 'npm');
    writeFileSync(npm, `#!/usr/bin/env bash\n${npmBody}\n`);
    chmodSync(npm, 0o755);
    const file = join(dir, 'step.sh');
    writeFileSync(file, script);
    const r = spawnSync('bash', ['-e', file], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    return { status: r.status, stdout: r.stdout };
  }

  it('versão JÁ publicada (E403 "cannot publish over") é sucesso — e o erro aparece no log', () => {
    const r = runWithFakeNpm(
      'echo "npm error code E403"\n' +
        'echo "npm error 403 Forbidden - You cannot publish over the previously published versions: 1.0.0-rc.999."\n' +
        'exit 1',
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('cannot publish over');
    expect(r.stdout).toContain('já estava publicada');
  });

  it('EPUBLISHCONFLICT (grafia antiga do npm) também é sucesso', () => {
    const r = runWithFakeNpm('echo "npm ERR! code EPUBLISHCONFLICT"; exit 1');
    expect(r.status).toBe(0);
  });

  it('qualquer OUTRA falha propaga o código do npm e mostra a saída', () => {
    const r = runWithFakeNpm('echo "npm error code E401 — token inválido"; exit 7');
    expect(r.status).toBe(7);
    expect(r.stdout).toContain('E401');
    expect(r.stdout).not.toContain('já estava publicada');
  });

  it('publish bem-sucedido sai 0', () => {
    const r = runWithFakeNpm('echo "+ @hiperplano/aluy-cli@1.0.0-rc.999"; exit 0');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('+ @hiperplano/aluy-cli@1.0.0-rc.999');
  });
});

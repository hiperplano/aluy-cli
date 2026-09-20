// release.yml · passo "GitHub Release (cria ou atualiza) + tarball" — prova EXECUTANDO o
// script do workflow, com um `gh` falso no PATH que registra os argumentos recebidos.
//
// Achado real (rc.180): foi a PRIMEIRA release criada pelo workflow depois do conserto do
// publish idempotente — e a única marcada `prerelease=true`. O GitHub esconde pre-release do
// badge "Latest", da barra lateral do repo e de `/releases/latest`, então o repositório passou
// a anunciar a rc.179 (a última criada à mão, sem a flag) enquanto o npm já servia a rc.180 no
// dist-tag `latest`. A regra antiga era local ao passo — "tem `-` ⇒ --prerelease" — e ignorava
// a política que o dist-tag do npm já aplicava dois passos acima: ENQUANTO NÃO HÁ STABLE, o rc
// é o release corrente. Duas políticas, uma versão, dois canais discordando.
//
// Agora as duas leem a MESMA saída (`steps.ver.outputs.stable`). Este teste trava isso no YAML.
import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractRunScript, readWorkflow } from './workflow-script.js';

const STEP = 'GitHub Release (cria ou atualiza) + tarball';

interface Run {
  status: number | null;
  /** Uma linha por invocação do `gh`, na ordem. */
  calls: string[];
}

describe('release.yml — canal do GitHub Release (pre-release × Latest)', () => {
  let raw: string;
  beforeAll(() => {
    raw = extractRunScript(readWorkflow('release.yml'), STEP);
    expect(raw).toContain('steps.ver.outputs.stable');
  });

  /**
   * Roda o passo com `stable`/`version` dados e um `gh` falso.
   * `releaseExists` decide o status do `gh release view` (0 = já existe).
   */
  function run(opts: { stable: '0' | '1'; version: string; releaseExists: boolean }): Run {
    const script = raw
      .replaceAll('${{ steps.ver.outputs.version }}', opts.version)
      .replaceAll('${{ steps.ver.outputs.stable }}', opts.stable)
      .replaceAll('${{ steps.pack.outputs.tgz }}', 'aluy-cli.tgz');
    expect(script).not.toContain('${{');

    const dir = mkdtempSync(join(tmpdir(), 'aluy-release-channel-'));
    const log = join(dir, 'gh.log');
    const gh = join(dir, 'gh');
    writeFileSync(
      gh,
      '#!/usr/bin/env bash\n' +
        `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\n` +
        `if [ "$1" = release ] && [ "$2" = view ]; then exit ${opts.releaseExists ? 0 : 1}; fi\n` +
        'exit 0\n',
    );
    chmodSync(gh, 0o755);
    const file = join(dir, 'step.sh');
    writeFileSync(file, script);
    const r = spawnSync('bash', ['-e', file], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    let calls: string[] = [];
    try {
      calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    } catch {
      /* nenhuma chamada */
    }
    return { status: r.status, calls };
  }

  const created = (c: string[]) => c.find((l) => l.startsWith('release create')) ?? '';
  const edited = (c: string[]) => c.find((l) => l.startsWith('release edit')) ?? '';

  it('SEM stable publicado, o rc nasce como Latest — não como pre-release', () => {
    const r = run({ stable: '0', version: '1.0.0-rc.999', releaseExists: false });
    expect(r.status).toBe(0);
    expect(created(r.calls)).toContain('--prerelease=false');
    expect(created(r.calls)).toContain('--latest=true');
  });

  it('COM stable publicado, o rc volta a ser pre-release e não rouba o Latest', () => {
    const r = run({ stable: '1', version: '1.0.0-rc.999', releaseExists: false });
    expect(r.status).toBe(0);
    expect(created(r.calls)).toContain('--prerelease=true');
    expect(created(r.calls)).toContain('--latest=false');
  });

  it('uma versão ESTÁVEL é sempre Latest, haja ou não stable anterior', () => {
    for (const stable of ['0', '1'] as const) {
      const r = run({ stable, version: '1.0.0', releaseExists: false });
      expect(r.status).toBe(0);
      expect(created(r.calls)).toContain('--prerelease=false');
      expect(created(r.calls)).toContain('--latest=true');
    }
  });

  // Sem isto, uma release criada com o canal errado (à mão, ou pela política velha) ficava
  // errada PARA SEMPRE: re-rodar o workflow anexava o tarball de novo e não corrigia a flag.
  it('release que JÁ existe tem o canal CORRIGIDO, não só o tarball reanexado', () => {
    const r = run({ stable: '0', version: '1.0.0-rc.999', releaseExists: true });
    expect(r.status).toBe(0);
    expect(r.calls.some((l) => l.startsWith('release upload'))).toBe(true);
    expect(edited(r.calls)).toContain('--prerelease=false');
    expect(edited(r.calls)).toContain('--latest=true');
    expect(created(r.calls)).toBe(''); // não tenta criar de novo
  });
});

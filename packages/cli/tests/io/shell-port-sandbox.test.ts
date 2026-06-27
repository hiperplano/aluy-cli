// EST-1010 · ADR-0065 — prova de SO REAL do confinamento do bash no NodeShellPort.
//
// HONESTIDADE (DoD, espelha o teste do #170): onde a máquina NÃO tem userns/bwrap,
// NÃO pulamos calado — provamos o FAIL-MODE (degrade roda cru + aviso). Onde HÁ piso
// (esta máquina: bwrap 0.11.0), provamos o confinamento DE VERDADE: um comando
// confinado NÃO enxerga um arquivo FORA do workspace (barrado por NAMESPACE de mount,
// não por reconhecer string), mas VÊ os arquivos do workspace.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { floorAvailable } from '@hiperplano/aluy-cli-core';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';
import { createSandbox, detectSandboxCapability } from '../../src/sandbox/index.js';

const cap = detectSandboxCapability();
const FLOOR = floorAvailable(cap);

describe('EST-1010 — confinamento do bash (shell-port × sandbox)', () => {
  let wsRoot: string;
  let secretDir: string;
  let secretFile: string;
  let wsFile: string;

  beforeAll(() => {
    wsRoot = mkdtempSync(join(tmpdir(), 'aluy-ws-'));
    // Segredo FORA do workspace — o confinado NÃO deve enxergar.
    secretDir = mkdtempSync(join(tmpdir(), 'aluy-secret-'));
    secretFile = join(secretDir, 'id_rsa');
    writeFileSync(secretFile, 'CHAVE-SECRETA-NAO-DEVE-VAZAR', 'utf8');
    // Arquivo DENTRO do workspace — o confinado DEVE enxergar.
    wsFile = join(wsRoot, 'dentro.txt');
    writeFileSync(wsFile, 'CONTEUDO-DO-WORKSPACE', 'utf8');
  });

  afterAll(() => {
    rmSync(wsRoot, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  });

  function makeShell(): NodeShellPort {
    const workspace = new NodeWorkspace({ root: wsRoot });
    const sandboxLauncher = createSandbox({ env: 'dev' });
    // killGraceMs curto p/ o teste não pendurar.
    return new NodeShellPort({ workspace, sandboxLauncher, killGraceMs: 50 });
  }

  it.runIf(FLOOR)(
    'CONFINADO: NÃO enxerga o segredo fora do workspace (barrado pelo SO)',
    async () => {
      const shell = makeShell();
      const res = await shell.exec(`cat '${secretFile}' 2>&1; echo "EXIT=$?"`);
      // O conteúdo do segredo NUNCA aparece — o path não existe no namespace.
      expect(res.stdout).not.toContain('CHAVE-SECRETA');
      // E o shell reporta que o arquivo não existe (mount-namespace o esconde).
      expect(res.stdout.toLowerCase()).toMatch(/no such file|não|cannot|inexistente|directory/);
    },
    30_000,
  );

  it.runIf(FLOOR)(
    'CONFINADO: VÊ os arquivos do próprio workspace',
    async () => {
      const shell = makeShell();
      const res = await shell.exec(`cat 'dentro.txt'`);
      expect(res.stdout).toContain('CONTEUDO-DO-WORKSPACE');
    },
    30_000,
  );

  it.runIf(FLOOR)(
    'CONFINADO: ofuscação por symlink p/ fora NÃO vaza (FU-VAU-5, barrado pelo SO)',
    async () => {
      const shell = makeShell();
      // Tenta criar um symlink p/ o dir do segredo e ler através dele — o alvo está
      // FORA do namespace, então o symlink aponta p/ o nada (não há travessia possível).
      const res = await shell.exec(
        `ln -s '${secretDir}' ./link 2>/dev/null; cat ./link/id_rsa 2>&1; echo DONE`,
      );
      expect(res.stdout).not.toContain('CHAVE-SECRETA');
      expect(res.stdout).toContain('DONE');
    },
    30_000,
  );

  it.runIf(FLOOR)(
    'CONFINADO: HOME reescrito + glob + base64 NÃO vazam (FU-VAU-5 — SO, não string)',
    async () => {
      const shell = makeShell();
      // 3 técnicas de ofuscação que um matcher de STRING erraria, mas o NAMESPACE
      // barra por construção (o path simplesmente não existe no mount do filho):
      //   (a) HOME reescrito p/ o dir do segredo + ler "$HOME/id_rsa"
      //   (b) glob expandindo o prefixo do segredo
      //   (c) comando codificado em base64 + executado (sh não vê o literal)
      const b64 = Buffer.from(`cat '${secretFile}'`, 'utf8').toString('base64');
      const res = await shell.exec(
        [
          `HOME='${secretDir}' sh -c 'cat "$HOME/id_rsa"' 2>&1`,
          `cat ${secretDir}/id_r* 2>&1`,
          `echo '${b64}' | base64 -d | sh 2>&1`,
          `echo DONE`,
        ].join('; '),
      );
      // NENHUMA das três faz o segredo vazar — barrado pelo SO em todas.
      expect(res.stdout).not.toContain('CHAVE-SECRETA');
      expect(res.stdout).toContain('DONE');
    },
    30_000,
  );

  it.skipIf(FLOOR)(
    'SEM PISO (honestidade): degrada — roda cru + aviso não-suprimível',
    async () => {
      const shell = makeShell();
      const res = await shell.exec(`echo ok`);
      // Sem piso, o comando AINDA roda (fail-open degrade), mas com o aviso de SO.
      expect(res.stdout).toContain('ok');
      expect(res.stderr.toLowerCase()).toMatch(/piso|sandbox|sem piso de so|sandbox/i);
    },
    30_000,
  );

  it('SEM launcher (fail-open): comportamento atual preservado', async () => {
    const workspace = new NodeWorkspace({ root: wsRoot });
    const shell = new NodeShellPort({ workspace, killGraceMs: 50 });
    const res = await shell.exec(`echo direto`);
    expect(res.stdout).toContain('direto');
    expect(res.stderr).not.toMatch(/piso de SO/i);
  });
});

// EST-1012 · ADR-0065 / CLI-SEC — CORPUS de avaliação de segurança (o gate numérico).
//
// Consolida, num único corpus reusável + SCORE, as duas defesas duras que a promoção
// a prod exige (co-dono seguranca+qa):
//   (A) PATH-OBFUSCATION → barrado pelo SANDBOX DE SO (não por reconhecer string):
//       o confinado não alcança um segredo FORA do workspace, por mais ofuscado que
//       seja o caminho. Prova "barrado pelo SO, não pela string" (FU-VAU-5).
//   (B) DESTRUTIVO/ESCALADA → sinalizado pela CATRACA (sempre-ask, não-relaxável):
//       toda forma perigosa casa `classifyAlwaysAsk` (recall alto, fail-safe).
//
// O teste FALHA se QUALQUER vetor escapar (o gate é 100%): um regression que abra um
// furo de confinamento OU de recall reprova aqui. O score é logado p/ o harness
// recorrente (EST-0952) consumir.

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyAlwaysAsk, floorAvailable } from '@hiperplano/aluy-cli-core';
import { createSandbox, detectSandboxCapability } from '../../src/sandbox/index.js';

// (A) testa a PRIMITIVA de confinamento (#170 launcher) DIRETO — está em `main`. A
// fiação no shell-port (EST-1010/#181) está em PR à parte; quando mergear, o mesmo
// corpus vale via NodeShellPort. Aqui provamos o PISO de SO em si.

const FLOOR = floorAvailable(detectSandboxCapability());

// Caminhos DETERMINÍSTICOS (conhecidos em collection-time, p/ os vetores serem
// montados no nível do describe). Os arquivos são criados no `beforeAll`.
const SECRET_DIR = join(tmpdir(), 'aluy-eval-1012-secret');
const SECRET_FILE = join(SECRET_DIR, 'id_rsa');
const SECRET_MARK = 'EVAL-SEGREDO-NAO-VAZA';

// (B) CATRACA — formas perigosas que DEVEM casar sempre-ask (não-relaxável).
const CATRACA_VECTORS: ReadonlyArray<{ id: string; command: string }> = [
  { id: 'rm-rf-root', command: 'rm -rf /' },
  { id: 'rm-flag-after', command: 'rm dir -rf' },
  { id: 'rm-long-recursive', command: 'rm --recursive build' },
  { id: 'rm-long-force', command: 'rm --force x' },
  { id: 'rm-R', command: 'rm -R node_modules' },
  { id: 'sudo-anything', command: 'sudo apt update' },
  { id: 'su-dash', command: 'su -' },
  { id: 'chmod-setuid-octal', command: 'chmod 4755 /tmp/x' },
  { id: 'chmod-setuid-symbolic', command: 'chmod u+s /tmp/x' },
  { id: 'chown-root', command: 'chown root:root /etc/passwd' },
  { id: 'pkexec', command: 'pkexec sh' },
];

describe('EST-1012 — corpus de avaliação de segurança (gate numérico)', () => {
  // -------- (B) CATRACA: recall de destrutivo/escalada --------
  describe('(B) catraca — destrutivo/escalada sempre casa', () => {
    let bPass = 0;
    for (const v of CATRACA_VECTORS) {
      it(`flagra: ${v.id}`, () => {
        const matches = classifyAlwaysAsk('run_command', { command: v.command });
        expect(matches.length).toBeGreaterThan(0); // sinalizado = ask (não passa batido)
        bPass++;
      });
    }
    afterAll(() => {
      console.log(`[EST-1012] catraca: ${bPass}/${CATRACA_VECTORS.length} vetores flagrados`);
    });
  });

  // -------- (A) SANDBOX: path-obfuscation barrado pelo SO --------
  describe('(A) sandbox — path-obfuscation barrado pelo SO', () => {
    let wsRoot: string;

    beforeAll(() => {
      wsRoot = mkdtempSync(join(tmpdir(), 'eval-ws-'));
      mkdirSync(SECRET_DIR, { recursive: true });
      writeFileSync(SECRET_FILE, SECRET_MARK, 'utf8');
    });
    afterAll(() => {
      rmSync(wsRoot, { recursive: true, force: true });
      rmSync(SECRET_DIR, { recursive: true, force: true });
    });

    // Roda o comando CONFINADO direto no launcher (#170) e devolve a saída coletada.
    function runConfined(command: string): Promise<string> {
      const launcher = createSandbox({ env: 'dev' });
      const { decision, process: child } = launcher.spawnConfined(
        ['/bin/sh', '-c', command],
        { workspaceRoots: [wsRoot], cwd: wsRoot, network: false },
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      if (!child) return Promise.resolve(`[sem processo: ${decision.action}]`);
      return new Promise((res) => {
        let out = '';
        child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
        child.stderr?.on('data', (d: Buffer) => (out += d.toString()));
        child.on('close', () => res(out));
      });
    }

    // Cada vetor tenta ler o segredo FORA do workspace por uma ofuscação distinta.
    function vectors(): ReadonlyArray<{ id: string; command: string }> {
      const b64 = Buffer.from(`cat '${SECRET_FILE}'`, 'utf8').toString('base64');
      const hexPath = SECRET_FILE.replace(/./g, (c) => '\\x' + c.charCodeAt(0).toString(16));
      return [
        { id: 'direto', command: `cat '${SECRET_FILE}' 2>&1` },
        { id: 'symlink', command: `ln -s '${SECRET_DIR}' ./l 2>/dev/null; cat ./l/id_rsa 2>&1` },
        { id: 'home-rewrite', command: `HOME='${SECRET_DIR}' sh -c 'cat "$HOME/id_rsa"' 2>&1` },
        { id: 'glob', command: `cat ${SECRET_DIR}/id_r* 2>&1` },
        { id: 'base64-exec', command: `echo '${b64}' | base64 -d | sh 2>&1` },
        { id: 'printf-hex', command: `cat "$(printf '${hexPath}')" 2>&1` },
      ];
    }

    let aPass = 0;
    let aTotal = 0;
    for (const v of FLOOR ? vectors() : []) {
      aTotal++;
      it(`barra: ${v.id}`, async () => {
        const out = await runConfined(`${v.command}; echo DONE`);
        expect(out).not.toContain(SECRET_MARK); // segredo NUNCA vaza
        aPass++;
      }, 30_000);
    }

    afterAll(() => {
      if (FLOOR) {
        console.log(`[EST-1012] sandbox: ${aPass}/${aTotal} vetores barrados pelo SO`);
      } else {
        console.log(
          '[EST-1012] sandbox: SEM PISO nesta máquina — vetores (A) não-avaliados (honesto)',
        );
      }
    });

    it('máquina com piso avalia o conjunto (A) completo', () => {
      // Honestidade: numa máquina sem piso, (A) não roda — registramos, não fingimos.
      expect(FLOOR ? vectors().length : 0).toBe(FLOOR ? 6 : 0);
    });
  });
});

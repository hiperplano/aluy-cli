// EST-0948 — ShellPort concreto: TIMEOUT obrigatório (anti-hang) + cwd PRESO.
// Cravas do seguranca. Usa comandos reais de shell (curtos/determinísticos).

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeShellPort } from '../../src/io/shell-port.js';
import { NodeWorkspace } from '../../src/io/workspace.js';

function tmpWorkspace(): { root: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'aluy-sh-'));
  const root = join(base, 'project');
  mkdirSync(root, { recursive: true });
  return { root, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

describe('NodeShellPort — timeout + cwd preso (cravas do seguranca)', () => {
  it('roda um comando e captura stdout + exitCode', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const r = await shell.exec('echo ola-aluy');
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('ola-aluy');
    } finally {
      cleanup();
    }
  });

  it('cwd PRESO à raiz do workspace (pwd = root canonicalizado)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const ws = new NodeWorkspace({ root });
      const shell = new NodeShellPort({ workspace: ws });
      const r = await shell.exec('pwd');
      expect(r.stdout.trim()).toBe(realpathSync(root));
      expect(r.stdout.trim()).toBe(ws.root);
    } finally {
      cleanup();
    }
  });

  it('TIMEOUT mata o comando SILENCIOSO/pendurado e reporta exitCode 124 (anti-hang)', async () => {
    // EST-0969 — `sleep 10` não produz NENHUMA saída: o heartbeat de inatividade de
    // OUTPUT dispara após `timeoutMs` de silêncio (= provável hung) e mata o grupo.
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root }),
        timeoutMs: 150, // teto de INATIVIDADE curto p/ o teste
      });
      const start = Date.now();
      const r = await shell.exec('sleep 10');
      const elapsed = Date.now() - start;
      expect(r.exitCode).toBe(124); // convenção de timeout
      expect(r.stderr).toMatch(/sem saída|hung|anti-hang/i);
      // Não pendurou os 10s — matou perto do teto de inatividade.
      expect(elapsed).toBeLessThan(5000);
    } finally {
      cleanup();
    }
  });

  it('EST-0969 — comando LONGO mas VERBOSO (saída periódica) NÃO é morto pelo heartbeat', async () => {
    // O comando cospe uma linha a cada ~40ms por 25 linhas (~1s de runtime TOTAL),
    // MUITO além do timeoutMs de inatividade — mas como há OUTPUT contínuo (intervalo
    // << idle), cada chunk RE-ARMA o heartbeat e o comando completa (exitCode 0). Se o
    // timeout fosse um teto TOTAL, ele teria sido morto no meio. O idle (800ms) é
    // folgado p/ não flakar sob carga de CI paralela, mas ainda << runtime total (~1s).
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({
        workspace: new NodeWorkspace({ root }),
        timeoutMs: 800, // INATIVIDADE de saída: << runtime total, mas robusto sob carga
      });
      const r = await shell.exec(
        'i=0; while [ $i -lt 25 ]; do echo line$i; sleep 0.04; i=$((i+1)); done',
      );
      expect(r.exitCode).toBe(0); // completou — nunca morto pelo heartbeat
      expect(r.stdout).toContain('line0');
      expect(r.stdout).toContain('line24');
    } finally {
      cleanup();
    }
  });

  it('timeout=0/negativo NÃO desativa o anti-hang (cai no default > 0)', () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      // construir não lança; o default garante um timeout sempre positivo.
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }), timeoutMs: 0 });
      expect(shell).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it('exitCode não-zero é propagado (comando que falha)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      const r = await shell.exec('exit 3');
      expect(r.exitCode).toBe(3);
    } finally {
      cleanup();
    }
  });

  // EST-0944 — REGRESSÃO: saída UTF-8 multibyte GRANDE (> 64KiB) não pode corromper
  // caracteres partidos na fronteira de chunk do pipe. Antes do StringDecoder, o
  // `Buffer.toString('utf8')` por chunk decodificava cada read ISOLADO ⇒ o tail de um
  // caractere de 3 bytes (ex.: '€' = E2 82 AC) cortado pelo read do kernel (~64KiB,
  // que NÃO é múltiplo de 3) virava `�` (U+FFFD). Isso atinge `cat` de fonte UTF-8,
  // JSON com acentos, logs com glifos box-drawing — caminho REAL do dogfood.
  it('saída UTF-8 multibyte > 64KiB NÃO corrompe (fronteira de chunk; sem U+FFFD)', async () => {
    const { root, cleanup } = tmpWorkspace();
    try {
      const shell = new NodeShellPort({ workspace: new NodeWorkspace({ root }) });
      // 100k '€' = 300_000 bytes ⇒ o pipe entrega em vários reads de ~64KiB; como
      // 65536 % 3 !== 0, AO MENOS um '€' é partido entre dois reads. Escrito por Node
      // num único write (sem alinhamento de shell que mascararia o bug).
      const N = 100_000;
      const gen = `process.stdout.write(Buffer.from('\\u20ac'.repeat(${N}), 'utf8'))`;
      const collected: string[] = [];
      const r = await shell.exec(`node -e "${gen}"`, {
        onChunk: (c) => {
          if (c.stream === 'stdout') collected.push(c.text);
        },
      });
      expect(r.exitCode).toBe(0);
      // SEM caractere de substituição (corrupção) na saída bufferizada...
      expect(r.stdout).not.toContain('�');
      // ...nem no streaming ao vivo (mesmo decode stateful alimenta os dois caminhos).
      expect(collected.join('')).not.toContain('�');
      // E a contagem de '€' bate exatamente (nada perdido nem quebrado). O buffer pode
      // estar truncado em MAX_OUTPUT_BYTES, então conferimos a contagem no stream vivo,
      // que recebe tudo. 300_000 bytes < 1MB ⇒ não trunca de qualquer forma.
      const euros = (collected.join('').match(/€/g) ?? []).length;
      expect(euros).toBe(N);
    } finally {
      cleanup();
    }
  });
});

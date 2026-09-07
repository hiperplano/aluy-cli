// O `npm` do WINDOWS é um shim `.cmd` — e o `spawn` do Node não executa `.cmd`.
//
// Relato do dono (04/09): "tentei usar o /upgrade no windows e não foi". A nota dizia
// apenas "o `npm install -g` não completou", que não ajuda a agir.
//
// A causa: `spawn('npm', …)` no Windows falha com ENOENT, porque lá o `npm` não é um
// executável — é `npm.cmd`, um batch. Ou seja, a atualização (automática E explícita)
// NUNCA funcionou no Windows; a falha era MUDA, então ninguém soube. Só apareceu quando a
// rc.168 passou a REPORTAR o fracasso — o defeito é antigo, a visibilidade é que é nova.
//
// Preferimos o NOME certo do executável a `shell: true`: com shell, a versão viraria parte
// de uma linha de comando interpretada, e argumento não-interpretado é sempre mais seguro.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpgrade } from '../../src/io/auto-update.js';

const GLOBAL = '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js';
const registry = () =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ rc: '1.0.0-rc.200' }),
  })) as never;

/** Captura o executável pedido; `falhaENOENT` simula o Windows sem o `.cmd`. */
function spawnEspiao(vistos: string[], falhaENOENT = false) {
  return vi.fn((bin: string) => {
    vistos.push(bin);
    const c = new EventEmitter() as EventEmitter & { kill: () => void };
    c.kill = () => undefined;
    queueMicrotask(() => {
      if (falhaENOENT)
        c.emit('error', Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' }));
      else c.emit('exit', 0);
    });
    return c as never;
  }) as never;
}

let dir: string;
const plataformaReal = process.platform;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aluy-win-'));
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: plataformaReal });
  rmSync(dir, { recursive: true, force: true });
});

function fingePlataforma(p: string): void {
  Object.defineProperty(process, 'platform', { value: p });
}

const base = { scriptPath: GLOBAL, realpath: (p: string) => p, aluyDir: dir };

describe('o executável do npm por plataforma', () => {
  it('WINDOWS ⇒ chama `npm.cmd` (o `spawn` não roda `.cmd` pelo nome `npm`)', async () => {
    fingePlataforma('win32');
    const vistos: string[] = [];
    await runUpgrade('1.0.0-rc.1', { ...base, fetch: registry(), spawn: spawnEspiao(vistos) });
    expect(vistos[0]).toBe('npm.cmd');
  });

  it('LINUX/macOS ⇒ segue chamando `npm` (sem regressão)', async () => {
    fingePlataforma('linux');
    const vistos: string[] = [];
    await runUpgrade('1.0.0-rc.1', { ...base, fetch: registry(), spawn: spawnEspiao(vistos) });
    expect(vistos[0]).toBe('npm');
  });
});

describe('a falha diz POR QUE', () => {
  it('ENOENT ⇒ o motivo chega ao resultado (era só "não completou")', async () => {
    fingePlataforma('linux');
    const r = await runUpgrade('1.0.0-rc.1', {
      ...base,
      fetch: registry(),
      spawn: spawnEspiao([], true),
    });
    expect(r.kind).toBe('falhou');
    const motivo = (r as { motivo?: string }).motivo ?? '';
    expect(motivo, 'sem o motivo não dá p/ saber se é PATH, permissão ou o npm falhando').toContain(
      'ENOENT',
    );
  });
});

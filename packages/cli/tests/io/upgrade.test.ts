// `/upgrade` — a atualização EXPLÍCITA.
//
// Pedido do dono (02/09), vendo a máquina anunciar versão nova: "ele não deveria rodar o
// upgrade silenciosamente — mostrando que atualizou no final na barra do footer, ou dar a
// opção do /upgrade".
//
// O incômodo tem nome: trocar o binário de alguém sem pedir é uma decisão que não é nossa.
// O que estes testes travam é o CONTRÁRIO do autoupdate — aqui NENHUM desfecho é mudo,
// inclusive os dois em que o automático cala de propósito ("já está no topo" e "não é
// instalação global"). Era justamente esse silêncio que ele recusou.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runUpgrade } from '../../src/io/auto-update.js';
import { linhasDoUpgrade, linhaDeInicio } from '../../src/io/upgrade.js';

const GLOBAL = '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js';

function registry(tags: Record<string, string>, ok = true) {
  return vi.fn(async () => ({ ok, status: ok ? 200 : 503, json: async () => tags })) as never;
}

function spawnFalso(ok: boolean) {
  return vi.fn(() => {
    const c = new EventEmitter() as EventEmitter & { kill: () => void };
    c.kill = () => undefined;
    queueMicrotask(() => c.emit('exit', ok ? 0 : 1));
    return c as never;
  }) as never;
}

let dir: string;
beforeEach(() => {
  // O estado vai p/ tmpdir — NUNCA o `~/.aluy` real de quem roda a suíte.
  dir = mkdtempSync(join(tmpdir(), 'aluy-upgrade-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const base = { scriptPath: GLOBAL, realpath: (p: string) => p, aluyDir: dir };

describe('runUpgrade — nenhum desfecho é mudo', () => {
  it('há versão nova ⇒ instala e RELATA de→para', async () => {
    const r = await runUpgrade('1.0.0-rc.162', {
      ...base,
      fetch: registry({ rc: '1.0.0-rc.167', latest: '1.0.0-rc.167' }),
      spawn: spawnFalso(true),
    });
    expect(r).toEqual({ kind: 'instalado', de: '1.0.0-rc.162', para: '1.0.0-rc.167' });
  });

  it('anuncia ANTES de baixar — o dono vê o que vai acontecer', async () => {
    const aoComecar = vi.fn();
    await runUpgrade('1.0.0-rc.162', {
      ...base,
      fetch: registry({ rc: '1.0.0-rc.167' }),
      spawn: spawnFalso(true),
      aoComecar,
    });
    expect(aoComecar).toHaveBeenCalledWith('1.0.0-rc.162', '1.0.0-rc.167');
  });

  it('JÁ no topo ⇒ diz isso (o autoupdate cala aqui — e era a queixa)', async () => {
    const aoComecar = vi.fn();
    const r = await runUpgrade('1.0.0-rc.167', {
      ...base,
      fetch: registry({ rc: '1.0.0-rc.167' }),
      spawn: spawnFalso(true),
      aoComecar,
    });
    expect(r.kind).toBe('ja-no-topo');
    expect(aoComecar, 'nada a baixar ⇒ nada a anunciar').not.toHaveBeenCalled();
  });

  it('instalação FALHOU ⇒ relata a falha, não finge sucesso', async () => {
    const r = await runUpgrade('1.0.0-rc.162', {
      ...base,
      fetch: registry({ rc: '1.0.0-rc.167' }),
      spawn: spawnFalso(false),
    });
    expect(r).toEqual({ kind: 'falhou', de: '1.0.0-rc.162', para: '1.0.0-rc.167' });
  });

  it('registro fora ⇒ diz o motivo (não some)', async () => {
    const r = await runUpgrade('1.0.0-rc.162', {
      ...base,
      fetch: registry({}, false),
      spawn: spawnFalso(true),
    });
    expect(r.kind).toBe('sem-registro');
  });

  it('NÃO é instalação global ⇒ recusa e explica (nunca troca o binário errado)', async () => {
    const r = await runUpgrade('1.0.0-rc.162', {
      ...base,
      scriptPath: '/home/eu/repo/packages/cli/dist/bin/aluy.js',
      fetch: registry({ rc: '1.0.0-rc.167' }),
      spawn: spawnFalso(true),
    });
    expect(r.kind).toBe('nao-e-global');
  });

  it('canal é respeitado: uma `latest` estável NÃO puxa quem está em rc', async () => {
    const r = await runUpgrade('1.0.0-rc.162', {
      ...base,
      fetch: registry({ latest: '2.0.0', rc: '1.0.0-rc.162' }),
      spawn: spawnFalso(true),
    });
    expect(r.kind, 'trocar de canal sem pedir seria pior que não atualizar').toBe('ja-no-topo');
  });
});

describe('as notas dizem o que aconteceu', () => {
  it('sucesso manda REINICIAR (a sessão viva segue na antiga)', () => {
    const l = linhasDoUpgrade({ kind: 'instalado', de: 'a', para: 'b' }).join(' ');
    expect(l).toContain('REINICIE');
  });

  it('falha dá o comando manual', () => {
    const l = linhasDoUpgrade({ kind: 'falhou', de: 'a', para: 'b' }).join(' ');
    expect(l).toContain('npm i -g');
  });

  it('a linha de início diz de→para', () => {
    expect(linhaDeInicio('rc.1', 'rc.2')).toContain('rc.2');
    expect(linhaDeInicio('rc.1', 'rc.2')).toContain('rc.1');
  });
});

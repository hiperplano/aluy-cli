// O SUCESSO do autoupdate não pode ser mudo.
//
// O relato (dono, 01/09): "me parece que o autoupdate não está funcionando, tenho uma
// máquina na versão 158 e nada de mostrar a atualização". Ele estava certo sobre o
// SINTOMA — e o silêncio era de desenho, não acidente:
//
//   • `readAutoUpdateNote` é lida no boot ANTES do `runAutoUpdate` da MESMA abertura, então
//     no boot em que a instalação acontece o estado ainda nem existe;
//   • no boot SEGUINTE o binário novo já está rodando, logo `installedOnDisk` deixa de ser
//     "mais novo que o rodando" e a nota também não dispara.
//
// Ou seja: no caminho de SUCESSO ela nunca aparecia. Só a de FALHA aparecia. O usuário era
// atualizado sem nunca saber — e, quando desconfiava, não tinha como distinguir "não havia
// nada" de "não funcionou".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { runAutoUpdate } from '../../src/io/auto-update.js';

// ISOLAMENTO — pelo CAMINHO INJETÁVEL (`aluyDir`), não por dublê de `node:os`.
//
// A 1ª versão dublava `homedir` com `vi.mock('node:os')`. Passava isolada e FALHAVA junto
// dos vizinhos: o dublê vale só para o grafo de módulos do arquivo que o declara, e quando
// outro teste do mesmo worker já carregou `auto-update.js`, ele fica com o `homedir` REAL —
// o teste passava a ler (e a poder ESCREVER) o `~/.aluy/auto-update.json` de quem roda a
// suíte. Com `lastCheck` recente lá, a função retornava antes e o caso caía.
//
// Uma dep de caminho remove a classe inteira, e é a MESMA disciplina já adotada no repo
// depois de dano equivalente: `baseDir` no TodoStore e `vaultPath` no cofre.

/** Registry dublê: devolve o mapa de dist-tags pedido. */
function registry(tags: Record<string, string>) {
  return vi.fn(async () => ({ ok: true, json: async () => tags })) as unknown as typeof fetch;
}

/**
 * `npm i -g` dublê: `ok` decide se a instalação "funciona". Usa `EventEmitter` + `exit`
 * porque é o que o `installInBackground` escuta (`child.once('exit', …)`) — o mesmo molde
 * do teste que já existe no repo. Meu primeiro dublê emitia `close` e nunca resolvia.
 */
function spawnFalso(ok: boolean) {
  return vi.fn(() => {
    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = () => undefined;
    queueMicrotask(() => child.emit('exit', ok ? 0 : 1));
    return child as never;
  }) as never;
}

function ambiente(dir: string): NodeJS.ProcessEnv {
  // HOME temporário: o estado do autoupdate NUNCA pode ir para o `~/.aluy` real de quem roda.
  return { HOME: dir, ALUY_AUTO_UPDATE: '1' };
}

describe('aoInstalar — o sucesso AVISA na sessão', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aluy-autoup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('instalou ⇒ chama `aoInstalar` com a versão nova', async () => {
    const aoInstalar = vi.fn();
    await runAutoUpdate('1.0.0-rc.158', ambiente(dir), true, {
      fetch: registry({ rc: '1.0.0-rc.161', latest: '1.0.0-rc.161' }),
      spawn: spawnFalso(true),
      scriptPath: '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js',
      realpath: (p) => p,
      aluyDir: dir, // NUNCA o `~/.aluy` real de quem roda a suíte
      aoInstalar,
    });
    expect(aoInstalar, 'o sucesso tem de ser anunciado').toHaveBeenCalledWith('1.0.0-rc.161');
  });

  it('NÃO havia novidade ⇒ não avisa (nada aconteceu)', async () => {
    const aoInstalar = vi.fn();
    await runAutoUpdate('1.0.0-rc.161', ambiente(dir), true, {
      fetch: registry({ rc: '1.0.0-rc.161', latest: '1.0.0-rc.161' }),
      spawn: spawnFalso(true),
      scriptPath: '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js',
      realpath: (p) => p,
      aluyDir: dir, // NUNCA o `~/.aluy` real de quem roda a suíte
      aoInstalar,
    });
    expect(aoInstalar).not.toHaveBeenCalled();
  });

  it('a instalação FALHOU ⇒ não anuncia sucesso', async () => {
    const aoInstalar = vi.fn();
    await runAutoUpdate('1.0.0-rc.158', ambiente(dir), true, {
      fetch: registry({ rc: '1.0.0-rc.161', latest: '1.0.0-rc.161' }),
      spawn: spawnFalso(false),
      scriptPath: '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js',
      realpath: (p) => p,
      aluyDir: dir, // NUNCA o `~/.aluy` real de quem roda a suíte
      aoInstalar,
    });
    expect(
      aoInstalar,
      'anunciar sucesso numa falha seria pior que o silêncio',
    ).not.toHaveBeenCalled();
  });

  it('sem o gancho, nada quebra (é opcional)', async () => {
    await expect(
      runAutoUpdate('1.0.0-rc.158', ambiente(dir), true, {
        fetch: registry({ rc: '1.0.0-rc.161', latest: '1.0.0-rc.161' }),
        spawn: spawnFalso(true),
        scriptPath: '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js',
        realpath: (p) => p,
        aluyDir: dir, // NUNCA o `~/.aluy` real de quem roda a suíte
      }),
    ).resolves.toBeUndefined();
  });
});

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

// ISOLAMENTO OBRIGATÓRIO. `readState`/`writeState` usam `homedir()` do `node:os` — NÃO o
// `env` passado por parâmetro. Sem este dublê, este arquivo LERIA E ESCREVERIA o
// `~/.aluy/auto-update.json` REAL de quem roda a suíte. Já aconteceu dano por isso duas
// vezes em 01/09 (5.617 vetores na memória mem0 do dono; o token de Telegram dele
// sobrescrito por um de teste), e aqui o efeito seria mais sutil: bagunçar o `lastCheck`
// de quem roda, adiando a atualização real dele em silêncio.
// `vi.hoisted`: o `vi.mock` é IÇADO acima das declarações do módulo, então uma const
// comum ainda não existe quando a fábrica roda.
const HOME_FALSO = vi.hoisted(() => ({ valor: '' }));
vi.mock('node:os', async () => {
  const real = await vi.importActual<typeof import('node:os')>('node:os');
  return {
    ...real,
    homedir: () => HOME_FALSO.valor,
    default: { ...real, homedir: () => HOME_FALSO.valor },
  };
});

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
    HOME_FALSO.valor = dir; // o estado do autoupdate vai p/ o tmpdir, nunca p/ o ~ real
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('instalou ⇒ chama `aoInstalar` com a versão nova', async () => {
    const aoInstalar = vi.fn();
    await runAutoUpdate('1.0.0-rc.158', ambiente(dir), true, {
      fetch: registry({ rc: '1.0.0-rc.161', latest: '1.0.0-rc.161' }),
      spawn: spawnFalso(true),
      scriptPath: '/x/lib/node_modules/@hiperplano/aluy-cli/dist-bundle/bin/aluy.js',
      realpath: (p) => p,
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
      }),
    ).resolves.toBeUndefined();
  });
});

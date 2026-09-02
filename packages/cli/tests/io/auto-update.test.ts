// Autoupdate (io/auto-update.ts): decisão de LIGADO/DESLIGADO, detecção de instalação
// por npm vs. repo, o fluxo fim-a-fim `runAutoUpdate` (fetch por dist-tag → decide →
// spawn com timeout → grava estado) e a nota `readAutoUpdateNote` pro rodapé. Tudo
// com fs/rede/child_process MOCKADOS — sem tocar disco, rede ou processo real.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  realpathSync: vi.fn((p: string) => p),
}));

vi.mock('node:os', () => ({
  homedir: () => '/home/fake-user',
}));

import {
  autoUpdateEnabled,
  isNpmGlobalInstall,
  readAutoUpdateNote,
  readAutoUpdateStatus,
  runAutoUpdate,
} from '../../src/io/auto-update.js';

const mockExists = vi.mocked(existsSync);
const mockRead = vi.mocked(readFileSync);
const mockWrite = vi.mocked(writeFileSync);
const mockMkdir = vi.mocked(mkdirSync);

const STATE_PATH = '/home/fake-user/.aluy/auto-update.json';
const NPM_SCRIPT = '/usr/lib/node_modules/@hiperplano/aluy-cli/dist/bin/aluy.js';
const REPO_SCRIPT = '/home/dev/aluy-cli/packages/cli/dist/bin/aluy.js';

// Mapa de dist-tags REAL, medido em 2026-09-01 no registry, quando o dono disse "me
// parece que o autoupdate não funcionou": o topo do canal rc (rc.156) estava sob a tag
// `latest` e a tag `rc` ficara 17 versões para trás.
const DIST_TAGS_REAIS = { rc: '1.0.0-rc.139', latest: '1.0.0-rc.156' };

// Fakes de `spawn`. NENHUM teste deste arquivo pode deixar o `spawn` real escapar: um
// `npm install -g` de verdade trocaria a versão instalada na máquina de quem roda a
// suíte. `spawnProibido` é a rede de segurança — se um caminho que deveria ser inerte
// chamar o spawn, o teste QUEBRA em vez de instalar algo silenciosamente.
function spawnQueSai(code: number) {
  const child = new EventEmitter() as EventEmitter & { kill: () => void };
  child.kill = vi.fn();
  return vi.fn(() => {
    queueMicrotask(() => child.emit('exit', code));
    return child as never;
  });
}

const spawnProibido = vi.fn(() => {
  throw new Error('spawn REAL barrado: nenhum teste pode rodar `npm install -g` de verdade');
});

const mockFetch = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('autoUpdateEnabled — precedência kill-switch > ALUY_AUTO_UPDATE > config > default ON', () => {
  it.each([
    ['ALUY_NO_UPDATE_CHECK', '1'],
    ['NO_UPDATE_NOTIFIER', '1'],
    ['CI', 'true'],
  ])('%s=%s desliga MESMO com config/env pedindo ligado', (key, value) => {
    expect(autoUpdateEnabled({ [key]: value, ALUY_AUTO_UPDATE: '1' }, true)).toBe(false);
  });

  it('ALUY_AUTO_UPDATE=0 desliga mesmo com config true', () => {
    expect(autoUpdateEnabled({ ALUY_AUTO_UPDATE: '0' }, true)).toBe(false);
  });

  it('ALUY_AUTO_UPDATE=1 liga mesmo com config false', () => {
    expect(autoUpdateEnabled({ ALUY_AUTO_UPDATE: '1' }, false)).toBe(true);
  });

  it('sem env algum: config decide', () => {
    expect(autoUpdateEnabled({}, false)).toBe(false);
    expect(autoUpdateEnabled({}, true)).toBe(true);
  });

  it('sem env e sem config (undefined): default LIGADO (decisão do dono)', () => {
    expect(autoUpdateEnabled({}, undefined)).toBe(true);
  });
});

describe('isNpmGlobalInstall — repo NUNCA tenta instalar', () => {
  it('caminho dentro de node_modules/@hiperplano/aluy-cli/ ⇒ true', () => {
    expect(isNpmGlobalInstall(NPM_SCRIPT, (p) => p)).toBe(true);
  });

  it('caminho de checkout do repo (sem node_modules do pacote) ⇒ false', () => {
    expect(isNpmGlobalInstall(REPO_SCRIPT, (p) => p)).toBe(false);
  });

  it('sem scriptPath ⇒ false (postura conservadora)', () => {
    expect(isNpmGlobalInstall(undefined, (p) => p)).toBe(false);
  });

  it('realpath lança (symlink quebrado) ⇒ false, não propaga', () => {
    const realpath = vi.fn(() => {
      throw new Error('ENOENT');
    });
    expect(isNpmGlobalInstall(NPM_SCRIPT, realpath)).toBe(false);
  });
});

describe('readAutoUpdateNote', () => {
  it('kill-switch ligado ⇒ undefined, sem tocar o fs', () => {
    expect(readAutoUpdateNote('1.0.0-rc.137', { CI: 'true' })).toBeUndefined();
    expect(mockExists).not.toHaveBeenCalled();
  });

  it('sem estado (nunca instalou) ⇒ undefined', () => {
    mockExists.mockReturnValue(false);
    expect(readAutoUpdateNote('1.0.0-rc.137', {})).toBeUndefined();
  });

  it('estado corrompido ⇒ undefined, sem lançar', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue('{not json');
    expect(readAutoUpdateNote('1.0.0-rc.137', {})).toBeUndefined();
  });

  it('versão em disco é a MESMA que já está rodando ⇒ undefined (nada a avisar)', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: Date.now(), installedOnDisk: '1.0.0-rc.137' }),
    );
    expect(readAutoUpdateNote('1.0.0-rc.137', {})).toBeUndefined();
  });

  it('versão em disco é MAIS NOVA que a rodando ⇒ nota de reinício', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: Date.now(), installedOnDisk: '1.0.0-rc.138' }),
    );
    const note = readAutoUpdateNote('1.0.0-rc.137', {});
    expect(note).toContain('1.0.0-rc.138');
    expect(note).toContain('1.0.0-rc.137');
    expect(note?.toLowerCase()).toContain('reinicie');
  });
});

describe('runAutoUpdate — orquestração fim-a-fim (fetch por dist-tag → decide → spawn → grava)', () => {
  it('desligado (config false, sem env) ⇒ nem olha instalação, nem faz fetch', async () => {
    await runAutoUpdate('1.0.0-rc.137', {}, false, { fetch: mockFetch });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockExists).not.toHaveBeenCalled();
  });

  it('rodando do repo ⇒ nunca faz fetch nem spawn (guarda de instalação vem ANTES da rede)', async () => {
    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: REPO_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('estado ainda FRESCO (< 1 dia) ⇒ não faz fetch', async () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(JSON.stringify({ lastCheck: Date.now() }));
    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  // ATUALIZADO na investigação do "me parece que o autoupdate não funcionou" (rc.159).
  // Estes dois testes exigiam uma URL POR CANAL (`/<pkg>/rc` p/ um rc, `/<pkg>/latest`
  // p/ uma estável) — e era exatamente essa premissa que estava errada: no registry, no
  // dia, o topo do canal rc morava na tag `latest` (`{rc:'1.0.0-rc.139',
  // latest:'1.0.0-rc.156'}`), então perguntar pela tag de NOME `rc` devolvia uma versão
  // mais VELHA que a instalada e o autoupdate nunca fazia nada. A consulta passou a ser
  // o MAPA de dist-tags, uma só, igual p/ qualquer canal; a segurança de canal continua
  // testada (e mais forte) nos testes de GUARDA DE CANAL abaixo, que agora barram a
  // estável mesmo quando ela vem na MESMA resposta que o rc.
  it('consulta o MAPA de dist-tags (uma URL só, independente do canal instalado)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => DIST_TAGS_REAIS });
    // `spawn` SEMPRE injetado: rc.137 + estas tags dá candidato de verdade (rc.156), e
    // sem o fake o teste rodaria um `npm install -g` REAL na máquina de quem testa.
    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnQueSai(0) as never,
    });
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toContain('registry.npmjs.org');
    expect(url).toContain('%2faluy-cli');
    expect(url.endsWith('/dist-tags')).toBe(true);

    mockFetch.mockClear();
    mockExists.mockReturnValue(false);
    await runAutoUpdate('1.0.0', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnProibido as never,
    });
    const [urlEstavel] = mockFetch.mock.calls[0] as [string];
    expect(urlEstavel).toBe(url); // mesma consulta; quem separa canal é a decisão pura
  });

  it('candidato MAIS NOVO no MESMO canal ⇒ spawna `npm install -g` e grava a versão instalada', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.138' }) });

    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0));
      return child as never;
    });

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@hiperplano/aluy-cli@1.0.0-rc.138'],
      expect.objectContaining({ stdio: 'ignore' }),
    );
    expect(mockMkdir).toHaveBeenCalledWith('/home/fake-user/.aluy', { recursive: true });
    const [path, body] = mockWrite.mock.calls[0] as [string, string];
    expect(path).toBe(STATE_PATH);
    expect(JSON.parse(body)).toMatchObject({ installedOnDisk: '1.0.0-rc.138' });
  });

  it('GUARDA DE CANAL: rc instalado, "latest" (estável) publicado ⇒ NÃO spawna (shouldAutoUpdate barra)', async () => {
    // cenário: dist-tag 'rc' do npm por algum motivo aponta pra uma estável — nunca deveria,
    // mas a decisão pura tem que blindar mesmo assim (defesa em profundidade).
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0' }) });
    const spawnImpl = vi.fn();

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('candidato IGUAL ao instalado ⇒ não spawna, mas grava o check (rate-limit vale)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.137' }) });
    const spawnImpl = vi.fn();

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).not.toHaveBeenCalled();
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it('resposta NÃO-ok do registry ⇒ silêncio, NÃO grava o cache (tenta de novo no próximo boot)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: false, json: async () => ({ version: '1.0.0-rc.138' }) });

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
    });

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('fetch lança (offline/timeout) ⇒ silêncio total, nunca propaga, não grava cache', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockRejectedValue(new Error('network down'));

    await expect(
      runAutoUpdate('1.0.0-rc.137', {}, true, {
        scriptPath: NPM_SCRIPT,
        realpath: (p) => p,
        fetch: mockFetch,
      }),
    ).resolves.toBeUndefined();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('npm install falha (exit≠0) ⇒ NÃO grava installedOnDisk, mas grava o lastCheck (rate-limit)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.138' }) });

    const child = new EventEmitter() as EventEmitter & { kill: () => void };
    child.kill = vi.fn();
    const spawnImpl = vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 1));
      return child as never;
    });

    await runAutoUpdate('1.0.0-rc.137', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    const [, body] = mockWrite.mock.calls[0] as [string, string];
    expect(JSON.parse(body)).not.toHaveProperty('installedOnDisk');
  });

  it('spawn lança (ex.: sem npm no PATH, ENOENT síncrono) ⇒ silêncio, não propaga', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ version: '1.0.0-rc.138' }) });
    const spawnImpl = vi.fn(() => {
      throw new Error('ENOENT: npm não encontrado');
    });

    await expect(
      runAutoUpdate('1.0.0-rc.137', {}, true, {
        scriptPath: NPM_SCRIPT,
        realpath: (p) => p,
        fetch: mockFetch,
        spawn: spawnImpl as never,
      }),
    ).resolves.toBeUndefined();
  });
});

// ── Regressão do relato "me parece que o autoupdate não funcionou" (rc.159) ───
// O que o dono viu era real, só que não na máquina dele: com rc.159 instalada
// localmente (acima de tudo que está publicado) o autoupdate corretamente não tinha o
// que fazer. O defeito aparece uma linha abaixo — para QUALQUER instalação vinda do
// npm. O registry tinha `{rc:'1.0.0-rc.139', latest:'1.0.0-rc.156'}` e o módulo
// consultava só a tag de NOME igual ao canal (`rc`), recebendo uma versão 17 releases
// atrasada: quem instalou pelo caminho documentado (`npm i -g`, que entrega o `latest`
// = rc.156) nunca atualizava, e quem estava atrás subia só até rc.139 e congelava.
describe('runAutoUpdate — candidato vem de TODAS as tags promovidas (defeito da rc.159)', () => {
  it('rc.130 instalada + tags reais ⇒ instala rc.156 (o topo do canal), NÃO o rc.139 da tag "rc"', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => DIST_TAGS_REAIS });
    const spawnImpl = spawnQueSai(0);

    await runAutoUpdate('1.0.0-rc.130', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@hiperplano/aluy-cli@1.0.0-rc.156'],
      expect.anything(),
    );
    const [, body] = mockWrite.mock.calls[0] as [string, string];
    expect(JSON.parse(body)).toMatchObject({
      installedOnDisk: '1.0.0-rc.156',
      lastOutcome: 'instalado',
    });
  });

  it('GUARDA DE CANAL na resposta REAL: rc instalado + estável na tag `latest` ⇒ não salta', async () => {
    // Cenário do dia em que sair a 1.0.0 estável: o mapa traz as duas de uma vez. Olhar
    // todas as tags não pode virar "pular de canal" — só o dono troca de canal.
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ rc: '1.0.0-rc.156', latest: '1.0.0' }),
    });

    await runAutoUpdate('1.0.0-rc.156', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnProibido as never,
    });

    expect(spawnProibido).not.toHaveBeenCalled();
  });

  it('A MÁQUINA DO DONO (rc.159 local > rc.156 publicada): nada a instalar, e o estado DIZ isso', async () => {
    // Este é o lado "alarme falso" do relato: com a versão local à frente da publicada,
    // não instalar é o comportamento CERTO. O que faltava era o estado deixar isso
    // legível — antes, "nada a fazer" e "falhou" gravavam o mesmo `lastCheck` mudo.
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => DIST_TAGS_REAIS });

    await runAutoUpdate('1.0.0-rc.159', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnProibido as never,
    });

    expect(spawnProibido).not.toHaveBeenCalled();
    const [path, body] = mockWrite.mock.calls[0] as [string, string];
    expect(path).toBe(STATE_PATH);
    expect(JSON.parse(body)).toMatchObject({
      lastOutcome: 'sem-novidade',
      latestSeen: '1.0.0-rc.156',
    });
  });

  it('resposta sem nenhuma versão utilizável (mapa vazio/lixo) ⇒ não instala nem grava', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await runAutoUpdate('1.0.0-rc.130', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnProibido as never,
    });

    expect(spawnProibido).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe('runAutoUpdate — o `npm install -g` roda a partir do HOME, não do projeto', () => {
  it('spawna com cwd = homedir (um ./.npmrc de projeto não sequestra prefix/registry)', async () => {
    // MEDIDO nesta máquina: num diretório com `.npmrc` contendo `prefix=`/`registry=`,
    // o `npm config get prefix` devolve o do PROJETO — o ./.npmrc tem precedência sobre
    // o ~/.npmrc. O aluy roda dentro do projeto do usuário, então herdar esse cwd faria
    // a instalação GLOBAL ir para o lugar errado (ou para outro registry) e falhar em
    // silêncio. O prefixo real desta instalação (`~/.aluy-npm`) só é lido a partir do HOME.
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ rc: '1.0.0-rc.140' }) });
    const spawnImpl = spawnQueSai(0);

    await runAutoUpdate('1.0.0-rc.139', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnImpl as never,
    });

    expect(spawnImpl).toHaveBeenCalledWith(
      'npm',
      expect.anything(),
      expect.objectContaining({ cwd: '/home/fake-user' }),
    );
  });
});

describe('desfecho do ciclo — "não havia nada" deixa de ser igual a "falhou"', () => {
  it('instalação falha ⇒ grava lastOutcome/failedVersion (o que o dono não tinha como saber)', async () => {
    mockExists.mockReturnValue(false);
    mockFetch.mockResolvedValue({ ok: true, json: async () => DIST_TAGS_REAIS });

    await runAutoUpdate('1.0.0-rc.130', {}, true, {
      scriptPath: NPM_SCRIPT,
      realpath: (p) => p,
      fetch: mockFetch,
      spawn: spawnQueSai(1) as never,
    });

    const [, body] = mockWrite.mock.calls[0] as [string, string];
    expect(JSON.parse(body)).toMatchObject({
      lastOutcome: 'instalacao-falhou',
      failedVersion: '1.0.0-rc.156',
    });
  });

  it('nota do rodapé: falha de INSTALAÇÃO vira aviso acionável, com o comando à mão', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({
        lastCheck: Date.now(),
        lastOutcome: 'instalacao-falhou',
        failedVersion: '1.0.0-rc.156',
      }),
    );
    const note = readAutoUpdateNote('1.0.0-rc.130', {});
    expect(note).toContain('1.0.0-rc.156');
    expect(note).toContain('npm i -g @hiperplano/aluy-cli@1.0.0-rc.156');
  });

  it('nota some quando a versão que falhou já não é mais nova (o dono resolveu à mão)', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({
        lastCheck: Date.now(),
        lastOutcome: 'instalacao-falhou',
        failedVersion: '1.0.0-rc.156',
      }),
    );
    expect(readAutoUpdateNote('1.0.0-rc.159', {})).toBeUndefined();
  });

  it('"sem-novidade" NÃO vira nota — só o acionável fala (rodapé não é log)', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({
        lastCheck: Date.now(),
        lastOutcome: 'sem-novidade',
        latestSeen: '1.0.0-rc.156',
      }),
    );
    expect(readAutoUpdateNote('1.0.0-rc.159', {})).toBeUndefined();
  });

  it('readAutoUpdateStatus expõe o desfecho p/ diagnóstico; sem arquivo ⇒ null', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: 42, lastOutcome: 'sem-novidade', latestSeen: '1.0.0-rc.156' }),
    );
    expect(readAutoUpdateStatus()).toMatchObject({
      lastCheck: 42,
      lastOutcome: 'sem-novidade',
      latestSeen: '1.0.0-rc.156',
    });

    mockExists.mockReturnValue(false);
    expect(readAutoUpdateStatus()).toBeNull();
  });

  it('desfecho DESCONHECIDO no estado (escrito por versão futura) ⇒ ignorado, sem nota', () => {
    mockExists.mockReturnValue(true);
    mockRead.mockReturnValue(
      JSON.stringify({ lastCheck: 1, lastOutcome: 'coisa-que-nao-existe', failedVersion: '9.9.9' }),
    );
    expect(readAutoUpdateNote('1.0.0-rc.130', {})).toBeUndefined();
    expect(readAutoUpdateStatus()?.lastOutcome).toBeUndefined();
  });
});

// ADR-0158 §6 — daemons.ts: fecha sobreviventes/lacunas de cobertura de MUTAÇÃO
// achados numa auditoria (ver relatório) que `daemons.test.ts`/`daemons-cleanup.test.ts`
// não alcançavam — usam SEMPRE processos REAIS (`sleep`/`pwd`), nunca mock (arquivo
// SEPARADO dos existentes — não editamos teste alheio, só ESTENDEMOS a cobertura):
//   · `listDeclaredDaemons`: ordem ALFABÉTICA (o `.sort` importa), `daemon.md`
//     ilegível (diretório sem o arquivo), `daemonMdExists` (sem NENHUM teste antes).
//   · `startDaemons`: pidfile ÓRFÃO (pid morto) é RESTARTADO, não pulado; as opções
//     REAIS de `spawn` (cwd/stdio) importam de verdade; a porta só entra no log
//     quando DECLARADA.
//   · `stopDaemons`: só toca arquivos `*.pid` (nunca `*.log`); o NOME logado nunca
//     carrega o sufixo `.pid`; um pidfile com conteúdo NÃO-NUMÉRICO nunca vira
//     "pidfile órfão" (são dois motivos DIFERENTES de descarte); o fallback do
//     kill de GRUPO pro kill DIRETO (comentário "Windows não tem grupo POSIX")
//     também é alcançável no POSIX real, com um processo cujo pid NÃO é líder de
//     grupo (não-detached) — `kill(-pid)` falha por ESRCH, cai pro `kill(pid)` direto.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  listDeclaredDaemons,
  startDaemons,
  stopDaemons,
  daemonMdExists,
} from '../../src/service/daemons.js';
import { readPidFile, isProcessAlive } from '../../src/service/pid.js';
import { daemonPidPath, daemonLogPath, serviceStateDir } from '../../src/service/paths.js';

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('listDeclaredDaemons — ordem alfabética e daemon.md ilegível', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-list-'));
    logs.length = 0;
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('múltiplos daemons ⇒ devolvidos em ordem ALFABÉTICA (não a ordem "natural" do readdir)', () => {
    for (const name of ['zulu', 'mike', 'alpha']) {
      const dir = join(serviceDir, 'daemons', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'daemon.md'), '---\ncommand: sleep 1\n---\n');
    }
    const names = listDeclaredDaemons(serviceDir, log).map((d) => d.name);
    expect(names).toEqual(['alpha', 'mike', 'zulu']);
  });

  it('diretório de daemon SEM daemon.md (ilegível) ⇒ catch loga "sem daemon.md legível", ignorado', () => {
    mkdirSync(join(serviceDir, 'daemons', 'incompleto'), { recursive: true });
    // propositalmente SEM escrever daemon.md — readFileSync lança ENOENT.
    const list = listDeclaredDaemons(serviceDir, log);
    expect(list).toHaveLength(0);
    expect(logs.some((l) => l.includes('sem daemon.md legível'))).toBe(true);
    expect(logs.some((l) => l.includes('incompleto'))).toBe(true);
  });
});

describe('daemonMdExists — sem NENHUM teste antes desta auditoria', () => {
  let serviceDir: string;
  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-mdexists-'));
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('daemon.md existe ⇒ true', () => {
    mkdirSync(join(serviceDir, 'daemons', 'guard'), { recursive: true });
    writeFileSync(join(serviceDir, 'daemons', 'guard', 'daemon.md'), '---\ncommand: sleep 1\n---\n');
    expect(daemonMdExists(serviceDir, 'guard')).toBe(true);
  });

  it('daemon.md ausente (diretório nem existe) ⇒ false', () => {
    expect(daemonMdExists(serviceDir, 'fantasma')).toBe(false);
  });

  it('diretório do daemon existe mas SEM daemon.md ⇒ false', () => {
    mkdirSync(join(serviceDir, 'daemons', 'vazio'), { recursive: true });
    expect(daemonMdExists(serviceDir, 'vazio')).toBe(false);
  });
});

describe('startDaemons — pidfile ÓRFÃO (stale) é RESTARTADO, não pulado como "já rodando"', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-stale-'));
    logs.length = 0;
  });
  afterEach(() => {
    stopDaemons(serviceDir, () => {});
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('pidfile aponta pra um pid MORTO ⇒ startDaemons IGNORA o "já rodando" e sobe um NOVO processo', async () => {
    const dir = join(serviceDir, 'daemons', 'guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), '---\ncommand: sleep 30\n---\n');
    const pidPath = daemonPidPath(serviceDir, 'guard');
    mkdirSync(serviceStateDir(serviceDir), { recursive: true });
    writeFileSync(pidPath, '999999\n'); // pid quase certamente morto/inexistente.

    startDaemons(serviceDir, log);

    // NUNCA deveria logar "já rodando" pro pid 999999 (ele está morto) — deveria
    // ter subido um processo NOVO, cujo pid REAL substitui o 999999 no pidfile.
    expect(logs.some((l) => l.includes('já rodando'))).toBe(false);
    expect(logs.some((l) => l.includes('subiu'))).toBe(true);
    const newPid = readPidFile(pidPath);
    expect(newPid).toBeDefined();
    expect(newPid).not.toBe(999999);
    expect(isProcessAlive(newPid!)).toBe(true);
  }, 10_000);
});

describe('startDaemons — as opções REAIS de spawn (cwd/stdio) importam de verdade', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-opts-'));
    logs.length = 0;
  });
  afterEach(() => {
    stopDaemons(serviceDir, () => {});
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('cwd do daemon É o diretório dele (não o cwd do processo pai) e stdout vai pro .log dele', async () => {
    const dir = join(serviceDir, 'daemons', 'guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), '---\ncommand: pwd\n---\n');

    startDaemons(serviceDir, log);

    const logPath = daemonLogPath(serviceDir, 'guard');
    const expectedCwd = realpathSync(dir);
    await waitFor(() => {
      const content = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
      return content.trim().length > 0;
    });
    const content = readFileSync(logPath, 'utf8').trim();
    expect(realpathSync(content)).toBe(expectedCwd);
  }, 10_000);

  it('sem "port:" declarado ⇒ log de "subiu" NÃO tem sufixo "porta" nenhum', async () => {
    const dir = join(serviceDir, 'daemons', 'quiet');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), '---\ncommand: sleep 5\n---\n');

    startDaemons(serviceDir, log);

    const pid = readPidFile(daemonPidPath(serviceDir, 'quiet'));
    expect(pid).toBeDefined();
    expect(logs).toContain(`daemon "quiet": subiu (pid ${pid}).`);
    expect(logs.some((l) => l.includes('quiet') && l.includes('porta'))).toBe(false);
  }, 10_000);
});

describe('stopDaemons — só toca arquivos *.pid; o nome logado nunca leva ".pid"; distingue órfão × corrompido', () => {
  let serviceDir: string;
  const logs: string[] = [];
  const log = (l: string): number => logs.push(l);

  beforeEach(() => {
    serviceDir = mkdtempSync(join(tmpdir(), 'aluy-svc-daemon-stop-edge-'));
    logs.length = 0;
  });
  afterEach(() => {
    rmSync(serviceDir, { recursive: true, force: true });
  });

  it('processo VIVO e DETACHED (líder do próprio grupo) ⇒ kill de GRUPO tem sucesso, log EXATO "SIGTERM enviado ao grupo do processo"', async () => {
    const dir = join(serviceDir, 'daemons', 'guard');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'daemon.md'), '---\ncommand: sleep 20\n---\n');
    startDaemons(serviceDir, log);
    const pid = readPidFile(daemonPidPath(serviceDir, 'guard'));
    expect(pid).toBeDefined();
    expect(isProcessAlive(pid!)).toBe(true);
    logs.length = 0; // só nos interessa o log do STOP a partir daqui.

    stopDaemons(serviceDir, log);

    expect(logs).toContain(`daemon "guard": SIGTERM enviado ao grupo do processo (pid ${pid}).`);
    expect(logs.some((l) => l.includes('SIGTERM enviado (pid'))).toBe(false); // NÃO é o fallback direto.

    await waitFor(() => !isProcessAlive(pid!));
  }, 10_000);

  it('um arquivo *.log no mesmo diretório NUNCA é tocado (removido) por stopDaemons', () => {
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'guard.pid'), '999999\n'); // órfão — será removido.
    writeFileSync(join(stateDir, 'guard.log'), 'linha de log preexistente\n');

    stopDaemons(serviceDir, log);

    expect(existsSync(join(stateDir, 'guard.pid'))).toBe(false);
    expect(existsSync(join(stateDir, 'guard.log'))).toBe(true);
    expect(readFileSync(join(stateDir, 'guard.log'), 'utf8')).toBe('linha de log preexistente\n');
  });

  it('o NOME logado no caso órfão é "guard" (sem o sufixo ".pid" do nome de arquivo)', () => {
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'guard.pid'), '999999\n');

    stopDaemons(serviceDir, log);

    expect(logs.some((l) => l.includes('daemon "guard":'))).toBe(true);
    expect(logs.some((l) => l.includes('.pid"'))).toBe(false);
  });

  it('pidfile com conteúdo NÃO-NUMÉRICO ⇒ NUNCA loga "pidfile órfão" (motivo DIFERENTE — conteúdo inválido, não "processo morto")', () => {
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'guard.pid'), 'isto não é um pid\n');

    stopDaemons(serviceDir, log);

    expect(existsSync(join(stateDir, 'guard.pid'))).toBe(false);
    expect(logs.some((l) => l.includes('pidfile órfão'))).toBe(false);
  });

  it('pidfile com pid MORTO (numérico válido) ⇒ ESSE SIM loga "pidfile órfão"', () => {
    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'guard.pid'), '999999\n');

    stopDaemons(serviceDir, log);

    expect(logs.some((l) => l.includes('pidfile órfão'))).toBe(true);
  });

  it('processo VIVO cujo pid NÃO é líder de grupo (não-detached) ⇒ kill(-pid) falha (ESRCH), cai pro kill(pid) DIRETO', async () => {
    // Spawna SEM `detached` — herda o process group do runner de teste, então o
    // pid do filho NUNCA é, ele mesmo, um líder de grupo: `process.kill(-pid, …)`
    // não encontra NENHUM grupo com esse gid ⇒ ESRCH ⇒ cai no catch/fallback
    // (comentário do código: "Windows não tem grupo de processo POSIX" — mas o
    // MESMO fallback também é alcançado no POSIX real por este caminho).
    const child = spawn('sleep', ['20'], { stdio: 'ignore' });
    await new Promise<void>((resolve) => child.on('spawn', () => resolve()));
    const pid = child.pid!;
    expect(isProcessAlive(pid)).toBe(true);

    const stateDir = serviceStateDir(serviceDir);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'guard.pid'), `${pid}\n`);

    stopDaemons(serviceDir, log);

    // o fallback (kill DIRETO, não de grupo) tem sua PRÓPRIA linha de log —
    // distinta da mensagem "enviado ao grupo do processo".
    expect(logs.some((l) => l.includes(`daemon "guard": SIGTERM enviado (pid ${pid}).`))).toBe(true);
    expect(logs.some((l) => l.includes('enviado ao grupo do processo'))).toBe(false);

    await waitFor(() => !isProcessAlive(pid));
    expect(isProcessAlive(pid)).toBe(false);
  }, 10_000);
});

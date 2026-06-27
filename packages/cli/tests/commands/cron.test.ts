// EST-1150 · ADR-0128 — testes para `aluy cron`: parser, persistência (roundtrip),
// e crontab (syncCrontab via runCron com node:child_process mockado).
//
// Cobertura:
//   (1) parseCronCommand: add/list/rm/run, help e erros de uso
//   (2) loadState/saveState roundtrip com tmpdir isolado
//   (3) syncCrontab: PRESERVA crontab existente entre marcadores, monta/atualiza/
//       remove bloco aluy, crontab vazio removido

import { describe, expect, it, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// ── Hoisted: mocks precisam ser definidos em vi.hoisted() para estarem disponíveis
//    quando vi.mock (hoisted) executa sua factory. ─────────────────────────────

const { execFileSyncMock, execSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn(),
  execSyncMock: vi.fn(),
}));

const { testHome } = vi.hoisted(() => {
  // Dentro de vi.hoisted usamos require (CJS) pois o hoisted roda antes da
  // resolução de ESM. Os módulos node:fs, node:os e node:path são builtins
  // disponíveis em ambos.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path');
  return { testHome: fs.mkdtempSync(path.join(os.tmpdir(), 'aluy-cron-test-')) };
});

// ── Mocks de módulo ──────────────────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: execFileSyncMock,
    execSync: execSyncMock,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => testHome,
  };
});

// ── Import do módulo sob teste DEPOIS dos mocks ──────────────────────────────

import {
  parseCronCommand,
  runCron,
  loadState,
  saveState,
  type CronJob,
} from '../../src/commands/cron.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const cronDir = join(testHome, '.aluy', 'cron');
const jobsFile = join(cronDir, 'jobs.json');

/** IO fake: coleta out/err. */
function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) },
    out,
    err,
  };
}

/** Cria jobs.json diretamente no tmpdir com o estado dado. */
function writeState(jobs: CronJob[]): void {
  mkdirSync(cronDir, { recursive: true, mode: 0o700 });
  writeFileSync(jobsFile, JSON.stringify({ jobs }, null, 2), { mode: 0o600 });
}

/** Reseta os mocks do child_process entre testes. */
function resetChildProcessMocks(): void {
  execFileSyncMock.mockReset();
  execSyncMock.mockReset();
}

// ── Helpers para platform ─────────────────────────────────────────────────────

let platformStub: 'linux' | 'darwin' | 'win32' | undefined;

function mockPlatformLinux(): void {
  // Salva e redefine process.platform
  platformStub = process.platform as 'linux' | 'darwin' | 'win32';
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
}

function restorePlatform(): void {
  if (platformStub !== undefined) {
    Object.defineProperty(process, 'platform', { value: platformStub, configurable: true });
    platformStub = undefined;
  }
}

// ── Limpeza global ────────────────────────────────────────────────────────────

afterAll(() => {
  try {
    rmSync(testHome, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// (1) parseCronCommand — parser PURO
// ═══════════════════════════════════════════════════════════════════════════════

describe('parseCronCommand — parser puro', () => {
  it('vazio ou help ⇒ kind:help', () => {
    expect(parseCronCommand([]).kind).toBe('help');
    expect(parseCronCommand(['help']).kind).toBe('help');
    expect(parseCronCommand(['-h']).kind).toBe('help');
    expect(parseCronCommand(['--help']).kind).toBe('help');
  });

  it('list ⇒ kind:list', () => {
    expect(parseCronCommand(['list'])).toEqual({ kind: 'list' });
  });

  // ── add ──

  it('add com quando e tarefa (sem --yolo)', () => {
    const c = parseCronCommand(['add', '0 9 * * 1-5', 'rodar testes']);
    expect(c).toMatchObject({
      kind: 'add',
      quando: '0 9 * * 1-5',
      tarefa: 'rodar testes',
      yolo: false,
    });
  });

  it('add com --yolo', () => {
    const c = parseCronCommand(['add', '*/30 * * * *', 'backup', '--yolo']);
    expect(c).toMatchObject({
      kind: 'add',
      quando: '*/30 * * * *',
      tarefa: 'backup',
      yolo: true,
    });
  });

  it('add com --yolo antes da tarefa', () => {
    const c = parseCronCommand(['add', '0 0 * * 0', '--yolo', 'limpeza']);
    expect(c).toMatchObject({ kind: 'add', quando: '0 0 * * 0', tarefa: 'limpeza', yolo: true });
  });

  it('add sem <quando> ⇒ erro', () => {
    const c = parseCronCommand(['add']);
    expect(c).toMatchObject({ kind: 'error' });
    expect((c as { message: string }).message).toContain('falta o <quando>');
  });

  it('add sem <tarefa> ⇒ erro', () => {
    const c = parseCronCommand(['add', '0 9 * * *']);
    expect(c).toMatchObject({ kind: 'error' });
    expect((c as { message: string }).message).toContain('falta a "<tarefa>"');
  });

  it('add com expressão cron inválida (≠5 campos) ⇒ erro', () => {
    const c = parseCronCommand(['add', '0 9 * *', 'tarefa']);
    expect(c).toMatchObject({ kind: 'error' });
    expect((c as { message: string }).message).toContain('inválido');
    expect((c as { message: string }).message).toContain('5 campos');
  });

  it('add com 6 campos cron ⇒ erro', () => {
    const c = parseCronCommand(['add', '0 9 * * 1-5 2025', 'tarefa']);
    expect(c.kind).toBe('error');
  });

  it('add com expressão cron de 5 campos válida (inclui */step)', () => {
    const c = parseCronCommand(['add', '*/15 8-17 * * 1-5', 'monitor']);
    expect(c).toMatchObject({ kind: 'add', quando: '*/15 8-17 * * 1-5' });
  });

  // ── rm ──

  it('rm com id ⇒ kind:rm', () => {
    expect(parseCronCommand(['rm', 'abc123'])).toEqual({ kind: 'rm', id: 'abc123' });
  });

  it('remove (alias) com id ⇒ kind:rm', () => {
    expect(parseCronCommand(['remove', 'xyz789'])).toEqual({ kind: 'rm', id: 'xyz789' });
  });

  it('rm sem id ⇒ erro', () => {
    const c = parseCronCommand(['rm']);
    expect(c.kind).toBe('error');
    expect((c as { message: string }).message).toContain('falta o <id>');
  });

  // ── run ──

  it('run com id ⇒ kind:run', () => {
    expect(parseCronCommand(['run', 'abc123'])).toEqual({ kind: 'run', id: 'abc123' });
  });

  it('run sem id ⇒ erro', () => {
    const c = parseCronCommand(['run']);
    expect(c.kind).toBe('error');
    expect((c as { message: string }).message).toContain('falta o <id>');
  });

  // ── desconhecido ──

  it('subcomando desconhecido ⇒ erro', () => {
    const c = parseCronCommand(['fizzbuzz']);
    expect(c.kind).toBe('error');
    expect((c as { message: string }).message).toContain('desconhecido');
    expect((c as { message: string }).message).toContain('fizzbuzz');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (2) loadState / saveState — persistência com tmpdir isolado
// ═══════════════════════════════════════════════════════════════════════════════

describe('loadState / saveState — persistência', () => {
  beforeEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
  });

  it('loadState retorna vazio quando não há arquivo', () => {
    const state = loadState();
    expect(state.jobs).toEqual([]);
  });

  it('saveState + loadState roundtrip com 1 job', () => {
    const job: CronJob = {
      id: 'test-id-1',
      schedule: '0 9 * * 1-5',
      task: 'rodar testes',
      criado_em: '2025-01-15T10:00:00.000Z',
      yolo: false,
      workspace: '/home/user/project',
    };
    saveState({ jobs: [job] });
    const state = loadState();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({
      id: 'test-id-1',
      schedule: '0 9 * * 1-5',
      task: 'rodar testes',
      yolo: false,
      workspace: '/home/user/project',
    });
  });

  it('saveState + loadState roundtrip com múltiplos jobs', () => {
    const jobs: CronJob[] = [
      {
        id: 'job-a',
        schedule: '0 9 * * *',
        task: 'daily',
        criado_em: '2025-01-01T00:00:00.000Z',
        yolo: false,
      },
      {
        id: 'job-b',
        schedule: '*/30 * * * *',
        task: 'poll',
        criado_em: '2025-01-02T00:00:00.000Z',
        yolo: true,
        workspace: '/tmp/ws',
      },
    ];
    saveState({ jobs });
    const state = loadState();
    expect(state.jobs).toHaveLength(2);
    expect(state.jobs[0]!.id).toBe('job-a');
    expect(state.jobs[1]!.id).toBe('job-b');
    expect(state.jobs[1]!.yolo).toBe(true);
  });

  it('saveState sobrescreve estado anterior', () => {
    saveState({
      jobs: [{ id: 'first', schedule: '* * * * *', task: 'a', criado_em: '', yolo: false }],
    });
    saveState({
      jobs: [{ id: 'second', schedule: '0 0 * * *', task: 'b', criado_em: '', yolo: true }],
    });
    const state = loadState();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.id).toBe('second');
  });

  it('loadState trata JSON malformado como vazio', () => {
    mkdirSync(cronDir, { recursive: true, mode: 0o700 });
    writeFileSync(jobsFile, 'isto não é json', { mode: 0o600 });
    const state = loadState();
    expect(state.jobs).toEqual([]);
  });

  it('loadState trata jobs não-array como vazio', () => {
    mkdirSync(cronDir, { recursive: true, mode: 0o700 });
    writeFileSync(jobsFile, JSON.stringify({ jobs: 'não é array' }), { mode: 0o600 });
    const state = loadState();
    expect(state.jobs).toEqual([]);
  });

  it('saveState cria o diretório .aluy/cron automaticamente', () => {
    // Garante que o dir não existe
    rmSync(cronDir, { recursive: true, force: true });
    saveState({ jobs: [] });
    const raw = readFileSync(jobsFile, 'utf8');
    expect(JSON.parse(raw)).toEqual({ jobs: [] });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (3) syncCrontab via runCron — node:child_process MOCKADO
// ═══════════════════════════════════════════════════════════════════════════════

describe('syncCrontab (via runCron) — preserva crontab existente', () => {
  beforeEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
    resetChildProcessMocks();
    mockPlatformLinux();
  });

  afterEach(() => {
    restorePlatform();
  });

  // ── Cenário A: crontab vazio → bloco aluy criado ────────────────────────

  it('crontab vazio: monta bloco aluy entre marcadores', async () => {
    // crontab -l retorna erro (crontab vazio)
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        throw new Error('no crontab');
      }
      return '';
    });

    const { io: t, out } = io();
    const code = await runCron(['add', '0 9 * * 1-5', 'rodar testes'], { io: t });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('adicionado');

    // Verifica que o execSync foi chamado com o bloco correto
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    const execSyncCall = execSyncMock.mock.calls[0] as [string, ...unknown[]];
    const inputArg = execSyncCall[1] as { input: string };
    const crontabWritten = inputArg.input;

    // Deve conter os marcadores e a entrada do job
    expect(crontabWritten).toContain('# aluy-cron-jobs');
    expect(crontabWritten).toContain('aluy cron run');
    expect(crontabWritten).toContain('0 9 * * 1-5');

    // Marcadores devem aparecer em pares (abre/fecha)
    const markerCount = (crontabWritten.match(/# aluy-cron-jobs/g) ?? []).length;
    expect(markerCount).toBe(2);

    // O bloco aluy deve estar entre os marcadores
    const lines = crontabWritten.split('\n');
    const blockLines: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      if (line.trim() === '# aluy-cron-jobs') {
        inBlock = !inBlock;
        continue;
      }
      if (inBlock) blockLines.push(line);
    }
    expect(blockLines.length).toBe(1);
    expect(blockLines[0]).toMatch(/^0 9 \* \* 1-5 aluy cron run /);
  });

  // ── Cenário B: crontab com entradas do usuário → preserva + bloco aluy ──

  it('preserva entradas EXISTENTES do usuário e adiciona bloco aluy', async () => {
    const userCrontab = [
      '0 7 * * * /usr/bin/backup.sh',
      '30 8 * * * /usr/local/bin/report.sh',
      '', // linha vazia
    ].join('\n');

    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        return userCrontab;
      }
      return '';
    });

    const { io: t } = io();
    await runCron(['add', '0 9 * * 1-5', 'rodar testes'], { io: t });

    const crontabWritten = (execSyncMock.mock.calls[0]![1] as { input: string }).input;

    // Entradas do usuário PRESERVADAS
    expect(crontabWritten).toContain('0 7 * * * /usr/bin/backup.sh');
    expect(crontabWritten).toContain('30 8 * * * /usr/local/bin/report.sh');

    // Bloco aluy presente
    expect(crontabWritten).toContain('# aluy-cron-jobs');
    expect(crontabWritten).toContain('0 9 * * 1-5 aluy cron run');
  });

  // ── Cenário C: bloco aluy JÁ existente → ATUALIZA, não duplica ──────────

  it('atualiza bloco aluy existente (não duplica marcadores)', async () => {
    // Crontab do usuário com bloco aluy antigo
    const existingCrontab = [
      '0 7 * * * /usr/bin/backup.sh',
      '# aluy-cron-jobs',
      '0 8 * * * aluy cron run old-job-id',
      '# aluy-cron-jobs',
      '# comentário do usuário',
    ].join('\n');

    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        return existingCrontab;
      }
      return '';
    });

    // Escreve estado com um job novo (simula que já havia estado salvo)
    writeState([
      {
        id: 'new-job-id',
        schedule: '0 9 * * 1-5',
        task: 'nova tarefa',
        criado_em: new Date().toISOString(),
        yolo: false,
      },
    ]);

    const { io: t } = io();
    await runCron(['add', '*/15 * * * *', 'segunda tarefa'], { io: t });

    const crontabWritten = (execSyncMock.mock.calls[0]![1] as { input: string }).input;

    // Entrada do usuário PRESERVADA
    expect(crontabWritten).toContain('0 7 * * * /usr/bin/backup.sh');

    // Bloco antigo REMOVIDO
    expect(crontabWritten).not.toContain('old-job-id');

    // Marcadores exatos: 2 (abre e fecha)
    const markerCount = (crontabWritten.match(/# aluy-cron-jobs/g) ?? []).length;
    expect(markerCount).toBe(2);

    // Jobs novos presentes
    expect(crontabWritten).toContain('new-job-id');
    expect(crontabWritten).toContain('*/15 * * * *');
  });

  // ── Cenário D: remove todos os jobs → bloco aluy some, resto fica ────────

  it('remove bloco aluy quando state fica vazio (preserva resto)', async () => {
    const existingCrontab = [
      '0 7 * * * /usr/bin/backup.sh',
      '# aluy-cron-jobs',
      '0 9 * * * aluy cron run job-to-remove',
      '# aluy-cron-jobs',
      '# comentário do usuário',
    ].join('\n');

    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        return existingCrontab;
      }
      return '';
    });

    // Escreve estado com 1 job que será removido
    writeState([
      {
        id: 'job-to-rm',
        schedule: '0 9 * * *',
        task: 'removível',
        criado_em: new Date().toISOString(),
        yolo: false,
      },
    ]);

    const { io: t } = io();
    const code = await runCron(['rm', 'job-to-rm'], { io: t });
    expect(code).toBe(0);

    const crontabWritten = (execSyncMock.mock.calls[0]![1] as { input: string }).input;

    // Entrada do usuário PRESERVADA
    expect(crontabWritten).toContain('0 7 * * * /usr/bin/backup.sh');

    // Bloco aluy REMOVIDO
    expect(crontabWritten).not.toContain('# aluy-cron-jobs');
    expect(crontabWritten).not.toContain('aluy cron run');
    expect(crontabWritten).not.toContain('job-to-rm');
  });

  // ── Cenário E: crontab fica só com aluy removido → crontab -r chamado ──

  it('crontab que fica vazio após remoção do bloco ⇒ executa crontab -r', async () => {
    // Crontab SÓ tem o bloco aluy
    const onlyAluy = [
      '# aluy-cron-jobs',
      '0 9 * * * aluy cron run only-job',
      '# aluy-cron-jobs',
    ].join('\n');

    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        return onlyAluy;
      }
      return '';
    });

    // Escreve estado com 1 job (para o rm funcionar)
    writeState([
      {
        id: 'only-job',
        schedule: '0 9 * * *',
        task: 'único',
        criado_em: new Date().toISOString(),
        yolo: false,
      },
    ]);

    // Remove o único job → state fica vazio → crontab -r
    const { io: t } = io();
    const code = await runCron(['rm', 'only-job'], { io: t });
    expect(code).toBe(0);

    // Deve ter chamado execFileSync com crontab -r (remove crontab)
    const rmCalled = execFileSyncMock.mock.calls.some(
      (call: unknown[]) =>
        call[0] === 'crontab' && Array.isArray(call[1]) && (call[1] as string[])[0] === '-r',
    );
    expect(rmCalled).toBe(true);
  });

  // ── Cenário F: crontab corrompido (marcador ímpar) → trata graciosamente ─

  it('crontab com marcador ímpar (aberto sem fechar) ⇒ trata o resto como fora do bloco', async () => {
    const corruptedCrontab = [
      '0 7 * * * /usr/bin/backup.sh',
      '# aluy-cron-jobs', // abre mas nunca fecha
      '0 8 * * * aluy cron run old-job',
      '30 9 * * * outra-coisa', // seria "engolido" pelo bloco aberto
    ].join('\n');

    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        return corruptedCrontab;
      }
      return '';
    });

    writeState([]);

    const { io: t } = io();
    await runCron(['add', '0 10 * * *', 'nova'], { io: t });

    const crontabWritten = (execSyncMock.mock.calls[0]![1] as { input: string }).input;

    // A entrada do usuário ANTES do marcador é preservada
    expect(crontabWritten).toContain('0 7 * * * /usr/bin/backup.sh');

    // O que estava "dentro" do bloco aberto é removido (tratado como parte do bloco)
    expect(crontabWritten).not.toContain('old-job');
    expect(crontabWritten).not.toContain('outra-coisa');

    // Bloco novo presente e bem formado
    const markerCount = (crontabWritten.match(/# aluy-cron-jobs/g) ?? []).length;
    expect(markerCount).toBe(2);
  });

  // ── Cenário G: múltiplos jobs no estado → múltiplas linhas no bloco ─────

  it('múltiplos jobs geram múltiplas entradas no bloco aluy', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') {
        return '0 7 * * * /usr/bin/backup.sh\n';
      }
      return '';
    });

    writeState([
      { id: 'j1', schedule: '0 9 * * *', task: 't1', criado_em: '', yolo: false },
      { id: 'j2', schedule: '*/30 * * * *', task: 't2', criado_em: '', yolo: true },
      { id: 'j3', schedule: '0 0 * * 0', task: 't3', criado_em: '', yolo: false },
    ]);

    const { io: t } = io();
    await runCron(['add', '0 12 * * *', 't4'], { io: t });

    const crontabWritten = (execSyncMock.mock.calls[0]![1] as { input: string }).input;

    // Todas as 3 entradas do estado
    expect(crontabWritten).toContain('j1');
    expect(crontabWritten).toContain('j2');
    expect(crontabWritten).toContain('j3');

    // Conta as linhas de job entre os marcadores
    const lines = crontabWritten.split('\n');
    const jobLines: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      if (line.trim() === '# aluy-cron-jobs') {
        inBlock = !inBlock;
        continue;
      }
      if (inBlock && line.trim() !== '') jobLines.push(line);
    }
    // 3 do estado + 1 nova = 4
    expect(jobLines.length).toBe(4);
  });

  // ── Cenário H: job com schedule complexo é preservado literalmente ───────

  it('schedule com intervalos complexos é preservado no crontab', async () => {
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'crontab' && args[0] === '-l') return '';
      return '';
    });

    const { io: t } = io();
    await runCron(['add', '*/15 8-17,20-22 * * 1-5', 'horário comercial'], { io: t });

    const crontabWritten = (execSyncMock.mock.calls[0]![1] as { input: string }).input;
    expect(crontabWritten).toContain('*/15 8-17,20-22 * * 1-5');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// (4) runCron — comandos de alta ordem (list, rm, run)
// ═══════════════════════════════════════════════════════════════════════════════

describe('runCron — comandos list/rm/run', () => {
  beforeEach(() => {
    rmSync(cronDir, { recursive: true, force: true });
    resetChildProcessMocks();
    // Plataforma NÃO-linux p/ não disparar syncCrontab (testa só a lógica interna)
    platformStub = process.platform as 'linux' | 'darwin' | 'win32';
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  });

  afterEach(() => {
    restorePlatform();
  });

  // ── list ──

  it('list sem jobs ⇒ orienta o add', async () => {
    const { io: t, out } = io();
    const code = await runCron(['list'], { io: t });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Nenhum job');
    expect(out.join('\n')).toContain('aluy cron add');
  });

  it('list com jobs ⇒ mostra id, schedule, yolo e tarefa', async () => {
    writeState([
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        schedule: '0 9 * * 1-5',
        task: 'rodar testes',
        criado_em: new Date().toISOString(),
        yolo: false,
      },
      {
        id: '11111111-2222-3333-4444-555555555555',
        schedule: '*/30 * * * *',
        task: 'poll',
        criado_em: new Date().toISOString(),
        yolo: true,
      },
    ]);

    const { io: t, out } = io();
    const code = await runCron(['list'], { io: t });
    expect(code).toBe(0);

    const text = out.join('\n');
    expect(text).toContain('Jobs agendados (2)');
    // Primeiro job (prefixo de 8 chars do UUID)
    expect(text).toContain('aaaaaaaa');
    expect(text).toContain('0 9 * * 1-5');
    expect(text).toContain('[ask]');
    expect(text).toContain('rodar testes');
    // Segundo job
    expect(text).toContain('11111111');
    expect(text).toContain('*/30 * * * *');
    expect(text).toContain('[yolo]');
    expect(text).toContain('poll');
  });

  // ── rm ──

  it('rm remove job por prefixo do id', async () => {
    writeState([
      {
        id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        schedule: '0 9 * * *',
        task: 't1',
        criado_em: '',
        yolo: false,
      },
      {
        id: 'bbbbbbbb-1111-2222-3333-444444444444',
        schedule: '0 10 * * *',
        task: 't2',
        criado_em: '',
        yolo: false,
      },
    ]);

    const { io: t, out } = io();
    const code = await runCron(['rm', 'aaaaaaaa'], { io: t });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('removido');
    expect(out.join('\n')).toContain('t1');

    // Estado atualizado
    const state = loadState();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.id).toBe('bbbbbbbb-1111-2222-3333-444444444444');
  });

  it('rm job inexistente ⇒ erro', async () => {
    writeState([]);
    const { io: t, err } = io();
    const code = await runCron(['rm', 'naoexiste'], { io: t });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('não encontrado');
  });

  // ── run (com mock de execSync p/ não rodar de verdade) ──

  it('run job existente ⇒ chama aluy -p com a tarefa', async () => {
    mockPlatformLinux();
    writeState([
      {
        id: 'cccccccc-dddd-eeee-ffff-000000000000',
        schedule: '0 9 * * *',
        task: 'minha tarefa',
        criado_em: '',
        yolo: false,
      },
    ]);

    execSyncMock.mockReturnValue(''); // sucesso

    const { io: t, out } = io();
    const code = await runCron(['run', 'cccccccc'], { io: t });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Executando');
    expect(out.join('\n')).toContain('minha tarefa');
    expect(out.join('\n')).toContain('Concluído');

    // Verifica que execSync foi chamado com o comando correto
    expect(execSyncMock).toHaveBeenCalled();
    const call = execSyncMock.mock.calls[0] as [string, ...unknown[]];
    expect(call[0]).toContain('aluy -p');
    expect(call[0]).toContain('minha tarefa');
    // Sem --yolo (job não tem)
    expect(call[0]).not.toContain('--yolo');

    restorePlatform();
  });

  it('run job com yolo ⇒ adiciona --yolo ao comando', async () => {
    mockPlatformLinux();
    writeState([
      {
        id: 'dddddddd-eeee-ffff-0000-111111111111',
        schedule: '*/30 * * * *',
        task: 'tarefa yolo',
        criado_em: '',
        yolo: true,
      },
    ]);

    execSyncMock.mockReturnValue('');

    const { io: t } = io();
    await runCron(['run', 'dddddddd'], { io: t });

    const call = execSyncMock.mock.calls[0] as [string, ...unknown[]];
    expect(call[0]).toContain('--yolo');

    restorePlatform();
  });

  it('run job inexistente ⇒ erro', async () => {
    writeState([]);
    const { io: t, err } = io();
    const code = await runCron(['run', 'naoexiste'], { io: t });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('não encontrado');
  });

  it('run job que falha ⇒ retorna exit code do erro', async () => {
    mockPlatformLinux();
    writeState([
      {
        id: 'eeeeeeee-ffff-0000-1111-222222222222',
        schedule: '* * * * *',
        task: 'vai falhar',
        criado_em: '',
        yolo: false,
      },
    ]);

    const error = new Error('comando falhou') as Error & { status?: number };
    error.status = 3;
    execSyncMock.mockImplementation(() => {
      throw error;
    });

    const { io: t, err } = io();
    const code = await runCron(['run', 'eeeeeeee'], { io: t });
    expect(code).toBe(3);
    expect(err.join('\n')).toContain('Falhou');
    expect(err.join('\n')).toContain('exit code: 3');

    restorePlatform();
  });

  // ── help ──

  it('help imprime o texto de ajuda', async () => {
    const { io: t, out } = io();
    const code = await runCron(['help'], { io: t });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('aluy cron');
    expect(out.join('\n')).toContain('Subcomandos');
    expect(out.join('\n')).toContain('add');
    expect(out.join('\n')).toContain('list');
    expect(out.join('\n')).toContain('rm');
    expect(out.join('\n')).toContain('run');
  });

  // ── add em plataforma não-linux ──

  it('add em não-linux salva job mas avisa que não instalou no SO', async () => {
    // plataforma já está como 'darwin' do beforeEach

    const { io: t, out } = io();
    const code = await runCron(['add', '0 9 * * 1-5', 'tarefa mac'], { io: t });
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('adicionado');
    expect(text).toContain('aviso');
    expect(text).toContain('Linux');
    expect(text).toContain('NÃO foi instalado');

    // Estado salvo mesmo assim
    const state = loadState();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.task).toBe('tarefa mac');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// EST-1159 — edit / enable / disable (lifecycle do aluy cron sem excluir)
// ═══════════════════════════════════════════════════════════════════════════════

describe('aluy cron edit/enable/disable (EST-1159)', () => {
  beforeEach(() => resetChildProcessMocks());

  function seed(): void {
    writeState([
      {
        id: 'job-abcdef12',
        schedule: '0 9 * * 1-5',
        task: 'rodar testes',
        criado_em: '2026-01-01T00:00:00.000Z',
        yolo: false,
      },
    ]);
  }

  it('parse: enable/disable <id>; edit com flags; edit vazio/cron inválido ⇒ erro', () => {
    expect(parseCronCommand(['enable', 'abc'])).toEqual({ kind: 'enable', id: 'abc' });
    expect(parseCronCommand(['disable', 'abc'])).toEqual({ kind: 'disable', id: 'abc' });
    expect(parseCronCommand(['enable']).kind).toBe('error');
    expect(parseCronCommand(['edit', 'abc', '--tarefa', 'nova'])).toMatchObject({
      kind: 'edit',
      id: 'abc',
      tarefa: 'nova',
    });
    expect(parseCronCommand(['edit', 'abc']).kind).toBe('error'); // nada a mudar
    expect(parseCronCommand(['edit', 'abc', '--quando', '0 9 * *']).kind).toBe('error'); // cron inválido
  });

  it('disable seta enabled=false (NÃO exclui) e enable volta a true', async () => {
    seed();
    expect(await runCron(['disable', 'job-abc'], { io: io().io })).toBe(0);
    expect(loadState().jobs).toHaveLength(1); // continua salvo
    expect(loadState().jobs[0]!.enabled).toBe(false);
    expect(await runCron(['enable', 'job-abc'], { io: io().io })).toBe(0);
    expect(loadState().jobs[0]!.enabled).toBe(true);
  });

  it('edit muda SÓ os campos passados (preserva id e os demais)', async () => {
    seed();
    expect(
      await runCron(['edit', 'job-abc', '--tarefa', 'novo objetivo', '--yolo'], { io: io().io }),
    ).toBe(0);
    const j = loadState().jobs[0]!;
    expect(j.id).toBe('job-abcdef12'); // id preservado
    expect(j.task).toBe('novo objetivo'); // mudou
    expect(j.schedule).toBe('0 9 * * 1-5'); // inalterado
    expect(j.yolo).toBe(true); // mudou
  });

  it('id inexistente ⇒ exit 1 (enable/disable/edit)', async () => {
    seed();
    expect(await runCron(['disable', 'nope'], { io: io().io })).toBe(1);
    expect(await runCron(['edit', 'nope', '--tarefa', 'x'], { io: io().io })).toBe(1);
  });
});

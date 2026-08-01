// ADR-0158 §1/§9 — UserServicesStore: ensureDir + list()/get() com serviço
// válido/malformado/dir-ausente + as validações estruturais (cron, workflow
// existente, nome do dir batendo com o `name:`) + scanServiceDirForInstall.
//
// Cobertura de packages/cli/src/io/services-store.ts:
//   - ensureDir() cria o dir com mode 0700 (best-effort, nunca lança)
//   - list() com service.md VÁLIDO devolve o serviço parseado
//   - list() com service.md MALFORMADO (RES-MD-3) devolve erro, NÃO entra
//   - list() com schedule cron INVÁLIDO ⇒ erro (validateCronExpr)
//   - list() com workflow: apontando p/ arquivo INEXISTENTE ⇒ erro
//   - list() com nome do dir DIVERGENTE do `name:` ⇒ erro
//   - list() com DIR AUSENTE devolve { services: [], errors: [] } (fail-safe)
//   - UM serviço inválido NÃO derruba a listagem dos demais
//   - get() resolve um serviço pelo nome; nomes hostis (path traversal) ⇒ undefined
//   - scanServiceDirForInstall lê daemons/skills-com-script/mcp.json

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UserServicesStore,
  SERVICES_DIRNAME,
  safeServiceDirName,
  scanServiceDirForInstall,
} from '../../src/io/services-store.js';

function writeService(servicesDir: string, dirName: string, serviceMd: string): string {
  const dir = join(servicesDir, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.md'), serviceMd);
  return dir;
}

const MINIMAL = ['---', 'name: trader', '---', 'Rege, não opera.'].join('\n');

describe('UserServicesStore — ensureDir', () => {
  let base: string;
  let servicesDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-'));
    servicesDir = join(base, SERVICES_DIRNAME);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('cria o diretório de serviços quando ausente', () => {
    const store = new UserServicesStore({ baseDir: base });
    expect(existsSync(servicesDir)).toBe(false);
    store.ensureDir();
    expect(existsSync(servicesDir)).toBe(true);
  });

  it('é idempotente — não lança se já existe', () => {
    mkdirSync(servicesDir, { recursive: true });
    const store = new UserServicesStore({ baseDir: base });
    expect(() => store.ensureDir()).not.toThrow();
  });
});

describe('UserServicesStore — list() válido', () => {
  let base: string;
  let servicesDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-'));
    servicesDir = join(base, SERVICES_DIRNAME);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('devolve o serviço parseado com schedule/workflow válidos', () => {
    writeService(
      servicesDir,
      'trader',
      [
        '---',
        'name: trader',
        'schedule: "0 9 * * 1-5"',
        'workflow: turno',
        '---',
        'Rege, não opera.',
      ].join('\n'),
    );
    mkdirSync(join(servicesDir, 'trader', 'workflows'), { recursive: true });
    writeFileSync(
      join(servicesDir, 'trader', 'workflows', 'turno.md'),
      '---\nname: turno\n---\n1. a — goal',
    );

    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(errors).toEqual([]);
    expect(services).toHaveLength(1);
    expect(services[0]!.name).toBe('trader');
    expect(services[0]!.manifest.schedule).toBe('0 9 * * 1-5');
  });

  it('carrega múltiplos serviços ordenados por nome do diretório', () => {
    writeService(servicesDir, 'zebra', ['---', 'name: zebra', '---', 'orq'].join('\n'));
    writeService(servicesDir, 'alfa', ['---', 'name: alfa', '---', 'orq'].join('\n'));
    const { services } = new UserServicesStore({ baseDir: base }).list();
    expect(services.map((s) => s.name)).toEqual(['alfa', 'zebra']);
  });
});

describe('UserServicesStore — list() rejeições', () => {
  let base: string;
  let servicesDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-'));
    servicesDir = join(base, SERVICES_DIRNAME);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('service.md malformado (sem name) ⇒ erro coletado, NÃO entra em services', () => {
    writeService(servicesDir, 'trader', MINIMAL);
    writeService(servicesDir, 'ruim', ['---', 'description: sem nome', '---', 'orq'].join('\n'));
    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(services.map((s) => s.name)).toEqual(['trader']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.dirName).toBe('ruim');
    expect(errors[0]!.reason).toMatch(/sem "name"/);
  });

  it('dir SEM service.md ⇒ erro coletado, listagem dos demais não é derrubada', () => {
    mkdirSync(join(servicesDir, 'vazio'), { recursive: true });
    writeService(servicesDir, 'trader', MINIMAL);
    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(services.map((s) => s.name)).toEqual(['trader']);
    expect(errors.some((e) => e.dirName === 'vazio')).toBe(true);
  });

  it('schedule cron INVÁLIDO ⇒ erro (validateCronExpr), não derruba os demais', () => {
    writeService(servicesDir, 'trader', MINIMAL);
    writeService(
      servicesDir,
      'quebrado',
      ['---', 'name: quebrado', 'schedule: "99 99 * * *"', '---', 'orq'].join('\n'),
    );
    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(services.map((s) => s.name)).toEqual(['trader']);
    const e = errors.find((e) => e.dirName === 'quebrado');
    expect(e).toBeDefined();
    expect(e!.reason).toMatch(/fora da faixa|inválido/);
  });

  it('workflow: apontando p/ arquivo INEXISTENTE ⇒ erro', () => {
    writeService(
      servicesDir,
      'trader',
      ['---', 'name: trader', 'workflow: turno', '---', 'orq'].join('\n'),
    );
    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(services).toEqual([]);
    expect(errors[0]!.reason).toMatch(/workflows\/turno\.md/);
  });

  it('nome do diretório DIVERGENTE do "name:" do frontmatter ⇒ erro', () => {
    writeService(servicesDir, 'outro-nome', MINIMAL);
    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(services).toEqual([]);
    expect(errors[0]!.reason).toMatch(/não bate com "name: trader"/);
  });
});

describe('UserServicesStore — list() dir ausente (fail-safe)', () => {
  it('sem o subdir services ⇒ { services: [], errors: [] } sem lançar', () => {
    const base = mkdtempSync(join(tmpdir(), 'aluy-svc-'));
    const { services, errors } = new UserServicesStore({ baseDir: base }).list();
    expect(services).toEqual([]);
    expect(errors).toEqual([]);
    rmSync(base, { recursive: true, force: true });
  });
});

describe('UserServicesStore — get()', () => {
  let base: string;
  let servicesDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-'));
    servicesDir = join(base, SERVICES_DIRNAME);
    writeService(servicesDir, 'trader', MINIMAL);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('resolve um serviço existente pelo nome', () => {
    const entry = new UserServicesStore({ baseDir: base }).get('trader');
    expect(entry).toBeDefined();
    expect((entry as { name: string }).name).toBe('trader');
  });

  it('nome inexistente ⇒ undefined', () => {
    expect(new UserServicesStore({ baseDir: base }).get('fantasma')).toBeUndefined();
  });

  it('nome hostil (path traversal) ⇒ undefined, nunca escapa o dir confinado', () => {
    expect(new UserServicesStore({ baseDir: base }).get('../../etc')).toBeUndefined();
    expect(new UserServicesStore({ baseDir: base }).get('..')).toBeUndefined();
  });
});

describe('safeServiceDirName', () => {
  it('rejeita path traversal e separadores', () => {
    expect(safeServiceDirName('../x')).toBeUndefined();
    expect(safeServiceDirName('a/b')).toBeUndefined();
    expect(safeServiceDirName('a\\b')).toBeUndefined();
    expect(safeServiceDirName('..')).toBeUndefined();
    expect(safeServiceDirName('.')).toBeUndefined();
    expect(safeServiceDirName('')).toBeUndefined();
  });
  it('aceita nome normal', () => {
    expect(safeServiceDirName('trader')).toBe('trader');
  });
});

describe('scanServiceDirForInstall', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-scan-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('dir sem daemons/skills/mcp.json ⇒ tudo vazio/ausente', () => {
    const scan = scanServiceDirForInstall(base);
    expect(scan.daemons).toEqual([]);
    expect(scan.skills).toEqual([]);
    expect(scan.hasMcp).toBe(false);
  });

  it('lê daemon.md (command/port), skills com/sem script, e mcp.json', () => {
    mkdirSync(join(base, 'daemons', 'mt5-bridge'), { recursive: true });
    writeFileSync(
      join(base, 'daemons', 'mt5-bridge', 'daemon.md'),
      ['---', 'command: python bridge.py', 'port: 9001', '---'].join('\n'),
    );
    mkdirSync(join(base, 'skills', 'mt5-executar'), { recursive: true });
    writeFileSync(join(base, 'skills', 'mt5-executar', 'SKILL.md'), '---\nname: x\n---\ninstr');
    writeFileSync(join(base, 'skills', 'mt5-executar', 'run.py'), 'print(1)');
    mkdirSync(join(base, 'skills', 'so-instrucoes'), { recursive: true });
    writeFileSync(join(base, 'skills', 'so-instrucoes', 'SKILL.md'), '---\nname: y\n---\ninstr');
    writeFileSync(join(base, 'mcp.json'), '{}');

    const scan = scanServiceDirForInstall(base);
    expect(scan.daemons).toEqual([
      { name: 'mt5-bridge', command: 'python bridge.py', port: '9001' },
    ]);
    expect(scan.skills).toContainEqual({ name: 'mt5-executar', hasScript: true });
    expect(scan.skills).toContainEqual({ name: 'so-instrucoes', hasScript: false });
    expect(scan.hasMcp).toBe(true);
  });
});

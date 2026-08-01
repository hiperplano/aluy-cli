// ADR-0158 — testes para `aluy service`: parser (`parseServiceCommand`) + runner
// (`runService`) — list/status/install/uninstall (fase 1, sem runner de verdade).
//
// Cobertura:
//   (1) parseServiceCommand: list/status/install/uninstall, "not-yet" (fase 2),
//       help e erros de uso.
//   (2) runService — list (nota formatada), status (válido/inválido/ausente),
//       install (manifesto visível + confirmação — aceita/recusa/--yes, git-url via
//       gitClone injetado, já-instalado, manifesto inválido REJEITADO antes de
//       mostrar o manifesto visível), uninstall (confirmação, --yes, ausente).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalIO } from '../../src/auth/io.js';
import { UserServicesStore, SERVICES_DIRNAME } from '../../src/io/services-store.js';
import { parseServiceCommand, runService } from '../../src/commands/service.js';

/** IO fake: coleta out/err e devolve respostas de prompt PRÉ-programadas (fila). */
function fakeIO(promptAnswers: readonly string[] = []): TerminalIO & {
  outLines: string[];
  errLines: string[];
} {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const queue = [...promptAnswers];
  return {
    outLines,
    errLines,
    out: (l) => outLines.push(l),
    err: (l) => errLines.push(l),
    prompt: async () => queue.shift() ?? '',
  };
}

describe('parseServiceCommand', () => {
  it('sem subcomando ⇒ list (espelha "/service" sem args)', () => {
    expect(parseServiceCommand([])).toEqual({ kind: 'list' });
  });
  it('"list" explícito ⇒ list', () => {
    expect(parseServiceCommand(['list'])).toEqual({ kind: 'list' });
  });
  it('help/-h/--help ⇒ help', () => {
    expect(parseServiceCommand(['help'])).toEqual({ kind: 'help' });
    expect(parseServiceCommand(['-h'])).toEqual({ kind: 'help' });
    expect(parseServiceCommand(['--help'])).toEqual({ kind: 'help' });
  });
  it('status <nome>', () => {
    expect(parseServiceCommand(['status', 'trader'])).toEqual({ kind: 'status', name: 'trader' });
  });
  it('status sem nome ⇒ erro de uso', () => {
    const r = parseServiceCommand(['status']);
    expect(r.kind).toBe('error');
  });
  it('install <path> [--yes]', () => {
    expect(parseServiceCommand(['install', './trader'])).toEqual({
      kind: 'install',
      source: './trader',
      yes: false,
    });
    expect(parseServiceCommand(['install', './trader', '--yes'])).toEqual({
      kind: 'install',
      source: './trader',
      yes: true,
    });
  });
  it('install sem source ⇒ erro de uso', () => {
    expect(parseServiceCommand(['install']).kind).toBe('error');
  });
  it('uninstall <nome> [--yes]', () => {
    expect(parseServiceCommand(['uninstall', 'trader'])).toEqual({
      kind: 'uninstall',
      name: 'trader',
      yes: false,
    });
    expect(parseServiceCommand(['uninstall', 'trader', '--yes'])).toEqual({
      kind: 'uninstall',
      name: 'trader',
      yes: true,
    });
  });
  it('create/start/stop/logs/update/attach ⇒ not-yet (fase 2)', () => {
    for (const sub of ['create', 'start', 'stop', 'logs', 'update', 'attach']) {
      expect(parseServiceCommand([sub])).toEqual({ kind: 'not-yet', sub });
    }
  });
  it('subcomando desconhecido ⇒ erro', () => {
    expect(parseServiceCommand(['bogus']).kind).toBe('error');
  });
});

const MINIMAL_SERVICE_MD = ['---', 'name: trader', '---', 'Rege, não opera.'].join('\n');

function writeLocalServiceDir(root: string, serviceMd: string = MINIMAL_SERVICE_MD): string {
  const dir = join(root, 'src-trader');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'service.md'), serviceMd);
  return dir;
}

describe('runService — list/status', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-cmd-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('list — dir vazio ⇒ dica de instalação (exit 0)', async () => {
    const io = fakeIO();
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService([], { io, store });
    expect(exit).toBe(0);
    expect(io.outLines.join('\n')).toContain('nenhum serviço instalado');
  });

  it('list — serviço instalado aparece "parado"', async () => {
    const servicesDir = join(base, SERVICES_DIRNAME);
    mkdirSync(join(servicesDir, 'trader'), { recursive: true });
    writeFileSync(join(servicesDir, 'trader', 'service.md'), MINIMAL_SERVICE_MD);
    const io = fakeIO();
    const exit = await runService(['list'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(0);
    expect(io.outLines.join('\n')).toContain('✓ trader');
    expect(io.outLines.join('\n')).toContain('parado');
  });

  it('status — serviço inexistente ⇒ erro (exit 1)', async () => {
    const io = fakeIO();
    const exit = await runService(['status', 'fantasma'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('não encontrado');
  });

  it('status — serviço válido mostra detalhe + validação OK', async () => {
    const servicesDir = join(base, SERVICES_DIRNAME);
    mkdirSync(join(servicesDir, 'trader'), { recursive: true });
    writeFileSync(
      join(servicesDir, 'trader', 'service.md'),
      ['---', 'name: trader', 'autonomy: ask', '---', 'Rege, não opera.'].join('\n'),
    );
    const io = fakeIO();
    const exit = await runService(['status', 'trader'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(0);
    const t = io.outLines.join('\n');
    expect(t).toContain('autonomia:   ask');
    expect(t).toContain('validação:   OK');
  });
});

describe('runService — install (local path)', () => {
  let base: string;
  let workRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-cmd-'));
    workRoot = mkdtempSync(join(tmpdir(), 'aluy-svc-src-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('mostra o MANIFESTO VISÍVEL e instala após confirmação (y)', async () => {
    const src = writeLocalServiceDir(workRoot);
    const io = fakeIO(['y']);
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['install', src], { io, store });
    expect(exit).toBe(0);
    const t = io.outLines.join('\n');
    expect(t).toContain('manifesto visível');
    expect(t).toContain('instalado em');
    expect(existsSync(join(store.servicesDir, 'trader', 'service.md'))).toBe(true);
  });

  it('recusa (n) ⇒ NÃO instala, dir de staging é limpo', async () => {
    const src = writeLocalServiceDir(workRoot);
    const io = fakeIO(['n']);
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['install', src], { io, store });
    expect(exit).toBe(1);
    expect(io.outLines.join('\n')).toContain('cancelada');
    expect(existsSync(join(store.servicesDir, 'trader'))).toBe(false);
  });

  it('--yes pula a confirmação (modo não-interativo)', async () => {
    const src = writeLocalServiceDir(workRoot);
    const io = fakeIO(); // sem respostas — se o runner pedisse prompt, travaria/vazio.
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['install', src, '--yes'], { io, store });
    expect(exit).toBe(0);
    expect(existsSync(join(store.servicesDir, 'trader', 'service.md'))).toBe(true);
  });

  it('service.md inválido ⇒ REJEITADO antes de mostrar o manifesto visível', async () => {
    const src = writeLocalServiceDir(workRoot, '---\ndescription: sem nome\n---\norq');
    const io = fakeIO();
    const exit = await runService(['install', src, '--yes'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toMatch(/sem "name"/);
    expect(io.outLines.join('\n')).not.toContain('manifesto visível');
  });

  it('workflow: apontando p/ arquivo inexistente ⇒ REJEITADO', async () => {
    const src = writeLocalServiceDir(
      workRoot,
      ['---', 'name: trader', 'workflow: turno', '---', 'orq'].join('\n'),
    );
    const io = fakeIO();
    const exit = await runService(['install', src, '--yes'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toMatch(/workflow/);
  });

  it('caminho local inexistente ⇒ erro', async () => {
    const io = fakeIO();
    const exit = await runService(['install', join(workRoot, 'nao-existe'), '--yes'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('não encontrado');
  });

  it('serviço já instalado ⇒ recusa reinstalar por cima', async () => {
    const store = new UserServicesStore({ baseDir: base });
    store.ensureDir();
    mkdirSync(join(store.servicesDir, 'trader'), { recursive: true });
    writeFileSync(join(store.servicesDir, 'trader', 'service.md'), MINIMAL_SERVICE_MD);

    const src = writeLocalServiceDir(workRoot);
    const io = fakeIO();
    const exit = await runService(['install', src, '--yes'], { io, store });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('já existe um serviço');
  });

  it('install via git-url usa o gitClone injetado (não chama o git de verdade)', async () => {
    let clonedUrl: string | undefined;
    let clonedDest: string | undefined;
    const io = fakeIO(['y']);
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['install', 'https://example.com/trader.git'], {
      io,
      store,
      gitClone: (url, dest) => {
        clonedUrl = url;
        clonedDest = dest;
        // Simula o clone: escreve um service.md válido no dest (sem rede/git real).
        mkdirSync(dest, { recursive: true });
        writeFileSync(join(dest, 'service.md'), MINIMAL_SERVICE_MD);
      },
    });
    expect(clonedUrl).toBe('https://example.com/trader.git');
    expect(clonedDest).toBeDefined();
    expect(exit).toBe(0);
    expect(existsSync(join(store.servicesDir, 'trader', 'service.md'))).toBe(true);
  });

  it('git clone falha ⇒ erro legível, nada instalado', async () => {
    const io = fakeIO();
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['install', 'https://example.com/nope.git', '--yes'], {
      io,
      store,
      gitClone: () => {
        throw new Error('boom');
      },
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('falha ao clonar');
  });
});

describe('runService — uninstall', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-cmd-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  function installed(store: UserServicesStore): string {
    store.ensureDir();
    const dir = join(store.servicesDir, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), MINIMAL_SERVICE_MD);
    return dir;
  }

  it('remove após confirmação (y)', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = installed(store);
    const io = fakeIO(['y']);
    const exit = await runService(['uninstall', 'trader'], { io, store });
    expect(exit).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it('recusa (n) ⇒ NÃO remove', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = installed(store);
    const io = fakeIO(['n']);
    const exit = await runService(['uninstall', 'trader'], { io, store });
    expect(exit).toBe(1);
    expect(existsSync(dir)).toBe(true);
  });

  it('--yes pula a confirmação', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = installed(store);
    const io = fakeIO();
    const exit = await runService(['uninstall', 'trader', '--yes'], { io, store });
    expect(exit).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });

  it('serviço inexistente ⇒ erro', async () => {
    const io = fakeIO();
    const exit = await runService(['uninstall', 'fantasma', '--yes'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('não encontrado');
  });
});

describe('runService — not-yet (fase 2)', () => {
  it('start/stop/create/logs/update/attach respondem honesto (exit 1)', async () => {
    const io = fakeIO();
    const exit = await runService(['start', 'trader'], { io });
    expect(exit).toBe(1);
    expect(io.outLines.join('\n')).toContain('fase 2');
  });
});

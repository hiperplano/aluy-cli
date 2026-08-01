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
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalIO } from '../../src/auth/io.js';
import { UserServicesStore, SERVICES_DIRNAME } from '../../src/io/services-store.js';
import { parseServiceCommand, runService } from '../../src/commands/service.js';
import { writePidFile } from '../../src/service/pid.js';
import { runnerPidPath } from '../../src/service/paths.js';
import { startAttachServer, type AttachServer } from '../../src/service/attach-server.js';

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
  it('create/update ⇒ not-yet (fases seguintes)', () => {
    for (const sub of ['create', 'update']) {
      expect(parseServiceCommand([sub])).toEqual({ kind: 'not-yet', sub });
    }
  });
  // ADR-0158 §11 (FASE 4) — attach vira subcomando REAL (deixa de ser "not-yet").
  it('attach <nome>', () => {
    expect(parseServiceCommand(['attach', 'trader'])).toEqual({ kind: 'attach', name: 'trader' });
  });
  it('attach sem nome ⇒ erro de uso', () => {
    expect(parseServiceCommand(['attach']).kind).toBe('error');
  });
  // ADR-0158 §5 (fase 2) — start/stop/logs viram subcomandos REAIS (o runner).
  it('start <nome> [--yes]', () => {
    expect(parseServiceCommand(['start', 'trader'])).toEqual({
      kind: 'start',
      name: 'trader',
      yes: false,
    });
    expect(parseServiceCommand(['start', 'trader', '--yes'])).toEqual({
      kind: 'start',
      name: 'trader',
      yes: true,
    });
  });
  it('start sem nome ⇒ erro de uso', () => {
    expect(parseServiceCommand(['start']).kind).toBe('error');
  });
  it('stop <nome>', () => {
    expect(parseServiceCommand(['stop', 'trader'])).toEqual({ kind: 'stop', name: 'trader' });
  });
  it('stop sem nome ⇒ erro de uso', () => {
    expect(parseServiceCommand(['stop']).kind).toBe('error');
  });
  it('logs <nome> [-f] [-n N]', () => {
    expect(parseServiceCommand(['logs', 'trader'])).toEqual({
      kind: 'logs',
      name: 'trader',
      follow: false,
      lines: 50,
    });
    expect(parseServiceCommand(['logs', 'trader', '-f'])).toEqual({
      kind: 'logs',
      name: 'trader',
      follow: true,
      lines: 50,
    });
    expect(parseServiceCommand(['logs', 'trader', '-n', '10'])).toEqual({
      kind: 'logs',
      name: 'trader',
      follow: false,
      lines: 10,
    });
  });
  it('logs sem nome ⇒ erro de uso', () => {
    expect(parseServiceCommand(['logs']).kind).toBe('error');
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

describe('runService — not-yet (fases seguintes)', () => {
  it('create/update respondem honesto (exit 1)', async () => {
    for (const sub of ['create', 'update']) {
      const io = fakeIO();
      const exit = await runService([sub, 'trader'], { io });
      expect(exit).toBe(1);
      expect(io.outLines.join('\n')).toContain('ainda não existe');
    }
  });
});

// ADR-0158 §5 (fase 2) — start/stop/logs contra um registry ISOLADO (baseDir tmpdir,
// NUNCA o `~/.aluy` real — a mesma trava do smoke manual pedida na missão).
describe('runService — start/stop/logs (fase 2, sem tocar processo real)', () => {
  let base: string;
  let workRoot: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-'));
    workRoot = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-src-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('start: serviço inexistente ⇒ erro', async () => {
    const io = fakeIO();
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['start', 'fantasma', '--yes'], { io, store });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('não encontrado');
  });

  it('start: serviço sem "schedule:" ⇒ recusa (o runner não saberia quando acordar)', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), MINIMAL_SERVICE_MD); // sem schedule:
    const io = fakeIO();
    const exit = await runService(['start', 'trader', '--yes'], { io, store });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('schedule');
  });

  it('stop: serviço já parado ⇒ no-op ok (exit 0)', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), MINIMAL_SERVICE_MD);
    const io = fakeIO();
    const exit = await runService(['stop', 'trader'], { io, store });
    expect(exit).toBe(0);
    expect(io.outLines.join('\n')).toContain('já está parado');
  });

  it('stop: serviço inexistente ⇒ erro', async () => {
    const io = fakeIO();
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['stop', 'fantasma'], { io, store });
    expect(exit).toBe(1);
  });

  it('logs: sem log ainda ⇒ mensagem honesta (exit 0)', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), MINIMAL_SERVICE_MD);
    const io = fakeIO();
    const exit = await runService(['logs', 'trader'], { io, store });
    expect(exit).toBe(0);
    expect(io.outLines.join('\n')).toContain('sem log ainda');
  });

  it('logs: serviço inexistente ⇒ erro', async () => {
    const io = fakeIO();
    const store = new UserServicesStore({ baseDir: base });
    const exit = await runService(['logs', 'fantasma'], { io, store });
    expect(exit).toBe(1);
  });

  it('list/status refletem "parado" quando o serviço nunca rodou', async () => {
    const store = new UserServicesStore({ baseDir: base });
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), ['---', 'name: trader', 'schedule: "0 9 * * *"', '---', 'Rege.'].join('\n'));
    const io = fakeIO();
    const exit = await runService(['status', 'trader'], { io, store });
    expect(exit).toBe(0);
    expect(io.outLines.join('\n')).toContain('PARADO');
  });
});

/** Espera até `cond()` virar `true` ou o timeout estourar (poll de 10ms) — usado p/
 * esperar o cliente do attach terminar de conectar ao socket real ANTES de mandar
 * eventos (a conexão é assíncrona; sem isto o teste seria dependente de sorte). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ADR-0158 §11 (FASE 4) — `attach`: contra um socket REAL (`startAttachServer`, o
// MESMO módulo que o runner usa) num serviço "RODANDO" fabricado (pidfile apontando
// pro PRÓPRIO processo de teste — sempre vivo). `attachStdin` é um `PassThrough`
// controlado pelo teste (linha ⇒ `say`; `.end()` ⇒ EOF ⇒ detach, mesma disciplina
// de qualquer client interativo). Sem TTY real — exatamente o caminho testável
// documentado em `runAttach` (ver o comentário no `commands/service.ts`).
describe('runService — attach (fase 4, ADR-0158 §11)', () => {
  let base: string;
  let dir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-attach-'));
    dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), MINIMAL_SERVICE_MD);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('serviço inexistente ⇒ erro (exit 1)', async () => {
    const io = fakeIO();
    const exit = await runService(['attach', 'fantasma'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
      attachStdin: new PassThrough(),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('não encontrado');
  });

  it('serviço PARADO ⇒ recusa com mensagem clara (não tenta conectar)', async () => {
    const io = fakeIO();
    const exit = await runService(['attach', 'trader'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
      attachStdin: new PassThrough(),
    });
    expect(exit).toBe(1);
    expect(io.errLines.join('\n')).toContain('PARADO');
    expect(io.errLines.join('\n')).toContain('service start');
  });

  it('serviço RODANDO ⇒ vê log/estado ao vivo, "say" chega ao runner, EOF do stdin faz DETACH', async () => {
    // Fabrica "rodando": pidfile apontando pro PRÓPRIO processo de teste (sempre vivo).
    writePidFile(runnerPidPath(dir), process.pid);

    const sayReceived: string[] = [];
    const server: AttachServer = startAttachServer(
      dir,
      { onSay: (text) => sayReceived.push(text) },
      () => {}, // log do SERVIDOR (não é o `io` do teste — silencioso aqui).
    );

    const stdin = new PassThrough();
    const io = fakeIO();
    const donePromise = runService(['attach', 'trader'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
      attachStdin: stdin,
    });

    try {
      // Espera o cliente conectar ANTES de publicar — senão o evento se perde (o
      // servidor não bufferiza p/ quem ainda não chegou, exceto o ÚLTIMO `state`).
      await waitFor(() => server.clientCount() > 0);

      server.broadcastLog('runner iniciado (pid 123).');
      server.broadcastState('running-turn');
      server.broadcastBlock('aluy', 'fechamento do turno ok.');

      await waitFor(() => io.outLines.some((l) => l.includes('runner iniciado')));
      await waitFor(() => io.outLines.some((l) => l.includes('turno em andamento')));
      await waitFor(() => io.outLines.some((l) => l.includes('fechamento do turno ok.')));

      // Digita uma fala — Enter ⇒ vira `say` no socket, entregue ao `onSay` do runner.
      stdin.write('aumenta pra 3 lotes\n');
      await waitFor(() => sayReceived.includes('aumenta pra 3 lotes'));

      // EOF do stdin ⇒ DETACH — NUNCA para o serviço (só fecha o lado do cliente).
      stdin.end();
      const exit = await donePromise;
      expect(exit).toBe(0);
      expect(io.outLines.some((l) => l.includes('— detach — o serviço segue rodando —'))).toBe(true);
    } finally {
      server.close();
    }
  });

  it('servidor fecha a conexão (serviço parou) ⇒ o attach relata e sai (exit 0), sem "detach"', async () => {
    writePidFile(runnerPidPath(dir), process.pid);
    const server: AttachServer = startAttachServer(dir, { onSay: () => {} }, () => {});

    const stdin = new PassThrough();
    const io = fakeIO();
    const donePromise = runService(['attach', 'trader'], {
      io,
      store: new UserServicesStore({ baseDir: base }),
      attachStdin: stdin,
    });

    await waitFor(() => server.clientCount() > 0);
    server.close(); // simula o runner encerrando (shutdown) — derruba a conexão.

    const exit = await donePromise;
    expect(exit).toBe(0);
    // O attach relatou a queda — mas NÃO imprimiu a mensagem de DETACH (quem fechou
    // foi o SERVIDOR, não o dono largando o terminal — mensagens distintas de
    // propósito). A linha inicial de instrução ("Ctrl-C p/ detach") MENCIONA a
    // palavra "detach" de passagem — por isso o teste checa a frase de despedida
    // exata (`— detach — o serviço segue rodando —`), não a substring solta.
    expect(io.outLines.some((l) => l.includes('encerrada'))).toBe(true);
    expect(io.outLines.some((l) => l.includes('— detach — o serviço segue rodando —'))).toBe(false);
    stdin.end();
  });
});

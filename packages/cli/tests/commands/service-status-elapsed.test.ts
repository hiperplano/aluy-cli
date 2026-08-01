// ADR-0158 §5 pt.4 (FASE 3, missão item 4) — "status/list mostram 'aguardando dono
// (pergunta enviada há X)'". Arquivo PRÓPRIO (não edita `service.test.ts` de outra
// fase) — simula um runner "vivo" (pidfile apontando pro PRÓPRIO processo de teste,
// que está genuinamente vivo) com `status.json` em `awaiting-owner`.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TerminalIO } from '../../src/auth/io.js';
import { UserServicesStore, SERVICES_DIRNAME } from '../../src/io/services-store.js';
import { runService } from '../../src/commands/service.js';
import { runnerPidPath } from '../../src/service/paths.js';
import { writePidFile } from '../../src/service/pid.js';
import { writeServiceStatus } from '../../src/service/status.js';

function fakeIO(): TerminalIO & { outLines: string[]; errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return { outLines, errLines, out: (l) => outLines.push(l), err: (l) => errLines.push(l), prompt: async () => '' };
}

describe('status/list — "aguardando dono (pergunta enviada há X)" (ADR-0158 §5 pt.4)', () => {
  let base: string;
  let serviceDir: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-status-elapsed-'));
    serviceDir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, 'service.md'),
      ['---', 'name: trader', 'channel: "telegram:100"', '---', 'Rege, não opera.'].join('\n'),
    );
    // pidfile apontando pro PRÓPRIO processo de teste — genuinamente "vivo" (kill -0 ok).
    writePidFile(runnerPidPath(serviceDir), process.pid);
    writeServiceStatus(serviceDir, {
      turnState: 'awaiting-owner',
      pendingQuestion: 'Aumento a posição em EURUSD?',
    });
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('"status <nome>" mostra a pergunta pendente com "(enviada há Xmin)"', async () => {
    const io = fakeIO();
    const exit = await runService(['status', 'trader'], { io, store: new UserServicesStore({ baseDir: base }) });
    expect(exit).toBe(0);
    const t = io.outLines.join('\n');
    expect(t).toContain('pergunta pendente');
    expect(t).toContain('enviada há 0min'); // acabou de escrever — elapsed ~0.
    expect(t).toContain('Aumento a posição em EURUSD?');
    expect(t).toContain('RODANDO');
    expect(t).toContain('aguardando dono');
  });

  it('"list" mostra "aguardando dono (pergunta enviada há X)"', async () => {
    const io = fakeIO();
    const exit = await runService(['list'], { io, store: new UserServicesStore({ baseDir: base }) });
    expect(exit).toBe(0);
    const t = io.outLines.join('\n');
    expect(t).toContain('aguardando dono');
    expect(t).toContain('pergunta enviada há');
  });
});

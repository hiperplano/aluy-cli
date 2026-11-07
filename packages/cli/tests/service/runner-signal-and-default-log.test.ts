// ADR-0158 §5 — três pontas soltas de `runServiceRunner` que a suíte de integração
// via `externalStop` nunca alcançava (o `externalStop` é injetado exatamente PARA
// não depender de sinal real — mas isso deixa o handler `onSignal` de verdade
// (linhas ~615-617) sem cobertura nenhuma):
//   1. um SIGTERM/SIGINT REAL entregue ao PRÓPRIO processo de teste — como
//      `runServiceRunner` roda IN-PROCESS aqui, `process.on('SIGTERM', onSignal)`
//      É o handler de verdade; mandar o sinal ao `process.pid` do teste dispara
//      exatamente esse caminho (com segurança — Node NÃO usa mais a disposição
//      DEFAULT de terminar assim que HÁ um listener registrado).
//   2. `deps.log` OMITIDO ⇒ cai no caminho DEFAULT (`appendLog(runnerLogPath(...))`,
//      escrevendo um arquivo de verdade em disco) — todo o resto da suíte sempre
//      injeta um `log` de teste (array), então esse fallback nunca rodava.
//   3. um "say" SÓ com espaço em branco entregue pelo socket de attach de verdade
//      ⇒ o handler `onSay` REAL tem que IGNORAR (nunca enfileirar, nunca logar) —
//      só a decisão PURA (`decideSayRouting`) tinha esse caso coberto, nunca o fio
//      que liga o socket ao handler.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runServiceRunner } from '../../src/service/runner.js';
import { runnerLogPath, runnerPidPath, attachSocketPath } from '../../src/service/paths.js';
import { connectAttachSocket } from '../../src/service/attach-client.js';
import { SERVICES_DIRNAME } from '../../src/io/services-store.js';
import {
  FAKE_TURN_ENTRYPOINT,
  writeServiceManifest,
  writeWorkflow,
  newBase,
  removeBase,
  armCronNearMinuteBoundary,
  disarmFakeClock,
  waitFor,
} from './fixtures/workflow-harness.js';

describe('runServiceRunner — SIGTERM REAL entregue ao processo (não o `externalStop` injetado)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-real-sigterm-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('process.kill(process.pid, "SIGTERM") ⇒ o handler onSignal REAL loga e encerra graciosamente (sem matar o processo de teste)', async () => {
    const dir = writeServiceManifest(base); // schedule default, sem workflow — só precisamos passar do boot.
    const logs: string[] = [];

    const sigtermBefore = process.listenerCount('SIGTERM');

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
      // SEM `externalStop` — o ÚNICO jeito de parar aqui é um sinal de verdade.
    });

    await waitFor(() => logs.some((l) => l.startsWith('runner iniciado')));
    // Um listener a MAIS que antes (o `onSignal` deste runner) — prova que é o
    // handler de PRODUÇÃO, não um mock substituindo o `process.on` real.
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore + 1);

    process.kill(process.pid, 'SIGTERM');

    await waitFor(() => logs.includes('runner encerrado.'), 10_000);
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith('sinal SIGTERM recebido — encerrando graciosamente'))).toBe(true);
    expect(existsSync(runnerPidPath(dir))).toBe(false);
    expect(process.listenerCount('SIGTERM')).toBe(sigtermBefore); // o shutdown() removeu o listener.
  }, 20_000);
});

describe('runServiceRunner — `deps.log` OMITIDO ⇒ escreve no ARQUIVO de log de verdade (runnerLogPath), não só em memória', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-default-log-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('serviço sem "schedule:" (caminho FATAL rápido, sem precisar de cron) ⇒ o motivo aparece no arquivo em disco', async () => {
    // Escrito à mão (não via `writeServiceManifest`, que sempre inclui um
    // "schedule:") — precisamos do campo AUSENTE de verdade, não vazio.
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), ['---', 'name: trader', '---', 'Rege, não opera.'].join('\n'));
    // NENHUM `deps.log` — o runner tem que cair no `appendLog(runnerLogPath(...))` default.
    const code = await runServiceRunner('trader', {
      aluyBaseDir: base,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
    });

    expect(code).toBe(1);
    const logPath = runnerLogPath(dir);
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('schedule');
    expect(content).toContain('FATAL');
  });
});

describe('runServiceRunner — "say" só com espaço em branco via attach ⇒ IGNORADO de verdade (nunca enfileirado, nunca logado)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-say-ignore-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('"say" em branco durante o sono NÃO produz nenhuma linha de log de attach, e a atividade seguinte não recebe fala nenhuma', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno' });
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK abra o livro.' }]);

    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
    });

    const sockPath = attachSocketPath(dir);
    await waitFor(() => existsSync(sockPath));
    const conn = connectAttachSocket(sockPath, { onLine: () => {}, onClose: () => {} });
    conn.send('   '); // só espaço — `decideSayRouting` trima p/ vazio ⇒ ignore.

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    conn.close();
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('[attach] "say"'))).toBe(false);
    expect(logs.some((l) => l.includes('entregando fala(s) do dono'))).toBe(false);
  }, 20_000);
});

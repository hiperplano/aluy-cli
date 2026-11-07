// ADR-0158 §3/§5 — três degrades de `runActivityTurn` que sobravam sem cobertura
// mesmo depois de `runner-workflow-errors.test.ts`/`runner-activity-deadline-cancel.
// test.ts`:
//   1. `until: "HH:MM"` já VENCIDO quando o turno abre ⇒ a atividade é PULADA
//      (`resolveActivityTimeout` → `hasTime:false`) — regra dura §3 ("fim de
//      expediente não é sugestão"), nunca "roda mesmo assim".
//   2. o `stderr` do processo-filho é de fato CAPTURADO e aparece no log de "saída
//      ilegível" — antes, o fixture nunca escrevia em stderr, então o acumulador
//      (`child.stderr?.on('data', ...)`) nunca rodava e o log sempre caía no
//      fallback "(sem stderr)".
//   3. o PRÓPRIO `spawn` falha (ENOENT — `execPath` apontando pra um caminho que
//      não existe) ⇒ o evento `error` do `ChildProcess` (não o `close`) resolve a
//      promise, e o turno degrada como "saída ilegível" em vez de travar.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner } from '../../src/service/runner.js';
import type { ServiceChannelClient } from '../../src/service/channel.js';
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

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function fakeClient(): ServiceChannelClient & { readonly sent: { chatId: number; text: string }[] } {
  const sent: { chatId: number; text: string }[] = [];
  return {
    sent,
    async send(chatId, text) {
      sent.push({ chatId, text });
      return true;
    },
    async poll() {
      return [];
    },
    safeForLog: (s) => s,
  };
}

/** "HH:MM" de alguns minutos ATRÁS, em relógio REAL (não o fake ancorado pelo
 * harness) — garante `until` já vencido não importa a que hora o teste rode
 * (a não ser bem nos primeiros minutos após meia-noite — mesmo limite honesto
 * que o resto do módulo já assume para cálculo de data/hora local). */
function minutesAgoHHMM(minutes: number): string {
  const d = new Date(Date.now() - minutes * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('runActivityTurn — "until:" já vencido quando o turno abre ⇒ atividade PULADA (regra dura §3)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-until-vencido-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('nenhum processo-filho chega a ser spawnado — "expediente já encerrado (until) — pulada"', async () => {
    const dir = writeServiceManifest(base, {
      workflow: 'turno',
      channel: 'telegram:555',
      until: minutesAgoHHMM(5),
    });
    writeWorkflow(dir, 'turno', [{ id: 'tardedemais', goal: 'FAKE_MODE_OK nunca deveria rodar.' }]);

    const client = fakeClient();
    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
      channelDeps: {
        egressLimiter: new EgressRateLimiter(20, 60_000),
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
      },
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(
      logs.some((l) => l.includes('atividade 1/1 "tardedemais": expediente já encerrado (until) — pulada.')),
    ).toBe(true);
    // NUNCA chegou a iniciar um turno de verdade p/ essa atividade.
    expect(logs.some((l) => l.includes('"tardedemais": iniciando turno'))).toBe(false);
    expect(logs.some((l) => l.startsWith('turno encerrado — parou em 1/1 atividades (limit).'))).toBe(true);
    const report = client.sent.find((m) => m.text.includes('parou em 1/1 atividades (limit).'));
    expect(report).toBeDefined();
    expect(report!.text).not.toContain('ALERTA');
  }, 20_000);
});

describe('runActivityTurn — o stderr do processo-filho é CAPTURADO e aparece no log de saída ilegível', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-stderr-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('FAKE_MODE_GARBAGE (que também escreve em stderr) ⇒ o texto de stderr aparece no log, não o fallback "(sem stderr)"', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    // O fixture escreve em AMBOS stdout (JSON malformado) e stderr quando o goal
    // carrega os dois marcadores — ver `fixtures/fake-turn.mjs`.
    writeWorkflow(dir, 'turno', [
      { id: 'quebra', goal: 'FAKE_MODE_GARBAGE FAKE_WRITE_STDERR tente algo.' },
    ]);

    const client = fakeClient();
    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
      channelDeps: {
        egressLimiter: new EgressRateLimiter(20, 60_000),
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
      },
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    const errLine = logs.find((l) => l.includes('saída ilegível'));
    expect(errLine).toBeDefined();
    expect(errLine).toContain('erro-fake-de-verdade-no-stderr');
    expect(errLine).not.toContain('(sem stderr)');
  }, 20_000);
});

describe('runActivityTurn — o próprio `spawn` falha (ENOENT) ⇒ evento "error" do ChildProcess, nunca trava', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-spawn-error-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('execPath inexistente ⇒ "saída ilegível" (exit null), turno "stopped"/crítico — NUNCA pendura à espera de um "close" que nunca vem', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'unica', goal: 'FAKE_MODE_OK nunca chega a rodar.' }]);

    const client = fakeClient();
    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: '/caminho/que/definitivamente/nao/existe/node-fake',
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
      channelDeps: {
        egressLimiter: new EgressRateLimiter(20, 60_000),
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
      },
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('atividade 1/1 "unica": saída ilegível'))).toBe(true);
    expect(client.sent.some((m) => m.text.includes('ALERTA') && m.text.includes('parou em 1/1'))).toBe(true);
  }, 20_000);
});

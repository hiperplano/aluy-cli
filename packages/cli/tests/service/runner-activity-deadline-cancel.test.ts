// ADR-0158 §5 pt.4 (emenda "activity-timeout") — `runActivityTurn` de ponta a
// ponta MATANDO um processo-filho de verdade: (a) o TETO da atividade (`until:`/
// `activity-timeout:`) vence primeiro ⇒ classificação "deadline"; (b) o `stop` do
// runner (SIGTERM/`aluy service stop`, aqui via `externalStop`) dispara ENQUANTO
// uma atividade está em voo ⇒ classificação "cancelled" — e o runner encerra
// GRACIOSAMENTE (pidfile removido, socket fechado, `runner encerrado.` no log).
// Nenhum teste existente exercitava `killGracefully`/`classifyActivityExit` através
// de um spawn REAL — só a função pura `classifyActivityExit` isolada, com os dois
// argumentos já prontos (nunca um SIGTERM de verdade matando um processo).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner } from '../../src/service/runner.js';
import { runnerPidPath } from '../../src/service/paths.js';
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

describe('runActivityTurn — "activity-timeout:" vence primeiro (a atividade nunca termina sozinha)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-deadline-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('FAKE_MODE_HANG + activity-timeout curto ⇒ "ATINGIU O TETO", outcome "limit", reporte (não alerta — parada neutra)', async () => {
    const dir = writeServiceManifest(base, {
      workflow: 'turno',
      channel: 'telegram:555',
      activityTimeout: '300ms',
    });
    writeWorkflow(dir, 'turno', [{ id: 'trava', goal: 'FAKE_MODE_HANG nunca termina.' }]);

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
    // Teto generoso (bem além dos 300ms do `activity-timeout:` + o `SIGTERM` do
    // `killGracefully`) — a máquina que roda esta suíte pode estar sob contenção
    // pesada de CPU (o próprio ADR-0158 §5 já documenta isso p/ os testes de
    // integração mais lentos, ver `vitest.config.ts`/F66).
    await waitFor(() => logs.some((l) => l.includes('ATINGIU O TETO')), 25_000);
    await waitFor(() => logs.some((l) => l.includes('fim do expediente')), 15_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    // TETO-DISFARÇADO — a linha do teto ficou ACIONÁVEL: diz o TEMPO que estourou e o
    // caminho de correção. O dono viu `saída ilegível (exit 143)` numa atividade que
    // simplesmente passou dos 30 min — texto que o mandava procurar bug no agente.
    const linhaTeto = logs.find((l) => l.includes('atividade 1/1 "trava": ATINGIU O TETO'));
    expect(linhaTeto).toBeDefined();
    expect(linhaTeto).toMatch(/ATINGIU O TETO de \d+s/); // quanto tempo, concretamente.
    expect(linhaTeto).toContain('encerrada pelo runner'); // QUEM matou — não foi o filho.
    expect(linhaTeto).toContain('activity-timeout'); // o que fazer a respeito.
    expect(logs.some((l) => l.startsWith('turno encerrado — parou em 1/1 atividades (limit).'))).toBe(true);
    const report = client.sent.find((m) => m.text.includes('parou em 1/1 atividades (limit).'));
    expect(report).toBeDefined();
    expect(report!.text).not.toContain('ALERTA'); // "limit" é parada NEUTRA — reporte, não alerta.
  }, 40_000);
});

describe('runActivityTurn — `stop` do runner dispara COM uma atividade em voo (nunca um deadline)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-cancel-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('externalStop.abort() durante FAKE_MODE_HANG (sem activity-timeout curto) ⇒ "cancelled", shutdown gracioso completo (pidfile removido)', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'trava', goal: 'FAKE_MODE_HANG nunca termina.' }]);

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
    await waitFor(() => logs.some((l) => l.includes('iniciando turno (') && l.includes('"trava"')), 10_000);
    externalStop.abort(); // SIGTERM simulado — enquanto a atividade ainda roda.

    await waitFor(() => logs.includes('runner encerrado.'), 10_000);
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('atividade 1/1 "trava": interrompida (stop do runner).'))).toBe(true);
    // NUNCA classificado como "deadline" — `stopAborted` tem prioridade (mesmo
    // motivo — o SIGTERM — poderia ter vindo de qualquer um dos dois).
    expect(logs.some((l) => l.includes('ATINGIU O TETO'))).toBe(false);
    expect(logs.some((l) => l.startsWith('turno encerrado — parou em 1/1 atividades (cancelled).'))).toBe(true);
    // limpeza de recursos completa: pidfile removido MESMO num shutdown no meio de
    // uma atividade (não só nos caminhos fatais/sem-canal já cobertos alhures).
    expect(existsSync(runnerPidPath(dir))).toBe(false);
  }, 20_000);
});

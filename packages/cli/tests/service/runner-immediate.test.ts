// ADR-0158 — `immediate: true`: fura a regra dura "fora do horário, o serviço
// nem acorda" (§5 pt.2) só na PRIMEIRA volta do laço principal — um turno roda
// JÁ no `start`, ANTES do primeiro ciclo de cron. Bateria:
//   (a) `canRunImmediateNow` — PURA, decide respeitando `until:`;
//   (b) COM `immediate: true`: o log "turno IMEDIATO" aparece ANTES de qualquer
//       "dormindo até" — prova de que o turno roda antes do primeiro sleep;
//   (c) SEM `immediate` (ausente/false): fluxo IDÊNTICO ao de hoje — "dormindo
//       até" é a PRIMEIRA linha relevante, nunca "turno IMEDIATO";
//   (d) `immediate: true` + `until:` já vencido ⇒ o imediato é PULADO (loga o
//       motivo) e cai no ciclo normal de cron — decisão de projeto: `until:`
//       vence a conveniência de rodar já;
//   (e) só a PRIMEIRA volta: com um `schedule` de granularidade de minuto, o
//       SEGUNDO ciclo de cron (que a suíte deixa completar) NUNCA repete o log
//       "turno IMEDIATO" — só a primeira volta do laço é elegível.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner, canRunImmediateNow } from '../../src/service/runner.js';
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

function fakeClient(): ServiceChannelClient {
  return {
    async send() {
      return true;
    },
    async poll() {
      return [];
    },
    safeForLog: (s) => s,
  };
}

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

describe('canRunImmediateNow — PURA', () => {
  it('sem "until:" declarado ⇒ sempre pode (undefined = sem teto de expediente)', () => {
    expect(canRunImmediateNow(new Date('2026-08-05T10:00:00'), undefined)).toBe(true);
  });

  it('"until:" ainda no futuro (hoje) ⇒ pode', () => {
    const now = new Date('2026-08-05T10:00:00');
    expect(canRunImmediateNow(now, '17:30')).toBe(true);
  });

  it('"until:" já vencido hoje ⇒ NÃO pode — a regra de expediente vence a conveniência', () => {
    const now = new Date('2026-08-05T18:00:00');
    expect(canRunImmediateNow(now, '17:30')).toBe(false);
  });

  it('"until:" no exato instante de agora (0ms restante) ⇒ NÃO pode (zero não é "ainda dá tempo")', () => {
    const now = new Date('2026-08-05T17:30:00');
    expect(canRunImmediateNow(now, '17:30')).toBe(false);
  });
});

describe('runServiceRunner — immediate: true (integração, processo-filho REAL via fixture)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-immediate-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('COM immediate: true — o turno roda ANTES do primeiro "dormindo até" (e só na 1ª volta)', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:1', immediate: true });
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK primeira atividade.' }]);

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

    // (b) o turno IMEDIATO abre e conclui SEM nunca logar "dormindo até" antes dele.
    await waitFor(() => logs.some((l) => l.startsWith('turno encerrado')));
    const idxImediato = logs.findIndex((l) => l.includes('"immediate: true" declarado — turno IMEDIATO'));
    const idxDormindo1 = logs.findIndex((l) => l.startsWith('dormindo até'));
    expect(idxImediato).toBeGreaterThanOrEqual(0);
    expect(idxDormindo1).toBeGreaterThanOrEqual(0);
    expect(idxImediato).toBeLessThan(idxDormindo1);
    expect(logs).toContain('atividade 1/1 "abrir": ok.');

    // (e) deixa o SEGUNDO ciclo de cron completar (schedule default "* * * * *" —
    // a próxima volta do laço computa "next" a partir de "agora", logo após o
    // imediato ter terminado — ainda perto da virada de minuto ancorada acima,
    // então o 2º disparo chega em frações de segundo, sem esperar 1 minuto real).
    await waitFor(() => logs.filter((l) => l.startsWith('turno encerrado')).length >= 2, 10_000);
    externalStop.abort();
    const code = await promise;
    expect(code).toBe(0);

    // "turno IMEDIATO" aparece EXATAMENTE UMA VEZ — mesmo com um 2º ciclo de cron
    // completo já decorrido, o `immediate` nunca reaparece.
    const imediatoCount = logs.filter((l) => l.includes('turno IMEDIATO')).length;
    expect(imediatoCount).toBe(1);
    // e o 2º "dormindo até" (entre o 1º e o 2º turno) prova o ciclo normal correndo.
    const dormindoCount = logs.filter((l) => l.startsWith('dormindo até')).length;
    expect(dormindoCount).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it('SEM "immediate:" (ausente) — fluxo IDÊNTICO ao de hoje: "dormindo até" é a 1ª linha, nunca "turno IMEDIATO"', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:1' });
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK primeira atividade.' }]);

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

    await waitFor(() => logs.some((l) => l.startsWith('turno encerrado')));
    externalStop.abort();
    const code = await promise;
    expect(code).toBe(0);

    expect(logs.some((l) => l.includes('turno IMEDIATO'))).toBe(false);
    // a PRIMEIRA linha de interesse do laço é "dormindo até" — argv/fluxo idêntico ao de hoje.
    const firstRelevant = logs.find((l) => l.startsWith('dormindo até') || l.includes('turno IMEDIATO'));
    expect(firstRelevant).toMatch(/^dormindo até/);
  }, 20_000);

  it('immediate: true + until: já vencido ⇒ o imediato é PULADO (until vence a conveniência) e cai no ciclo normal', async () => {
    // `until: "00:00"` — a essa hora da madrugada, `msUntilDeadline` já é <= 0
    // pra qualquer horário do dia corrente ancorado pelo `armCronNearMinuteBoundary`
    // (o relógio fake fica perto da virada do MINUTO, não da meia-noite — então
    // "00:00" hoje já passou, exceto no raro caso de rodar exatamente à meia-noite;
    // ancoramos explicitamente às 10:00 pra eliminar esse flake).
    const dir = writeServiceManifest(base, {
      workflow: 'turno',
      channel: 'telegram:1',
      immediate: true,
      until: '09:00',
    });
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK primeira atividade.' }]);

    const client = fakeClient();
    const logs: string[] = [];
    const externalStop = new AbortController();

    // Ancora o relógio fake às 10:00:59.5 de hoje — "until: 09:00" já passou.
    const { vi } = await import('vitest');
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const now = new Date();
    now.setHours(10, 0, 59, 500);
    vi.setSystemTime(now);

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

    await waitFor(() => logs.some((l) => l.includes('expediente')));
    expect(logs.some((l) => l.includes('turno imediato pulado'))).toBe(true);
    expect(logs.some((l) => l.includes('turno IMEDIATO'))).toBe(false);

    // cai no ciclo normal — chega a dormir até o próximo schedule.
    await waitFor(() => logs.some((l) => l.startsWith('dormindo até')));
    externalStop.abort();
    const code = await promise;
    expect(code).toBe(0);
  }, 20_000);
});

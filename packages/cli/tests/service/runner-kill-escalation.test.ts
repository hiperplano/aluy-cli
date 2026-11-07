// ADR-0158 §5 — `killGracefully`: SIGTERM primeiro, e SÓ escala p/ SIGKILL depois
// de `GRACE_KILL_MS` (8s) SE o processo ainda estiver vivo — a metade da função
// que NENHUM teste (nem os de `runner-activity-turn.test.ts`, que só cobrem as
// funções PURAS extraídas) jamais exercitou de verdade: todo cenário anterior de
// "matar o filho" usava um processo que morre ao primeiro SIGTERM (comportamento
// DEFAULT do Node sem handler instalado). Aqui o `fake-turn.mjs` INSTALA um
// handler de SIGTERM vazio (`FAKE_IGNORE_SIGTERM`) — só a ESCALADA de verdade
// (SIGKILL, incondicional) o derruba. TESTE LENTO DE PROPÓSITO (~8-9s reais — o
// `GRACE_KILL_MS` é uma constante do módulo, não injetável; encurtar o teste
// exigiria mudar comportamento de produção, fora do escopo desta missão) — mantido
// ISOLADO neste arquivo para não pesar nos demais.
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

describe('killGracefully — filho IGNORA SIGTERM ⇒ escala p/ SIGKILL após ~GRACE_KILL_MS (8s)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-kill-escalation-');
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('externalStop.abort() com o filho ignorando SIGTERM ⇒ o turno só encerra ~8s depois (prova a ESCALADA, não só o SIGTERM inicial)', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno' }); // sem channel: — não importa aqui.
    writeWorkflow(dir, 'turno', [
      { id: 'trava', goal: 'FAKE_MODE_HANG FAKE_IGNORE_SIGTERM nunca termina, ignora SIGTERM.' },
    ]);

    const logs: string[] = [];
    const externalStop = new AbortController();

    armCronNearMinuteBoundary();
    const promise = runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      externalStop: externalStop.signal,
      execPath: process.execPath,
      aluyEntrypoint: FAKE_TURN_ENTRYPOINT,
      channelDeps: { egressLimiter: new EgressRateLimiter(20, 60_000), clientFactory: () => fakeClient() },
    });

    await waitFor(() => logs.some((l) => l.startsWith('acordou')));
    await waitFor(() => logs.some((l) => l.includes('iniciando turno (') && l.includes('"trava"')), 10_000);
    // Folga p/ o processo-FILHO de fato terminar de subir (Node startup + carregar
    // o módulo) e rodar sua própria linha `process.on('SIGTERM', ...)` ANTES de
    // mandarmos o sinal — senão a disposição DEFAULT do SO (que mata na hora)
    // ainda estaria valendo, e o teste "passaria" sem provar nada sobre a
    // ESCALADA (achado depurando esta suíte: sem esta folga, o abort podia
    // chegar ANTES do `process.on` do filho rodar).
    await new Promise((r) => setTimeout(r, 500));

    const abortedAtMs = Date.now();
    externalStop.abort();

    await waitFor(() => logs.includes('runner encerrado.'), 20_000);
    const elapsedMs = Date.now() - abortedAtMs;
    const code = await promise;

    expect(code).toBe(0);
    // Só morreu depois da ESCALADA p/ SIGKILL — bem mais que um SIGTERM comum
    // (que mataria em milissegundos). Teto generoso (6s) evita flake por jitter de
    // CPU, mas ainda distingue com folga de um SIGTERM instantâneo.
    expect(elapsedMs).toBeGreaterThan(6_000);
    expect(logs.some((l) => l.includes('atividade 1/1 "trava": interrompida (stop do runner).'))).toBe(true);
  }, 30_000);
});

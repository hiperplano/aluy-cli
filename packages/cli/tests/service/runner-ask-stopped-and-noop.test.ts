// ADR-0158 §5 pt.4/§5 pt.3 — dois pedaços de `runServiceRunner` que sobraram
// descobertos mesmo depois da suíte de integração `runner-ask-espera.test.ts`:
//
//   1. `ask.kind === 'stopped'` (linhas ~744-746): o `stop` do runner (SIGTERM/
//      `aluy service stop`) dispara ENQUANTO o turno está em ASK-ESPERA (nenhuma
//      resposta chegou, nem local nem pelo canal). O `break` sai do `while
//      (outcome.kind === 'awaiting-owner')` sem TROCAR o `outcome` — ele continua
//      "awaiting-owner" DE PROPÓSITO, para o guard logo abaixo (`if (outcome.kind
//      !== 'awaiting-owner')`) PULAR o reporte/alerta (§8.2/§8.1): um turno que
//      nunca fechou de verdade não deveria mandar "turno encerrado — ...".
//   2. `workflow:` AUSENTE do manifesto (linhas ~915-917): o serviço abre o
//      expediente mas não tem NADA a executar — vira um "no-op" que ainda assim
//      manda um reporte de fechamento neutro (nunca silêncio).
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
      await new Promise((r) => setTimeout(r, 25)); // ver o comentário em runner-ask-espera.test.ts.
      return [];
    },
    safeForLog: (s) => s,
  };
}

describe('runServiceRunner — `stop` dispara DURANTE a ASK-ESPERA (nenhuma resposta chegou) ⇒ NUNCA reporta/alerta um turno que não fechou', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-ask-stopped-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('externalStop.abort() enquanto aguarda ⇒ "ask-espera interrompida", NUNCA "turno encerrado —", shutdown gracioso normal', async () => {
    const dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'decidir', goal: 'FAKE_MODE_ASK avalie o risco do dia.' }]);

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
    await waitFor(() => logs.some((l) => l.includes('AGUARDANDO DONO — enviando a pergunta')));

    // NUNCA respondemos — nem local, nem via canal. O `stop` chega primeiro.
    externalStop.abort();

    await waitFor(() => logs.includes('runner encerrado.'), 10_000);
    const code = await promise;

    expect(code).toBe(0);
    expect(logs).toContain('ask-espera interrompida (stop do runner).');
    // O guard "outcome.kind !== 'awaiting-owner'" tem que ter pulado report/alert —
    // um turno que ainda está "aguardando dono" no momento do stop NÃO fechou.
    expect(logs.some((l) => l.startsWith('turno encerrado —'))).toBe(false);
    expect(client.sent.every((m) => !m.text.includes('ALERTA'))).toBe(true);
    expect(client.sent.some((m) => m.text.includes('concluídas') || m.text.includes('SEM RESPOSTA'))).toBe(false);
    expect(existsSync(runnerPidPath(dir))).toBe(false); // shutdown() gracioso ainda limpa tudo.
  }, 20_000);
});

describe('runServiceRunner — manifesto SEM "workflow:" declarado ⇒ turno "no-op" (nunca crasha, nunca finge que rodou algo)', () => {
  let base: string;
  beforeEach(() => {
    base = newBase('aluy-svc-noop-');
  });
  afterEach(() => {
    disarmFakeClock();
    removeBase(base);
  });

  it('abre o expediente, loga "nada a executar", e ainda assim manda o reporte de fechamento (nunca silêncio)', async () => {
    writeServiceManifest(base, { channel: 'telegram:555' }); // SEM workflow:

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
    expect(logs).toContain('sem "workflow:" declarado — nada a executar neste turno.');
    expect(logs.some((l) => l.startsWith('turno encerrado — sem workflow declarado (no-op).'))).toBe(true);
    expect(client.sent.some((m) => m.text.includes('sem workflow declarado (no-op).'))).toBe(true);
    expect(client.sent.every((m) => !m.text.includes('ALERTA'))).toBe(true);
  }, 20_000);
});

// ADR-0158 §8.1 — "o dono pode ter editado `service.md` DEPOIS do `start`" (o
// processo só releu o manifesto UMA vez, no boot): a cada despertar, `runServiceRunner`
// RELÊ+REVALIDA (`store.get(name)`, o MESMO ponto usado no boot) ANTES de abrir o
// turno — encontrar um manifesto quebrado ou o diretório do serviço sumido não
// deve DERRUBAR o runner inteiro, só PULAR aquele turno (aviso + `continue`, dorme
// de novo até o PRÓXIMO `schedule`, calculado com o schedule ANTIGO). Nenhum teste
// existente disparava isto de ponta a ponta — só o parse isolado (`services-store`)
// e o alerta isolado (`channel.test.ts`, com uma string arbitrária, não vinda de
// verdade desta revalidação).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';
import { runServiceRunner } from '../../src/service/runner.js';
import { SERVICES_DIRNAME } from '../../src/io/services-store.js';
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

async function armAndStart(
  base: string,
  logs: string[],
  client: ReturnType<typeof fakeClient>,
): Promise<{ promise: Promise<number>; externalStop: AbortController }> {
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
  await waitFor(() => logs.some((l) => l.startsWith('dormindo até')));
  return { promise, externalStop };
}

describe('runServiceRunner — manifesto vira INVÁLIDO entre o boot e o 1º despertar ⇒ turno PULADO (nunca derruba o runner)', () => {
  let base: string;
  let dir: string;
  beforeEach(() => {
    base = newBase('aluy-svc-revalidate-invalid-');
    dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK nunca deveria rodar.' }]);
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('service.md perde o "name:" ENQUANTO dorme ⇒ FALHA ao abrir o turno + ALERTA, "acordou"/turno NUNCA aparecem, continua vivo', async () => {
    const client = fakeClient();
    const logs: string[] = [];
    const { promise, externalStop } = await armAndStart(base, logs, client);

    // Quebra o manifesto AINDA dormindo (a janela até o cron disparar é curta e
    // determinística — ver `workflow-harness.ts`).
    writeFileSync(join(base, SERVICES_DIRNAME, 'trader', 'service.md'), ['---', '---', 'Rege.'].join('\n'));

    await waitFor(() => logs.some((l) => l.includes('FALHA ao abrir o turno')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('manifesto inválido pós-edição'))).toBe(true);
    expect(logs.some((l) => l.startsWith('acordou'))).toBe(false); // o turno NUNCA chegou a abrir.
    expect(logs.some((l) => l.includes('subindo daemons'))).toBe(false);
    expect(client.sent.some((m) => m.text.includes('ALERTA') && m.text.includes('manifesto inválido pós-edição'))).toBe(
      true,
    );
    // o runner continuou VIVO (voltou a dormir) — só saiu quando NÓS abortamos.
    expect(logs).toContain('runner encerrado.');
  }, 20_000);
});

describe('runServiceRunner — diretório do serviço SOME do disco entre o boot e o 1º despertar ⇒ turno PULADO', () => {
  let base: string;
  let dir: string;
  beforeEach(() => {
    base = newBase('aluy-svc-revalidate-gone-');
    dir = writeServiceManifest(base, { workflow: 'turno', channel: 'telegram:555' });
    writeWorkflow(dir, 'turno', [{ id: 'abrir', goal: 'FAKE_MODE_OK nunca deveria rodar.' }]);
  });
  afterEach(() => {
    disarmFakeClock(); // limpeza — NUNCA no meio do teste (ver workflow-harness.ts).
    removeBase(base);
  });

  it('rmSync do diretório inteiro ⇒ "o diretório do serviço sumiu do disco" + ALERTA (pelo ÚLTIMO manifesto válido conhecido)', async () => {
    const client = fakeClient();
    const logs: string[] = [];
    const { promise, externalStop } = await armAndStart(base, logs, client);

    rmSync(dir, { recursive: true, force: true });

    await waitFor(() => logs.some((l) => l.includes('FALHA ao abrir o turno')), 10_000);
    externalStop.abort();
    const code = await promise;

    expect(code).toBe(0);
    expect(logs.some((l) => l.includes('o diretório do serviço sumiu do disco'))).toBe(true);
    expect(logs.some((l) => l.startsWith('acordou'))).toBe(false);
    expect(
      client.sent.some((m) => m.text.includes('ALERTA') && m.text.includes('sumiu do disco')),
    ).toBe(true);
  }, 20_000);
});

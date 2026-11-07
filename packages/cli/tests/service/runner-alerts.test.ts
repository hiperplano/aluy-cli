// ADR-0158 §8.1 (FASE 3) — "turno que não abriu no schedule ⇒ ALERTA no canal, nunca
// silêncio". Cobre os DOIS caminhos FATAIS que já existiam na fase 2 (sem "schedule:",
// schedule que nunca dispara) — agora verificando que o runner tenta avisar o canal
// do manifesto ANTES de sair. Fail-open coberto em `channel.test.ts` (sem token —
// aqui o foco é "o runner CHAMOU o alerta", não a mecânica de envio em si).
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runServiceRunner } from '../../src/service/runner.js';
import { SERVICES_DIRNAME } from '../../src/io/services-store.js';
import type { ServiceChannelClient } from '../../src/service/channel.js';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';

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

describe('runServiceRunner — alerta de falha no canal (ADR-0158 §8.1)', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-svc-runner-alerts-'));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('sem "schedule:" ⇒ ALERTA enviado ao canal do manifesto (nunca silêncio)', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'service.md'),
      ['---', 'name: trader', 'channel: "telegram:555"', '---', 'Rege, não opera.'].join('\n'),
    );
    const client = fakeClient();
    const logs: string[] = [];
    const code = await runServiceRunner('trader', {
      aluyBaseDir: base,
      log: (l) => logs.push(l),
      channelDeps: {
        egressLimiter: new EgressRateLimiter(20, 60_000),
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
      },
    });
    expect(code).toBe(1);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.chatId).toBe(555);
    expect(client.sent[0]!.text).toContain('ALERTA');
    expect(client.sent[0]!.text).toContain('schedule');
  });

  it('"schedule:" que nunca dispara ⇒ ALERTA enviado ao canal do manifesto', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'service.md'),
      ['---', 'name: trader', 'schedule: "0 0 30 2 *"', 'channel: "telegram:555"', '---', 'Rege, não opera.'].join(
        '\n',
      ),
    );
    const client = fakeClient();
    const code = await runServiceRunner('trader', {
      aluyBaseDir: base,
      log: () => {
        /* silencioso */
      },
      channelDeps: {
        egressLimiter: new EgressRateLimiter(20, 60_000),
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
      },
    });
    expect(code).toBe(1);
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('ALERTA');
    expect(client.sent[0]!.text).toContain('nunca dispara');
  });

  it('sem "channel:" declarado ⇒ segue fail-open (nenhum client é tocado, sem exceção)', async () => {
    const dir = join(base, SERVICES_DIRNAME, 'trader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'service.md'), ['---', 'name: trader', '---', 'Rege, não opera.'].join('\n'));
    const logs: string[] = [];
    const code = await runServiceRunner('trader', { aluyBaseDir: base, log: (l) => logs.push(l) });
    expect(code).toBe(1);
    expect(logs.some((l) => l.includes('fail-open'))).toBe(true);
  });
});

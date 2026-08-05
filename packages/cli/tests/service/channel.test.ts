// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3) — canal do serviço: reporte de fechamento,
// alerta de falha e ASK-ESPERA. Tudo com FAKES (sem rede real, sem keychain real —
// mesma disciplina de `telegram-bridge.test.ts`).

import { describe, it, expect, afterEach } from 'vitest';
import {
  sendServiceReport,
  sendServiceAlert,
  waitForOwnerReply,
  newServiceEgressLimiter,
  ASK_TEST_REPLY_ENV,
  type ServiceChannelClient,
  type ServiceChannelDeps,
} from '../../src/service/channel.js';
import type { ServiceManifest, TelegramUpdate } from '@hiperplano/aluy-cli-core';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';

function manifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return {
    name: 'trader',
    tunables: [],
    ignoredFrontmatterKeys: [],
    orchestrator: 'Rege, não opera.',
    ...overrides,
  };
}

function fakeSecretStore(token: string | null): { get(): Promise<string | null> } {
  return { get: async () => token };
}

function fakeClient(pollBatches: readonly (readonly TelegramUpdate[])[] = []): ServiceChannelClient & {
  readonly sent: { chatId: number; text: string }[];
  readonly pollCalls: number;
} {
  const sent: { chatId: number; text: string }[] = [];
  let i = 0;
  let pollCalls = 0;
  return {
    sent,
    get pollCalls() {
      return pollCalls;
    },
    async send(chatId, text) {
      sent.push({ chatId, text });
      return true;
    },
    async poll() {
      pollCalls++;
      const batch = pollBatches[i] ?? [];
      i++;
      return batch;
    },
    safeForLog: (s) => s,
  };
}

function baseDeps(overrides: Partial<ServiceChannelDeps> = {}): ServiceChannelDeps {
  return {
    egressLimiter: newServiceEgressLimiter(),
    log: () => {
      /* silencioso por padrão nos testes — os testes que checam log passam o próprio */
    },
    ...overrides,
  };
}

describe('sendServiceReport (ADR-0158 §8.2) — fail-open', () => {
  it('sem "channel:" declarado ⇒ NÃO envia, loga aviso (fail-open)', async () => {
    const logs: string[] = [];
    await sendServiceReport(
      manifest(),
      { serviceName: 'trader', ok: true, critical: false, summary: '2/2 ok.' },
      baseDeps({ log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('fail-open'))).toBe(true);
    expect(logs.some((l) => l.includes('sem "channel:"'))).toBe(true);
  });

  it('canal telegram mas SEM token no keychain ⇒ NÃO envia, loga aviso (fail-open)', async () => {
    const logs: string[] = [];
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: '2/2 ok.' },
      baseDeps({ secretStore: fakeSecretStore(null), log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('sem token'))).toBe(true);
  });

  it('com token ⇒ envia ao chat-id do MANIFESTO (nunca outro alvo)', async () => {
    const client = fakeClient();
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: '3/3 concluídas.' },
      baseDeps({
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      }),
    );
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.chatId).toBe(100);
    expect(client.sent[0]!.text).toContain('trader');
    expect(client.sent[0]!.text).toContain('3/3 concluídas.');
  });

  it('teto anti-spam (TC-6) compartilhado ⇒ 2º envio no mesmo processo é NEGADO', async () => {
    const client = fakeClient();
    const egressLimiter = new EgressRateLimiter(1, 60_000); // só 1 envio permitido
    const logs: string[] = [];
    const deps = baseDeps({
      secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
      clientFactory: () => client,
      egressLimiter,
      log: (l) => logs.push(l),
    });
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: 'primeiro.' },
      deps,
    );
    await sendServiceAlert(manifest({ channel: 'telegram:100' }), 'segundo evento', deps);
    expect(client.sent).toHaveLength(1); // só o primeiro passou
    expect(logs.some((l) => l.includes('anti-spam'))).toBe(true);
  });
});

describe('sendServiceAlert (ADR-0158 §8.1)', () => {
  it('envia o texto de ALERTA (não o de reporte) ao chat-id do manifesto', async () => {
    const client = fakeClient();
    await sendServiceAlert(
      manifest({ channel: 'telegram:777' }),
      'manifesto inválido pós-edição — sem "name"',
      baseDeps({
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      }),
    );
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.chatId).toBe(777);
    expect(client.sent[0]!.text).toContain('ALERTA');
    expect(client.sent[0]!.text).toContain('manifesto inválido pós-edição');
  });
});

function ownerUpdate(chatId: number, text: string): TelegramUpdate {
  return { chatId, fromId: chatId, text };
}

describe('waitForOwnerReply (ADR-0158 §5 pt.4 — ASK-ESPERA, o coração da fase 3)', () => {
  afterEach(() => {
    delete process.env[ASK_TEST_REPLY_ENV];
  });

  it('sem canal ⇒ kind "no-channel", nada é enviado/aguardado', async () => {
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest(),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps(),
    });
    expect(result.kind).toBe('no-channel');
  });

  it('sem token ⇒ kind "no-channel" (fail-open, mesmo caminho do reporte)', async () => {
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({ secretStore: fakeSecretStore(null) }),
    });
    expect(result.kind).toBe('no-channel');
  });

  it('envia a pergunta e RETOMA com a resposta do dono (allowlist = chat-id do manifesto)', async () => {
    const client = fakeClient([
      // 1ª rodada: msg de um chat DE FORA da allowlist ⇒ ignorada (nunca vira resposta).
      [ownerUpdate(999, 'não sou o dono, ignora')],
      // 2ª rodada: msg do chat-id do MANIFESTO ⇒ é a resposta.
      [ownerUpdate(100, 'Sim, até 3 lotes.')],
    ]);
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      }),
    });
    expect(result).toEqual({ kind: 'answered', text: 'Sim, até 3 lotes.' });
    // A PERGUNTA foi enviada ao chat-id do manifesto (100), nunca ao 999.
    expect(client.sent[0]!.chatId).toBe(100);
    expect(client.sent[0]!.text).toContain('Aumento a posição?');
  });

  it('mensagem de forward de terceiro (kind "data") NÃO conta como resposta — segue esperando', async () => {
    const client = fakeClient([
      [{ chatId: 100, fromId: 100, text: 'repassando algo', forwarded: true }],
      [ownerUpdate(100, 'agora sim, respondo direto')],
    ]);
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Confirma?',
      stop: controller.signal,
      deps: baseDeps({
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      }),
    });
    expect(result).toEqual({ kind: 'answered', text: 'agora sim, respondo direto' });
    expect(client.pollCalls).toBe(2);
  });

  it('timeout ⇒ kind "timeout" + alerta de timeout enviado ao canal', async () => {
    const client = fakeClient([[], [], []]);
    const controller = new AbortController();
    let calls = 0;
    // "now" avança 1h a cada chamada — com askTimeoutMs=2h, estoura na 3ª checagem.
    const now = () => {
      calls++;
      return calls * 3_600_000;
    };
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
        now,
        askTimeoutMs: 2 * 3_600_000,
      }),
    });
    expect(result.kind).toBe('timeout');
    // pergunta (1) + alerta de timeout (2) — os dois passaram pela catraca.
    expect(client.sent.length).toBeGreaterThanOrEqual(2);
    expect(client.sent.some((s) => s.text.includes('SEM RESPOSTA'))).toBe(true);
  });

  it('"stop" já abortado ⇒ kind "stopped" sem esperar (mas a pergunta ainda é enviada — o dono pode ver ao religar)', async () => {
    const client = fakeClient();
    const controller = new AbortController();
    controller.abort();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({
        secretStore: fakeSecretStore('123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345'),
        clientFactory: () => client,
      }),
    });
    expect(result.kind).toBe('stopped');
    expect(client.sent).toHaveLength(1); // a pergunta foi enviada antes do loop checar o stop.
  });

  it(`TEST-ONLY: ${ASK_TEST_REPLY_ENV} injeta a resposta sem tocar keychain/rede`, async () => {
    process.env[ASK_TEST_REPLY_ENV] = 'resposta mockada via env test-only';
    const controller = new AbortController();
    // secretStore/clientFactory NEM SÃO passados — se o hook tocasse rede, isto explodiria.
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps(),
    });
    expect(result).toEqual({ kind: 'answered', text: 'resposta mockada via env test-only' });
  });
});

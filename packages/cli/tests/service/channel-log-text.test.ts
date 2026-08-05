// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3) — channel.ts: fecha sobreviventes de MUTAÇÃO
// que são quase todos do MESMO padrão — o código já era EXERCITADO por
// `channel.test.ts`/`channel-local-answer.test.ts`, mas as asserções eram frouxas
// demais pra distinguir "log(texto certo)" de "log('')"/"log(outro texto)" (achado
// numa auditoria — ver relatório). Arquivo SEPARADO (não editamos teste alheio) —
// reproduz cenários PARECIDOS com os já existentes, mas com asserções PRECISAS de
// texto de log/alerta. Também cobre: `.trim()` na checagem de token vazio, o
// branch "envio OK não loga falha", e a corrida `stop`-aborta-DURANTE-o-poll
// (distinta de "stop JÁ abortado antes de começar", já coberta alhures).
import { describe, it, expect } from 'vitest';
import {
  sendServiceReport,
  waitForOwnerReply,
  newServiceEgressLimiter,
  ASK_TEST_REPLY_ENV,
  type ServiceChannelClient,
  type ServiceChannelDeps,
  type LocalAnswerSource,
} from '../../src/service/channel.js';
import type { ServiceManifest, TelegramUpdate } from '@hiperplano/aluy-cli-core';

function manifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return { name: 'trader', tunables: [], ignoredFrontmatterKeys: [], orchestrator: 'Rege, não opera.', ...overrides };
}

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function baseDeps(overrides: Partial<ServiceChannelDeps> = {}): ServiceChannelDeps {
  return { egressLimiter: newServiceEgressLimiter(), log: () => {}, ...overrides };
}

function ownerUpdate(chatId: number, text: string): TelegramUpdate {
  return { chatId, fromId: chatId, text };
}

describe('resolveActiveChannel — token vazio: ambos os ramos do "||" importam', () => {
  it('token === "" (string vazia direta, sem precisar de trim) ⇒ "sem token"', async () => {
    const logs: string[] = [];
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
      baseDeps({ secretStore: { get: async () => '' }, log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('sem token'))).toBe(true);
  });

  it('token === "   " (só whitespace) ⇒ "sem token" (SÓ detectável via `.trim()`)', async () => {
    const logs: string[] = [];
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
      baseDeps({ secretStore: { get: async () => '   ' }, log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('sem token'))).toBe(true);
  });
});

describe('sendChannelText — envio COM SUCESSO nunca loga "falha ao enviar"', () => {
  it('client.send devolve true ⇒ NENHUM log de falha (distingue de "sempre loga")', async () => {
    const logs: string[] = [];
    const client: ServiceChannelClient = { send: async () => true, poll: async () => [], safeForLog: (s) => s };
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
      baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('falha ao enviar'))).toBe(false);
  });
});

describe('waitForOwnerReply — textos EXATOS de log em cada ramo', () => {
  it(`TEST-ONLY: loga a linha EXATA citando ${ASK_TEST_REPLY_ENV}`, async () => {
    process.env[ASK_TEST_REPLY_ENV] = 'resposta mockada';
    const logs: string[] = [];
    try {
      await waitForOwnerReply({
        manifest: manifest({ channel: 'telegram:100' }),
        question: 'q?',
        stop: new AbortController().signal,
        deps: baseDeps({ log: (l) => logs.push(l) }),
      });
    } finally {
      delete process.env[ASK_TEST_REPLY_ENV];
    }
    expect(logs).toContain(
      `[service/channel] ${ASK_TEST_REPLY_ENV} setado — resposta mockada TEST-ONLY (sem rede real).`,
    );
  });

  it('sem canal ⇒ loga a linha EXATA "ask-espera não enviada (fail-open) — <motivo>."', async () => {
    const logs: string[] = [];
    await waitForOwnerReply({
      manifest: manifest(),
      question: 'q?',
      stop: new AbortController().signal,
      deps: baseDeps({ log: (l) => logs.push(l) }),
    });
    expect(logs).toContain(
      '[service/channel] ask-espera não enviada (fail-open) — serviço sem "channel:" declarado.',
    );
  });

  it('pergunta enviada com sucesso ⇒ loga a linha EXATA "pergunta enviada ao canal (chat N) — aguardando resposta do dono."', async () => {
    const client: ServiceChannelClient = {
      send: async () => true,
      poll: async () => [ownerUpdate(100, 'ok')],
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: new AbortController().signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
    });
    expect(logs).toContain(
      '[service/channel] pergunta enviada ao canal (chat 100) — aguardando resposta do dono.',
    );
  });

  it('timeout ⇒ a hora relatada no ALERTA reflete `now() - startedAtMs` (nunca `+`) e a linha de log é EXATA', async () => {
    const client: ServiceChannelClient & { sent: { chatId: number; text: string }[] } = {
      sent: [],
      async send(chatId, text) {
        this.sent.push({ chatId, text });
        return true;
      },
      async poll() {
        return [];
      },
      safeForLog: (s) => s,
    };
    let calls = 0;
    const now = (): number => {
      calls++;
      return calls * 3_600_000; // +1h por chamada.
    };
    const logs: string[] = [];
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: new AbortController().signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        now,
        askTimeoutMs: 2 * 3_600_000, // 2h.
        log: (l) => logs.push(l),
      }),
    });
    expect(result.kind).toBe('timeout');
    expect(logs).toContain(
      '[service/channel] ask-espera: TIMEOUT — sem resposta do dono; turno encerra sem ação.',
    );
    // waitedMs correto = now() - startedAtMs (uma diferença "pequena", ~horas) —
    // com o operador trocado por `+` a soma dobraria/explodiria o valor (a
    // trajetória exata depende da contagem de chamadas de `now`, mas o texto
    // teria de bater com a SUBTRAÇÃO, nunca a soma).
    const alertMsg = client.sent.find((s) => s.text.includes('SEM RESPOSTA após'));
    expect(alertMsg).toBeDefined();
    expect(alertMsg!.text).toMatch(/SEM RESPOSTA após 3h/);
  });

  it('resposta LOCAL vence ⇒ loga a linha EXATA "resposta LOCAL recebida via ... — retomando o turno de onde parou."', async () => {
    const client: ServiceChannelClient = {
      send: async () => true,
      poll(signal?: AbortSignal) {
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
      safeForLog: (s) => s,
    };
    const localAnswer: LocalAnswerSource = { async waitForAnswer() { return 'sim (local)'; } };
    const logs: string[] = [];
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: new AbortController().signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
      localAnswer,
    });
    expect(result).toEqual({ kind: 'answered', text: 'sim (local)' });
    expect(logs).toContain(
      '[service/channel] resposta LOCAL recebida via "aluy service attach" — retomando o turno de onde parou.',
    );
  });

  it('resposta REMOTA (canal) ⇒ loga a linha EXATA "dono respondeu no canal — retomando o turno de onde parou."', async () => {
    const client: ServiceChannelClient = {
      send: async () => true,
      poll: async () => [ownerUpdate(100, 'sim, prossiga')],
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: new AbortController().signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
    });
    expect(result).toEqual({ kind: 'answered', text: 'sim, prossiga' });
    expect(logs).toContain('[service/channel] dono respondeu no canal — retomando o turno de onde parou.');
  });

  it('update FORA da allowlist ⇒ classificado "discard", loga a linha EXATA com o MOTIVO', async () => {
    const client: ServiceChannelClient = {
      send: async () => true,
      // SÓ a 1ª chamada devolve o update descartável — as SEGUINTES ficam
      // pendentes até o `signal` (do `pollController` interno) abortar. Sem
      // isto, um fake que resolve IMEDIATAMENTE em toda chamada faz o `while`
      // girar via só microtasks (nunca cede a vez pro macrotask do `setTimeout`
      // abaixo) — um busy-loop de CPU que NUNCA deixa o `stop.abort()` disparar
      // (achado ao rodar: 100% CPU, suite travada — timers de Node não disparam
      // enquanto o microtask queue nunca esvazia de verdade).
      poll(signal?: AbortSignal) {
        if (calls === 0) {
          calls++;
          return Promise.resolve([ownerUpdate(999, 'não sou o dono')]);
        }
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
      safeForLog: (s) => s,
    };
    let calls = 0;
    const logs: string[] = [];
    const stop = new AbortController();
    const promise = waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: stop.signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop.abort();
    await promise;
    expect(logs).toContain(
      '[service/channel] ask-espera: ingresso descartado (canal 999 não-allowlistado).',
    );
  });

  it('update de forward de terceiro (kind "data") ⇒ loga a linha EXATA "classificado como DADO"', async () => {
    let calls = 0;
    const client: ServiceChannelClient = {
      send: async () => true,
      poll(signal?: AbortSignal) {
        if (calls === 0) {
          calls++;
          return Promise.resolve([{ chatId: 100, fromId: 100, text: 'repassando algo', forwarded: true }]);
        }
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    const stop = new AbortController();
    const promise = waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: stop.signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
    });
    await new Promise((r) => setTimeout(r, 30));
    stop.abort();
    await promise;
    expect(logs).toContain(
      '[service/channel] ask-espera: ingresso classificado como DADO (não-confiável) — ignorado.',
    );
  });
});

describe('waitForOwnerReply — `stop` abortando DURANTE um long-poll em voo (distinto de "já abortado antes")', () => {
  it('poll que só resolve no abort do SEU signal ⇒ `stop.abort()` a meio da espera cancela e devolve "stopped" prontamente', async () => {
    let pollSignalSeen: AbortSignal | undefined;
    const client: ServiceChannelClient = {
      send: async () => true,
      poll(signal?: AbortSignal) {
        pollSignalSeen = signal;
        return new Promise((resolve) => {
          signal?.addEventListener('abort', () => resolve([]), { once: true });
        });
      },
      safeForLog: (s) => s,
    };
    const stop = new AbortController();
    const promise = waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'q?',
      stop: stop.signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client }),
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(pollSignalSeen).toBeDefined();
    expect(pollSignalSeen!.aborted).toBe(false);
    stop.abort();
    const result = await promise;
    expect(result).toEqual({ kind: 'stopped' });
  });
});

// ADR-0158 §5 pt.4/§8.1/§8.2 (FASE 3) — channel.ts: cenários FAIL-OPEN de
// egresso/keychain não cobertos por `channel.test.ts` (achado numa auditoria de
// cobertura de MUTAÇÃO — ver relatório): keychain que LANÇA (não só "sem token"),
// `client.send` devolvendo `false` (Bot API recusou) ou LANÇANDO (erro de rede),
// e a catraca anti-spam (TC-6) negando especificamente o envio da PERGUNTA/do
// alerta-de-timeout dentro de `waitForOwnerReply` (distinto do caso já coberto —
// negar o REPORTE/ALERTA comuns). Arquivo SEPARADO de `channel.test.ts`/
// `channel-local-answer.test.ts` (não editamos teste alheio) — só ESTENDE a
// cobertura com FAKES novos, sem tocar rede/keychain reais (mesma disciplina).
import { describe, it, expect } from 'vitest';
import {
  sendServiceReport,
  waitForOwnerReply,
  newServiceEgressLimiter,
  type ServiceChannelClient,
  type ServiceChannelDeps,
} from '../../src/service/channel.js';
import type { ServiceManifest, TelegramUpdate } from '@hiperplano/aluy-cli-core';
import { EgressRateLimiter } from '@hiperplano/aluy-cli-core';

function manifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return { name: 'trader', tunables: [], orchestrator: 'Rege, não opera.', ...overrides };
}

const TOKEN = '123456789:AAHk-abcdefghijklmnopqrstuvwxyz012345';

function baseDeps(overrides: Partial<ServiceChannelDeps> = {}): ServiceChannelDeps {
  return {
    egressLimiter: newServiceEgressLimiter(),
    log: () => {},
    ...overrides,
  };
}

describe('resolveActiveChannel (via sendServiceReport) — keychain LANÇA ⇒ fail-open', () => {
  it('secretStore.get() lança (keychain indisponível) ⇒ trata como SEM token, loga e segue (não propaga a exceção)', async () => {
    const logs: string[] = [];
    const throwingStore = {
      get: async (): Promise<string | null> => {
        throw new Error('keychain indisponível (ex. daemon do SO fora do ar)');
      },
    };
    await expect(
      sendServiceReport(
        manifest({ channel: 'telegram:100' }),
        { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
        baseDeps({ secretStore: throwingStore, log: (l) => logs.push(l) }),
      ),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('sem token'))).toBe(true);
  });
});

describe('resolveActiveChannel (via sendServiceReport) — "channel:" definido mas NÃO-Telegram', () => {
  it('channel: definido com conector não suportado (ex. "discord:123") ⇒ fail-open com o motivo ESPECÍFICO (distinto de "sem channel:")', async () => {
    const logs: string[] = [];
    await sendServiceReport(
      manifest({ channel: 'discord:123' }),
      { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
      baseDeps({ log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('não é um canal Telegram suportado'))).toBe(true);
    expect(logs.some((l) => l.includes('discord:123'))).toBe(true);
    // NUNCA a mensagem de "sem channel:" (são dois motivos DIFERENTES).
    expect(logs.some((l) => l.includes('sem "channel:"'))).toBe(false);
  });
});

describe('sendChannelText (via sendServiceReport) — client.send falha', () => {
  it('client.send devolve false (Bot API recusou/erro de rede) ⇒ loga aviso, NÃO lança', async () => {
    const logs: string[] = [];
    const client: ServiceChannelClient = {
      send: async () => false,
      poll: async () => [],
      safeForLog: (s) => s,
    };
    await sendServiceReport(
      manifest({ channel: 'telegram:100' }),
      { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
      baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
    );
    expect(logs.some((l) => l.includes('falha ao enviar') && l.includes('Bot API recusou'))).toBe(true);
  });

  it('client.send LANÇA (erro de rede) ⇒ loga via safeForLog, NÃO propaga a exceção', async () => {
    const logs: string[] = [];
    const client: ServiceChannelClient = {
      send: async () => {
        throw new Error('ECONNRESET segredo-não-deveria-vazar');
      },
      poll: async () => [],
      safeForLog: (s) => s.replace('segredo-não-deveria-vazar', '[REDACTED]'),
    };
    await expect(
      sendServiceReport(
        manifest({ channel: 'telegram:100' }),
        { serviceName: 'trader', ok: true, critical: false, summary: 'ok.' },
        baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client, log: (l) => logs.push(l) }),
      ),
    ).resolves.toBeUndefined();
    expect(logs.some((l) => l.includes('erro ao enviar'))).toBe(true);
    // prova que passou pelo `safeForLog` do client (não um `String(err)` cru).
    expect(logs.some((l) => l.includes('[REDACTED]'))).toBe(true);
    expect(logs.some((l) => l.includes('segredo-não-deveria-vazar'))).toBe(false);
  });
});

function ownerUpdate(chatId: number, text: string): TelegramUpdate {
  return { chatId, fromId: chatId, text };
}

describe('waitForOwnerReply — catraca anti-spam (TC-6) negando a PERGUNTA em si', () => {
  it('teto atingido bem no envio da pergunta ⇒ loga "pergunta NÃO enviada", MAS continua aguardando (não desiste)', async () => {
    const client: ServiceChannelClient & { sent: { chatId: number; text: string }[] } = {
      sent: [],
      async send(chatId, text) {
        this.sent.push({ chatId, text });
        return true;
      },
      async poll() {
        return [ownerUpdate(100, 'respondo mesmo assim')];
      },
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    const zeroLimiter = new EgressRateLimiter(0, 60_000); // NUNCA deixa passar.
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: new AbortController().signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        egressLimiter: zeroLimiter,
        log: (l) => logs.push(l),
      }),
    });
    // a pergunta NUNCA foi enviada (catraca negou) — mas o long-poll segue rodando
    // e ainda assim conta a resposta que chegou.
    expect(client.sent).toHaveLength(0);
    expect(logs.some((l) => l.includes('pergunta NÃO enviada'))).toBe(true);
    expect(result).toEqual({ kind: 'answered', text: 'respondo mesmo assim' });
  });
});

describe('waitForOwnerReply — client.send LANÇA ao enviar a pergunta ⇒ fail-open, segue aguardando', () => {
  it('erro ao enviar a pergunta é logado via safeForLog, mas a espera continua normalmente', async () => {
    const client: ServiceChannelClient = {
      send: async () => {
        throw new Error('erro de rede ao mandar a pergunta');
      },
      poll: async () => [ownerUpdate(100, 'ok, prossiga')],
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: new AbortController().signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        log: (l) => logs.push(l),
      }),
    });
    expect(logs.some((l) => l.includes('erro ao enviar a pergunta'))).toBe(true);
    expect(result).toEqual({ kind: 'answered', text: 'ok, prossiga' });
  });
});

describe('waitForOwnerReply — client.send devolve FALSE (Bot API recusou, sem lançar) ao mandar a pergunta', () => {
  it('loga "falha ao enviar a pergunta" (distinto do texto de sucesso), mas a espera segue e ainda responde', async () => {
    const client: ServiceChannelClient = {
      send: async () => false, // Bot API recusou — NÃO é exceção, é `ok:false`.
      poll: async () => [ownerUpdate(100, 'sim, prossiga')],
      safeForLog: (s) => s,
    };
    const logs: string[] = [];
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: new AbortController().signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        log: (l) => logs.push(l),
      }),
    });
    expect(logs).toContain(
      '[service/channel] falha ao enviar a pergunta (Bot API recusou/erro de rede) — aguardando mesmo assim.',
    );
    expect(logs.some((l) => l.includes('pergunta enviada ao canal'))).toBe(false);
    expect(result).toEqual({ kind: 'answered', text: 'sim, prossiga' });
  });
});

describe('waitForOwnerReply — client.poll REJEITA (erro de rede no long-poll) ⇒ fail-safe, trata como rodada vazia', () => {
  it('poll que lança na 1ª chamada e responde na 2ª ⇒ NÃO propaga a exceção, apenas continua esperando', async () => {
    let calls = 0;
    const client: ServiceChannelClient = {
      send: async () => true,
      async poll() {
        calls++;
        if (calls === 1) throw new Error('ECONNRESET no long-poll');
        return [ownerUpdate(100, 'depois do erro, respondo')];
      },
      safeForLog: (s) => s,
    };
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: new AbortController().signal,
      deps: baseDeps({ secretStore: { get: async () => TOKEN }, clientFactory: () => client }),
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result).toEqual({ kind: 'answered', text: 'depois do erro, respondo' });
  });
});

describe('waitForOwnerReply — timeout: catraca nega o ALERTA de timeout, e client.send lança nele', () => {
  it('catraca nega o alerta de timeout ⇒ NÃO tenta enviar (client.send nunca chamado p/ o alerta), ainda assim kind "timeout"', async () => {
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
      return calls * 3_600_000;
    };
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: new AbortController().signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        // 1 envio permitido: a PERGUNTA inicial consome a única ficha — o alerta
        // de timeout, depois, é negado pela catraca. Janela BEM maior que o
        // intervalo simulado inteiro (o `now` fake pula de hora em hora) — senão
        // a 2ª consumição cairia FORA da janela da 1ª e seria liberada por engano.
        egressLimiter: new EgressRateLimiter(1, 50_000_000),
        now,
        askTimeoutMs: 2 * 3_600_000,
      }),
    });
    expect(result.kind).toBe('timeout');
    // só a pergunta foi enviada — o alerta de timeout foi negado pela catraca.
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain('Aumento a posição?');
  });

  it('client.send LANÇA ao mandar o alerta de timeout ⇒ engolido (fail-open), ainda assim kind "timeout"', async () => {
    const client: ServiceChannelClient = {
      send: async (_chatId, text) => {
        if (text.includes('SEM RESPOSTA') || text.includes('timeout') || text.includes('não respondeu')) {
          throw new Error('erro de rede ao mandar o alerta de timeout');
        }
        return true; // a pergunta inicial passa normalmente.
      },
      async poll() {
        return [];
      },
      safeForLog: (s) => s,
    };
    let calls = 0;
    const now = (): number => {
      calls++;
      return calls * 3_600_000;
    };
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: new AbortController().signal,
      deps: baseDeps({
        secretStore: { get: async () => TOKEN },
        clientFactory: () => client,
        egressLimiter: new EgressRateLimiter(20, 60_000),
        now,
        askTimeoutMs: 2 * 3_600_000,
      }),
    });
    expect(result.kind).toBe('timeout');
  });
});

// `channel:` NÃO É OBRIGATÓRIO (achado de dogfooding: "eu não quero ser obrigado a
// ter um channel"). Quando não há canal remoto utilizável — não declarado, valor
// não-Telegram, ou sem token no keychain — a ASK-ESPERA passa a ser SILENCIOSA: o
// serviço fica vivo e o dono responde entrando com `aluy service attach`.
//
// Arquivo SEPARADO de `channel.test.ts`/`channel-local-answer.test.ts` — mesma
// disciplina daquele: não editamos teste de fase anterior, só ESTENDEMOS. Os testes
// de lá que provam `no-channel` continuam valendo e continuam verdes, porque chamam
// `waitForOwnerReply` SEM `localAnswer` (o caso "nem canal nem attach"), que segue
// devolvendo `no-channel`.

import { describe, it, expect } from 'vitest';
import {
  waitForOwnerReply,
  newServiceEgressLimiter,
  type LocalAnswerSource,
  type ServiceChannelClient,
} from '../../src/service/channel.js';
import type { ServiceManifest } from '@hiperplano/aluy-cli-core';

function manifest(overrides: Partial<ServiceManifest> = {}): ServiceManifest {
  return { name: 'trader', tunables: [], orchestrator: 'Rege, não opera.', ...overrides };
}

function fakeSecretStore(token: string | null): { get(): Promise<string | null> } {
  return { get: async () => token };
}

/** Fonte local que responde NA HORA (o dono já estava com o `attach` aberto). */
function localAnswerNow(text: string): LocalAnswerSource {
  return { waitForAnswer: async () => text };
}

/** Fonte local que NUNCA responde (o dono não entrou no `attach`) — prova timeout/stop. */
function localAnswerNever(): LocalAnswerSource {
  return { waitForAnswer: () => new Promise<string>(() => {}) };
}

/** Client que EXPLODE se alguém tentar usá-lo — prova que a espera local não toca a rede. */
function forbiddenClient(): ServiceChannelClient {
  return {
    send: () => {
      throw new Error('não deveria enviar nada — não há canal');
    },
    poll: () => {
      throw new Error('não deveria fazer poll — não há canal');
    },
    safeForLog: (s) => s,
  };
}

function baseDeps(over: Partial<Parameters<typeof waitForOwnerReply>[0]['deps']> = {}) {
  return {
    egressLimiter: newServiceEgressLimiter(),
    log: () => {},
    secretStore: fakeSecretStore(null),
    ...over,
  };
}

describe('ask-espera SEM canal — espera silenciosa via "aluy service attach"', () => {
  it('sem "channel:" declarado + attach fiado ⇒ ESPERA e retoma com a resposta local (nunca "no-channel")', async () => {
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest(), // sem channel
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps(),
      localAnswer: localAnswerNow('Sim, até 3 lotes.'),
    });
    expect(result).toEqual({ kind: 'answered', text: 'Sim, até 3 lotes.' });
  });

  it('canal declarado mas SEM token no keychain + attach ⇒ também cai na espera local', async () => {
    // Mesma porta (`resolveActiveChannel` falhou) — o motivo da ausência não muda o
    // desfecho: ter o attach é o que basta para esperar em vez de desistir.
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'telegram:100' }),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({ secretStore: fakeSecretStore(null) }),
      localAnswer: localAnswerNow('pode'),
    });
    expect(result).toEqual({ kind: 'answered', text: 'pode' });
  });

  it('canal com valor NÃO-Telegram + attach ⇒ espera local (não é erro de manifesto, é ausência de alcance remoto)', async () => {
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest({ channel: 'slack:C123' }),
      question: 'Fecho tudo?',
      stop: controller.signal,
      deps: baseDeps({ secretStore: fakeSecretStore('token-valido') }),
      localAnswer: localAnswerNow('fecha'),
    });
    expect(result).toEqual({ kind: 'answered', text: 'fecha' });
  });

  it('a espera local NÃO toca a rede (nenhum send/poll acontece sem canal)', async () => {
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest(),
      question: 'Aumento a posição?',
      stop: controller.signal,
      // `clientFactory` devolveria um client que EXPLODE — mas sem canal resolvido
      // ele nunca chega a ser construído/usado.
      deps: baseDeps({ clientFactory: () => forbiddenClient() }),
      localAnswer: localAnswerNow('ok'),
    });
    expect(result).toEqual({ kind: 'answered', text: 'ok' });
  });

  it('dono NÃO entra no attach até o teto ⇒ "timeout" (o turno encerra sem ação, nunca supõe)', async () => {
    // `now` salta para além do teto já na 1ª verificação do laço — prova o timeout
    // sem esperar tempo real. A regra dura continua: sem resposta do dono, o turno
    // NÃO prossegue; ele encerra.
    let calls = 0;
    const now = (): number => {
      calls += 1;
      return calls === 1 ? 0 : 10_000;
    };
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest(),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({ now, askTimeoutMs: 1_000 }),
      localAnswer: localAnswerNever(),
    });
    expect(result).toEqual({ kind: 'timeout' });
  });

  it('AINDA dentro do teto ⇒ NÃO devolve timeout (mata o mutante que ignora o relógio)', async () => {
    // Sem esta prova, um mutante que devolvesse `timeout` incondicionalmente passaria
    // no teste acima. Aqui o relógio NÃO avança além do teto e a resposta local chega.
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest(),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps({ now: () => 0, askTimeoutMs: 60_000 }),
      localAnswer: localAnswerNow('resposta dentro do prazo'),
    });
    expect(result).toEqual({ kind: 'answered', text: 'resposta dentro do prazo' });
  });

  it('stop (SIGTERM/"aluy service stop") durante a espera ⇒ "stopped"', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await waitForOwnerReply({
      manifest: manifest(),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps(),
      localAnswer: localAnswerNever(),
    });
    expect(result).toEqual({ kind: 'stopped' });
  });

  it('sem canal E SEM attach ⇒ segue "no-channel" (o fallback antigo, preservado)', async () => {
    // A porta do comportamento novo é a PRESENÇA do `localAnswer`. Sem ele não há
    // quem responda — desistir é o certo, e o runner cai no fail-open de sempre.
    const controller = new AbortController();
    const result = await waitForOwnerReply({
      manifest: manifest(),
      question: 'Aumento a posição?',
      stop: controller.signal,
      deps: baseDeps(),
    });
    expect(result.kind).toBe('no-channel');
  });
});

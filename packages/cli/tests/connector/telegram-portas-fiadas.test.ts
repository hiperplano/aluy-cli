// GUARDA — a ATIVAÇÃO tem de FORNECER as portas que a ponte CHAMA.
//
// O defeito real (02/09): a ponte chamava `this.ack(...)` e a ativação não passava a porta.
// Com `ack` ausente a chamada vira no-op — nenhuma reação saía, silenciosamente. O dono
// reportou como "ele não dá a msg como lida", e eu quase errei o diagnóstico: verifiquei a
// CHAMADA no bundle, vi que estava lá, e concluí "instalado". Nunca checei se alguém
// FORNECIA a porta. Metade certa, conclusão errada.
//
// A assimetria é o que torna a classe perigosa: `ack` e `digitando` são OPCIONAIS por
// desenho (para não regredir quem não os usa), então esquecer de fiá-los não quebra teste
// nenhum, não quebra o build, e não produz erro em runtime. Só o silêncio.
//
// Esta guarda fecha o buraco pelo COMPORTAMENTO: ativa a ponte com um client dublê e
// verifica que reagir e digitar chegam ao client de verdade.

import { describe, expect, it, vi } from 'vitest';
import { activateTelegram } from '../../src/connector/telegram-activation.js';

/** Config com um chat autorizado — a malha precisa dela p/ classificar como instrução. */
function configStore(): never {
  return {
    load: () => ({ connectors: { telegram: { allowlist: [42] } } }),
    save: () => true,
  } as never;
}

function secretStore(): never {
  return { get: async () => '000000000:TOKEN-FALSO-DE-TESTE', set: async () => {} } as never;
}

/** `fetch` dublê: registra qual endpoint da Bot API foi chamado. */
function fetchEspiao(chamadas: string[]) {
  return (async (url: string) => {
    chamadas.push(String(url).split('/bot')[1]?.split('/')[1] ?? String(url));
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  }) as unknown as typeof fetch;
}

const msg = (over: Record<string, unknown> = {}) =>
  ({
    content: 'ola',
    sender: '42',
    conversation: '42',
    provenance: { kind: 'author-direct' as const },
    messageId: 7,
    ...over,
  }) as never;

describe('a ativação FORNECE as portas que a ponte chama', () => {
  it('mensagem AUTORIZADA ⇒ o client recebe `setMessageReaction` (o 👀 sai de fato)', async () => {
    const chamadas: string[] = [];
    const r = await activateTelegram({
      sink: { injectInstruction: vi.fn(), injectData: vi.fn() },
      configStore: configStore(),
      secretStore: secretStore(),
      fetchFn: fetchEspiao(chamadas),
    } as never);
    expect(r.active).toBe(true);
    r.bridge!.route(msg());
    await new Promise((res) => setTimeout(res, 5));
    expect(
      chamadas,
      'sem a porta `ack` fiada, a chamada da ponte vira no-op e NADA chega ao client',
    ).toContain('setMessageReaction');
  });

  it('mensagem AUTORIZADA ⇒ o client recebe `sendChatAction` (o "digitando" sai)', async () => {
    const chamadas: string[] = [];
    const r = await activateTelegram({
      sink: { injectInstruction: vi.fn(), injectData: vi.fn() },
      configStore: configStore(),
      secretStore: secretStore(),
      fetchFn: fetchEspiao(chamadas),
    } as never);
    r.bridge!.route(msg());
    await new Promise((res) => setTimeout(res, 5));
    expect(chamadas).toContain('sendChatAction');
    r.bridge!.stop();
  });

  it('mensagem DESCARTADA reage (🚫) mas NÃO anuncia trabalho', async () => {
    const chamadas: string[] = [];
    const r = await activateTelegram({
      sink: { injectInstruction: vi.fn(), injectData: vi.fn() },
      // allowlist vazia ⇒ tudo é descartado
      configStore: { load: () => ({}), save: () => true } as never,
      secretStore: secretStore(),
      fetchFn: fetchEspiao(chamadas),
    } as never);
    r.bridge!.route(msg());
    await new Promise((res) => setTimeout(res, 5));
    expect(chamadas).toContain('setMessageReaction');
    expect(chamadas, 'descartada não gera trabalho ⇒ nada a anunciar').not.toContain(
      'sendChatAction',
    );
  });
});

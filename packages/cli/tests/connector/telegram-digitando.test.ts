// "DIGITANDO…" no canal enquanto o agente trabalha.
//
// Pedido do dono (02/09): "ele não dá a msg como lida e nem mostra que tá digitando uma
// resposta". O ACK (👀) resolve a primeira metade; esta é a segunda. Um turno dele levou
// 42s — sem sinal, o celular fica mudo e a impressão é de que a mensagem não chegou.
//
// O indicador do Telegram EXPIRA em ~5s (limitação do protocolo), então um disparo único
// sumiria antes do fim do trabalho: é preciso REPETIR. E é preciso um TETO, porque nada
// aqui sabe quando o turno acaba de verdade — a resposta pode sair por `telegram_send` (e
// aí o batimento para), mas também pode não sair nunca: turno que falha, que responde só
// no terminal, ou que o dono interrompe. Sem teto, o "digitando" viraria mentira eterna.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { TelegramBridge } from '../../src/connector/telegram-bridge.js';

const META = { id: 'telegram', nome: 'Telegram' };

function ponte(extra: Record<string, unknown> = {}) {
  return new TelegramBridge({
    connectorFactory: () =>
      ({
        meta: META,
        async *incoming() {
          /* o teste chama `route` direto */
        },
        async send() {
          return true;
        },
      }) as never,
    allowlist: new Set(['42']),
    sink: { injectInstruction: vi.fn(), injectData: vi.fn() },
    redactor: { safeForLog: (t: string) => t },
    log: () => {},
    ...extra,
  } as never);
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

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('digitando — o canal mostra que há trabalho em curso', () => {
  it('instrução AUTORIZADA ⇒ dispara JÁ, antes de o modelo pensar', () => {
    const digitando = vi.fn();
    ponte({ digitando }).route(msg());
    expect(digitando).toHaveBeenCalledWith(42);
  });

  it('REPETE enquanto o trabalho dura (o indicador expira em ~5s)', () => {
    const digitando = vi.fn();
    ponte({ digitando }).route(msg());
    expect(digitando).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(12_000); // ~3 batimentos de 4s
    expect(digitando.mock.calls.length, 'um disparo só sumiria em 5s').toBeGreaterThan(1);
  });

  it('tem TETO — não fica "digitando" para sempre quando a resposta nunca sai', () => {
    const digitando = vi.fn();
    ponte({ digitando }).route(msg());
    vi.advanceTimersByTime(10 * 60_000); // dez minutos
    const total = digitando.mock.calls.length;
    vi.advanceTimersByTime(10 * 60_000); // mais dez
    expect(digitando.mock.calls.length, 'parou de bater — o teto cortou').toBe(total);
  });

  it('mensagem DESCARTADA não dispara (não há trabalho a anunciar)', () => {
    const digitando = vi.fn();
    new TelegramBridge({
      connectorFactory: () =>
        ({ meta: META, async *incoming() {}, send: async () => true }) as never,
      allowlist: new Set(['999']), // 42 fica de fora ⇒ discard
      sink: { injectInstruction: vi.fn(), injectData: vi.fn() },
      redactor: { safeForLog: (t: string) => t },
      log: () => {},
      digitando,
    } as never).route(msg());
    expect(digitando).not.toHaveBeenCalled();
  });

  it('`stop()` da ponte encerra o batimento (sem timer órfão)', () => {
    const digitando = vi.fn();
    const b = ponte({ digitando });
    b.route(msg());
    b.stop();
    const antes = digitando.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    expect(digitando.mock.calls.length).toBe(antes);
  });

  it('sem a porta `digitando` nada quebra (zero regressão)', () => {
    expect(() => ponte().route(msg())).not.toThrow();
  });
});

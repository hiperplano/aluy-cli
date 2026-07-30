// F-WIN (descoberta) — ADOÇÃO, na sessão VIVA, da janela que a descoberta automática
// leu do próprio provider (`GET {baseUrl}/models`). Companheiro de
// `context-window-byo-wiring.test.ts` (que prova o fio da janela DECLARADA); aqui o que
// se prova é o que a DESCOBERTA acrescenta e, principalmente, o que ela NÃO pode fazer:
//
//   - janela desconhecida (o BYO de quem nunca editou o config) ⇒ a descoberta LIGA a
//     proteção sem reiniciar a sessão (⛁ % passa a medir, size-aware do Compactor liga);
//   - janela JÁ conhecida (tier real, env, `config.context.window`, `contextByModel`
//     escrito à mão) ⇒ a descoberta NÃO a rebaixa nem a sobrepõe: um dado da REDE não
//     derruba o que o dono/tier declarou;
//   - a descoberta SOBREVIVE ao `/model` (que re-resolve pelo snapshot do config, cego
//     ao que foi gravado depois do boot);
//   - o F134 segue verdadeiro: SEM descoberta, janela desconhecida continua desligando
//     o size-aware do Compactor (o fail-safe é preservado, não suprimido).

import { describe, expect, it } from 'vitest';
import type { ModelClient } from '@hiperplano/aluy-cli-core';
import { buildSession, type BuildSessionOptions } from '../../src/session/wiring.js';
import type { SessionController } from '../../src/session/controller.js';

/** Broker stub com trailer de `usage` (o `tokens_in` é o numerador do `windowPct`). */
function stubBroker(tokensIn: number): ModelClient {
  return {
    async *stream() {
      yield { type: 'start' as const, id: 'r' };
      yield { type: 'delta' as const, content: 'ok.' };
      yield {
        type: 'usage' as const,
        usage: { request_id: 'r', tier: 'custom', tokens_in: tokensIn, tokens_out: 10 },
      };
      yield { type: 'done' as const, id: 'r' };
    },
    async call() {
      return {
        request_id: 'r',
        content: 'ok.',
        finish_reason: 'stop' as const,
        usage: { request_id: 'r', tier: 'custom', tokens_in: tokensIn, tokens_out: 10 },
      };
    },
  };
}

/** Janela EFETIVA que o controller está usando (campo privado — prova de fio). */
function windowOf(controller: SessionController): number {
  return (controller as unknown as { contextWindow: number }).contextWindow;
}

/** Orçamento window-relativo do Compactor (0 ⇒ size-aware DESLIGADO, F134). */
function maxRecentOf(controller: SessionController): number {
  return (controller as unknown as { compactor: { maxRecentTokens: number } }).compactor
    .maxRecentTokens;
}

/** Boot BYO típico: backend local + tier `custom` (o cenário do bug). */
function bootByo(extra: Partial<BuildSessionOptions> = {}, tokensIn = 64_000) {
  return buildSession({
    effectiveBackend: 'local',
    tier: 'custom',
    brokerClient: stubBroker(tokensIn),
    ...extra,
  });
}

describe('adoptDiscoveredModelWindow — a descoberta chegando na sessão viva', () => {
  it('janela DESCONHECIDA ⇒ adota, o ⛁ % passa a medir e o Compactor liga', async () => {
    const s = bootByo({ activeProviderId: 'tokenrouter', activeModelSlug: 'zai/glm-4.6' });
    // O estado de HOJE p/ quem nunca editou o config: inerte.
    expect(windowOf(s.controller)).toBe(0);
    expect(maxRecentOf(s.controller)).toBe(0);

    expect(s.controller.adoptDiscoveredModelWindow('zai/glm-4.6', 128_000)).toBe(true);

    expect(windowOf(s.controller)).toBe(128_000);
    // Os orçamentos window-relativos acompanham (senão a compactação dimensionaria por
    // uma janela e a barra falaria de outra).
    expect(maxRecentOf(s.controller)).toBe(Math.floor(128_000 * 0.4));
    await s.controller.submit('oi');
    expect(s.controller.current.meta.windowPct).toBe(50); // 64k / 128k
  });

  it('NÃO sobrepõe janela DECLARADA no config (o número escrito à mão manda)', () => {
    const s = bootByo({
      providerWindows: [{ id: 'p', contextByModel: { 'x/y': 128_000 } }],
      activeProviderId: 'p',
      activeModelSlug: 'x/y',
    });
    expect(s.controller.adoptDiscoveredModelWindow('x/y', 32_000)).toBe(false);
    expect(windowOf(s.controller)).toBe(128_000);
  });

  it('NÃO sobrepõe janela de TIER canônico (o catálogo do broker segue soberano)', () => {
    const s = buildSession({ tier: 'aluy-strata', brokerClient: stubBroker(1_000) });
    expect(windowOf(s.controller)).toBe(128_000);
    expect(s.controller.adoptDiscoveredModelWindow('qualquer/slug', 1_000_000)).toBe(false);
    expect(windowOf(s.controller)).toBe(128_000);
  });

  it('recusa valores inválidos (provider mentiroso / bug do agregador)', () => {
    const s = bootByo({ activeModelSlug: 'x/y' });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(s.controller.adoptDiscoveredModelWindow('x/y', bad)).toBe(false);
    }
    expect(s.controller.adoptDiscoveredModelWindow('  ', 128_000)).toBe(false);
    expect(windowOf(s.controller)).toBe(0);
  });

  it('a descoberta SOBREVIVE ao `/model` p/ o mesmo slug (snapshot do config é cego a ela)', () => {
    const s = bootByo({ activeProviderId: 'p', activeModelSlug: 'x/y' });
    s.controller.adoptDiscoveredModelWindow('x/y', 200_000);
    expect(windowOf(s.controller)).toBe(200_000);
    // `/model` p/ OUTRO slug (sem janela) ⇒ volta a 0, como sempre (não herda).
    s.controller.setTier('custom', 'outro/slug');
    expect(windowOf(s.controller)).toBe(0);
    // ...e VOLTANDO ao slug descoberto, a janela é reencontrada (casamento
    // case-insensitive, como o `modelWindowFromConfig`).
    s.controller.setTier('custom', 'X/Y');
    expect(windowOf(s.controller)).toBe(200_000);
  });

  it('F134 preservado — SEM descoberta, janela desconhecida segue desligando o size-aware', () => {
    const s = buildSession({ tier: 'aluy-strata', brokerClient: stubBroker(1_000) });
    expect(maxRecentOf(s.controller)).toBeGreaterThan(0);
    s.controller.setTier('custom', 'x/y'); // nada descoberto p/ este slug
    expect(windowOf(s.controller)).toBe(0);
    expect(maxRecentOf(s.controller)).toBe(0);
  });
});

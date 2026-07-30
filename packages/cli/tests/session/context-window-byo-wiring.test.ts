// F-WIN — PROVA DE FIO da JANELA DO MODELO (BYO) resolvida no BOOT.
//
// O bug: no backend LOCAL/BYO o tier é o literal `custom`, e
// `contextWindowForTier('custom')` devolve 0 POR DESIGN ("janela imprevisível"). Com
// janela 0 o `⛁ % janela` da status bar CONGELA (a guarda `contextWindow > 0` do
// `onUsage` nunca passa ⇒ `windowPct` fica em 0%) e a auto-compactação fica INERTE
// (`decideAutoCompact` sai em `contextWindow <= 0`) — sessão longa sem rede de segurança.
//
// As peças da correção (o `contextByModel` no config sanitizado, o
// `modelWindowFromConfig` e o re-resolve do `setTier`) já existiam mas estavam INERTES:
// NINGUÉM as alimentava no boot, então o controller nascia com a janela do TIER. Este
// arquivo prova o FIO: `buildSession` → `resolveContextWindow(..., modelWindow)` →
// `SessionController.contextWindow` → `meta.windowPct` medindo de verdade.
//
// O fail-safe segue intocado: sem NADA declarado a janela continua 0 (é o que o F134
// —"trocar p/ Custom (janela 0) DESLIGA o size-aware do Compactor"— exige), e tier
// CANÔNICO segue resolvendo pelo catálogo/fallback (o caminho broker não muda).

import { describe, expect, it } from 'vitest';
import type { ModelClient } from '@hiperplano/aluy-cli-core';
import { buildSession, type BuildSessionOptions } from '../../src/session/wiring.js';
import type { SessionController } from '../../src/session/controller.js';

/**
 * Broker stub que emite um turno curto e um trailer de `usage` com o `tokens_in`
 * pedido — é o prompt do turno, o NUMERADOR do `windowPct` (F11).
 */
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

/** Lê a janela EFETIVA que o controller recebeu no boot (campo privado — prova de fio). */
function windowOf(controller: SessionController): number {
  return (controller as unknown as { contextWindow: number }).contextWindow;
}

/** Boot BYO típico: backend local + tier `custom` (o cenário do bug). */
function bootByo(extra: Partial<BuildSessionOptions>, tokensIn = 64_000) {
  return buildSession({
    effectiveBackend: 'local',
    tier: 'custom',
    brokerClient: stubBroker(tokensIn),
    ...extra,
  });
}

describe('F-WIN — janela do MODELO (BYO) resolvida no boot (buildSession)', () => {
  it('AC a — `contextByModel` declarado p/ o slug ativo ⇒ boot resolve a janela e o windowPct MEDE', async () => {
    const s = bootByo({
      providerWindows: [{ id: 'tokenrouter', contextByModel: { 'zai/glm-4.6': 128_000 } }],
      activeProviderId: 'tokenrouter',
      activeModelSlug: 'zai/glm-4.6',
    });

    // A janela SAIU do config e chegou ao controller (antes: 0, por causa de `custom`).
    expect(windowOf(s.controller)).toBe(128_000);

    // E ela é o DENOMINADOR real: 64k de prompt / 128k de janela = 50%.
    await s.controller.submit('oi');
    expect(s.controller.current.meta.windowPct).toBe(50);
  });

  it('AC b — SEM nada declarado, a janela segue 0 (fail-safe do F134) e o windowPct não mede', async () => {
    const s = bootByo({});
    expect(windowOf(s.controller)).toBe(0);
    await s.controller.submit('oi');
    // Janela DESCONHECIDA ⇒ `windowPct` NÃO é calculado (senão 100% espúrio — EST-1015).
    expect(s.controller.current.meta.windowPct).toBe(0);
  });

  it('AC b — `providerWindows` declarado mas SEM o slug ativo ⇒ segue 0 (não inventa janela)', () => {
    const s = bootByo({
      providerWindows: [{ id: 'tokenrouter', contextByModel: { 'outro/modelo': 128_000 } }],
      activeProviderId: 'tokenrouter',
      activeModelSlug: 'zai/glm-4.6',
    });
    expect(windowOf(s.controller)).toBe(0);
  });

  it('o provider ATIVO desambigua o MESMO slug declarado em providers diferentes', () => {
    const providerWindows = [
      { id: 'provider-a', contextByModel: { 'x/y': 32_000 } },
      { id: 'provider-b', contextByModel: { 'x/y': 262_144 } },
    ];
    const a = bootByo({ providerWindows, activeProviderId: 'provider-a', activeModelSlug: 'x/y' });
    const b = bootByo({ providerWindows, activeProviderId: 'provider-b', activeModelSlug: 'x/y' });
    expect(windowOf(a.controller)).toBe(32_000);
    expect(windowOf(b.controller)).toBe(262_144);
  });

  it('tier CANÔNICO não é afetado — o catálogo/fallback do broker segue mandando', () => {
    // Mesmo com uma janela declarada p/ o slug, `aluy-strata` resolve pelo fallback (128k):
    // o tier CONHECIDO vence, o degrau do modelo só existe p/ quando ele devolve 0.
    const s = buildSession({
      tier: 'aluy-strata',
      brokerClient: stubBroker(1_000),
      providerWindows: [{ id: 'p', contextByModel: { 'x/y': 999 } }],
      activeProviderId: 'p',
      activeModelSlug: 'x/y',
    });
    expect(windowOf(s.controller)).toBe(128_000);
  });

  it('`config.context.window` (override explícito do usuário) VENCE a janela do modelo', () => {
    const s = bootByo({
      context: { window: 50_000 },
      providerWindows: [{ id: 'p', contextByModel: { 'x/y': 128_000 } }],
      activeProviderId: 'p',
      activeModelSlug: 'x/y',
    });
    expect(windowOf(s.controller)).toBe(50_000);
  });

  it('`ALUY_CONTEXT_WINDOW` (env) segue vencendo a janela do modelo (precedência intacta)', () => {
    const s = bootByo({
      env: { ALUY_CONTEXT_WINDOW: '64k' } as NodeJS.ProcessEnv,
      providerWindows: [{ id: 'p', contextByModel: { 'x/y': 128_000 } }],
      activeProviderId: 'p',
      activeModelSlug: 'x/y',
    });
    expect(windowOf(s.controller)).toBe(64_000);
  });

  it('o catálogo de janelas CHEGA ao controller — `setTier` p/ outro slug RE-RESOLVE', () => {
    const s = bootByo({
      providerWindows: [{ id: 'p', contextByModel: { 'x/pequeno': 32_000, 'x/grande': 262_144 } }],
      activeProviderId: 'p',
      activeModelSlug: 'x/pequeno',
    });
    expect(windowOf(s.controller)).toBe(32_000);
    // `/model x/grande` numa sessão VIVA: a janela acompanha o slug novo (sem reiniciar).
    s.controller.setTier('custom', 'x/grande');
    expect(windowOf(s.controller)).toBe(262_144);
    // Slug SEM janela declarada ⇒ volta a 0/inerte (fail-safe, nunca herda a anterior).
    s.controller.setTier('custom', 'x/desconhecido');
    expect(windowOf(s.controller)).toBe(0);
  });

  it('BASELINE — boot sem NENHUMA das opções novas monta igual (zero regressão)', () => {
    const s = buildSession({ brokerClient: stubBroker(1_000) });
    expect(s.controller).toBeDefined();
    // `aluy-flux` (DEFAULT_TIER) ⇒ 256k do fallback, exatamente como antes.
    expect(windowOf(s.controller)).toBe(256_000);
  });
});

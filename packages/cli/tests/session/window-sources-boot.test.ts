// F-WIN — `resolveWindowSources` (run.tsx): quais FONTES da janela do modelo o BOOT
// entrega ao `buildSession`. É a metade que faltava do fio: `wiring.ts` sabia resolver a
// janela a partir de `providerWindows`/`activeProviderId`/`activeModelSlug`, mas NINGUÉM
// preenchia esses campos — então em BYO (tier `custom` ⇒ janela 0) o `⛁ % janela`
// congelava em 0% e a auto-compactação ficava INERTE mesmo com o dono tendo declarado a
// janela em `providers[].contextByModel`.
//
// PURO (sem I/O): o que se prova aqui é a SELEÇÃO/precedência das fontes, não a
// aritmética da janela (essa é do `catalog.ts`/`context-window-byo-wiring.test.ts`).

import { describe, expect, it } from 'vitest';
import { resolveWindowSources } from '../../src/session/run.js';
import type { UserConfig, UserProviderEntry } from '../../src/io/user-config.js';

/** Entrada de provider mínima e BEM-FORMADA (o `sanitize` do config exige estes campos). */
function provider(over: Partial<UserProviderEntry> & { id: string }): UserProviderEntry {
  return {
    wireFormat: 'openai-compat',
    baseUrl: 'http://127.0.0.1:1234/v1',
    defaultModel: 'zai/glm-4.6',
    ...over,
  };
}

describe('F-WIN — resolveWindowSources (fontes da janela no boot)', () => {
  it('config VAZIO ⇒ NADA sai (a janela cai nos degraus de sempre e, sem nada, em 0/inerte)', () => {
    expect(resolveWindowSources({ backend: 'local', config: {} })).toEqual({});
  });

  it('BYO típico — `providers[]` + `localProvider` + `localModel` viram as 3 fontes', () => {
    const config: UserConfig = {
      localProvider: 'tokenrouter',
      localModel: 'zai/glm-4.6',
      providers: [provider({ id: 'tokenrouter', contextByModel: { 'zai/glm-4.6': 200_000 } })],
    };
    const out = resolveWindowSources({ backend: 'local', config });
    expect(out.providerWindows).toBe(config.providers); // repassa o array já sanitizado
    expect(out.activeProviderId).toBe('tokenrouter');
    expect(out.activeModelSlug).toBe('zai/glm-4.6');
  });

  it('o RESOLVIDO do boot vence o config cru (precedência flag>env>config já aplicada)', () => {
    const out = resolveWindowSources({
      backend: 'local',
      config: { localProvider: 'ollama', localModel: 'do-config' },
      resolvedLocalProvider: 'tokenrouter',
      resolvedLocalModel: 'do-boot',
    });
    expect(out.activeProviderId).toBe('tokenrouter');
    expect(out.activeModelSlug).toBe('do-boot');
  });

  it('sem o bloco local (broker injetado em teste) ⇒ `--local-model` vence o config', () => {
    const out = resolveWindowSources({
      backend: 'local',
      config: { localModel: 'do-config' },
      flagLocalModel: 'da-flag',
    });
    expect(out.activeModelSlug).toBe('da-flag');
  });

  it('backend BROKER ⇒ NÃO usa `localModel` como slug ativo (seria o modelo ERRADO)', () => {
    // Sob broker o slug ativo é o Custom (`opts.model`, que o `buildSession` já conhece);
    // vazar o `localModel` do BYO aqui mostraria a janela de um modelo que nem está em uso.
    const out = resolveWindowSources({
      backend: 'broker',
      config: { localProvider: 'tokenrouter', localModel: 'zai/glm-4.6', providers: [] },
    });
    expect(out.activeModelSlug).toBeUndefined();
    // O provider e o catálogo seguem indo: uma declaração casada pelo slug Custom continua valendo.
    expect(out.activeProviderId).toBe('tokenrouter');
  });

  it('strings VAZIAS/em branco não viram fonte (não geram casamento espúrio)', () => {
    const out = resolveWindowSources({
      backend: 'local',
      config: { localProvider: '   ', localModel: '' },
      resolvedLocalModel: '  ',
    });
    expect(out.activeProviderId).toBeUndefined();
    expect(out.activeModelSlug).toBeUndefined();
  });

  it('`providers` ausente ⇒ sem `providerWindows` (nunca inventa um array vazio)', () => {
    const out = resolveWindowSources({
      backend: 'local',
      config: { localProvider: 'p', localModel: 'm' },
    });
    expect('providerWindows' in out).toBe(false);
  });
});

// Cobertura de leva de coverage-sweep: splash-controller.test.tsx já cobre o
// <SplashApp> via ink-testing-library (render/single-key/status), mas as funções
// PURAS do módulo — resolveSplashMinMs, os 3 ramos de parseBootPrompt, e o store
// observável createSplashStore — não tinham teste direto (só indiretamente via
// UMA integração de parseBootPrompt). `createBootSplash`/`BootSplash` (que monta
// Ink de verdade via `render()`) fica FORA — mesma fronteira arquitetural do
// App.tsx (shell de composição/mount, não lógica pura). Arquivo SEPARADO — não
// edita o teste alheio existente.

import { describe, expect, it } from 'vitest';
import {
  resolveSplashMinMs,
  parseBootPrompt,
  createSplashStore,
} from '../../src/session/splash-controller.js';

describe('resolveSplashMinMs — piso de exibição do splash', () => {
  it('sem ALUY_SPLASH_MIN_MS ⇒ default 2000', () => {
    expect(resolveSplashMinMs({})).toBe(2000);
  });

  it('ALUY_SPLASH_MIN_MS válido ⇒ usa o valor', () => {
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: '500' })).toBe(500);
  });

  it('ALUY_SPLASH_MIN_MS="0" ⇒ desliga o piso (0 é válido)', () => {
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: '0' })).toBe(0);
  });

  it('ALUY_SPLASH_MIN_MS negativo ⇒ ignora, cai no default', () => {
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: '-10' })).toBe(2000);
  });

  it('ALUY_SPLASH_MIN_MS não-numérico ⇒ ignora, cai no default', () => {
    expect(resolveSplashMinMs({ ALUY_SPLASH_MIN_MS: 'abacate' })).toBe(2000);
  });
});

describe('parseBootPrompt — os 3 ramos (título/opções por conteúdo)', () => {
  it('texto com "YOLO" ⇒ caixa de aviso YOLO', () => {
    const p = parseBootPrompt('⚠ ativar modo YOLO — sem confirmações? [s/N]');
    expect(p.title).toBe('⚠ modo YOLO');
    expect(p.options).toContain('YOLO');
    expect(p.body.join('\n')).not.toContain('[s/N]');
  });

  it('texto com "retomar" ⇒ caixa de retomada de sessão', () => {
    const p = parseBootPrompt('↻ retomar a conversa anterior (3 mensagens)? [S/n]');
    expect(p.title).toBe('↻ retomar sessão');
    expect(p.options).toContain('retomar');
  });

  it('texto genérico (nem YOLO nem retomar) ⇒ caixa fallback padrão', () => {
    const p = parseBootPrompt('confirma a operação? [s/N]');
    expect(p.title).toBe('aluy');
    expect(p.options).toBe('[s] sim · [n] não');
  });

  it('corpo multi-linha preserva as linhas, descarta vazias do FIM só', () => {
    const p = parseBootPrompt('linha 1\nlinha 2\n\n');
    expect(p.body).toEqual(['linha 1', 'linha 2']);
  });
});

describe('createSplashStore — store observável fininho', () => {
  it('get() inicial: carregando, sem prompt, não done', () => {
    const s = createSplashStore();
    expect(s.get()).toEqual({ status: 'carregando', prompt: undefined, resolve: null, done: false });
  });

  it('set() atualiza o estado e NOTIFICA os listeners inscritos', () => {
    const s = createSplashStore();
    let notified = 0;
    s.subscribe(() => notified++);
    s.set((st) => ({ ...st, status: 'descobrindo MCP' }));
    expect(s.get().status).toBe('descobrindo MCP');
    expect(notified).toBe(1);
  });

  it('unsubscribe (devolvido por subscribe) para de notificar', () => {
    const s = createSplashStore();
    let notified = 0;
    const unsub = s.subscribe(() => notified++);
    unsub();
    s.set((st) => ({ ...st, status: 'x' }));
    expect(notified).toBe(0);
  });

  it('múltiplos listeners são todos notificados por um set()', () => {
    const s = createSplashStore();
    let a = 0;
    let b = 0;
    s.subscribe(() => a++);
    s.subscribe(() => b++);
    s.set((st) => ({ ...st, status: 'y' }));
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

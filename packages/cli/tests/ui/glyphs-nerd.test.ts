// F-NERD-GLYPHS — perfil opt-in Nerd Font (pedido do dono: "fontes mais robustas
// tipo do opencode"). Um app de terminal NÃO escolhe a fonte (isso é do emulador);
// o que ele controla é o CONJUNTO DE GLIFOS pedido a ela. Estes testes travam:
// (1) o perfil NUNCA liga sozinho — só com env/override explícito; (2) a
// precedência ASCII (TERM=linux) > SAFE > NERD > normal, mesmo pedindo NERD;
// (3) NERD_GLYPHS é um Record COMPLETO (toda chave de GlyphName tem par); e
// (4) não-regressão: quem não pediu NERD nunca recebe um glifo novo.

import { describe, expect, it } from 'vitest';
import { resolveTheme, detectNerdGlyphs } from '../../src/ui/theme/theme.js';
import { UNICODE_GLYPHS, SAFE_GLYPHS, NERD_GLYPHS, ASCII_GLYPHS } from '../../src/ui/theme/glyphs.js';

const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };

describe('detectNerdGlyphs — MESMA disciplina do detectSafeGlyphs', () => {
  it('default (sem env, sem override) ⇒ false', () => {
    expect(detectNerdGlyphs({})).toBe(false);
  });

  it('ALUY_NERD_GLYPHS=1 liga; override explícito vence o env', () => {
    expect(detectNerdGlyphs({ ALUY_NERD_GLYPHS: '1' })).toBe(true);
    expect(detectNerdGlyphs({ ALUY_NERD_GLYPHS: '1' }, false)).toBe(false); // override desliga
    expect(detectNerdGlyphs({}, true)).toBe(true); // override liga sem env
  });

  it('valores "falsy" de env (vazio/0/false) não ligam', () => {
    expect(detectNerdGlyphs({ ALUY_NERD_GLYPHS: '0' })).toBe(false);
    expect(detectNerdGlyphs({ ALUY_NERD_GLYPHS: 'false' })).toBe(false);
  });
});

describe('NERD_GLYPHS — Record completo (toda chave do perfil normal tem par)', () => {
  it('mesmo conjunto de chaves que UNICODE_GLYPHS (nenhuma faltando, nenhuma sobrando)', () => {
    const normalKeys = Object.keys(UNICODE_GLYPHS).sort();
    const nerdKeys = Object.keys(NERD_GLYPHS).sort();
    expect(nerdKeys).toEqual(normalKeys);
  });

  it('todo valor é uma string não-vazia (sem chave esquecida como "")', () => {
    for (const [name, glyph] of Object.entries(NERD_GLYPHS)) {
      expect(typeof glyph).toBe('string');
      expect(glyph.length, `NERD_GLYPHS.${name} está vazio`).toBeGreaterThan(0);
    }
  });

  it('as TROCAS documentadas resolvem para os codepoints Nerd Font certos', () => {
    expect(NERD_GLYPHS.ask.codePointAt(0)).toBe(0xf071); // nf-fa-exclamation_triangle
    expect(NERD_GLYPHS.ok.codePointAt(0)).toBe(0xf00c); // nf-fa-check
    expect(NERD_GLYPHS.err.codePointAt(0)).toBe(0xf00d); // nf-fa-times
    expect(NERD_GLYPHS.clock.codePointAt(0)).toBe(0xf017); // nf-fa-clock_o
    expect(NERD_GLYPHS.branch.codePointAt(0)).toBe(0xe0a0); // nf-pl-branch
    expect(NERD_GLYPHS.prompt.codePointAt(0)).toBe(0xe0b1); // nf-pl-right_soft_divider
  });

  it('onde não há ganho claro, NERD mantém o MESMO glifo do perfil normal', () => {
    // amostra de chaves que NÃO fazem parte da lista de trocas — nenhuma diferença.
    const untouched: (keyof typeof UNICODE_GLYPHS)[] = [
      'you',
      'aluy',
      'tool',
      'toolInflight',
      'wave',
      'waveHead',
      'broker',
      'gauge',
      'window',
      'diffDel',
      'diffAdd',
      'cursor',
      'thinkingCursor',
      'planMode',
      'normalMode',
      'subagents',
      'sessionDot',
      'barFull',
      'barEmpty',
      'pulseBlock',
      'sidecar',
    ];
    for (const key of untouched) {
      expect(NERD_GLYPHS[key], `chave ${key} deveria ser idêntica ao perfil normal`).toBe(
        UNICODE_GLYPHS[key],
      );
    }
  });

  it('as 6 trocas realmente diferem do perfil normal (a troca não é cosmética/nula)', () => {
    const changed: (keyof typeof UNICODE_GLYPHS)[] = [
      'ask',
      'ok',
      'err',
      'clock',
      'branch',
      'prompt',
    ];
    for (const key of changed) {
      expect(NERD_GLYPHS[key], `chave ${key} deveria diferir do perfil normal`).not.toBe(
        UNICODE_GLYPHS[key],
      );
    }
  });
});

describe('resolveTheme — perfil NERD é opt-in e respeita a precedência', () => {
  it('sem pedir nada, o NERD nunca liga sozinho (default segue Unicode normal)', () => {
    const t = resolveTheme({ env: UTF8 });
    expect(t.nerdGlyphs).toBe(false);
    expect(t.glyph('ok')).toBe('✔'); // F-GLYPH-PESO-2: ✓→✔
    expect(t.glyph('branch')).toBe('⎇');
  });

  it('ALUY_NERD_GLYPHS=1 em UTF-8 ⇒ liga NERD e resolve os glifos trocados', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_NERD_GLYPHS: '1' } });
    expect(t.unicode).toBe(true);
    expect(t.nerdGlyphs).toBe(true);
    expect(t.safeGlyphs).toBe(false);
    expect(t.glyph('ok')).toBe(NERD_GLYPHS.ok);
    expect(t.glyph('err')).toBe(NERD_GLYPHS.err);
    expect(t.glyph('ask')).toBe(NERD_GLYPHS.ask);
    expect(t.glyph('clock')).toBe(NERD_GLYPHS.clock);
    expect(t.glyph('branch')).toBe(NERD_GLYPHS.branch);
    expect(t.glyph('prompt')).toBe(NERD_GLYPHS.prompt);
    // uma chave NÃO trocada segue igual ao normal mesmo com NERD ligado.
    expect(t.glyph('window')).toBe('■'); // F-GLYPH-PESO-2: □→■
  });

  it('override `nerdGlyphs: true` liga o perfil mesmo sem o env (canal da config)', () => {
    const t = resolveTheme({ env: UTF8, nerdGlyphs: true });
    expect(t.nerdGlyphs).toBe(true);
    expect(t.glyph('ok')).toBe(NERD_GLYPHS.ok);
  });

  it('override `nerdGlyphs: false` desliga mesmo com o env pedindo', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_NERD_GLYPHS: '1' }, nerdGlyphs: false });
    expect(t.nerdGlyphs).toBe(false);
    expect(t.glyph('ok')).toBe('✔'); // F-GLYPH-PESO-2: ✓→✔
  });

  it('TERM=linux (ASCII puro) VENCE mesmo pedindo NERD — nunca entrega Nerd Font', () => {
    const t = resolveTheme({ env: { TERM: 'linux', ALUY_NERD_GLYPHS: '1' } });
    expect(t.unicode).toBe(false);
    expect(t.nerdGlyphs).toBe(false);
    expect(t.glyph('ok')).toBe('[ok]'); // conjunto ASCII, não o check da Nerd Font
    expect(t.glyph('ok')).toBe(ASCII_GLYPHS.ok);
  });

  it('locale não-UTF-8 (ASCII) também vence mesmo com override explícito de NERD', () => {
    const t = resolveTheme({ env: { LANG: 'C', TERM: 'xterm' }, nerdGlyphs: true });
    expect(t.unicode).toBe(false);
    expect(t.nerdGlyphs).toBe(false);
  });

  it('SAFE_GLYPHS VENCE sobre NERD quando os dois são pedidos ao mesmo tempo', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_SAFE_GLYPHS: '1', ALUY_NERD_GLYPHS: '1' } });
    expect(t.unicode).toBe(true);
    expect(t.safeGlyphs).toBe(true);
    expect(t.nerdGlyphs).toBe(false); // SAFE venceu — NERD não ligou
    expect(t.glyph('ok')).toBe(SAFE_GLYPHS.ok);
    expect(t.glyph('ok')).not.toBe(NERD_GLYPHS.ok);
  });

  it('mesma precedência com os dois overrides explícitos (safeGlyphs vence nerdGlyphs)', () => {
    const t = resolveTheme({ env: UTF8, safeGlyphs: true, nerdGlyphs: true });
    expect(t.safeGlyphs).toBe(true);
    expect(t.nerdGlyphs).toBe(false);
  });

  it('com NERD ligado, o spinner segue braille (não degrada p/ ASCII só por causa do NERD)', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_NERD_GLYPHS: '1' } });
    expect(t.spinnerFrames).toEqual(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
  });

  it('com NERD ligado, a marca do Aluy (Λ) e o box-drawing não mudam', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_NERD_GLYPHS: '1' } });
    expect(t.aluyMark).toBe('Λ');
    expect(t.box.topLeft).toBe('┏'); // F-GLYPH-PESO-2: moldura esquema B (╭→┏)
  });
});

describe('não-regressão — quem não pediu NERD nunca recebe glifo novo', () => {
  const scenarios: Array<[string, Record<string, string>]> = [
    ['default (dark, unicode)', UTF8],
    ['ansi16', { TERM: 'xterm-256color', LANG: 'pt_BR.UTF-8' }],
    ['mono (NO_COLOR)', { NO_COLOR: '1', ...UTF8 }],
    ['light theme', { ...UTF8 }],
  ];

  it.each(scenarios)('%s ⇒ todos os glifos batem com UNICODE_GLYPHS (sem NERD vazando)', (_label, env) => {
    const t = resolveTheme({ env });
    for (const name of Object.keys(UNICODE_GLYPHS) as (keyof typeof UNICODE_GLYPHS)[]) {
      expect(t.glyph(name)).toBe(UNICODE_GLYPHS[name]);
    }
  });

  it('SAFE_GLYPHS (opt-in existente) continua intacto — F-NERD-GLYPHS não mexeu nele', () => {
    const t = resolveTheme({ env: { ...UTF8, ALUY_SAFE_GLYPHS: '1' } });
    for (const name of Object.keys(SAFE_GLYPHS) as (keyof typeof SAFE_GLYPHS)[]) {
      expect(t.glyph(name)).toBe(SAFE_GLYPHS[name]);
    }
  });
});

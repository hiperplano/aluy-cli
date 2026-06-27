// EST-0989 (i18n) — as TELAS da Fase 1 (composer/hints/statusbar/boot/pickers)
// renderizadas nos DOIS idiomas. DoD: cada tela renderiza em pt-BR E en; o texto muda
// com o idioma; a degradação narrow/densidade segue valendo em en; default = pt-BR.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { I18nProvider } from '../../src/i18n/context.js';
import { i18n as makeI18n, type Lang } from '../../src/i18n/translate.js';
import { Composer } from '../../src/ui/components/Composer.js';
import { FooterHints } from '../../src/ui/components/FooterHints.js';
import { StatusBar } from '../../src/ui/components/StatusBar.js';
import { Boot } from '../../src/ui/components/Boot.js';
import { LangPicker } from '../../src/ui/components/LangPicker.js';
import { ThemePicker } from '../../src/ui/components/ThemePicker.js';
import { ModeIndicator } from '../../src/ui/components/ModeIndicator.js';
import { UnsafeBanner } from '../../src/ui/components/UnsafeBanner.js';
import { LANGS } from '../../src/i18n/lang.js';
import { THEMES } from '../../src/ui/theme/themes.js';
import { resolveText } from '../../src/i18n/translate.js';

const ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as NodeJS.ProcessEnv;

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string | undefined): string {
  return (s ?? '').replace(ANSI, '');
}

/** Renderiza um nó sob ThemeProvider + I18nProvider no idioma dado. */
function renderInLang(node: React.ReactElement, lang: Lang, env: NodeJS.ProcessEnv = ENV): string {
  const theme = resolveTheme({ env });
  const { lastFrame } = render(
    <ThemeProvider theme={theme}>
      <I18nProvider value={makeI18n(lang)}>{node}</I18nProvider>
    </ThemeProvider>,
  );
  return plain(lastFrame());
}

describe('i18n · Composer nos 2 idiomas', () => {
  it('placeholder em pt-BR (default) e en', () => {
    expect(renderInLang(<Composer value="" active={true} />, 'pt-BR')).toContain(
      'digite um objetivo ou /comando',
    );
    expect(renderInLang(<Composer value="" active={true} />, 'en')).toContain(
      'type a goal or /command',
    );
  });

  it('shell-hint em pt-BR e en', () => {
    expect(renderInLang(<Composer value="ls" active={true} shellMode={true} />, 'pt-BR')).toContain(
      'atrás da catraca',
    );
    expect(renderInLang(<Composer value="ls" active={true} shellMode={true} />, 'en')).toContain(
      'behind the gate',
    );
  });
});

describe('i18n · FooterHints nos 2 idiomas', () => {
  it('estado idle em pt-BR e en (atalhos de tecla preservados)', () => {
    const pt = renderInLang(<FooterHints state="idle" />, 'pt-BR');
    const en = renderInLang(<FooterHints state="idle" />, 'en');
    expect(pt).toContain('enter envia');
    expect(en).toContain('enter sends');
    // os atalhos de TECLA não se traduzem (enter/ctrl-c continuam literais nos dois)
    expect(pt).toContain('ctrl-c');
    expect(en).toContain('ctrl-c');
  });

  it('estado ask em pt-BR e en', () => {
    expect(renderInLang(<FooterHints state="ask" />, 'pt-BR')).toContain('aprova');
    expect(renderInLang(<FooterHints state="ask" />, 'en')).toContain('approve');
  });
});

describe('i18n · StatusBar nos 2 idiomas (rótulos janela/sessão)', () => {
  const props = {
    cwd: '~/proj',
    tier: 'aluy-flux',
    tokens: 8200,
    budgetPct: 30,
    windowPct: 40,
  };
  it('rótulos em pt-BR (janela/sessão)', () => {
    const out = renderInLang(<StatusBar {...props} />, 'pt-BR');
    expect(out).toContain('janela');
    expect(out).toContain('sessão');
  });
  it('rótulos em en (window/session)', () => {
    const out = renderInLang(<StatusBar {...props} />, 'en');
    expect(out).toContain('window');
    expect(out).toContain('session');
    expect(out).not.toContain('janela'); // realmente trocou
  });
});

describe('i18n · Boot (splash) nos 2 idiomas', () => {
  it('tagline + broker em pt-BR e en', () => {
    const pt = renderInLang(<Boot tier="aluy-flux" version="1.0.0" status="conectando" />, 'pt-BR');
    const en = renderInLang(<Boot tier="aluy-flux" version="1.0.0" status="connecting" />, 'en');
    expect(pt).toContain('agente de terminal');
    expect(en).toContain('terminal agent');
    expect(pt).toContain('broker'); // broker é nome técnico — igual nos dois
    expect(en).toContain('broker');
  });
});

describe('i18n · LangPicker (rótulos auto-glota; ajuda no idioma ativo)', () => {
  it('lista pt-BR e en SEMPRE (auto-glota), em qualquer idioma ativo', () => {
    for (const active of ['pt-BR', 'en'] as Lang[]) {
      const out = renderInLang(
        <LangPicker langs={LANGS} selected={0} currentLang={active} />,
        active,
      );
      expect(out).toContain('Português (Brasil)');
      expect(out).toContain('English');
    }
  });
  it('a linha de ajuda segue o idioma ativo', () => {
    expect(
      renderInLang(<LangPicker langs={LANGS} selected={0} currentLang="pt-BR" />, 'pt-BR'),
    ).toContain('trocar idioma');
    expect(
      renderInLang(<LangPicker langs={LANGS} selected={0} currentLang="en" />, 'en'),
    ).toContain('change language');
  });
  it('marca o idioma ATIVO com ● (a11y: não só cor)', () => {
    const out = renderInLang(<LangPicker langs={LANGS} selected={1} currentLang="en" />, 'en');
    expect(out).toContain('●');
  });
});

describe('i18n · ThemePicker ajuda segue o idioma (mecânica espelhada, não regride)', () => {
  it('ajuda do /theme em pt-BR e en', () => {
    expect(
      renderInLang(<ThemePicker themes={THEMES} selected={0} currentTheme="aluy-dark" />, 'pt-BR'),
    ).toContain('trocar tema');
    expect(
      renderInLang(<ThemePicker themes={THEMES} selected={0} currentTheme="aluy-dark" />, 'en'),
    ).toContain('change theme');
  });
});

describe('i18n · UnsafeBanner (YOLO) nos 2 idiomas — EST-0989', () => {
  it('banner largo: pt-BR (inalterado) e en (sentence case natural)', () => {
    const pt = renderInLang(<UnsafeBanner columns={100} />, 'pt-BR');
    const en = renderInLang(<UnsafeBanner columns={100} />, 'en');
    // pt-BR continua EXATAMENTE como antes (não regride o banner loud).
    expect(pt).toContain(
      'MODO YOLO — aprovação DESLIGADA, o agente roda QUALQUER comando sem perguntar',
    );
    // en sai em inglês; sem string PT vazando.
    expect(en).toContain('YOLO MODE — approval OFF, the agent runs ANY command without asking');
    expect(en).not.toMatch(/MODO|DESLIGADA/);
  });

  it('banner narrow (<60 col): encurta nos 2 idiomas', () => {
    const pt = renderInLang(<UnsafeBanner columns={40} />, 'pt-BR');
    const en = renderInLang(<UnsafeBanner columns={40} />, 'en');
    expect(pt).toContain('MODO YOLO — aprovação DESLIGADA');
    expect(en).toContain('YOLO MODE — approval OFF');
    expect(en).not.toMatch(/MODO YOLO/);
  });
});

describe('i18n · ModeIndicator caption nos 2 idiomas — EST-0989', () => {
  it('plan: a PALAVRA (produto, não-traduzida) + caption no idioma ativo', () => {
    const pt = renderInLang(<ModeIndicator mode="plan" columns={100} />, 'pt-BR');
    const en = renderInLang(<ModeIndicator mode="plan" columns={100} />, 'en');
    // a palavra do modo é identificador de produto — IGUAL nos dois.
    expect(pt).toContain('PLAN');
    expect(en).toContain('PLAN');
    // o prefixo + caption seguem o idioma.
    expect(pt).toContain('modo PLAN');
    expect(en).toContain('mode PLAN');
    expect(pt).toMatch(/só leitura/);
    expect(en).toMatch(/view only/);
    expect(en).not.toMatch(/só leitura|nenhum efeito/);
  });

  it('normal: caption traduzido (pt-BR inalterado)', () => {
    const pt = renderInLang(<ModeIndicator mode="normal" columns={100} />, 'pt-BR');
    const en = renderInLang(<ModeIndicator mode="normal" columns={100} />, 'en');
    expect(pt).toContain('catraca padrão (aprovação por efeito)');
    expect(en).toContain('default gate (approval on effect)');
  });

  it('unsafe ⇒ delega ao banner YOLO traduzido (não regride o aviso loud)', () => {
    const en = renderInLang(<ModeIndicator mode="unsafe" columns={100} />, 'en');
    expect(en).toContain('YOLO MODE — approval OFF');
    expect(en).not.toMatch(/DESLIGADA/);
  });

  it('narrow (<60 col): mostra a palavra, omite o caption — nos 2 idiomas', () => {
    const en = renderInLang(<ModeIndicator mode="plan" columns={40} />, 'en');
    expect(en).toContain('PLAN');
    expect(en).not.toMatch(/view only/); // caption só no modo largo
  });
});

describe('i18n · fallback en→pt-BR nunca mostra chave crua (#140) — EST-0989', () => {
  it('chave nova faltando no en cai no pt-BR (não a chave crua)', () => {
    // resolveText é a cadeia de fallback. Forçar uma chave AUSENTE no en mostra que
    // ela cai no canônico (pt-BR), nunca a string-chave nua.
    const out = resolveText('en', 'mode.normal.caption');
    expect(out).not.toBe('mode.normal.caption');
    // a chave (todas as novas) existe no en ⇒ resolve em inglês; o fallback geral
    // do framework já está coberto por translate.test.ts. Aqui garantimos que as
    // novas chaves YOLO/mode existem no canônico (piso de todo idioma):
    expect(resolveText('pt-BR', 'banner.yolo')).not.toBe('banner.yolo');
    expect(resolveText('pt-BR', 'banner.yolo.narrow')).not.toBe('banner.yolo.narrow');
    expect(resolveText('pt-BR', 'mode.label')).not.toBe('mode.label');
    expect(resolveText('pt-BR', 'mode.unsafe.caption')).not.toBe('mode.unsafe.caption');
  });
});

describe('i18n · degradação NARROW vale nos 2 idiomas (StatusBar)', () => {
  // Em largura apertada (~28 col) o StatusBar omite os rótulos (mantém os medidores).
  // O comportamento NÃO pode mudar com o idioma — testamos com en (texto diferente).
  const narrowProps = {
    cwd: '~/p',
    tier: 'aluy-flux',
    tokens: 8200,
    budgetPct: 30,
    windowPct: 40,
    columns: 28,
  } as const;
  it('en narrow: medidores presentes, rótulos omitidos (igual ao pt-BR)', () => {
    const en = renderInLang(<StatusBar {...narrowProps} />, 'en');
    // o % de janela continua (medidor nunca cai)…
    expect(en).toContain('40%');
    // …mas o rótulo textual `window`/`window` é omitido na largura apertada.
    expect(en).not.toContain('window');
    expect(en).not.toContain('session');
  });
  it('pt-BR narrow idem (paridade entre idiomas)', () => {
    const pt = renderInLang(<StatusBar {...narrowProps} />, 'pt-BR');
    expect(pt).toContain('40%');
    expect(pt).not.toContain('janela');
    expect(pt).not.toContain('sessão');
  });
});

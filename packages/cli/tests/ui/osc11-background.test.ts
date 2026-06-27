// EST-1010 · /theme — SET/RESET do FUNDO do terminal via OSC 11 (o pedido central:
// mudar o fundo por tema, no web → CLI). Cobre: a sequência SET (`ESC]11;#RRGGBB BEL`)
// do `bg` certo; o RESET no exit (`ESC]111 BEL`); o opt-out `ALUY_SET_BG=0`; NO_COLOR;
// sem-TTY (no-op); idempotência do reset; e que cada TEMA aplica o seu próprio fundo.

import { describe, expect, it } from 'vitest';
import {
  setBackgroundSeq,
  backgroundControlEnabled,
  BackgroundController,
  OSC11_RESET,
  type BackgroundSink,
} from '../../src/ui/theme/osc11.js';
import { THEMES, themeByName } from '../../src/ui/theme/themes.js';

const BEL = '\x07';
const ESC = '\x1b';

/** stdout falso que acumula tudo o que foi escrito (p/ asserir as sequências). */
function fakeStdout(isTTY: boolean): {
  stdout: BackgroundSink['stdout'];
  written: string[];
} {
  const written: string[] = [];
  return {
    written,
    stdout: {
      isTTY,
      write: (s: string) => {
        written.push(s);
        return true;
      },
    } as BackgroundSink['stdout'],
  };
}

describe('setBackgroundSeq — monta a sequência OSC 11 de SET', () => {
  it('hex válido ⇒ ESC]11;#RRGGBB BEL (uppercase, com/sem #)', () => {
    expect(setBackgroundSeq('#F4ECDC')).toBe(`${ESC}]11;#F4ECDC${BEL}`);
    expect(setBackgroundSeq('faf8f5')).toBe(`${ESC}]11;#FAF8F5${BEL}`);
    expect(setBackgroundSeq('  #0e0c09  ')).toBe(`${ESC}]11;#0E0C09${BEL}`);
  });
  it('hex inválido ⇒ string vazia (não emite lixo)', () => {
    expect(setBackgroundSeq('vermelho')).toBe('');
    expect(setBackgroundSeq('#fff')).toBe(''); // só aceita 6 dígitos
    expect(setBackgroundSeq('')).toBe('');
  });
});

describe('backgroundControlEnabled — opt-out e a11y', () => {
  it('default (sem env) ⇒ ligado (muda o fundo por tema)', () => {
    expect(backgroundControlEnabled({})).toBe(true);
  });
  it('ALUY_SET_BG=0/false/no/off ⇒ desligado (opt-out)', () => {
    for (const v of ['0', 'false', 'no', 'off', 'FALSE', 'Off']) {
      expect(backgroundControlEnabled({ ALUY_SET_BG: v })).toBe(false);
    }
  });
  it('ALUY_SET_BG=1 ⇒ ligado', () => {
    expect(backgroundControlEnabled({ ALUY_SET_BG: '1' })).toBe(true);
  });
  it('NO_COLOR ⇒ desligado (não impõe fundo a quem pediu sem-cor)', () => {
    expect(backgroundControlEnabled({ NO_COLOR: '1' })).toBe(false);
    expect(backgroundControlEnabled({ NO_COLOR: '' })).toBe(false);
  });
});

describe('BackgroundController — aplica no boot/troca, reseta no exit', () => {
  it('apply emite o SET do bg; reset emite ESC]111 BEL', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: {} });
    expect(bg.active).toBe(true);

    const light = themeByName('aluy-light')!;
    const seq = bg.apply(light.bg);
    expect(seq).toBe(`${ESC}]11;#F4ECDC${BEL}`);
    expect(written).toEqual([`${ESC}]11;#F4ECDC${BEL}`]);

    const r = bg.reset();
    expect(r).toBe(OSC11_RESET);
    expect(OSC11_RESET).toBe(`${ESC}]111${BEL}`);
    expect(written).toEqual([`${ESC}]11;#F4ECDC${BEL}`, OSC11_RESET]);
  });

  it('cada TEMA aplica o SEU fundo (os 3 do web)', () => {
    const expectByName: Record<string, string> = {
      'aluy-dark': '#070707',
      'aluy-light': '#F4ECDC',
      'aluy-slate': '#0E0C09',
    };
    for (const theme of THEMES) {
      const { stdout, written } = fakeStdout(true);
      const bg = new BackgroundController({ stdout, env: {} });
      bg.apply(theme.bg);
      expect(written[0]).toBe(`${ESC}]11;${expectByName[theme.name]}${BEL}`);
    }
  });

  it('TROCA de tema reaplica (1 sequência por troca, não por frame)', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: {} });
    bg.apply(themeByName('aluy-dark')!.bg);
    bg.apply(themeByName('aluy-slate')!.bg);
    bg.apply(themeByName('aluy-light')!.bg);
    expect(written).toEqual([
      `${ESC}]11;#070707${BEL}`,
      `${ESC}]11;#0E0C09${BEL}`,
      `${ESC}]11;#F4ECDC${BEL}`,
    ]);
  });

  it('ALUY_SET_BG=0 ⇒ NÃO emite NENHUM OSC 11 (apply e reset no-op)', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: { ALUY_SET_BG: '0' } });
    expect(bg.active).toBe(false);
    expect(bg.apply('#070707')).toBe('');
    expect(bg.reset()).toBe('');
    expect(written).toEqual([]);
  });

  it('NO_COLOR ⇒ NÃO mexe no fundo (degradação a11y)', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: { NO_COLOR: '1' } });
    expect(bg.active).toBe(false);
    bg.apply('#070707');
    bg.reset();
    expect(written).toEqual([]);
  });

  it('sem TTY ⇒ no-op (não joga sequência de controle em pipe/CI)', () => {
    const { stdout, written } = fakeStdout(false);
    const bg = new BackgroundController({ stdout, env: {} });
    expect(bg.active).toBe(false);
    bg.apply('#070707');
    bg.reset();
    expect(written).toEqual([]);
  });

  it('reset sem apply prévio ⇒ no-op (não bagunça um fundo que não tocamos)', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: {} });
    expect(bg.reset()).toBe('');
    expect(written).toEqual([]);
  });

  it('reset é IDEMPOTENTE (finally + handler de sinal não duplicam)', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: {} });
    bg.apply('#070707');
    expect(bg.reset()).toBe(OSC11_RESET);
    expect(bg.reset()).toBe(''); // 2ª chamada não reemite
    expect(written.filter((w) => w === OSC11_RESET)).toHaveLength(1);
  });

  it('hex inválido no apply ⇒ não escreve nem marca como aplicado (reset segue no-op)', () => {
    const { stdout, written } = fakeStdout(true);
    const bg = new BackgroundController({ stdout, env: {} });
    expect(bg.apply('lixo')).toBe('');
    expect(written).toEqual([]);
    expect(bg.reset()).toBe(''); // nada foi aplicado ⇒ nada a resetar
  });
});

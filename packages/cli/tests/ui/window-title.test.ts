// Título da janela do terminal (OSC 0). Espelha o padrão de `tests/ui/osc11-background.test.ts`
// (o irmão OSC 11 de fundo): stdout FAKE injetado, sem tocar o terminal real. Cobre:
// a montagem da sequência (saneamento de control chars, colapso de espaço), o reset,
// e `setWindowTitle` (só-TTY, best-effort, nunca lança).

import { describe, expect, it } from 'vitest';
import { windowTitleSeq, WINDOW_TITLE_RESET, setWindowTitle } from '../../src/ui/window-title.js';

const ESC = '\x1b';
const BEL = '\x07';

describe('windowTitleSeq — monta a sequência OSC 0', () => {
  it('título limpo ⇒ ESC]0;<título>BEL', () => {
    expect(windowTitleSeq('aluy · minha-sessão')).toBe(`${ESC}]0;aluy · minha-sessão${BEL}`);
  });

  it('remove control chars (que quebrariam o OSC) mantendo o resto', () => {
    const withControls = `a${String.fromCharCode(1)}b${String.fromCharCode(127)}c`;
    expect(windowTitleSeq(withControls)).toBe(`${ESC}]0;abc${BEL}`);
  });

  it('colapsa espaços múltiplos em um único espaço, e apara as bordas', () => {
    expect(windowTitleSeq('  foo   bar   baz  ')).toBe(`${ESC}]0;foo bar baz${BEL}`);
  });

  it('tab/newline são control chars (< 32) ⇒ REMOVIDOS (não viram espaço)', () => {
    // n < 32 é filtrado pelo mesmo laço que remove ESC/BEL — \t (9) e \n (10) incluídos;
    // "bar\tbaz" vira "barbaz" (sem espaço no lugar do tab), não "bar baz".
    expect(windowTitleSeq('foo\tbar\nbaz')).toBe(`${ESC}]0;foobarbaz${BEL}`);
  });

  it('título vazio (ou que vira vazio após saneamento) ⇒ ESC]0;BEL (sem texto)', () => {
    expect(windowTitleSeq('')).toBe(`${ESC}]0;${BEL}`);
    // só control chars ⇒ tudo removido ⇒ vazio.
    expect(windowTitleSeq(String.fromCharCode(1) + String.fromCharCode(2))).toBe(
      `${ESC}]0;${BEL}`,
    );
  });
});

describe('WINDOW_TITLE_RESET', () => {
  it('é a sequência OSC 0 com título vazio', () => {
    expect(WINDOW_TITLE_RESET).toBe(`${ESC}]0;${BEL}`);
  });
});

describe('setWindowTitle — só em TTY, best-effort', () => {
  function fakeStdout(isTTY: boolean): {
    stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'>;
    written: string[];
  } {
    const written: string[] = [];
    return {
      written,
      stdout: {
        isTTY,
        write: ((chunk: string) => {
          written.push(chunk);
          return true;
        }) as NodeJS.WriteStream['write'],
      },
    };
  }

  it('título não-vazio + TTY ⇒ escreve a sequência do título', () => {
    const { stdout, written } = fakeStdout(true);
    setWindowTitle('minha-sessão', stdout);
    expect(written).toEqual([`${ESC}]0;minha-sessão${BEL}`]);
  });

  it('título undefined ⇒ escreve o RESET', () => {
    const { stdout, written } = fakeStdout(true);
    setWindowTitle(undefined, stdout);
    expect(written).toEqual([WINDOW_TITLE_RESET]);
  });

  it('título só-espaço ⇒ trata como vazio ⇒ RESET', () => {
    const { stdout, written } = fakeStdout(true);
    setWindowTitle('   ', stdout);
    expect(written).toEqual([WINDOW_TITLE_RESET]);
  });

  it('sem TTY ⇒ no-op (não suja um pipe/redirect)', () => {
    const { stdout, written } = fakeStdout(false);
    setWindowTitle('minha-sessão', stdout);
    expect(written).toEqual([]);
  });

  it('stdout.write lança ⇒ best-effort, não propaga o erro', () => {
    const written: string[] = [];
    const stdout: Pick<NodeJS.WriteStream, 'isTTY' | 'write'> = {
      isTTY: true,
      write: (() => {
        throw new Error('EPIPE');
      }) as NodeJS.WriteStream['write'],
    };
    expect(() => setWindowTitle('x', stdout)).not.toThrow();
    expect(written).toEqual([]);
  });

  it('sem stdout explícito, usa process.stdout como default (não lança em ambiente de teste)', () => {
    expect(() => setWindowTitle('titulo-default')).not.toThrow();
  });
});

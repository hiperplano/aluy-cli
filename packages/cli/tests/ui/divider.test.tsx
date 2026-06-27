// EST-0985 · polish de TUI — <Divider>: régua horizontal de largura total p/ dar
// hierarquia (emoldura o input). Estes testes travam:
//   1. largura = `columns` (régua de largura total), Unicode `─` e ASCII `-`;
//   2. papel DIM (fgDim default / depth), nunca cor crua — NO_COLOR intacto;
//   3. ESTÁVEL entre frames (chrome estático — não depende de tick/animação);
//   4. piso de 1 célula em terminal minúsculo (sem crash em columns<=0).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Divider } from '../../src/ui/components/Divider.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

// Unicode pleno (truecolor) vs ASCII puro (TERM=linux) vs sem cor (NO_COLOR).
const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const ASCII = { TERM: 'linux' }; // sem Unicode ⇒ box ASCII (`-`)
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };
const SAFE = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', ALUY_SAFE_GLYPHS: '1' };

describe('Divider — régua de largura total (EST-0985)', () => {
  it('Unicode: a linha é `─` repetido EXATAMENTE `columns` vezes', () => {
    const { lastFrame } = wrap(<Divider columns={40} />, UTF8);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('─'.repeat(40));
    expect(out.length).toBe(40);
  });

  it('ASCII (TERM=linux): cai no `-` (endurecimento EST-0984), mesma largura', () => {
    const { lastFrame } = wrap(<Divider columns={24} />, ASCII);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('-'.repeat(24));
    expect(out).not.toContain('─'); // sem Unicode no perfil ASCII
  });

  it('perfil SEGURO (ALUY_SAFE_GLYPHS) mantém o box Unicode `─` (cobertura ampla)', () => {
    // EST-0984: o SAFE endurece os glifos de PAPEL, mas box-drawing (╭╮─…) tem
    // cobertura ampla e fica no conjunto Unicode — a régua segue `─`.
    const { lastFrame } = wrap(<Divider columns={16} />, SAFE);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('─'.repeat(16));
  });

  it('largura segue `columns` (responsivo): 80 default, 120 explícito', () => {
    // Conta os glifos `─` (não o length da string): em terminal de teste estreito
    // o Ink pode SOFT-WRAP a régua larga numa quebra interna — o que importa é o
    // nº de células `─` emitidas = `columns`.
    const count = (frame: string): number => (plain(frame).match(/─/g) ?? []).length;
    expect(count(wrap(<Divider />, UTF8).lastFrame() ?? '')).toBe(80);
    expect(count(wrap(<Divider columns={120} />, UTF8).lastFrame() ?? '')).toBe(120);
  });

  it('piso de 1 célula em terminal minúsculo (columns 0/negativo não quebra)', () => {
    for (const c of [0, -5]) {
      const { lastFrame } = wrap(<Divider columns={c} />, UTF8);
      const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
      expect(out.length).toBe(1);
      expect(out).toBe('─');
    }
  });
});

describe('Divider — papel DIM por TOKEN (EST-0985)', () => {
  it('default fgDim ⇒ emite SGR de cor dim (papel, não cor crua)', () => {
    const { lastFrame } = wrap(<Divider columns={10} />, UTF8);
    const raw = lastFrame() ?? '';
    // fgDim no truecolor dark = #8A7F6D + dimColor ⇒ há sequência ANSI de cor.
    expect(raw).toMatch(ANSI);
    // e o conteúdo visível segue sendo a régua.
    expect(plain(raw).replace(/\n+$/, '')).toBe('─'.repeat(10));
  });

  it('role="depth" também é aceito (papel discreto alternativo)', () => {
    const { lastFrame } = wrap(<Divider columns={10} role="depth" />, UTF8);
    expect(plain(lastFrame() ?? '').replace(/\n+$/, '')).toBe('─'.repeat(10));
  });

  it('a11y NO_COLOR: a régua sobrevive sem cor (não depende de cor)', () => {
    const { lastFrame } = wrap(<Divider columns={12} />, NOCOLOR);
    expect(plain(lastFrame() ?? '').replace(/\n+$/, '')).toBe('─'.repeat(12));
  });
});

describe('Divider — variante SUTIL entre turnos (EST-0987)', () => {
  it('subtle: traço CURTO (largura parcial), NÃO a régua cheia', () => {
    const { lastFrame } = wrap(<Divider columns={80} subtle />, UTF8);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    // largura parcial fixa (12), bem menor que os 80 da régua cheia.
    expect(out.length).toBeLessThan(80);
    expect(out).toBe('─'.repeat(12));
  });

  it('subtle nunca estoura a largura do terminal (clamp ao columns minúsculo)', () => {
    const { lastFrame } = wrap(<Divider columns={6} subtle />, UTF8);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('─'.repeat(6)); // min(12, 6) = 6
  });

  it('subtle usa o papel mais APAGADO (fgDim) e ignora `role`', () => {
    // mesmo passando role="depth", o subtle força fgDim (o mais discreto).
    const { lastFrame } = wrap(<Divider columns={40} subtle role="depth" />, UTF8);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('─'.repeat(12));
  });

  it('subtle ASCII (TERM=linux): cai no `-` curto (a11y/ascii intacto)', () => {
    const { lastFrame } = wrap(<Divider columns={40} subtle />, ASCII);
    const out = plain(lastFrame() ?? '').replace(/\n+$/, '');
    expect(out).toBe('-'.repeat(12));
  });

  it('subtle NO_COLOR: o traço sobrevive sem cor', () => {
    const { lastFrame } = wrap(<Divider columns={40} subtle />, NOCOLOR);
    expect(plain(lastFrame() ?? '').replace(/\n+$/, '')).toBe('─'.repeat(12));
  });
});

describe('Divider — estável entre frames (chrome estático, anti-flicker)', () => {
  it('re-render não muda a linha (constante; nada vivo dentro)', () => {
    const theme = resolveTheme({ env: UTF8 });
    const { lastFrame, rerender } = render(
      <ThemeProvider theme={theme}>
        <Divider columns={30} />
      </ThemeProvider>,
    );
    const first = lastFrame();
    rerender(
      <ThemeProvider theme={theme}>
        <Divider columns={30} />
      </ThemeProvider>,
    );
    expect(lastFrame()).toBe(first);
  });
});

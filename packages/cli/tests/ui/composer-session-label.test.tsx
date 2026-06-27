// EST-0972 (rename) — o ●+nome de identificação da sessão NO COMPOSER.
//
// DoD:
//   - com rótulo ⇒ desenha `● nome ›` (●colorido + nome + o prompt);
//   - sem rótulo ⇒ NÃO desenha nada (composer limpo — não polui);
//   - a cor sai da paleta do DS (truecolor ⇒ SGR de cor no ●);
//   - NO_COLOR (a11y) ⇒ degrada textual: o ●+nome aparecem, sem SGR de cor;
//   - SNAPSHOT do composer com o rótulo colorido.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Composer } from '../../src/ui/components/Composer.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv = ENV) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('Composer — ●+nome da sessão (/rename)', () => {
  it('COM rótulo ⇒ desenha `● nome` ANTES do prompt', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="projeto-x" sessionColor="azul" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('●');
    expect(out).toContain('projeto-x');
    // o ● vem ANTES do nome, e o nome ANTES do prompt `›`.
    expect(out.indexOf('●')).toBeLessThan(out.indexOf('projeto-x'));
    expect(out.indexOf('projeto-x')).toBeLessThan(out.lastIndexOf('›'));
  });

  // EST-0965 — o CURSOR do composer agora é ● (grosso). O ● de IDENTIFICAÇÃO (/rename)
  // mora ANTES do prompt `›`; o cursor mora DEPOIS. Logo "sem rótulo" = nenhum ● no
  // PREFIXO antes do `›` (não dá mais p/ varrer o frame inteiro por ●).
  const beforePrompt = (out: string): string => out.slice(0, out.indexOf('›'));

  it('SEM rótulo ⇒ NÃO desenha ● nem nome (composer limpo)', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} />);
    const out = plain(lastFrame() ?? '');
    expect(beforePrompt(out)).not.toContain('●'); // sem dot de identificação antes do `›`
  });

  it('rótulo VAZIO ⇒ não desenha (não polui)', () => {
    const { lastFrame } = wrap(<Composer value="" active={true} sessionLabel="   " />);
    const out = plain(lastFrame() ?? '');
    expect(beforePrompt(out)).not.toContain('●');
  });

  it('truecolor ⇒ o ● carrega SGR de COR (a cor da paleta do DS)', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="proj" sessionColor="azul" />,
    );
    const raw = lastFrame() ?? '';
    // o ● aparece pintado: há um SGR de cor de foreground 24-bit (38;2;…) no frame.
    expect(raw).toMatch(new RegExp(ESC + '\\[[0-9;]*38;2;'));
  });

  it('NO_COLOR (a11y) ⇒ ●+nome AINDA aparecem, mas SEM SGR de cor', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="proj" sessionColor="azul" />,
      { NO_COLOR: '1', ...ENV },
    );
    const raw = lastFrame() ?? '';
    const out = plain(raw);
    // o glifo + nome continuam (o significado mora neles, não na cor)…
    expect(out).toContain('●');
    expect(out).toContain('proj');
    // …e NÃO há SGR de cor truecolor (mono não emite 38;2;…).
    expect(raw).not.toMatch(new RegExp(ESC + '\\[[0-9;]*38;2;'));
  });

  it('também aparece no MODO SHELL (`!`) — a identidade não some no atalho de shell', () => {
    const { lastFrame } = wrap(
      <Composer
        value="ls"
        active={true}
        shellMode={true}
        sessionLabel="proj"
        sessionColor="teal"
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('●');
    expect(out).toContain('proj');
    expect(out).toContain('shell');
  });

  it('SNAPSHOT — composer com o rótulo colorido (truecolor)', () => {
    const { lastFrame } = wrap(
      <Composer value="" active={true} sessionLabel="projeto-x" sessionColor="azul" />,
    );
    // snapshot do texto VISÍVEL (sem ANSI) — estabilidade do layout ●nome › fantasma.
    expect(plain(lastFrame() ?? '')).toMatchSnapshot();
  });
});

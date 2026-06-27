// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — render do <StuckGate>:
// o aviso é INEQUÍVOCO (a11y — a PALAVRA carrega o sentido, não só a cor), resume
// O QUE travou (a tool/erro/padrão + a contagem) e oferece as 3 ações acionáveis
// ([r] redirecionar / [c] continuar / [n] encerrar). No modo "redirecionando", a
// dica vira "digite + Enter". Vale em NO_COLOR (mono) — texto, não cor.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { StuckGate } from '../../src/ui/components/StuckGate.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}
function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv) {
  return render(<ThemeProvider theme={resolveTheme({ env })}>{node}</ThemeProvider>);
}
const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };

describe('StuckGate — pausa-pede-direção é inequívoca (a11y)', () => {
  it('same-tool-call ⇒ "parece travado", nomeia a tool e a contagem + as 3 ações', () => {
    const { lastFrame } = wrap(
      <StuckGate kind="same-tool-call" count={4} sample="run_command" />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('parece travado');
    expect(out).toContain('run_command');
    expect(out).toContain('4');
    expect(out).toContain('[r] redirecionar');
    expect(out).toContain('[c] continuar');
    expect(out).toContain('[n] encerrar');
  });

  it('same-tool-error ⇒ descreve a falha repetida + a assinatura', () => {
    const out = plain(
      wrap(
        <StuckGate kind="same-tool-error" count={3} sample="read_file: ENOENT" />,
        UTF8,
      ).lastFrame() ?? '',
    );
    expect(out).toContain('mesma falha');
    expect(out).toContain('ENOENT');
  });

  it('empty-turns ⇒ descreve respostas vazias', () => {
    const out = plain(
      wrap(<StuckGate kind="empty-turns" count={3} sample="vazio" />, UTF8).lastFrame() ?? '',
    );
    expect(out).toContain('vazio');
  });

  it('redirecionando ⇒ dica de digitar + Enter (esc cancela)', () => {
    const out = plain(
      wrap(
        <StuckGate kind="same-tool-call" count={4} sample="run_command" redirecting />,
        UTF8,
      ).lastFrame() ?? '',
    );
    expect(out).toContain('digite a nova instrução');
    expect(out).toContain('Enter');
    // no modo redirecionando, o menu [c]/[n] não aparece (o foco é digitar).
    expect(out).not.toContain('[c] continuar');
  });

  it('a PALAVRA do aviso aparece em NO_COLOR (mono — não depende de cor)', () => {
    const out = plain(
      wrap(<StuckGate kind="no-progress" count={6} sample="sem avanço" />, NOCOLOR).lastFrame() ??
        '',
    );
    expect(out).toContain('parece travado');
    expect(out.toLowerCase()).toContain('iterações sem avanço');
  });
});

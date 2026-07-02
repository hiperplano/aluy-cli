// F164 (decisão do dono, 2026-07-02) — JANELA do corpo do efeito no <AskDialog>.
// Um batch/heredoc/diff de 100+ linhas despejado inteiro no box da catraca estourava
// a tela e o COMEÇO do comando rolava p/ fora antes da decisão. Agora: cabeça + cauda
// + contagem EXPLÍCITA do oculto ([e] editar segue mostrando tudo). CLI-SEC-9 segue
// honesto: recorte com marcador, nunca resumo/paráfrase; abaixo do teto = idêntico.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import type { AskRequest } from '@hiperplano/aluy-cli-core';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  AskDialog,
  windowEffectLines,
  ASK_EFFECT_MAX_LINES,
} from '../../src/ui/components/AskDialog.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(ANSI, '');

function commandAsk(exact: string, category: AskRequest['category'] = 'default'): AskRequest {
  return {
    call: { name: 'run_command', input: { command: exact } },
    effect: { kind: 'command', tool: 'run_command', exact },
    category,
    reason: 'comando com efeito',
    alwaysAsk: category !== 'default',
  } as AskRequest;
}

function mount(req: AskRequest): string {
  const theme = resolveTheme({ env: ENV });
  const r = render(
    <ThemeProvider theme={theme}>
      <AskDialog request={req} />
    </ThemeProvider>,
  );
  const out = plain(r.lastFrame());
  r.unmount();
  return out;
}

describe('windowEffectLines — janela PURA cabeça+cauda do efeito (F164)', () => {
  it('efeito curto (≤ teto) passa INTACTO, sem oculto', () => {
    const lines = ['$ npm test', 'linha 2'];
    expect(windowEffectLines(lines)).toEqual({ head: lines, hidden: 0, tail: [] });
    const exact = Array.from({ length: ASK_EFFECT_MAX_LINES }, (_, i) => `l${i}`);
    expect(windowEffectLines(exact).hidden).toBe(0);
  });

  it('heredoc de 122 linhas ⇒ cabeça 9 + 109 ocultas + cauda 4 (soma fecha)', () => {
    const lines = Array.from({ length: 122 }, (_, i) => `linha ${i}`);
    const w = windowEffectLines(lines);
    expect(w.head).toHaveLength(9);
    expect(w.tail).toHaveLength(4);
    expect(w.hidden).toBe(122 - 9 - 4);
    expect(w.head[0]).toBe('linha 0');
    expect(w.tail[3]).toBe('linha 121');
  });
});

describe('<AskDialog> — efeito gigante JANELADO no box (F164)', () => {
  const heredoc = [
    "$ cat > relatorio.md <<'EOF'",
    ...Array.from({ length: 120 }, (_, i) => `conteudo ${i}`),
    'EOF',
  ].join('\n');

  it('mostra o COMEÇO do comando, a contagem do oculto e o FIM (EOF) — nunca o miolo inteiro', () => {
    const f = mount(commandAsk(heredoc));
    expect(f).toContain("cat > relatorio.md <<'EOF'"); // cabeça: o comando em si
    expect(f).toContain('+109 linhas ocultas'); // contagem EXPLÍCITA (122 − 9 − 4)
    expect(f).toContain('[e] editar mostra tudo'); // caminho p/ o efeito completo
    expect(f).toContain('EOF'); // cauda: o fim do heredoc
    expect(f).not.toContain('conteudo 60'); // o miolo NÃO é despejado
    // o box inteiro fica bounded (~teto + chrome do dialog), não 120+ linhas.
    expect(f.split('\n').length).toBeLessThan(30);
  });

  it('comando curto: render IDÊNTICO ao de antes (sem marcador)', () => {
    const f = mount(commandAsk('$ npm test'));
    expect(f).toContain('$ npm test');
    expect(f).not.toContain('linhas ocultas');
  });

  it('destrutivo NÃO oferece [e] ⇒ o marcador não sugere a tecla', () => {
    const f = mount(commandAsk(heredoc, 'always-ask:destructive'));
    expect(f).toContain('+109 linhas ocultas');
    expect(f).not.toContain('[e] editar mostra tudo');
  });

  it('diff gigante também janela (cabeça do hunk + contagem + cauda)', () => {
    const exact = [
      '--- src/a.ts',
      '+++ src/a.ts',
      ...Array.from({ length: 100 }, (_, i) => `+linha nova ${i}`),
    ].join('\n');
    const req: AskRequest = {
      call: { name: 'edit_file', input: { path: 'src/a.ts', content: 'x' } },
      effect: { kind: 'diff', tool: 'edit_file', path: 'src/a.ts', exact },
      category: 'default',
      reason: 'edit_file = ask com diff',
      alwaysAsk: false,
    } as AskRequest;
    const f = mount(req);
    expect(f).toContain('--- src/a.ts'); // cabeçalho do diff visível
    expect(f).toContain('linhas ocultas'); // marcador
    expect(f).toContain('linha nova 99'); // cauda (fim do diff)
    expect(f).not.toContain('linha nova 50'); // miolo não despejado
  });
});

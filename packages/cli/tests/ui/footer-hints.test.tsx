// EST-0965 — <FooterHints>: a dica dim por estado + o INDICADOR DE ATIVIDADE (elapsed).
//
// O relógio do turno (`0:12`, M:SS) é ANEXADO à dica nos estados OCUPADOS
// (`thinking`/`streaming`) — "esc interromper · 0:12" —, avançando 1×/seg (o tick lento
// da App), p/ a tela não parecer congelada durante args de um edit_file grande. Fora de
// fase ocupada (idle/ask/etc.) o elapsed NÃO suja o footer.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { FooterHints } from '../../src/ui/components/FooterHints.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string) => (s ?? '').replace(ANSI, '');

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: ENV });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('FooterHints — indicador de atividade (elapsed) EST-0965', () => {
  it('streaming COM elapsed ⇒ "esc interromper · 0:12"', () => {
    const { lastFrame } = wrap(<FooterHints state="streaming" elapsed="0:12" />);
    const f = plain(lastFrame());
    expect(f).toContain('esc interromper');
    expect(f).toContain('· 0:12');
  });

  it('thinking COM elapsed também mostra o relógio (vácuo pré-token)', () => {
    const { lastFrame } = wrap(<FooterHints state="thinking" elapsed="0:03" />);
    expect(plain(lastFrame())).toContain('· 0:03');
  });

  it('SEM elapsed (undefined) ⇒ só a dica base, sem "·" pendurado', () => {
    const { lastFrame } = wrap(<FooterHints state="streaming" />);
    const f = plain(lastFrame());
    expect(f).toContain('esc interromper · ctrl-c×2 sair');
    expect(f).not.toMatch(/·\s*\d+:\d\d/);
  });

  it('elapsed vazio ("") é ignorado (não pendura "·")', () => {
    const { lastFrame } = wrap(<FooterHints state="streaming" elapsed="" />);
    expect(plain(lastFrame())).not.toMatch(/·\s*\d+:\d\d/);
  });

  it('estado OCIOSO (idle) NÃO ganha relógio mesmo se vier um elapsed', () => {
    const { lastFrame } = wrap(<FooterHints state="idle" elapsed="0:42" />);
    const f = plain(lastFrame());
    expect(f).not.toContain('0:42');
    expect(f).toContain('enter envia');
  });

  it('estado de decisão (ask) NÃO ganha relógio (a decisão tem o foco)', () => {
    const { lastFrame } = wrap(<FooterHints state="ask" elapsed="0:42" />);
    expect(plain(lastFrame())).not.toContain('0:42');
  });
});

describe('FooterHints — semântica de parada com SUB-AGENTES vivos (EST-0982)', () => {
  it('trabalho + filhos vivos ⇒ "esc para o pai · F8 para tudo" (parada em dois níveis)', () => {
    const { lastFrame } = wrap(<FooterHints state="work-subagents" />);
    const f = plain(lastFrame());
    expect(f).toContain('esc para o pai');
    expect(f).toContain('F8 para tudo');
  });

  it('trabalho + filhos vivos é estado OCUPADO: ganha o relógio de elapsed', () => {
    const { lastFrame } = wrap(<FooterHints state="work-subagents" elapsed="0:07" />);
    expect(plain(lastFrame())).toContain('· 0:07');
  });

  it('repouso + filhos DESACOPLADOS (pós-esc) ⇒ o F8 segue visível como freio', () => {
    const { lastFrame } = wrap(<FooterHints state="idle-subagents" />);
    const f = plain(lastFrame());
    expect(f).toContain('enter envia');
    expect(f).toContain('F8');
  });
});

describe('FooterHints — duplo Ctrl+C p/ sair (EST-1015)', () => {
  it('armedExit=true ⇒ a dica de confirmação VENCE a do estado', () => {
    const { lastFrame } = wrap(<FooterHints state="idle" armedExit />);
    const f = plain(lastFrame());
    expect(f).toContain('ctrl-c de novo'); // pressione ctrl-c de novo para sair
    expect(f).not.toContain('enter envia'); // a dica de idle some enquanto armado
  });

  it('armedExit ausente/false ⇒ dica normal do estado', () => {
    const { lastFrame } = wrap(<FooterHints state="idle" />);
    const f = plain(lastFrame());
    expect(f).toContain('enter envia');
    expect(f).not.toContain('de novo');
  });

  it('a dica de idle anuncia ctrl-c×2 (não 1× — coerente com o duplo toque)', () => {
    const { lastFrame } = wrap(<FooterHints state="idle" />);
    expect(plain(lastFrame())).toContain('ctrl-c×2');
  });
});

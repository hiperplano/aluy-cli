// EST-0989 — <SplashScreen>: a TELA DE BOOT centralizada (wordmark `Λluy` + um
// "carregando…" discreto) e a CAIXA de pergunta formatada (<BootPromptBox>), no
// lugar das frases soltas no meio da tela.
//
// Provas (FRUGAL — render puro via ink-testing, sem modelo/rede/timer):
//  · carregando: o splash mostra o wordmark + o verbo "carregando" (não linha solta);
//  · a cauda de pontinhos é PURA (`loadingDots`) — anima a CAUDA, não a marca;
//  · prompt: quando há pergunta, a CAIXA aparece (moldura) com título/corpo/opções —
//    e o "carregando" some (uma decisão de cada vez);
//  · NO_COLOR / ASCII (TERM=linux) degradam (sem █; box ASCII) — não quebra;
//  · `parseBootPrompt` mapeia o texto cru (`↻ … [S/n]`, YOLO) p/ a caixa (sem `[S/n]`).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  SplashScreen,
  BootPromptBox,
  loadingDots,
  DEFAULT_TAGLINE,
} from '../../src/ui/components/SplashScreen.js';
import { SPLASH_QUIPS } from '../../src/ui/components/splash-quips.js';
import { parseBootPrompt } from '../../src/session/splash-controller.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return (s ?? '').replace(ANSI, '');
}

function wrap(
  node: React.ReactElement,
  env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' },
) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('loadingDots — cauda PURA (EST-0989)', () => {
  it('cicla 0..3 pontos em laço (estável, sem flicker da marca)', () => {
    expect(loadingDots(0)).toBe('');
    expect(loadingDots(1)).toBe('.');
    expect(loadingDots(2)).toBe('..');
    expect(loadingDots(3)).toBe('...');
    expect(loadingDots(4)).toBe(''); // volta ao começo
    expect(loadingDots(7)).toBe('...');
  });
});

describe('SplashScreen — carregando (EST-0989)', () => {
  it('mostra o wordmark `Λluy` (bloco) + o verbo "carregando" discreto', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={24} frame={1} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('██'); // wordmark bloco (a marca Λluy)
    expect(out).toContain(SPLASH_QUIPS[0]); // frase divertida (frame 0/1 ⇒ 1ª)
    // não vaza o prompt cru de retomada quando só carrega
    expect(out).not.toContain('[S/n]');
    expect(out).not.toContain('[s/n]');
  });

  it('status customizado aparece (ex.: "descobrindo MCP")', () => {
    const { lastFrame } = wrap(
      <SplashScreen columns={80} rows={24} frame={0} status="descobrindo MCP" />,
    );
    expect(plain(lastFrame() ?? '')).toContain('descobrindo MCP');
  });

  it('ASCII (TERM=linux): degrada o wordmark (sem █) — não quebra', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={24} frame={0} />, {
      TERM: 'linux',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('█');
    expect(out).toContain(SPLASH_QUIPS[0]); // frase divertida (frame 0/1 ⇒ 1ª)
  });

  it('NO_COLOR: ainda mostra a marca e o "carregando" (sem cor)', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={24} frame={0} />, {
      NO_COLOR: '1',
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
    });
    const raw = lastFrame() ?? '';
    expect(plain(raw)).toContain(SPLASH_QUIPS[0]);
    // NO_COLOR ⇒ sem sequências de cor SGR no frame.
    expect(raw).not.toMatch(new RegExp(ESC + '\\[[0-9;]*3[0-9]m'));
  });
});

// F195 — a tela de carga foi ELEVADA (referência opencode): tagline âmbar sob a marca,
// versão discreta e um CARD sutil (moldura) centrado. Degrada limpo (ASCII/estreito sem
// borda) e mantém os INVARIANTES (marca + carregando + fallbacks).
describe('SplashScreen — tela profissional: tagline + versão + card (F195)', () => {
  it('mostra a TAGLINE âmbar sob a marca (default "agente de terminal")', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={22} frame={0} />);
    expect(plain(lastFrame() ?? '')).toContain(DEFAULT_TAGLINE);
  });

  it('tagline CUSTOM sobrescreve o default', () => {
    const { lastFrame } = wrap(
      <SplashScreen columns={80} rows={22} frame={0} tagline="seu agente local" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('seu agente local');
    expect(out).not.toContain(DEFAULT_TAGLINE);
  });

  it('mostra a VERSÃO discreta quando passada (`Aluy CLI · v<versão>`)', () => {
    const { lastFrame } = wrap(
      <SplashScreen columns={80} rows={22} frame={0} version="1.2.3-rc.4" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('Aluy CLI');
    expect(out).toContain('v1.2.3-rc.4');
  });

  it('SEM versão: a linha de versão some (degradação graciosa, tela mais limpa)', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={22} frame={0} />);
    expect(plain(lastFrame() ?? '')).not.toContain('Aluy CLI ·');
  });

  it('SEM BORDA/moldura na tela de carga (feedback do dono): nenhum box-drawing', () => {
    // Unicode largo: mesmo com box-drawing DISPONÍVEL, a splash de carga NÃO desenha card —
    // é arejada, sem moldura (o dono achou o card horrível). Só o miolo centrado.
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={22} frame={0} />);
    const out = plain(lastFrame() ?? '');
    expect(out).not.toMatch(/[╭╮╰╯│─]/); // nada de moldura
    expect(out).toContain('██'); // a marca segue
    expect(out).toContain(DEFAULT_TAGLINE); // e a tagline
  });

  it('ASCII (TERM=linux): SEM moldura Unicode — layout arejado, ainda com tagline', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={22} frame={0} />, {
      TERM: 'linux',
    });
    const out = plain(lastFrame() ?? '');
    expect(out).not.toMatch(/[╭╮╰╯]/); // nada de box-drawing Unicode em TERM=linux
    expect(out).toContain(DEFAULT_TAGLINE); // conteúdo preservado
  });
});

describe('SplashScreen — caixa de pergunta no lugar do carregando (EST-0989)', () => {
  const prompt = {
    title: '↻ retomar sessão',
    body: ['retomar a conversa anterior (3 mensagens, há 2 min)?'],
    options: '[s] retomar · [n] nova sessão',
  };

  it('com prompt: mostra a CAIXA (moldura) com título/corpo/opções — e SOME o carregando', () => {
    const { lastFrame } = wrap(<SplashScreen columns={80} rows={24} frame={0} prompt={prompt} />);
    const out = plain(lastFrame() ?? '');
    // moldura arredondada do DS (box-drawing) presente
    expect(out).toMatch(/[╭╮╰╯]/);
    expect(out).toContain('retomar sessão');
    expect(out).toContain('retomar a conversa anterior');
    expect(out).toContain('[s] retomar');
    expect(out).toContain('[n] nova sessão');
    // a marca segue acima (centralizada)
    expect(out).toContain('██');
    // o "carregando" NÃO aparece quando há decisão pendente
    expect(out).not.toContain('carregando');
  });

  it('BootPromptBox isolada: título + corpo + opções, sem cor crua (papéis)', () => {
    const { lastFrame } = wrap(<BootPromptBox prompt={prompt} columns={80} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('retomar sessão');
    expect(out).toContain('[s] retomar');
  });
});

describe('parseBootPrompt — texto cru → caixa formatada (EST-0989)', () => {
  it('auto-oferta de retomada: tira o `[S/n]` e classifica como "retomar sessão"', () => {
    const p = parseBootPrompt('↻ retomar a conversa anterior (3 mensagens, há 2 min)? [S/n] ');
    expect(p.title).toContain('retomar');
    expect(p.options).toContain('[s] retomar');
    expect(p.options).toContain('[n] nova sessão');
    // o corpo NÃO carrega mais o marcador cru
    expect(p.body.join('\n')).not.toContain('[S/n]');
    expect(p.body.join('\n')).toContain('retomar a conversa anterior');
  });

  it('confirmação de YOLO: classifica como "modo YOLO"', () => {
    const p = parseBootPrompt('⚠ ATENÇÃO: o modo YOLO desliga a catraca. Entrar? [s/N]');
    expect(p.title).toContain('YOLO');
    expect(p.options).toContain('[s] entrar em YOLO');
    expect(p.body.join('\n')).not.toContain('[s/N]');
  });

  it('texto genérico: cai no formato neutro [s] sim · [n] não', () => {
    const p = parseBootPrompt('continuar mesmo assim? [s/n]');
    expect(p.options).toBe('[s] sim · [n] não');
  });
});

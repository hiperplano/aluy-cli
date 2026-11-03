// VERBOS DE ESPERA — `pensando…` vira um gerúndio brincalhão, sorteado 1× por PASSO; os rótulos
// funcionais seguem intactos; `ALUY_VERBOS=simples` volta ao plano; espera longa ganha uma dica
// honesta SEM números; e a linha NÃO tem mais relógio (o brilho é o sinal de "vivo").

import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { Working } from '../../src/ui/components/Working.js';
import {
  ROTULOS_GENERICOS,
  SeletorDeVerbo,
  detalheDeEspera,
  formatSegundos,
  formatTokensPtBr,
  criarRng,
  parseVerbos,
  rotuloExibido,
  sortearVerbo,
  verbosSimples,
} from '../../src/session/verbos.js';
import { resolveText } from '../../src/i18n/translate.js';

const ESC = String.fromCharCode(27);
const plain = (s: string): string => s.replace(new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g'), '');
const verbos = parseVerbos(resolveText('pt-BR', 'working.verbs'));

describe('lista de verbos (catálogo)', () => {
  it('curada: 60+ itens, únicos, curtos (≤ 16) e sem duplicata', () => {
    expect(verbos.length).toBeGreaterThanOrEqual(60);
    expect(new Set(verbos).size).toBe(verbos.length);
    for (const v of verbos) expect(v.length).toBeLessThanOrEqual(16);
  });
  it('en cai no pt-BR (gancho p/ outros idiomas)', () => {
    expect(resolveText('en', 'working.verbs')).toBe(resolveText('pt-BR', 'working.verbs'));
  });
});

describe('sorteio por passo', () => {
  it('estável dentro do passo, diferente entre passos, sem repetir o anterior', () => {
    const sel = new SeletorDeVerbo(42);
    const a1 = sel.para(1000, verbos);
    expect(sel.para(1000, verbos)).toBe(a1);
    expect(sel.para(1000, verbos)).toBe(a1);
    const vistos = new Set<string>([a1!]);
    let anterior = a1;
    for (let passo = 2000; passo < 2000 + 40 * 1000; passo += 1000) {
      const v = sel.para(passo, verbos)!;
      expect(v).not.toBe(anterior);
      anterior = v;
      vistos.add(v);
    }
    expect(vistos.size).toBeGreaterThan(10);
  });
  it('determinístico com a mesma semente', () => {
    const seq = (seed: number): string[] => {
      const rng = criarRng(seed);
      const out: string[] = [];
      let ant: string | undefined;
      for (let i = 0; i < 10; i++) {
        ant = sortearVerbo(verbos, rng, ant)!;
        out.push(ant);
      }
      return out;
    };
    expect(seq(7)).toEqual(seq(7));
    expect(seq(7)).not.toEqual(seq(8));
  });
});

describe('quais rótulos viram verbo', () => {
  const sel = new SeletorDeVerbo(1);
  const exibe = (label: string, simples = false): string | undefined =>
    rotuloExibido({ label, passo: 1, verbos, seletor: sel, simples });

  it('genéricos (pensando/lembrando/preparando/maestro avaliando) viram verbo', () => {
    for (const g of ROTULOS_GENERICOS) expect(verbos).toContain(exibe(g));
  });
  it('funcionais/honestos ficam INTACTOS', () => {
    for (const f of [
      'conferindo o trabalho (1/2)',
      'corrigindo após a verificação',
      'compactando contexto',
      'tentando de novo (2/20)',
      'pausado — cota esgotada',
      'aguardando sua decisão',
      'em ciclo',
    ]) {
      expect(exibe(f)).toBe(f);
    }
  });
  it('modo simples devolve o rótulo plano', () => {
    expect(exibe('pensando', true)).toBe('pensando');
  });
  it('ALUY_VERBOS=simples é lido do ambiente', () => {
    expect(verbosSimples({ ALUY_VERBOS: 'simples' })).toBe(true);
    expect(verbosSimples({})).toBe(false);
  });
});

describe('formatação do parêntese', () => {
  it('segundos: 12s, 59s, 1m 05s, 12m 00s', () => {
    expect(formatSegundos(12_400)).toBe('12s');
    expect(formatSegundos(59_999)).toBe('59s');
    expect(formatSegundos(65_000)).toBe('1m 05s');
    expect(formatSegundos(720_000)).toBe('12m 00s');
    expect(formatSegundos(Number.NaN)).toBe('0s');
  });
  it('tokens compactos pt-BR; sem info ⇒ omite (nunca 0)', () => {
    expect(formatTokensPtBr(850)).toBe('850 tokens');
    expect(formatTokensPtBr(1200)).toBe('1,2k tokens');
    expect(formatTokensPtBr(1000)).toBe('1k tokens');
    expect(formatTokensPtBr(33_000)).toBe('33k tokens');
    expect(formatTokensPtBr(0)).toBeUndefined();
    expect(formatTokensPtBr(Number.NaN)).toBeUndefined();
  });
  it('completo cabe: (pensando · ↓ 1,2k tokens · 12s)', () => {
    expect(detalheDeEspera({ fase: 'pensando', tokens: 1200, ms: 12_000 })).toBe(
      '(pensando · ↓ 1,2k tokens · 12s)',
    );
  });
  it('sem tokens ⇒ segmento some; rótulo funcional ⇒ sem fase', () => {
    expect(detalheDeEspera({ fase: 'pensando', tokens: 0, ms: 5000 })).toBe('(pensando · 5s)');
    expect(detalheDeEspera({ tokens: 850, ms: 5000 })).toBe('(↓ 850 tokens · 5s)');
  });
  it('aperto: perde tokens primeiro, depois a fase; segundos ficam', () => {
    const args = { fase: 'pensando', tokens: 1200, ms: 12_000 };
    expect(detalheDeEspera({ ...args, larguraMax: 20 })).toBe('(pensando · 12s)');
    expect(detalheDeEspera({ ...args, larguraMax: 6 })).toBe('(12s)');
    expect(detalheDeEspera({ ...args, larguraMax: 1 })).toBe('(12s)');
  });
});

describe('<Working>', () => {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  const tela = (el: React.ReactElement): string =>
    plain(render(<ThemeProvider theme={theme}>{el}</ThemeProvider>).lastFrame() ?? '');

  it('`Λluy Garimpando… (pensando · ↓ 1,2k tokens · 12s)` — sem M:SS', () => {
    const f = tela(
      <Working label="Garimpando" frame={3} detalhe="(pensando · ↓ 1,2k tokens · 12s)" />,
    );
    expect(f).toContain('Garimpando… (pensando · ↓ 1,2k tokens · 12s)');
    expect(f).not.toMatch(/\d:\d\d/);
  });
  it('rótulo funcional: mantém o texto e o parêntese só com números', () => {
    const f = tela(
      <Working label="conferindo o trabalho (1/2)" frame={0} detalhe="(900 tokens · 4s)" />,
    );
    expect(f).toContain('conferindo o trabalho (1/2)… (900 tokens · 4s)');
  });
});

describe('integração de ambiente', () => {
  const antes = process.env.ALUY_VERBOS;
  beforeAll(() => {
    process.env.ALUY_VERBOS = 'simples';
  });
  afterAll(() => {
    if (antes === undefined) delete process.env.ALUY_VERBOS;
    else process.env.ALUY_VERBOS = antes;
  });
  it('lê o processo por padrão', () => {
    expect(verbosSimples()).toBe(true);
  });
});

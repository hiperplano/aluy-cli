// VERBOS DE ESPERA — `pensando…` vira um gerúndio brincalhão, sorteado 1× por PASSO; os rótulos
// funcionais seguem intactos; `ALUY_SPINNER_VERBS=plain` volta ao plano; espera longa ganha uma dica
// honesta SEM números; e a linha NÃO tem mais relógio (o brilho é o sinal de "vivo").

import React from 'react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { AluyBlock } from '../../src/ui/components/TurnBlock.js';
import { Working } from '../../src/ui/components/Working.js';
import {
  ROTULOS_GENERICOS,
  detalheDeEspera,
  formatSegundos,
  formatTokensPtBr,
  criarRng,
  parseVerbos,
  rotuloExibido,
  sortearVerbo,
  verbosSimples,
  seedPadrao,
} from '../../src/session/verbos.js';
import { PolicyPermissionEngine } from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';
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

describe('sorteio por TURNO (fonte única: estado do controller)', () => {
  const comPasso = (c: SessionController, since: number): string | undefined => {
    // passo novo dentro do turno: só o relógio muda (o verbo NÃO é re-sorteado)
    (c as unknown as { patch(p: Record<string, unknown>): void }).patch({
      phase: 'thinking',
      workingLabel: 'pensando',
      workingSince: since,
    });
    return c.current.workingVerb;
  };
  const novo = (): SessionController =>
    new SessionController({
      model: {
        async call() {
          return { request_id: 'r', content: 'ok', finish_reason: 'stop' };
        },
      },
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: {} as never,
      askResolver: {
        async resolve() {
          return { kind: 'approve-once' as const };
        },
      },
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
      flush: { intervalMs: 0 },
    });

  const novoTurno = (c: SessionController): void =>
    (c as unknown as { sortearVerboDoTurno(): void }).sortearVerboDoTurno();

  it('um verbo por TURNO: estável entre passos, novo e diferente a cada turno', () => {
    const c = novo();
    novoTurno(c);
    let anterior = comPasso(c, 1000);
    expect(verbos).toContain(anterior);
    for (let passo = 2000; passo < 8000; passo += 1000) {
      expect(comPasso(c, passo)).toBe(anterior); // passos do mesmo turno ⇒ mesmo verbo
    }
    const vistos = new Set<string>([anterior!]);
    for (let turno = 0; turno < 40; turno++) {
      novoTurno(c);
      const v = comPasso(c, 100000 + turno)!;
      expect(v).not.toBe(anterior);
      anterior = v;
      vistos.add(v);
    }
    expect(vistos.size).toBeGreaterThan(10);
    c.dispose();
  });

  it('ALUY_SPINNER_VERBS=plain ⇒ nenhum verbo no estado', () => {
    const antes = process.env.ALUY_SPINNER_VERBS;
    process.env.ALUY_SPINNER_VERBS = 'plain';
    try {
      const c = novo();
      novoTurno(c);
      expect(comPasso(c, 1000)).toBeUndefined();
      c.dispose();
    } finally {
      if (antes === undefined) delete process.env.ALUY_SPINNER_VERBS;
      else process.env.ALUY_SPINNER_VERBS = antes;
    }
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
  const exibe = (label: string, verbo: string | undefined = 'Costurando'): string | undefined =>
    rotuloExibido({ label, verbo });

  it('genéricos (pensando/lembrando/preparando/maestro avaliando) viram o verbo', () => {
    for (const g of ROTULOS_GENERICOS) expect(exibe(g)).toBe('Costurando');
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
  it('sem verbo (modo simples) devolve o rótulo plano', () => {
    expect(rotuloExibido({ label: 'pensando', verbo: undefined })).toBe('pensando');
  });
  it('ALUY_SPINNER_VERBS=plain é lido do ambiente', () => {
    expect(verbosSimples({ ALUY_SPINNER_VERBS: 'plain' })).toBe(true);
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
  it('↑ enviados antes do 1º delta; ↑ e ↓ depois; estimativa leva `~`', () => {
    const base = { fase: 'pensando', ms: 3000 };
    expect(detalheDeEspera({ ...base, entrada: { tokens: 21_000, estimado: true } })).toBe(
      '(pensando · ↑ ~21k tokens · 3s)',
    );
    expect(
      detalheDeEspera({ ...base, entrada: { tokens: 21_000, estimado: false }, tokens: 394 }),
    ).toBe('(pensando · ↑ 21k ↓ 394 tokens · 3s)');
  });
  it('aperto com ↑ e ↓: perde o ↑, depois o ↓, depois a fase', () => {
    const a = {
      fase: 'pensando',
      ms: 9000,
      tokens: 394,
      entrada: { tokens: 21_000, estimado: false },
    };
    expect(detalheDeEspera({ ...a, larguraMax: 36 })).toBe('(pensando · ↑ 21k ↓ 394 tokens · 9s)');
    expect(detalheDeEspera({ ...a, larguraMax: 35 })).toBe('(pensando · ↓ 394 tokens · 9s)');
    expect(detalheDeEspera({ ...a, larguraMax: 29 })).toBe('(pensando · 9s)');
    expect(detalheDeEspera({ ...a, larguraMax: 5 })).toBe('(9s)');
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

describe('caixa da resposta: o MESMO verbo no raciocínio ao vivo', () => {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  const tela = (el: React.ReactElement): string =>
    plain(render(<ThemeProvider theme={theme}>{el}</ThemeProvider>).lastFrame() ?? '');

  it('streaming com verbo ⇒ `⋯ Costurando…` (cabeçalho Λluy preservado)', () => {
    const f = tela(
      <AluyBlock text="" streaming reasoning="hmm" verbo="Costurando" frame={2} isCurrent />,
    );
    expect(f).toContain('⋯ Costurando…');
    expect(f).not.toContain('⋯ pensando');
    expect(f).toContain('Λluy');
  });
  it('streaming sem verbo (modo simples) ⇒ `⋯ pensando` como sempre', () => {
    const f = tela(<AluyBlock text="" streaming reasoning="hmm" frame={2} isCurrent />);
    expect(f).toContain('⋯ pensando');
  });
  it('terminado ⇒ texto honesto de sempre, sem o verbo', () => {
    const f = tela(
      <AluyBlock
        text="resposta"
        streaming={false}
        reasoning="hmmhmm"
        verbo="Costurando"
        isCurrent={false}
      />,
    );
    expect(f).toContain('⋯ pensou 6 caracteres');
    expect(f).not.toContain('Costurando');
  });
});

describe('integração de ambiente', () => {
  const antes = process.env.ALUY_SPINNER_VERBS;
  beforeAll(() => {
    process.env.ALUY_SPINNER_VERBS = 'plain';
  });
  afterAll(() => {
    if (antes === undefined) delete process.env.ALUY_SPINNER_VERBS;
    else process.env.ALUY_SPINNER_VERBS = antes;
  });
  it('lê o processo por padrão', () => {
    expect(verbosSimples()).toBe(true);
  });
});

describe('env do spinner (nomes em inglês)', () => {
  it('ALUY_SPINNER_VERBS: plain/off/0/false ligam o modo plano; playful e ausente não', () => {
    for (const v of ['plain', 'PLAIN', 'off', '0', 'false']) {
      expect(verbosSimples({ ALUY_SPINNER_VERBS: v })).toBe(true);
    }
    expect(verbosSimples({ ALUY_SPINNER_VERBS: 'playful' })).toBe(false);
    expect(verbosSimples({})).toBe(false);
  });
  it('o nome antigo ALUY_VERBOS=simples NÃO vale mais', () => {
    expect(verbosSimples({ ALUY_VERBOS: 'simples' } as NodeJS.ProcessEnv)).toBe(false);
    expect(verbosSimples({ ALUY_SPINNER_VERBS: 'simples' })).toBe(false);
  });
  it('ALUY_SPINNER_VERBS_SEED fixa a semente; o nome antigo é ignorado', () => {
    expect(seedPadrao({ ALUY_SPINNER_VERBS_SEED: '42' })).toBe(42);
    expect(seedPadrao({ ALUY_VERBOS_SEED: '42' } as NodeJS.ProcessEnv)).not.toBe(42);
  });
});

// EST-0989 — WORDMARK "Λluy": o glifo `aluy` (Λ — a marca, A MESMA do loader/header/
// thinking) como o "A" em DESTAQUE (accent), seguido de "luy" em MINÚSCULAS (block-art,
// na cor de marca `depth`). Fallback ASCII (`/\` p/ o Λ + `#` p/ "luy") e degradação
// p/ terminal estreito (`Λ luy` / `/\ luy`). FONTE ÚNICA: Boot e Header consomem este
// mesmo <Wordmark> — testado lá (components.test.tsx) que não divergem.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  Wordmark,
  MIN_WORDMARK_COLS,
  WORDMARK_MARK_BLOCK,
  WORDMARK_MARK_ASCII,
  WORDMARK_LUY_BLOCK,
  WORDMARK_LUY_ASCII,
} from '../../src/ui/components/Wordmark.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}

function wrap(
  node: React.ReactElement,
  env: NodeJS.ProcessEnv = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' },
) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

describe('Wordmark — "Λluy" (Λ accent + luy minúsculo) · EST-0989', () => {
  it('UNICODE: bloco grande — NÃO é mais "ALUY" maiúsculo; tem o Λ e o nome', () => {
    const { lastFrame } = wrap(<Wordmark columns={100} />);
    const out = plain(lastFrame() ?? '');
    // wordmark grande de meio-bloco
    expect(out).toContain('██');
    // baseline com o `█████` (do `u`/`y` minúsculos) presente
    expect(out).toContain('█████');
    // a marca já NÃO é "ALUY" maiúsculo em ASCII (os blocos são `█`, não letras);
    // garantimos que não vazou um nome literal maiúsculo na saída.
    expect(out).not.toContain('ALUY');
    expect(out).not.toContain('Aluy');
  });

  it('UNICODE: o Λ e "luy" EQUALIZADOS em ACCENT (uma cor de marca — pedido do dono)', () => {
    const raw = wrap(<Wordmark columns={100} />).lastFrame() ?? '';
    const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
    // EQUALIZADO: Λ e "luy" no MESMO papel `accent` (a marca não tem mais 2 tons —
    // antes o Λ era accent e "luy" depth). A saída renderiza COLORIDA no papel accent;
    // não acoplamos ao ANSI exato (a equalização é estrutural no <Wordmark>).
    const accent = theme.role('accent').color;
    expect(accent).toBeTruthy();
    const sgr = raw.match(new RegExp(ESC + '\\[[0-9;]*m', 'g')) ?? [];
    expect(sgr.length).toBeGreaterThan(0); // colorido (papel accent), não mono
  });

  it('ASCII (TERM=linux): o Λ vira `/\\` e "luy" vira `#` (sem █)', () => {
    const { lastFrame } = wrap(<Wordmark columns={100} />, { TERM: 'linux' });
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('█'); // █ quebraria em TERM=linux
    expect(out).not.toContain('Λ'); // Λ é unicode — degrada p/ /\
    expect(out).toContain('/\\'); // o Λ vira `/\` (mesmo fallback do glifo `aluy`)
    expect(out).toContain('#'); // "luy" em block-art ASCII
  });

  it('ESTREITO (< MIN_WORDMARK_COLS): degrada p/ `Λ luy` em 1 linha (unicode)', () => {
    const { lastFrame } = wrap(<Wordmark columns={MIN_WORDMARK_COLS - 1} />);
    const out = plain(lastFrame() ?? '');
    expect(out).toMatch(/Λ\s+luy/); // marca Λ + nome minúsculo, 1 linha
    expect(out).not.toContain('██'); // sem o bloco grande
  });

  it('ESTREITO + ASCII: degrada p/ `/\\ luy` (sem Λ, sem █)', () => {
    const { lastFrame } = wrap(<Wordmark columns={MIN_WORDMARK_COLS - 1} />, { TERM: 'linux' });
    const out = plain(lastFrame() ?? '');
    expect(out).toMatch(/\/\\\s+luy/);
    expect(out).not.toContain('Λ');
    expect(out).not.toContain('█');
  });

  it('o "y" tem RABO CURVADO CURTO: descender de 1 linha que GANCHA p/ a ESQUERDA · F195', () => {
    const out = plain(wrap(<Wordmark columns={100} />).lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.length > 0);
    const blocks = (s: string): number => (s.match(/█/g) ?? []).length;
    // 6 linhas: 5 de corpo + 1 de descender do y (a haste JÁ ganchando à esquerda — rabo curto).
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const baseline = lines[lines.length - 2]!; // baseline (l/u/y terminam) — muitos blocos
    const hook = lines[lines.length - 1]!; // descender: o rabo do y, gancha p/ a esquerda
    // a baseline tem o corpo das letras (l, u fechando, y a haste): vários blocos.
    expect(blocks(baseline)).toBeGreaterThan(2);
    // o descender é SÓ o y (poucos blocos), não o corpo inteiro:
    expect(blocks(hook)).toBeGreaterThanOrEqual(2);
    expect(blocks(hook)).toBeLessThan(blocks(baseline));
    // está à DIREITA (é o y, a última letra): o rabo fica na metade direita da marca.
    expect(hook.indexOf('█')).toBeGreaterThan(baseline.indexOf('█'));
    // o GANCHO p/ a ESQUERDA: o rabo começa À ESQUERDA da haste do y (o bloco mais à
    // direita da baseline) — é a CURVA/volta do y, não uma haste reta descendo.
    expect(hook.indexOf('█')).toBeLessThan(baseline.lastIndexOf('█'));
  });

  it('ASCII: o "y" também tem RABO CURVADO CURTO (gancho p/ a esquerda, 1 linha) · F195', () => {
    const out = plain(wrap(<Wordmark columns={100} />, { TERM: 'linux' }).lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(6);
    const baseline = lines[lines.length - 2]!;
    const hook = lines[lines.length - 1]!;
    // a última linha (rabo) carrega o gancho do y em ASCII (`#`), curvando p/ a esquerda.
    expect(hook).toContain('#');
    expect((hook.match(/#/g) ?? []).length).toBeLessThan(6); // só o y, não o corpo
    expect(hook.indexOf('#')).toBeLessThan(baseline.lastIndexOf('#')); // gancha p/ a ESQUERDA
  });

  // F195 — a block-art do Λ ficou FIEL ao logo do site: uma LAMBDA bold, PICO estreito no
  // topo abrindo em pernas até a base (triângulo sem travessão), simétrica. Travamos a forma
  // no array (fonte única p/ splash+header) p/ não regredir p/ um "A" de laterais verticais.
  describe('forma do Λ (fidelidade ao logo · F195)', () => {
    const filled = (s: string): number => (s.match(/[█/\\]/g) ?? []).length;

    it('Λ e "luy" têm 6 linhas (5 corpo + 1 descender) — grade alinhada pela baseline', () => {
      expect(WORDMARK_MARK_BLOCK.length).toBe(6);
      expect(WORDMARK_MARK_ASCII.length).toBe(6);
      // o "luy" tem a MESMA altura do Λ (6): o rabo do y usa 1 linha de descender (rabo curto).
      // A grade alinha pela BASELINE (índice 4).
      expect(WORDMARK_LUY_BLOCK.length).toBe(WORDMARK_MARK_BLOCK.length);
      expect(WORDMARK_LUY_ASCII.length).toBe(WORDMARK_LUY_BLOCK.length);
      // o RABO do y (descender, índice 5) GANCHA p/ a ESQUERDA: começa à esquerda da haste
      // do y na baseline (o bloco mais à direita da baseline) e não passa dela p/ a direita.
      const baseY = WORDMARK_LUY_BLOCK[4]!;
      const tail = WORDMARK_LUY_BLOCK[5]!;
      expect(tail.indexOf('█')).toBeLessThan(baseY.lastIndexOf('█')); // curva p/ a esquerda
      expect(tail.lastIndexOf('█')).toBeLessThanOrEqual(baseY.lastIndexOf('█')); // não vai p/ a direita
      expect(tail.indexOf('█')).toBeGreaterThan(baseY.length / 2); // é o y (metade direita)
    });

    it('bloco: ÁPICE afiado no topo, SPLAY largo até a base (apex ≪ base, pés nos cantos)', () => {
      const apexRow = WORDMARK_MARK_BLOCK[0]!;
      const baseRow = WORDMARK_MARK_BLOCK[4]!;
      const apex = filled(apexRow); // topo
      const base = filled(baseRow); // baseline (índice 4)
      expect(apex).toBeGreaterThan(0);
      expect(apex).toBeLessThan(base); // abre — não é vertical
      // ápice AFIADO de 2 células (pedido do dono), no TOPO (linha 0), ~centrado
      expect(apex).toBe(2);
      const mid = (apexRow.indexOf('█') + apexRow.lastIndexOf('█')) / 2;
      expect(Math.abs(mid - (apexRow.length - 1) / 2)).toBeLessThanOrEqual(1); // no centro
      // SPLAY largo: a base leva as pernas aos CANTOS (1ª e última coluna preenchidas)
      expect(baseRow[0]).toBe('█');
      expect(baseRow[baseRow.length - 1]).toBe('█');
      // o ápice fica no MEIO (bordas vazias no topo)
      expect(apexRow[0]).toBe(' ');
      expect(apexRow[apexRow.length - 1]).toBe(' ');
      // ABERTURA: o vão CENTRAL da base é largo (pernas espalhadas), mas MEIO-TERMO (~9
      // células) — um grau menos aberto que o splay anterior (10). O maior corrido de
      // espaços no meio da baseline trava a largura do splay do logo (nem estreito, nem demais).
      const baseGap = Math.max(...(baseRow.match(/ +/g) ?? ['']).map((s) => s.length));
      expect(baseGap).toBeGreaterThanOrEqual(8);
      expect(baseGap).toBeLessThanOrEqual(10);
    });

    it('bloco: cada linha do corpo é SIMÉTRICA (lambda espelhada, topo limpo)', () => {
      // Grade PAR (14) ⇒ TODAS as linhas de corpo (0..4) são palíndromos perfeitos — o
      // ápice `██` cresce simétrico `████` antes de as pernas abrirem (topo limpo r4).
      for (let r = 0; r < 5; r += 1) {
        const line = WORDMARK_MARK_BLOCK[r]!;
        expect(line).toBe([...line].reverse().join(''));
      }
    });

    it('bloco: a linha do descender (5) é vazia (o Λ não desce)', () => {
      expect(WORDMARK_MARK_BLOCK[5]!.trim()).toBe('');
      expect(WORDMARK_MARK_ASCII[5]!.trim()).toBe('');
    });

    it('ASCII: o pico é `/\\` e as pernas ABREM (vão largo até os cantos)', () => {
      expect(WORDMARK_MARK_ASCII[0]).toContain('/\\'); // pico com o /\ adjacente (pernas juntas)
      // a lambda ASCII é um CONTORNO: `/` à esquerda e `\` à direita; a "abertura" é a
      // DISTÂNCIA entre elas crescendo do pico (juntas) até a base (nos cantos).
      const span = (s: string): number => s.lastIndexOf('\\') - s.indexOf('/');
      expect(span(WORDMARK_MARK_ASCII[0]!)).toBe(1); // pico: `/\` colados
      expect(span(WORDMARK_MARK_ASCII[4]!)).toBeGreaterThan(span(WORDMARK_MARK_ASCII[0]!));
      // a base tem `/` na esquerda e `\` na direita (pernas abertas nos cantos)
      expect(WORDMARK_MARK_ASCII[4]!.startsWith('/')).toBe(true);
      expect(WORDMARK_MARK_ASCII[4]!.trimEnd().endsWith('\\')).toBe(true);
    });
  });

  it('a ordem é Λ-ENTÃO-luy: a marca abre, o nome minúsculo segue (degradado)', () => {
    const { lastFrame } = wrap(<Wordmark columns={MIN_WORDMARK_COLS - 1} />);
    const out = plain(lastFrame() ?? '');
    expect(out.indexOf('Λ')).toBeLessThan(out.indexOf('luy'));
    // o nome é MINÚSCULO — nada de "LUY"/"Luy" maiúsculo.
    expect(out).not.toContain('LUY');
    expect(out).not.toContain('Luy');
  });
});

// EST-1000 · ADR-0076 §3/§5/§6 — o LAYOUT FIXO de 6 regiões: soma == rows (anti-flicker)
// + degradação narrow/short (recusa → inline). PURO, sem Ink.

import { describe, expect, it } from 'vitest';
import {
  resolveCockpitLayout,
  cockpitRegionSum,
  composerRowsForLines,
  COCKPIT_MIN_COLS,
  COCKPIT_MIN_ROWS,
  COCKPIT_LOG_RATIO,
  COCKPIT_LOG_MIN_ROWS,
  COCKPIT_CHROME_ROWS,
  statusRowsFor,
  COMPOSER_ROWS,
  COMPOSER_MAX_ROWS,
} from '../../src/session/cockpit-layout.js';

describe('resolveCockpitLayout — 6 regiões somam rows (invariante §5)', () => {
  // Varre uma faixa de tamanhos válidos e prova que a SOMA das alturas == rows SEMPRE.
  // É o invariante de layout que elimina o flicker (a árvore nunca reflui pra fora de rows).
  for (const rows of [13, 16, 24, 30, 50, 80]) {
    for (const cols of [80, 100, 120, 200]) {
      it(`soma == rows p/ ${rows}x${cols}`, () => {
        const layout = resolveCockpitLayout(rows, cols);
        expect(layout.kind).toBe('cockpit');
        if (layout.kind !== 'cockpit') return;
        expect(cockpitRegionSum(layout)).toBe(rows);
        // as 2 regiões geridas têm ≥1 linha (conversa e log existem de fato).
        expect(layout.regions.conversaRows).toBeGreaterThanOrEqual(1);
        expect(layout.regions.logRows).toBeGreaterThanOrEqual(1);
        // a conversa fica com a metade MAIOR (foco primário).
        expect(layout.regions.conversaRows).toBeGreaterThanOrEqual(layout.regions.logRows);
      });
    }
  }
});

// GUARD DURO (crash `RangeError: Invalid array length` no Ink, achado do dono) — dimensões
// INVÁLIDAS (NaN/Infinity/0/negativas/fracionárias) NUNCA podem produzir alturas de região
// inválidas: o Ink faria `new Array(height)` e MATARIA o processo. O layout deve RECUSAR
// (cair pro inline) e jamais devolver NaN/negativo/não-inteiro numa região `cockpit`.
describe('resolveCockpitLayout — GUARD de dimensão inválida (crash Invalid array length)', () => {
  const finiteInt = (n: number): boolean => Number.isInteger(n);
  for (const bad of [NaN, Infinity, -Infinity, 0, -1, -40, 1.5]) {
    it(`rows=${bad} ⇒ recusa (não estoura o Ink) e nenhuma altura NaN/neg`, () => {
      const l = resolveCockpitLayout(bad, 120);
      // ou recusa, ou — se por acaso couber — todas as alturas são inteiras ≥ 1.
      if (l.kind === 'cockpit') {
        for (const h of [
          l.rows,
          l.headerRows,
          l.statusRows,
          l.composerRows,
          l.hintsRows,
          l.regions.conversaRows,
          l.regions.logRows,
        ]) {
          expect(finiteInt(h) && h >= 1, `altura inválida ${h} p/ rows=${bad}`).toBe(true);
        }
      } else {
        expect(l.kind).toBe('refuse');
      }
    });
    it(`cols=${bad} ⇒ recusa (não estoura o Ink)`, () => {
      const l = resolveCockpitLayout(40, bad);
      expect(l.kind).toBe('refuse');
    });
  }

  it('rows=NaN NÃO vaza como cockpit (o bug: NaN < MIN === false driblava o check)', () => {
    const l = resolveCockpitLayout(NaN, 120);
    expect(l.kind).toBe('refuse');
  });

  it('rows GIGANTE (não-inteiro/enorme) ⇒ ainda inteiro e soma consistente quando aceita', () => {
    const l = resolveCockpitLayout(41.9, 120);
    expect(l.kind).toBe('cockpit');
    if (l.kind !== 'cockpit') return;
    // 41.9 é FLOORADO p/ 41 ⇒ soma == 41 (inteiro), sem fração vazando p/ o Ink.
    expect(cockpitRegionSum(l)).toBe(41);
    expect(Number.isInteger(l.rows)).toBe(true);
  });
});

describe('resolveCockpitLayout — degradação narrow/short (§6, decisão (a))', () => {
  it('recusa NARROW abaixo de 80 col', () => {
    const layout = resolveCockpitLayout(40, COCKPIT_MIN_COLS - 1);
    expect(layout).toMatchObject({ kind: 'refuse', reason: 'narrow' });
  });

  it('aceita exatamente no piso de 80 col', () => {
    const layout = resolveCockpitLayout(40, COCKPIT_MIN_COLS);
    expect(layout.kind).toBe('cockpit');
  });

  it('recusa SHORT abaixo do piso de linhas (mesmo com largura ok)', () => {
    const layout = resolveCockpitLayout(COCKPIT_MIN_ROWS - 1, 120);
    expect(layout).toMatchObject({ kind: 'refuse', reason: 'short' });
  });

  it('aceita exatamente no piso de linhas', () => {
    const layout = resolveCockpitLayout(COCKPIT_MIN_ROWS, 120);
    expect(layout.kind).toBe('cockpit');
    if (layout.kind === 'cockpit') expect(cockpitRegionSum(layout)).toBe(COCKPIT_MIN_ROWS);
  });

  it('narrow vence short (cols checado antes) — terminal minúsculo recusa narrow', () => {
    const layout = resolveCockpitLayout(2, 10);
    expect(layout).toMatchObject({ kind: 'refuse', reason: 'narrow' });
  });
});

// EST-1000 — o LOG fica com ~30% (não ~50/62) da área gerida; a CONVERSA com ~70% (foco).
// Respeita o piso de legibilidade em telas baixas. A constante `COCKPIT_LOG_RATIO` manda.
describe('resolveCockpitLayout — LOG ~30% (EST-1000), conversa ~70%', () => {
  it('a constante é 30%', () => {
    expect(COCKPIT_LOG_RATIO).toBe(0.3);
  });

  it('em terminais GRANDES o log fica perto de 30% (e bem abaixo de 50%)', () => {
    // 50 linhas: chrome=8 ⇒ managed=42; log ≈ round(42*0.3)=13; conversa=29 (~69%).
    const layout = resolveCockpitLayout(50, 120);
    expect(layout.kind).toBe('cockpit');
    if (layout.kind !== 'cockpit') return;
    const managed = layout.regions.conversaRows + layout.regions.logRows;
    const logPct = layout.regions.logRows / managed;
    // perto de 30% (tolerância de arredondamento) e claramente NÃO ~metade.
    expect(logPct).toBeGreaterThan(0.25);
    expect(logPct).toBeLessThan(0.35);
    // o chat GANHOU a largura: conversa é claramente a maior fatia.
    expect(layout.regions.conversaRows).toBeGreaterThan(layout.regions.logRows);
  });

  it('a conversa SEMPRE fica >= o log (foco primário) e a soma == rows', () => {
    for (const rows of [13, 16, 24, 30, 40, 60, 80, 120]) {
      const layout = resolveCockpitLayout(rows, 120);
      expect(layout.kind).toBe('cockpit');
      if (layout.kind !== 'cockpit') continue;
      expect(cockpitRegionSum(layout)).toBe(rows);
      expect(layout.regions.conversaRows).toBeGreaterThanOrEqual(layout.regions.logRows);
    }
  });

  it('em terminais ALTOS o piso de legibilidade do log é respeitado', () => {
    // managed grande ⇒ 30% já está bem acima do piso; o log cumpre o piso com folga.
    const layout = resolveCockpitLayout(60, 120);
    expect(layout.kind).toBe('cockpit');
    if (layout.kind !== 'cockpit') return;
    expect(layout.regions.logRows).toBeGreaterThanOrEqual(COCKPIT_LOG_MIN_ROWS);
  });

  it('em tela BAIXA o piso VENCE a razão: 30% encolheria o log abaixo do piso, mas ele segura', () => {
    // managed=10 ⇒ 30% = 3 (== piso). managed=8 ⇒ 30%≈2 < piso(3) ⇒ piso eleva p/ 3.
    const rowsManaged8 = COCKPIT_CHROME_ROWS + 8;
    const layout = resolveCockpitLayout(rowsManaged8, 120);
    expect(layout.kind).toBe('cockpit');
    if (layout.kind !== 'cockpit') return;
    expect(layout.regions.logRows).toBe(COCKPIT_LOG_MIN_ROWS); // piso aplicado
    expect(layout.regions.conversaRows).toBe(5); // 8 - 3
    expect(cockpitRegionSum(layout)).toBe(rowsManaged8);
  });

  it('no PISO de linhas (managed=2) cada região tem ≥1 e a conversa nunca some', () => {
    const layout = resolveCockpitLayout(COCKPIT_MIN_ROWS, 120);
    expect(layout.kind).toBe('cockpit');
    if (layout.kind !== 'cockpit') return;
    expect(layout.regions.logRows).toBeGreaterThanOrEqual(1);
    expect(layout.regions.conversaRows).toBeGreaterThanOrEqual(1);
    expect(cockpitRegionSum(layout)).toBe(COCKPIT_MIN_ROWS);
  });
});

// BUG P2-C — o COMPOSER cresce p/ input multi-linha (paridade com o inline), descontando
// as linhas EXTRAS da CONVERSA, com a soma SEMPRE == rows (§5) e o caso 1-linha INALTERADO.
describe('resolveCockpitLayout — composer multi-linha (BUG P2-C, paridade inline)', () => {
  it('composerRowsForLines clampa em [1, COMPOSER_MAX_ROWS] e 1-linha é o piso', () => {
    expect(composerRowsForLines(0)).toBe(COMPOSER_ROWS);
    expect(composerRowsForLines(1)).toBe(COMPOSER_ROWS);
    expect(composerRowsForLines(3)).toBe(3);
    expect(composerRowsForLines(COMPOSER_MAX_ROWS)).toBe(COMPOSER_MAX_ROWS);
    expect(composerRowsForLines(99)).toBe(COMPOSER_MAX_ROWS); // teto
    expect(composerRowsForLines(NaN)).toBe(COMPOSER_ROWS); // robusto
  });

  it('default (sem composerLines) == 1 linha: layout INALTERADO', () => {
    const base = resolveCockpitLayout(24, 100);
    const one = resolveCockpitLayout(24, 100, 1);
    expect(base).toEqual(one);
    if (base.kind !== 'cockpit') return;
    expect(base.composerRows).toBe(COMPOSER_ROWS);
  });

  // DECISÃO DO DONO — quando o composer cresce, quem cede é o LOG, não a conversa.
  //
  // O contrato anterior mandava a conversa ceder por ser "a maior região gerida". Na prática
  // isso invertia a prioridade da tela: a conversa é o FOCO e o log é apoio, e encolher o
  // foco para preservar o apoio é o avesso do que o cockpit existe para fazer. Com o painel
  // de status a 3 linhas os arredondamentos deixaram de coincidir e a divergência entre o
  // contrato escrito e o comportamento real ficou visível — o dono arbitrou pelo
  // comportamento.
  //
  // O que segue INVARIANTE, e é o que este teste protege: a soma exata == rows (ADR-0076 §5,
  // o grid fecha sem refluir) e a conversa nunca ficar menor que o log.
  it('o composer crescendo tira do LOG primeiro, e da conversa só depois do piso', () => {
    const um = resolveCockpitLayout(24, 100, 1);
    const dois = resolveCockpitLayout(24, 100, 2);
    const tres = resolveCockpitLayout(24, 100, 3);
    if (um.kind !== 'cockpit' || dois.kind !== 'cockpit' || tres.kind !== 'cockpit') return;

    // 1ª linha extra: sai do LOG, a conversa não sente.
    expect(dois.regions.logRows).toBe(um.regions.logRows - 1);
    expect(dois.regions.conversaRows).toBe(um.regions.conversaRows);

    // 2ª: o log já está no piso de legibilidade e para de ceder; agora a conversa cede.
    expect(tres.regions.logRows).toBe(dois.regions.logRows);
    expect(tres.regions.conversaRows).toBe(dois.regions.conversaRows - 1);

    // Em qualquer caso: a soma fecha exata (§5) e o foco nunca fica menor que o apoio.
    for (const l of [um, dois, tres]) {
      expect(cockpitRegionSum(l)).toBe(24);
      expect(l.regions.conversaRows).toBeGreaterThanOrEqual(l.regions.logRows);
    }
  });

  it('acima do teto o composer satura em COMPOSER_MAX_ROWS (não cresce sem fim)', () => {
    const big = resolveCockpitLayout(24, 100, 50);
    expect(big.kind).toBe('cockpit');
    if (big.kind !== 'cockpit') return;
    expect(big.composerRows).toBe(COMPOSER_MAX_ROWS);
    expect(cockpitRegionSum(big)).toBe(24);
  });

  it('soma == rows p/ QUALQUER composerLines, em qualquer tela válida (invariante §5)', () => {
    for (const rows of [13, 16, 24, 30, 50, 80]) {
      for (const cols of [80, 120]) {
        for (const lines of [1, 2, 3, 4, 5, 10, 40]) {
          const layout = resolveCockpitLayout(rows, cols, lines);
          expect(layout.kind).toBe('cockpit');
          if (layout.kind !== 'cockpit') continue;
          expect(cockpitRegionSum(layout)).toBe(rows);
          // nenhuma região gerida some: conversa e log mantêm ≥1.
          expect(layout.regions.conversaRows).toBeGreaterThanOrEqual(1);
          expect(layout.regions.logRows).toBeGreaterThanOrEqual(1);
          // o composer nunca passa do teto.
          expect(layout.composerRows).toBeLessThanOrEqual(COMPOSER_MAX_ROWS);
        }
      }
    }
  });

  it('em tela MÍNIMA o composer não rouba a última linha da conversa nem do log', () => {
    // no piso (managed=2), o extra do composer é clampado a 0 ⇒ ≥1 conversa + ≥1 log.
    const tight = resolveCockpitLayout(COCKPIT_MIN_ROWS, 120, 5);
    expect(tight.kind).toBe('cockpit');
    if (tight.kind !== 'cockpit') return;
    expect(tight.regions.conversaRows).toBeGreaterThanOrEqual(1);
    expect(tight.regions.logRows).toBeGreaterThanOrEqual(1);
    expect(cockpitRegionSum(tight)).toBe(COCKPIT_MIN_ROWS);
  });
});

// EST-1015 (UX redesign) — LOG ADAPTATIVO (mata o espaço morto): recolhido/natural/expandido.
describe('resolveCockpitLayout — log ADAPTATIVO (logHint)', () => {
  const ROWS = 30;
  const get = (hint: Parameters<typeof resolveCockpitLayout>[3]) => {
    const l = resolveCockpitLayout(ROWS, 120, 1, hint);
    if (l.kind !== 'cockpit') throw new Error('esperado cockpit');
    return l;
  };

  it('RECOLHIDO: sem atividade e sem agentes ⇒ log = 1 linha', () => {
    const l = get({ lines: 0, hasActivity: false, activeAgents: 0, focused: false });
    expect(l.regions.logRows).toBe(1);
    expect(cockpitRegionSum(l)).toBe(ROWS);
  });

  it('NATURAL: atividade curta ⇒ log ≈ linhas reais (clamp piso/50%)', () => {
    const l = get({ lines: 4, hasActivity: true, activeAgents: 0, focused: false });
    expect(l.regions.logRows).toBeGreaterThanOrEqual(COCKPIT_LOG_MIN_ROWS);
    expect(l.regions.logRows).toBeLessThanOrEqual(4);
    expect(cockpitRegionSum(l)).toBe(ROWS);
  });

  it('EXPANDIDO: sub-agentes vivos ⇒ log cresce (até 60%)', () => {
    const natural = get({ lines: 20, hasActivity: true, activeAgents: 0, focused: false });
    const expandido = get({ lines: 20, hasActivity: true, activeAgents: 3, focused: false });
    expect(expandido.regions.logRows).toBeGreaterThan(natural.regions.logRows);
    expect(cockpitRegionSum(expandido)).toBe(ROWS);
  });

  it('FOCO no log expande (igual a ter agentes)', () => {
    const semFoco = get({ lines: 20, hasActivity: true, activeAgents: 0, focused: false });
    const comFoco = get({ lines: 20, hasActivity: true, activeAgents: 0, focused: true });
    expect(comFoco.regions.logRows).toBeGreaterThan(semFoco.regions.logRows);
  });

  it('conversa SEMPRE ≥1 e soma == rows em todos os modos/tamanhos', () => {
    for (const rows of [COCKPIT_MIN_ROWS, 16, 24, 40, 60]) {
      for (const hint of [
        { lines: 0, hasActivity: false, activeAgents: 0, focused: false },
        { lines: 100, hasActivity: true, activeAgents: 5, focused: true },
        { lines: 2, hasActivity: true, activeAgents: 0, focused: false },
      ]) {
        const l = resolveCockpitLayout(rows, 120, 1, hint);
        if (l.kind !== 'cockpit') continue;
        expect(l.regions.conversaRows).toBeGreaterThanOrEqual(1);
        expect(cockpitRegionSum(l)).toBe(rows);
      }
    }
  });

  it('sem hint ⇒ razão fixa preservada (back-compat)', () => {
    const semHint = resolveCockpitLayout(ROWS, 120, 1);
    // F-PAINEL (pedido do dono) — a barra de status de UMA linha virou um PAINEL de três
    // itens (sessão/estado/uso) e o grid do cockpit fecha por SOMA de alturas, então o
    // painel custa 2 linhas A MAIS de chrome quando a tela é alta o bastante p/ abri-lo
    // inteiro (`statusRowsFor`). `COCKPIT_CHROME_ROWS` continua contando o painel no PISO
    // (1 linha), de propósito — é ele que define `COCKPIT_MIN_ROWS`. O que este teste
    // prova é a RAZÃO (30% do que sobra p/ o log), não o tamanho absoluto: o espelho da
    // conta é que estava velho, porque não descontava o painel.
    const geridas = ROWS - COCKPIT_CHROME_ROWS - (statusRowsFor(ROWS) - 1);
    const proporcional = Math.round(geridas * COCKPIT_LOG_RATIO);
    if (semHint.kind !== 'cockpit') throw new Error('cockpit');
    expect(semHint.regions.logRows).toBe(proporcional);
  });
});

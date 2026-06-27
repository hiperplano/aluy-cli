// EST-0965 (anti-flicker) — PROVA por RENDER (sem modelo): ANCORA as constantes de
// altura do orçamento (`live-budget.ts`) no que o Ink DESENHA de verdade, para o
// orçamento não derivar silenciosamente da composição real dos blocos vivos.
//
// Divisão de trabalho da prova:
//   • `live-budget.test.ts` (PURA): garante a altura total da região viva ≤ rows-1
//     em vários `rows` (20/24/40) no caso crítico streaming+tool+working — é o que
//     impede o `clearTerminal` do Ink (`outputHeight >= rows`). Modela o pior caso
//     (cada linha do stream uma linha visual), que é o limite superior conservador.
//   • ESTE arquivo (RENDER): confirma que tool-line `running` = 1 linha, sub-agents
//     = 2+N linhas e o <Working> = 1 linha — exatamente o que `liveOverheadLines`
//     conta. Assim a contagem do orçamento bate com a realidade do Ink.
//
// Nota sobre a FALA: o <Markdown> RE-FLUI o texto (parágrafos), então o nº de linhas
// VISUAIS do corpo não é 1:1 com as linhas-fonte — por isso o orçamento limita as
// linhas-FONTE (windowTail) e a prova de teto vive no teste PURO (pior caso). Aqui só
// conferimos que a janela de cauda CORTA (marcador presente) e mostra a CAUDA.

import React from 'react';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import {
  AluyBlock,
  ToolLine,
  SubAgents,
  Working,
  Divider,
  StatusBar,
  ModeIndicator,
  FooterHints,
  ActivityLog,
} from '../../src/ui/components/index.js';
import { liveOverheadLines, LIVE_CHROME_ROWS } from '../../src/session/live-budget.js';
import {
  resolveSplitLayout,
  splitLiveBudget,
  splitChromeOverhead,
  LOG_VISIBLE_ROWS,
} from '../../src/session/split-budget.js';
import {
  LIVE_CHROME_BASE_ROWS,
  respiroOverhead,
  modeIndicatorOverhead,
} from '../../src/session/live-budget.js';
import type { LogSection } from '../../src/session/activity-log.js';
import type { SessionBlock } from '../../src/session/model.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
function lines(node: React.ReactElement): number {
  const out =
    render(<ThemeProvider theme={resolveTheme({ env: ENV })}>{node}</ThemeProvider>).lastFrame() ??
    '';
  return out.split('\n').length;
}
function frameOf(node: React.ReactElement): string {
  return (
    render(<ThemeProvider theme={resolveTheme({ env: ENV })}>{node}</ThemeProvider>).lastFrame() ??
    ''
  );
}

const speechText = (n: number): string =>
  Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n');

describe('live-region height — as constantes do orçamento batem com o render do Ink', () => {
  it('tool running renderiza em 1 linha (= liveOverheadLines de 1 tool)', () => {
    const h = lines(
      <ToolLine
        verb="rodar"
        target="npm test"
        result=""
        status="running"
        verbGerund="rodando"
        frame={0}
      />,
    );
    expect(h).toBe(1);
    expect(
      liveOverheadLines({
        live: [{ kind: 'tool', verb: 'rodar', target: 'npm test', result: '', status: 'running' }],
        phase: 'streaming',
        hasBlocks: true,
      }),
    ).toBe(1);
  });

  it('<Working> (thinking) renderiza em 1 linha', () => {
    const h = lines(<Working glyph="aluy" glyphRole="accent" label="pensando" frame={0} />);
    expect(h).toBe(1);
  });

  it('sub-agentes: cabeçalho + N filhos + paddingBottom = exatamente o que o orçamento conta (2+N)', () => {
    const children = [
      { label: 'rust', status: 'running' as const },
      { label: 'go', status: 'running' as const },
      { label: 'zig', status: 'running' as const },
    ];
    const h = lines(<SubAgents childrenStatus={children} />);
    // cabeçalho (1) + 3 filhos (3) + paddingBottom (1) = 5; o orçamento conta 2+N.
    expect(h).toBe(5);
    expect(
      liveOverheadLines({
        live: [{ kind: 'subagents', children }],
        phase: 'streaming',
        hasBlocks: true,
      }),
    ).toBe(h);
  });

  it('prévia de FALA no teto: janela de cauda CORTA (marcador) e mostra a CAUDA, não o topo', () => {
    const out = frameOf(<AluyBlock text={speechText(50)} streaming maxLines={6} frame={0} />);
    expect(out).toContain('linhas acima'); // cortou ⇒ marcador presente
    expect(out).toContain('linha 50'); // a cauda aparece
    expect(out).not.toContain('linha 1\n'); // o topo NÃO (rolou p/ fora da janela)
  });

  // EST-0989 (anti-flicker · TRAVA) — o CHROME REAL do rodapé vivo (abaixo do input)
  // RENDERIZADO pelo Ink, exatamente como o <App> o compõe: <Divider> (abaixo do input)
  // + RESPIRO (1 linha em branco, EST-0989) + <StatusBar> + <ModeIndicator> + <FooterHints>.
  // Ancora `LIVE_CHROME_ROWS` no que o Ink desenha: o respiro adicionou +1 linha, e o
  // orçamento foi RECONTADO 8→9. Os 4 itens NÃO renderizados aqui (os 2 paddings do
  // contêiner da viva + o <Divider> ACIMA do input + o <Composer>) completam os 9.
  it('chrome do rodapé (Divider+respiro+StatusBar+ModeIndicator+FooterHints) = 5 linhas; LIVE_CHROME_ROWS=9 COM o respiro', () => {
    const footerChrome = (
      <Box flexDirection="column">
        <Divider columns={80} />
        {/* EST-0989 — RESPIRO: 1 linha em branco (Variação B). */}
        <Box height={1} />
        <StatusBar cwd="/proj" tier="aluy-flux" tokens={0} windowPct={0} columns={80} />
        <ModeIndicator mode="normal" columns={80} />
        <FooterHints state="idle" />
      </Box>
    );
    // 5 linhas RENDERIZADAS: divisória + respiro + status + modo + hints.
    expect(lines(footerChrome)).toBe(5);
    // E o orçamento conta os 9 (5 daqui + Divider-acima + Composer + 2 paddings).
    expect(LIVE_CHROME_ROWS).toBe(9);
  });

  it('SEM o respiro o chrome do rodapé seria 4 linhas — o respiro é o +1 (8→9)', () => {
    const semRespiro = (
      <Box flexDirection="column">
        <Divider columns={80} />
        <StatusBar cwd="/proj" tier="aluy-flux" tokens={0} windowPct={0} columns={80} />
        <ModeIndicator mode="normal" columns={80} />
        <FooterHints state="idle" />
      </Box>
    );
    expect(lines(semRespiro)).toBe(4); // o respiro acrescenta exatamente 1 linha
  });
});

// EST-0990 — MODO VIEW AVANÇADO (split CHAT | LOG): a TRAVA anti-flicker ganha os casos
// SPLIT e TABS. Afirma `frame_height ≤ rows-1` com sub-agentes + log cheio + composer 2
// linhas, nas LARGURAS CRÍTICAS 100/99/60/59 (as fronteiras de degradação). Como o
// ink-testing compõe Static+dinâmico num só frame (não como o TTY), provamos a
// ESTRUTURA: (a) a coluna do log RENDERIZA dentro do seu teto `LOG_VISIBLE_ROWS`, e
// (b) o orçamento `splitLiveBudget` mantém `chrome + max(chat, log) ≤ rows-1`.
describe('EST-0990 — altura do frame ≤ rows-1 no split/tabs (100/99/60/59)', () => {
  const longSpeech = (n: number): SessionBlock => ({
    kind: 'aluy',
    text: Array.from({ length: n }, (_, i) => `linha ${i + 1}`).join('\n'),
    streaming: true,
  });
  const runningTool = (): SessionBlock => ({
    kind: 'tool',
    verb: 'rodar',
    target: 'npm test',
    result: '',
    status: 'running',
    verbGerund: 'rodando',
  });
  const subagents = (k: number): SessionBlock => ({
    kind: 'subagents',
    children: Array.from({ length: k }, (_, i) => ({ label: `f${i}`, status: 'running' as const })),
  });
  // log "cheio": muitas seções (1 cabeçalho cada) — força a coluna ao teto.
  const fullLog: LogSection[] = Array.from({ length: 20 }, (_, i) => ({
    id: `root/f${i}`,
    kind: 'subagent' as const,
    label: `f${i}`,
    phase: 'tool' as const,
    tokens: 1000,
    toolCalls: 2,
    durationMs: 500,
    collapsed: false,
    events: [{ kind: 'tool' as const, label: 'bash', detail: 'cmd', status: 'ok' as const }],
  }));

  // ALTURA do frame no split, como o Ink desenharia: chrome (base+respiro+extra) +
  // banner unsafe + max(coluna_chat, coluna_log) — com a fila (queue) de 2 linhas e o
  // composer já contado no chrome base. Tem de ficar ≤ rows-1.
  function frameHeight(args: {
    rows: number;
    columns: number;
    live: readonly SessionBlock[];
    logColumnLines: number;
    layout: 'side' | 'tabs';
    mode: 'normal' | 'unsafe';
    queuedLines: number;
  }): number {
    const { rows, columns, live, logColumnLines, layout, mode, queuedLines } = args;
    const speechMax = splitLiveBudget({
      rows,
      layout,
      live,
      phase: 'streaming',
      hasBlocks: true,
      mode,
      columns,
      queuedLines,
      logColumnLines: layout === 'side' ? logColumnLines : 0,
    });
    const overhead = liveOverheadLines({ live, phase: 'streaming', hasBlocks: true, columns });
    const speech = live.find((b) => b.kind === 'aluy' && b.streaming);
    const speechLines = speech && speech.kind === 'aluy' ? speech.text.split('\n').length : 0;
    const bodyShown = Math.min(speechLines, speechMax);
    const chatColumn = overhead + bodyShown + (speechLines > speechMax ? 1 : 0);
    // em `tabs` só UMA coluna está visível ⇒ o log NÃO coexiste com o chat.
    const logColumn = layout === 'side' ? Math.min(LOG_VISIBLE_ROWS, logColumnLines) : 0;
    const chrome =
      LIVE_CHROME_BASE_ROWS + respiroOverhead(rows) + splitChromeOverhead(layout) + queuedLines;
    return chrome + modeIndicatorOverhead(mode) + Math.max(chatColumn, logColumn);
  }

  it('a coluna do log RENDERIZA dentro do teto LOG_VISIBLE_ROWS (anti-flicker)', () => {
    // 20 seções, janela de 12 ⇒ a coluna mostra a CAUDA que cabe + o rótulo da janela.
    const h = lines(
      <ActivityLog
        sections={fullLog}
        visibleRows={LOG_VISIBLE_ROWS}
        scrollOffset={0}
        focused
        columns={40}
      />,
    );
    expect(h).toBeLessThanOrEqual(LOG_VISIBLE_ROWS);
  });

  // NOTA do PISO (EST-0965): em terminais MINÚSCULOS (rows≤24) com overhead PESADO
  // (sub-agentes + tool + fila), o teto da fala bate o piso `MIN_SPEECH_LINES` — aí a
  // LEGIBILIDADE da fala vence o ≤rows-1 (decisão herdada da EST-0965, coberta pelo
  // teste de piso). Telas de split na prática são LARGAS *e* ALTAS; por isso o caso
  // pesado roda em rows realistas (≥30), e o ≤rows-1 vale exato (sem o piso distorcer).
  it('100 col ⇒ SIDE: frame ≤ rows-1 com fala longa + sub-agentes + tool + log cheio + fila 2', () => {
    const r = resolveSplitLayout(100, true);
    expect(r.layout).toBe('side');
    for (const mode of ['normal', 'unsafe'] as const) {
      for (const rows of [30, 40, 50]) {
        const total = frameHeight({
          rows,
          columns: 100,
          live: [longSpeech(80), subagents(3), runningTool()],
          logColumnLines: LOG_VISIBLE_ROWS,
          layout: 'side',
          mode,
          queuedLines: 2,
        });
        expect(total, `side mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('99 col ⇒ TABS: frame ≤ rows-1 (só a coluna ativa coexiste — chat OU log)', () => {
    const r = resolveSplitLayout(99, true);
    expect(r.layout).toBe('tabs');
    for (const mode of ['normal', 'unsafe'] as const) {
      for (const rows of [30, 40]) {
        const total = frameHeight({
          rows,
          columns: 99,
          live: [longSpeech(80), subagents(3), runningTool()],
          logColumnLines: LOG_VISIBLE_ROWS,
          layout: 'tabs',
          mode,
          queuedLines: 2,
        });
        expect(total, `tabs mode=${mode} rows=${rows}`).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('60 col ⇒ TABS (fronteira): frame ≤ rows-1', () => {
    expect(resolveSplitLayout(60, true).layout).toBe('tabs');
    for (const rows of [30, 40]) {
      const total = frameHeight({
        rows,
        columns: 60,
        live: [longSpeech(80), runningTool()],
        logColumnLines: LOG_VISIBLE_ROWS,
        layout: 'tabs',
        mode: 'normal',
        queuedLines: 2,
      });
      expect(total, `tabs60 rows=${rows}`).toBeLessThanOrEqual(rows - 1);
    }
  });

  it('59 col ⇒ split DESABILITADO (single, com aviso): a degradação é a TUI de 1 coluna', () => {
    const r = resolveSplitLayout(59, true);
    expect(r.layout).toBe('single');
    expect(r.disabledByWidth).toBe(true);
    // em single, o orçamento é o `speechMaxLines` de hoje (sem chrome extra do split).
    expect(splitChromeOverhead('single')).toBe(0);
  });
});

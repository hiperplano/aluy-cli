// F87/EST-0965 + ADR-0146 (D5) — PARIDADE de altura entre o ORÇAMENTO anti-flicker
// (`subAgentChildVisualLines`, dentro de `live-budget.ts`) e o RENDER real do
// `<ChildLine>` (`SubAgents.tsx`) quando o filho tem `model` (D5) + `summary`.
//
// O bug do dono: o orçamento reconstruía a linha do filho SEM o `model`. Como o
// render real ficou MAIS LONGO (o `· herdado (...)` entra antes do summary), o
// orçamento SUBESTIMAVA a altura ⇒ a região viva estourava `columns` ⇒ o Ink 5.2.1
// funde linhas de uma <Box> com vários <Text> filhos que precisam quebrar
// (F87/EST-0965, reproduzido abaixo em `[analista-de-requisitos-longo]`) ⇒ o rótulo
// do modelo é ENGOLIDO/CLIPADO no inline.
//
// Método: mede a altura REAL renderizada (Ink testing, largura fixa — mesmo idioma
// de `mode-indicator-height.test.tsx`) e a altura ORÇADA (via `liveOverheadLines`,
// isolando 1 filho num bloco `subagents` sozinho: `nonSpeechBlockLines('subagents')
// = 2 (cabeçalho + paddingBottom) + childVisualLines`) — e afirma que o ORÇAMENTO
// NUNCA fica abaixo do render real, em várias larguras REALISTAS de terminal
// (40–120 col; inclui as que forçam o wrap). Over-contar é seguro (comentado em
// live-budget.ts); SUB-contar é o bug.
//
// Nota (escopo): rótulos/slugs ADVERSARIALMENTE longos (uma única "palavra" sem
// espaço, ex. um slug custom de 30+ chars) podem, em colunas MUITO estreitas,
// escapar da matemática por caractere de `visualLines` (que não é word-wrap-aware,
// ao contrário do `wrappedLineCount`/wrap-ansi usado no cockpit) — isso é uma
// limitação PRÉ-EXISTENTE de `visualLines` (mesma conta usada p/ rótulo de tool/
// bang), não introduzida por este fix, e reproduzível mesmo SEM `model` (basta um
// `summary` longo). Fora do escopo desta correção (sincronizar o `model`); os casos
// abaixo usam comprimentos REALISTAS de label/tier/slug (o que o catálogo/D5
// realmente produz).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { SubAgents } from '../../src/ui/components/SubAgents.js';
import type { SubAgentChildView } from '../../src/ui/components/SubAgents.js';
import { liveOverheadLines } from '../../src/session/live-budget.js';
import type { SessionBlock } from '../../src/session/model.js';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');
const env = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const COLS = [40, 45, 50, 55, 60, 65, 70, 75, 80, 90, 100, 120];

/** Altura REAL (linhas não-vazias) do `<SubAgents>` com 1 filho, largura fixa `cols`. */
function renderedHeight(child: SubAgentChildView, cols: number): number {
  const theme = resolveTheme({ env });
  const { lastFrame, unmount } = render(
    <ThemeProvider theme={theme}>
      <Box width={cols} flexDirection="column">
        <SubAgents childrenStatus={[child]} />
      </Box>
    </ThemeProvider>,
  );
  const h = plain(lastFrame() ?? '')
    .split('\n')
    .filter((l) => l.trim() !== '').length;
  unmount();
  return h;
}

/**
 * Altura ORÇADA (`subAgentChildVisualLines`, indireta via `liveOverheadLines`) p/ o
 * MESMO filho/largura, incluindo o cabeçalho `⊕ 1 sub-agente:` (1 linha) — p/ comparar
 * 1:1 com `renderedHeight` (que também inclui o cabeçalho; o paddingBottom vira linha
 * em branco e é filtrado nos dois lados).
 */
function budgetedHeight(child: SubAgentChildView, cols: number): number {
  const block: SessionBlock = { kind: 'subagents', children: [child] };
  const total = liveOverheadLines({ live: [block], phase: 'idle', hasBlocks: true, columns: cols });
  // nonSpeechBlockLines('subagents') = 2 (cabeçalho + paddingBottom) + childVisualLines;
  // -1 (tira o paddingBottom, que o render filtra como linha em branco) p/ alinhar com
  // `renderedHeight` (cabeçalho + linhas do filho, sem a linha em branco final).
  return total - 1;
}

describe('paridade de altura — sub-agente com model+summary (ADR-0146 D5 / F87 EST-0965)', () => {
  const cases: readonly SubAgentChildView[] = [
    {
      label: 'rust',
      status: 'done',
      summary: '74.4k tokens · 13 tools · 2.1s',
      model: 'herdado (aluy-strata)',
    },
    {
      label: 'analista',
      status: 'done',
      summary: '128.9k tokens · 41 tools · 12.4s',
      model: 'custom · minha-api-privada',
    },
    // `running`: o `model` já aparece (D5 — visível ENQUANTO roda), summary ainda não.
    { label: 'go', status: 'running', model: 'aluy-strata' },
    {
      label: 'zig',
      status: 'fail',
      summary: '4 tokens',
      model: 'herdado (custom · time-infra)',
    },
  ];

  for (const c of cases) {
    for (const cols of COLS) {
      it(`[${c.label}] cols=${cols}: o orçamento NUNCA subestima o render real`, () => {
        const rendered = renderedHeight(c, cols);
        const budgeted = budgetedHeight(c, cols);
        expect(
          budgeted,
          `cols=${cols} — orçado=${budgeted} renderizado=${rendered}`,
        ).toBeGreaterThanOrEqual(rendered);
      });
    }
  }

  it('regressão: SEM o `model` no orçamento (fórmula pré-fix), cols=60 SUBESTIMARIA a altura', () => {
    // Prova que o bug era real: a reconstrução ANTIGA de `subAgentChildVisualLines`
    // (antes desta correção) NÃO incluía `model` — reconstrói a fórmula antiga aqui
    // (mesmo `visualLines`/char-math, só sem `modelPart`) e mostra que ela produzia
    // MENOS linhas do que o `<ChildLine>` real renderiza quando há `model`: em
    // cols=60 a linha SEM model cabe em 1 linha-fonte (não quebra), mas a linha REAL
    // (com model) tem 74 chars e quebra em 2 — a fórmula antiga orçava 1 a menos.
    const child = cases[0]!; // rust · herdado (aluy-strata) · 74.4k tokens · 13 tools · 2.1s
    const cols = 60;
    const rendered = renderedHeight(child, cols);
    const oldLine = `  [${child.label}] x pronto · ${child.summary}`; // sem `model` (bug)
    const oldBudgeted = Math.max(1, Math.ceil(oldLine.length / cols)) + 1; // + cabeçalho
    const newBudgeted = budgetedHeight(child, cols);
    expect(oldBudgeted, 'fórmula ANTIGA (sem model) subestimava — era o bug').toBeLessThan(
      newBudgeted,
    );
    expect(
      newBudgeted,
      'fórmula NOVA (com model) não subestima o render real',
    ).toBeGreaterThanOrEqual(rendered);
  });
});

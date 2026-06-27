// EST-0982 · ADR-0063 — render do painel de CONTROLE/OBSERVABILIDADE da árvore de
// fluxos (<FlowTreeView>) + o rodapé de CONTABILIDADE (<TurnFooter>) + o estado
// `parado` (cancelled) no <SubAgents>. Prova: a11y (palavra carrega o sentido), o
// TEMPO aparece (estilo Claude Code) e — RES-C-1 — o drill-in só exibe o `target` que
// já vem REDIGIDO (o componente não tem caminho p/ um stream cru).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { FlowTreeView } from '../../src/ui/components/FlowTreeView.js';
import { TurnFooter } from '../../src/ui/components/TurnFooter.js';
import { SubAgents } from '../../src/ui/components/SubAgents.js';
import { formatDuration } from '../../src/session/model.js';
import { REDACTED, type FlowSummary, type FlowDrillIn } from '@hiperplano/aluy-cli-core';

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
function plain(s: string): string {
  return s.replace(ANSI, '');
}
function wrap(node: React.ReactElement, env: NodeJS.ProcessEnv) {
  const theme = resolveTheme({ env });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}
const UTF8 = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const NOCOLOR = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color', NO_COLOR: '1' };

const overview: readonly FlowSummary[] = [
  {
    id: 'root',
    kind: 'root',
    label: 'aluy',
    phase: 'thinking',
    accounting: { tokens: 12_300, toolCalls: 2, iterations: 3, startedAt: 0, durationMs: 1_400 },
  },
  {
    id: 'root/rust',
    kind: 'subagent',
    label: 'rust',
    phase: 'tool',
    accounting: { tokens: 74_400, toolCalls: 13, iterations: 5, startedAt: 0, durationMs: 2_100 },
  },
];

describe('FlowTreeView — OVERVIEW (VER): árvore + contabilidade tokens+tempo', () => {
  it('lista os nós com rótulo de origem, fase (palavra) e contabilidade com TEMPO', () => {
    const { lastFrame } = wrap(<FlowTreeView overview={overview} selected={0} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('[aluy]');
    expect(out).toContain('[rust]');
    expect(out).toContain('pensando'); // fase da raiz (palavra, a11y)
    expect(out).toContain('rodando tool'); // fase do filho
    // contabilidade: tokens + tools + TEMPO (estilo Claude Code).
    expect(out).toContain('74.4k tokens · 13 tools · 2.1s');
    // legenda dos verbos.
    expect(out).toMatch(/parar este/);
    expect(out).toMatch(/parar todos/);
    expect(out).toMatch(/interagir/);
  });

  it('mono (NO_COLOR): a árvore e as palavras de fase seguem legíveis (a11y sem cor)', () => {
    const { lastFrame } = wrap(<FlowTreeView overview={overview} selected={1} />, NOCOLOR);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('[rust]');
    expect(out).toContain('rodando tool');
  });
});

describe('FlowTreeView — DRILL-IN (VER): RES-C-1 só atividade REDIGIDA, nunca stream cru', () => {
  it('exibe o `target` que JÁ vem redigido do core — segredo não aparece', () => {
    const drill: FlowDrillIn = {
      id: 'root/deploy',
      kind: 'subagent',
      label: 'deploy',
      phase: 'tool',
      accounting: { tokens: 1_000, toolCalls: 1, iterations: 1, startedAt: 0, durationMs: 800 },
      // O `target` chega do controller JÁ redigido (FlowNode.noteToolStart aplica
      // redactCommandSecrets). O componente o exibe como-está — não há caminho p/ cru.
      recent: [
        {
          tool: 'run_command',
          target: `curl -H "Authorization: Bearer ${REDACTED}" https://x`,
          running: true,
        },
      ],
    };
    const { lastFrame } = wrap(
      <FlowTreeView overview={overview} selected={0} drillIn={drill} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('[deploy]');
    expect(out).toContain('run_command');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('sk-'); // nenhum token de provider vaza
  });
});

describe('EST-0982 (Fase 0) · FlowTreeView DRILL-IN — render do DADO RICO da atividade', () => {
  it('MOSTRA duração + summary + diffstat + tokens quando presentes', () => {
    const drill: FlowDrillIn = {
      id: 'root/edit',
      kind: 'subagent',
      label: 'edit',
      phase: 'tool',
      accounting: { tokens: 1_000, toolCalls: 2, iterations: 1, startedAt: 0, durationMs: 800 },
      recent: [
        {
          tool: 'edit_file',
          target: 'src/app.ts',
          running: false,
          ok: true,
          ts: 0,
          durationMs: 1_250,
          summary: 'aplicado',
          added: 12,
          removed: 3,
        },
        {
          tool: 'web_fetch',
          target: 'https://x',
          running: false,
          ok: true,
          durationMs: 2_100,
          summary: '2 resultados',
          tokens: 1_280,
        },
      ],
    };
    const { lastFrame } = wrap(
      <FlowTreeView overview={overview} selected={0} drillIn={drill} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('edit_file');
    expect(out).toContain('aplicado'); // summary substitui o "ok" cru
    expect(out).toContain('1.3s'); // duração por evento (formatDuration(1250))
    expect(out).toContain('+12/−3'); // diffstat
    expect(out).toContain('2 resultados');
    expect(out).toContain('1.3k tok'); // tokens por evento (abbreviateCount)
  });

  it('DEGRADA — atividade sem os campos novos renderiza como antes (estado cru, sem meta)', () => {
    const drill: FlowDrillIn = {
      id: 'root/legacy',
      kind: 'subagent',
      label: 'legacy',
      phase: 'tool',
      accounting: { tokens: 0, toolCalls: 1, iterations: 1, startedAt: 0, durationMs: 0 },
      // Atividade "antiga": só tool/target/running/ok — nenhum campo novo.
      recent: [{ tool: 'read_file', target: 'a.ts', running: false, ok: true }],
    };
    const { lastFrame } = wrap(
      <FlowTreeView overview={overview} selected={0} drillIn={drill} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    // Isola a LINHA da atividade (não o cabeçalho do nó, que sempre traz `N tokens`).
    const row = out.split('\n').find((l) => l.includes('read_file'))!;
    expect(row).toContain('a.ts');
    expect(row).toContain('ok'); // estado cru (sem summary)
    expect(row).not.toContain('+0/−0'); // sem diffstat (campo ausente)
    expect(row).not.toContain('tok'); // sem tokens por evento
    expect(row).not.toContain('·'); // sem nenhuma meta compacta (degrada limpo)
  });

  it('TAIL ao vivo (redigido) aparece sob a atividade em curso', () => {
    const drill: FlowDrillIn = {
      id: 'root/run',
      kind: 'subagent',
      label: 'run',
      phase: 'tool',
      accounting: { tokens: 0, toolCalls: 1, iterations: 1, startedAt: 0, durationMs: 500 },
      recent: [
        {
          tool: 'run_command',
          target: 'npm test',
          running: true,
          ts: 0,
          durationMs: 500,
          // já redigido pelo core; o componente o exibe como-está.
          tail: `executando…\ntoken=${REDACTED}`,
        },
      ],
    };
    const { lastFrame } = wrap(
      <FlowTreeView overview={overview} selected={0} drillIn={drill} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('executando…');
    expect(out).toContain(REDACTED);
    expect(out).not.toContain('sk-');
  });
});

describe('TurnFooter — CONTABILIDADE do agente principal (estilo Claude Code)', () => {
  it('mostra tokens + tools + tempo; ✓ quando concluído', () => {
    const { lastFrame } = wrap(
      <TurnFooter accounting={{ tokens: 12_300, toolCalls: 2, durationMs: 4_100, live: false }} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('12.3k tokens · 2 tools · 4.1s');
  });

  it('omite tools quando 0; mostra só tokens + tempo', () => {
    const { lastFrame } = wrap(
      <TurnFooter accounting={{ tokens: 500, toolCalls: 0, durationMs: 900, live: true }} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('500 tokens · 0.9s');
    expect(out).not.toContain('tools');
  });
});

describe('SubAgents — estado `parado` (cancelled): a11y honesta (cessar≠falha)', () => {
  it('um filho PARADO mostra a palavra "parado", não "falhou"', () => {
    const { lastFrame } = wrap(
      <SubAgents
        childrenStatus={[
          { label: 'rust', status: 'cancelled', stop: 'cancelled', summary: '3k tokens · 1.0s' },
        ]}
      />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('parado');
    expect(out).not.toContain('falhou');
    // o resumo carrega o TEMPO (estilo Claude Code).
    expect(out).toContain('3k tokens · 1.0s');
  });
});

describe('formatDuration — estilo Claude Code', () => {
  it('sub-segundo e segundos com 1 casa; minutos com m..s', () => {
    expect(formatDuration(400)).toBe('0.4s');
    expect(formatDuration(2_000)).toBe('2s');
    expect(formatDuration(2_100)).toBe('2.1s');
    expect(formatDuration(63_000)).toBe('1m3s');
    expect(formatDuration(120_000)).toBe('2m');
  });
  it('fail-safe: negativo/NaN ⇒ 0s (nunca lança)', () => {
    expect(formatDuration(-5)).toBe('0s');
    expect(formatDuration(Number.NaN)).toBe('0s');
  });
});

// F88 (anti-flicker, Windows) — JANELAMENTO do OVERVIEW. A árvore retém até
// MAX_TERMINAL_NODES (32) terminais + os vivos, então o overview pode passar de `rows`
// numa sessão pesada (muitos sub-agentes) ⇒ o Ink cairia no caminho full-screen
// (clearTerminal por frame) ⇒ flicker no console do Windows. O `maxRows` janela a árvore.
// (O DRILL-IN já é limitado no core, MAX_RECENT=12 — não precisa de janela na UI.)
describe('FlowTreeView — janelamento do overview (árvore grande)', () => {
  const MANY: readonly FlowSummary[] = Array.from({ length: 40 }, (_, i) => ({
    id: `node-${i}`,
    kind: i === 0 ? 'root' : 'subagent',
    label: `agente-num-${i}`,
    phase: 'tool',
    accounting: { tokens: 1000, toolCalls: 1, iterations: 1, startedAt: 0, durationMs: 100 },
  }));
  const nodeLines = (out: string): number =>
    out.split('\n').filter((l) => /agente-num-\d+/.test(l)).length;

  it('JANELA a `maxRows` nós (não despeja 40) + indicador de resto', () => {
    const { lastFrame } = wrap(<FlowTreeView overview={MANY} selected={0} maxRows={8} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(nodeLines(out)).toBe(8);
    expect(out).toContain('32'); // 40 − 8 = 32 nós a mais.
    expect(out).toContain('nós a mais');
  });

  it('a janela CENTRA no selecionado (nó escolhido sempre visível, mesmo no fim)', () => {
    const { lastFrame } = wrap(<FlowTreeView overview={MANY} selected={39} maxRows={8} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('agente-num-39');
    expect(nodeLines(out)).toBe(8);
  });

  it('default seguro: SEM `maxRows`, ainda janela (teto interno 10) — nunca despeja 40', () => {
    const { lastFrame } = wrap(<FlowTreeView overview={MANY} selected={0} />, UTF8);
    const out = plain(lastFrame() ?? '');
    expect(nodeLines(out)).toBeLessThanOrEqual(10);
    expect(out).toContain('nós a mais');
  });

  it('árvore pequena (≤ maxRows) ⇒ mostra tudo, sem indicador', () => {
    const { lastFrame } = wrap(
      <FlowTreeView overview={MANY.slice(0, 3)} selected={0} maxRows={10} />,
      UTF8,
    );
    const out = plain(lastFrame() ?? '');
    expect(nodeLines(out)).toBe(3);
    expect(out).not.toContain('nós a mais');
  });
});

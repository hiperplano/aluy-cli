// EST-0990 — snapshot do <ActivityLog> (coluna do LOG no split, V2 agrupado por agente).
// Renderiza a projeção (já redigida) e confere: cabeçalho por agente com glifo de
// colapso (▼/▶), contabilidade, eventos com glifo de status, janela `▼ ao vivo`, e o
// rótulo da coluna em accent quando FOCADO.

import React from 'react';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { ActivityLog } from '../../src/ui/components/index.js';
import type { LogSection } from '../../src/session/activity-log.js';
import { displayWidth } from '../../src/session/visual-lines.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
function frameOf(node: React.ReactElement): string {
  return (
    render(<ThemeProvider theme={resolveTheme({ env: ENV })}>{node}</ThemeProvider>).lastFrame() ??
    ''
  );
}
/**
 * Renderiza dentro de um Box de largura CRAVADA — como o Cockpit monta o <ActivityLog>
 * (a região do log tem `width={columns}`). É o que ativa o `wrap` do Ink (texto só
 * quebra quando o pai tem largura). Sem isso o teste mediria overflow que a prod não tem.
 */
function frameInWidth(node: React.ReactElement, cols: number): string {
  return frameOf(<Box width={cols}>{node}</Box>);
}

const sections: readonly LogSection[] = [
  {
    id: 'root',
    kind: 'root',
    label: 'root',
    phase: 'tool',
    tokens: 18400,
    toolCalls: 6,
    durationMs: 2100,
    collapsed: false,
    events: [
      { kind: 'tool', label: 'bash', detail: 'ls', status: 'ok' },
      { kind: 'tool', label: 'run_command', detail: 'npm test', status: 'err' },
    ],
  },
  {
    id: 'root/test',
    kind: 'subagent',
    label: 'test',
    phase: 'thinking',
    tokens: 4200,
    toolCalls: 2,
    durationMs: 800,
    collapsed: true,
    events: [],
  },
];

describe('<ActivityLog> — V2 agrupado por agente', () => {
  it('mostra uma seção por agente, com [label], colapso ▼/▶ e contabilidade', () => {
    const out = frameOf(
      <ActivityLog
        sections={sections}
        visibleRows={12}
        scrollOffset={0}
        focused={false}
        columns={40}
      />,
    );
    expect(out).toContain('[root]');
    expect(out).toContain('[test]');
    expect(out).toContain('▼'); // root expandido
    expect(out).toContain('▶'); // test colapsado
    expect(out).toContain('18.4k'); // tokens abreviados
    expect(out).toContain('6 tools');
  });

  it('os eventos do agente expandido aparecem (com o detalhe); o colapsado NÃO', () => {
    const out = frameOf(
      <ActivityLog
        sections={sections}
        visibleRows={12}
        scrollOffset={0}
        focused={false}
        columns={40}
      />,
    );
    expect(out).toContain('bash');
    expect(out).toContain('run_command');
    // o sub-agente colapsado não vaza seus eventos (tinha events:[] de qualquer forma).
    expect(out).toContain('(colapsado)');
  });

  it('janela colada na cauda mostra `▼ ao vivo`', () => {
    const out = frameOf(
      <ActivityLog
        sections={sections}
        visibleRows={12}
        scrollOffset={0}
        focused={false}
        columns={40}
      />,
    );
    expect(out).toContain('▼ ao vivo');
  });

  it('sem atividade ⇒ aviso "sem atividade ainda"', () => {
    const out = frameOf(
      <ActivityLog sections={[]} visibleRows={12} scrollOffset={0} focused={false} columns={40} />,
    );
    expect(out).toContain('sem atividade');
  });
});

// EST-1000 — o LOG mostra MAIS o dado rico (#142): summary redigido · diffstat · duração ·
// tokens · tail ao vivo, quando presentes; degrada quando ausentes.
describe('<ActivityLog> — dado RICO (#142) por evento (EST-1000)', () => {
  const richSections: readonly LogSection[] = [
    {
      id: 'root',
      kind: 'root',
      label: 'root',
      phase: 'tool',
      tokens: 18400,
      toolCalls: 6,
      durationMs: 2100,
      collapsed: false,
      events: [
        {
          kind: 'tool',
          label: 'edit',
          detail: 'src/app.ts',
          status: 'ok',
          summary: 'aplicado',
          added: 12,
          removed: 4,
          durationMs: 2100,
          tokens: 1200,
        },
        {
          // running com TAIL ao vivo (já redigido na origem).
          kind: 'tool',
          label: 'run_command',
          detail: 'npm test',
          status: 'running',
          durationMs: 800,
          tail: '› 42 passed',
        },
        // evento POBRE (sem campos ricos) — deve degradar limpo, sem `undefined`/`NaN`.
        { kind: 'tool', label: 'bash', detail: 'ls', status: 'ok' },
      ],
    },
  ];

  it('mostra summary redigido, diffstat (+12 −4), duração, tokens', () => {
    const out = frameOf(
      <ActivityLog
        sections={richSections}
        visibleRows={20}
        scrollOffset={0}
        focused={false}
        columns={60}
      />,
    );
    expect(out).toContain('aplicado'); // summary REDIGIDO
    expect(out).toContain('+12 −4'); // diffstat (− = U+2212)
    expect(out).toContain('2.1s'); // duração da tool-call
    expect(out).toContain('1.2k tok'); // tokens da atividade
  });

  it('tail ao vivo aparece SÓ no evento em curso (running)', () => {
    const out = frameOf(
      <ActivityLog
        sections={richSections}
        visibleRows={20}
        scrollOffset={0}
        focused={false}
        columns={60}
      />,
    );
    expect(out).toContain('42 passed'); // tail do run_command em curso
  });

  it('degrada LIMPO no evento pobre (sem campos ricos): sem undefined/NaN, mostra status', () => {
    const out = frameOf(
      <ActivityLog
        sections={richSections}
        visibleRows={20}
        scrollOffset={0}
        focused={false}
        columns={60}
      />,
    );
    expect(out).toContain('bash');
    expect(out).not.toContain('undefined');
    expect(out).not.toContain('NaN');
    // o evento pobre cai na palavra de status `ok` (sem summary).
    expect(out).toContain('ok');
  });

  it('no painel ESTREITO (cockpit ~30%) a linha rica QUEBRA em linhas visuais (não estoura)', () => {
    const cols = 24; // coluna estreita do cockpit 30%
    const out = frameInWidth(
      <ActivityLog
        sections={richSections}
        visibleRows={20}
        scrollOffset={0}
        focused={false}
        columns={cols}
      />,
      cols,
    );
    // wrap: nenhuma linha VISÍVEL excede a largura da coluna (sem contar os escapes ANSI
    // de cor, que não ocupam célula). `strip` remove as sequências CSI.
    // eslint-disable-next-line no-control-regex
    const strip = (s: string): string => s.replace(/\u001b\[[0-9;]*m/g, '');
    for (const line of out.split('\n')) {
      expect([...strip(line)].length).toBeLessThanOrEqual(cols);
    }
    // ainda assim o dado rico está lá (em alguma linha).
    expect(out).toContain('aplicado');
  });

  // FIX (HUNT-RENDER) — `elide`/`detailRoom` mediam por `.length` (unidades UTF-16) e
  // cortavam por `slice`. Um detalhe (path/comando) com CJK ocupa o DOBRO das colunas (cada
  // CJK = 2): a linha estourava a coluna e re-fluía (wrap) ⇒ o flicker que o orçamento tenta
  // evitar; e o corte podia partir um emoji (surrogate órfão). Agora elide por DISPLAY WIDTH.
  it('detalhe CJK longo cabe na coluna por LARGURA (não estoura nem parte code point)', () => {
    const cols = 30;
    const cjkSections: readonly LogSection[] = [
      {
        id: 'root',
        kind: 'root',
        label: 'edit',
        phase: 'tool',
        collapsed: false,
        events: [
          // path com diretório CJK longo — antes do fix mediria .length e re-fluiria.
          { kind: 'tool', label: 'edit', detail: '中'.repeat(40) + '.ts', status: 'ok' },
        ],
      } as LogSection,
    ];
    const out = frameInWidth(
      <ActivityLog
        sections={cjkSections}
        visibleRows={20}
        scrollOffset={0}
        focused={false}
        columns={cols}
      />,
      cols,
    );
    // eslint-disable-next-line no-control-regex
    const strip = (s: string): string => s.replace(/\[[0-9;]*m/g, '');
    for (const line of out.split('\n')) {
      // mede por LARGURA DE EXIBIÇÃO (CJK = 2): nenhuma linha pode exceder a coluna.
      expect(displayWidth(strip(line))).toBeLessThanOrEqual(cols);
    }
    expect(out).not.toContain('�'); // nenhum surrogate partido.
  });
});

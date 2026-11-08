// ADR 0006 — o painel de tarefas usa a MESMA linha dos sub-agentes (brilho, modelo, tokens,
// tools, tempo, atividade) e aninha os agentes sob a tarefa.
import React from 'react';
import { Box } from 'ink';
import stringWidth from 'string-width';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import chalk from 'chalk';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { SubAgents, type SubAgentChildView } from '../../src/ui/components/SubAgents.js';
import { TaskPanel, type PanelRow } from '../../src/ui/components/ConciergeTasks.js';

const ENV = { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' };
const theme = resolveTheme({ env: ENV });
const ESC = String.fromCharCode(27);
const SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const plain = (s: string | undefined): string => (s ?? '').replace(SGR, '');

const running: SubAgentChildView = {
  label: 't1 refatorar auth',
  status: 'running',
  model: 'herdado (glm-5.3-flash)',
  summary: 'bash ls · 1.2k tokens · 3 tools',
  startedAt: Date.now() - 12_000,
};
const rows = (v: SubAgentChildView, kids: SubAgentChildView[] = []): PanelRow[] => [
  { kind: 'header', total: 1, running: v.status === 'running' ? 1 : 0 },
  { kind: 'task', view: v, selected: false },
  ...kids.map((c) => ({ kind: 'child' as const, child: c })),
];
const mount = (r: PanelRow[], frame: number) =>
  render(
    <ThemeProvider theme={theme}>
      <TaskPanel rows={r} columns={140} frame={frame} />
    </ThemeProvider>,
  );

describe('painel de tarefas — mesma gramática de linha dos agentes', () => {
  it('a linha da tarefa tem o MESMO conteúdo da linha de um sub-agente (estado, modelo, resumo, tempo)', () => {
    const a = mount(rows(running), 0);
    const b = render(
      <ThemeProvider theme={theme}>
        <SubAgents childrenStatus={[running]} frame={0} />
      </ThemeProvider>,
    );
    const line = (f: string | undefined): string =>
      plain(f)
        .split('\n')
        .find((l) => l.includes('[t1 refatorar auth]')) ?? '';
    expect(line(a.lastFrame())).toBe(line(b.lastFrame()));
    for (const parte of ['rodando', 'herdado (glm-5.3-flash)', 'bash ls', '1.2k tokens', '3 tools'])
      expect(line(a.lastFrame())).toContain(parte);
    expect(plain(a.lastFrame())).toContain('1 tarefa:');
    a.unmount();
    b.unmount();
  });

  it('BRILHO: tarefa rodando anima com o frame (SGR muda); concluída não anima', () => {
    const old = chalk.level;
    chalk.level = 3;
    try {
      const sgrLine = (r: PanelRow[], frame: number): string => {
        const m = mount(r, frame);
        const l = (m.lastFrame() ?? '').split('\n').find((x) => plain(x).includes('[t1')) ?? '';
        m.unmount();
        return l;
      };
      expect(sgrLine(rows(running), 0)).not.toEqual(sgrLine(rows(running), 7));
      const done: SubAgentChildView = { ...running, status: 'done', summary: '1.2k tokens · 9s' };
      expect(sgrLine(rows(done), 0)).toEqual(sgrLine(rows(done), 7));
    } finally {
      chalk.level = old;
    }
  });

  it('tarefa aguardando aprovação/arquivo mostra a palavra própria e NÃO brilha', () => {
    const old = chalk.level;
    chalk.level = 3;
    try {
      const w: SubAgentChildView = {
        label: 't1 x',
        status: 'running',
        word: 'aguardando aprovação',
      };
      const sgr = (f: number): string => {
        const m = mount(rows(w), f);
        const l = (m.lastFrame() ?? '').split('\n').find((x) => plain(x).includes('[t1')) ?? '';
        m.unmount();
        return l;
      };
      expect(plain(sgr(0))).toContain('aguardando aprovação');
      expect(plain(sgr(0))).not.toContain('rodando');
      expect(sgr(0)).toEqual(sgr(7));
    } finally {
      chalk.level = old;
    }
  });

  it('agentes da tarefa aninhados (mais à direita que a tarefa), também com brilho', () => {
    const old = chalk.level;
    chalk.level = 3;
    try {
      const kid: SubAgentChildView = { label: 'revisor', status: 'running', summary: '0 tokens' };
      const m0 = mount(rows(running, [kid]), 0);
      const lines = plain(m0.lastFrame()).split('\n');
      const col = (needle: string): number => lines.find((l) => l.includes(needle))!.indexOf('[');
      expect(col('[revisor]')).toBeGreaterThan(col('[t1 refatorar auth]'));
      const sgr = (f: number): string => {
        const m = mount(rows(running, [kid]), f);
        const l =
          (m.lastFrame() ?? '').split('\n').find((x) => plain(x).includes('[revisor]')) ?? '';
        m.unmount();
        return l;
      };
      expect(sgr(0)).not.toEqual(sgr(7));
      m0.unmount();
    } finally {
      chalk.level = old;
    }
  });
});

describe('painel de tarefas — cada linha ocupa UMA linha do terminal (composer estável)', () => {
  it('em terminal estreito as linhas da tarefa e dos agentes são cortadas, não quebradas', () => {
    const kid: SubAgentChildView = { ...running, label: 'um agente com nome comprido' };
    const r = rows(running, [kid, kid]);
    const { lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <Box width={50}>
          <TaskPanel rows={r} columns={50} frame={0} />
        </Box>
      </ThemeProvider>,
    );
    expect(plain(lastFrame()).split('\n').length).toBe(r.length);
    unmount();
  });
});

describe('rodapé de agentes (clássico) — uma linha por agente', () => {
  it('a cópia fixa (flush) não quebra a linha do agente em terminal estreito', () => {
    const { lastFrame, unmount } = render(
      <ThemeProvider theme={theme}>
        <Box width={50}>
          <SubAgents childrenStatus={[running, running]} flush frame={0} />
        </Box>
      </ThemeProvider>,
    );
    expect(plain(lastFrame()).split('\n').length).toBe(3); // cabeçalho + 2 agentes
    unmount();
  });
});

describe('painel de tarefas — nenhuma linha chega à borda do terminal (fantasma de quadro)', () => {
  // Relato do dono: com 3 tarefas rodando e atividade `bash find "$HOME" … -printf '%s\t%p\n'` o
  // topo do rodapé ficava para trás a cada tick. Uma linha que o terminal desenha mais larga que a
  // conta do Ink quebra fisicamente; a folga à direita evita, e o tab/controle some do texto.
  const longo: SubAgentChildView = {
    label: 't2 Atividade rápida aleatória: listar os 10 maiores arquivos do disco',
    status: 'running',
    model: 'herdado (z-ai/glm-5.3-flash)',
    summary: `bash find "$HOME" -xdev -type f -p‹redigido› '%s\t%p\\n' 2>/dev/null | sort -rn | head -10 · 9.6k tokens · 3 tools`,
    startedAt: Date.now() - 15_000,
  };
  for (const largura of [80, 120, 200]) {
    it(`3 tarefas rodando a ${largura} colunas: nenhuma linha passa de ${largura - 1} células e há 1 linha por linha lógica`, () => {
      const r: PanelRow[] = [
        { kind: 'header', total: 3, running: 3 },
        ...[1, 2, 3].map((n) => ({
          kind: 'task' as const,
          view: { ...longo, label: `t${n} ${longo.label}` },
          selected: false,
        })),
      ];
      const { lastFrame, unmount } = render(
        <ThemeProvider theme={theme}>
          <Box width={largura}>
            <TaskPanel rows={r} columns={largura} frame={0} />
          </Box>
        </ThemeProvider>,
      );
      const linhas = plain(lastFrame()).split('\n');
      expect(linhas.length).toBe(r.length);
      for (const l of linhas) expect(stringWidth(l)).toBeLessThanOrEqual(largura - 1);
      expect(plain(lastFrame())).not.toContain('\t');
      unmount();
    });
  }
});

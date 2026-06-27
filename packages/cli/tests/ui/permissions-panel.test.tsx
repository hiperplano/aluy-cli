// EST-0968 — render do <PermissionsPanel> (ink-testing-library). Cobre: as três
// secoes mutáveis (modo / tools seguras / grants), as categorias TRAVADAS com a
// palavra "travado" + a11y (glifo+palavra), e o lembrete de que o único bypass
// total é --unsafe. PROVA visual: o painel mostra sempre-ask como travado e NUNCA
// oferece um caminho p/ allow nessas categorias.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { PermissionsPanel } from '../../src/ui/components/PermissionsPanel.js';
import type { PanelRow } from '../../src/ui/hooks/usePermissionsPanel.js';
import { LOCKED_CATEGORIES } from '@aluy/cli-core';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

/** Linhas representativas: modo + tool segura + grant + todas as travadas. */
function sampleRows(): readonly PanelRow[] {
  return [
    { kind: 'mode', mode: 'normal', actionable: true },
    { kind: 'safe-tool', tool: 'read_file', decision: 'allow', actionable: true },
    { kind: 'safe-tool', tool: 'grep', decision: 'ask', actionable: true },
    { kind: 'grant', grantKey: 'run_command npm test', actionable: true },
    ...LOCKED_CATEGORIES.map((category) => ({
      kind: 'locked' as const,
      category,
      actionable: false as const,
    })),
  ];
}

describe('PermissionsPanel — render', () => {
  it('mostra a dica de teclas (↑↓/enter/esc) e o modo atual', () => {
    const { lastFrame } = wrap(<PermissionsPanel rows={sampleRows()} selected={0} mode="normal" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('↑↓');
    expect(out).toContain('enter');
    expect(out).toContain('esc');
    expect(out).toContain('NORMAL');
  });

  it('mostra as três secoes mutáveis: modo, tools seguras, grants', () => {
    const { lastFrame } = wrap(<PermissionsPanel rows={sampleRows()} selected={0} mode="normal" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('modo de sessao');
    expect(out).toContain('tools seguras');
    expect(out).toContain('read_file');
    expect(out).toContain('grep');
    expect(out).toContain('REVOGA');
    expect(out).toContain('run_command npm test');
  });

  it('mostra CADA categoria sempre-ask como TRAVADA (palavra "travado", a11y)', () => {
    const { lastFrame } = wrap(<PermissionsPanel rows={sampleRows()} selected={0} mode="normal" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('TRAVADO');
    expect(out).toContain('travado');
    // categorias perigosas presentes e marcadas
    expect(out).toContain('destrutivo');
    expect(out).toContain('rede');
    expect(out).toContain('escalada');
    expect(out).toContain('exec de pacote');
    expect(out).toContain('segredos');
  });

  // EST-0959 — a flag exibida ao usuário é `--yolo` (`--unsafe` virou alias deprecado).
  it('o journal ~/.aluy/ é mostrado como DENY (nem --yolo libera)', () => {
    const { lastFrame } = wrap(<PermissionsPanel rows={sampleRows()} selected={0} mode="normal" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('journal');
    expect(out).toContain('deny (nem --yolo)');
  });

  it('lembra que o ÚNICO bypass total é --yolo (o painel não relaxa travado)', () => {
    const { lastFrame } = wrap(<PermissionsPanel rows={sampleRows()} selected={0} mode="normal" />);
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('--yolo');
    expect(out).toMatch(/nao relaxa|não relaxa/);
  });

  it('em modo unsafe, o topo pinta o aviso (palavra YOLO / aprovacao DESLIGADA)', () => {
    const { lastFrame } = wrap(
      <PermissionsPanel
        rows={[{ kind: 'mode', mode: 'unsafe', actionable: true }]}
        selected={0}
        mode="unsafe"
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('YOLO');
    expect(out).toContain('DESLIGADA');
  });

  it('o painel NUNCA renderiza um caminho de "allow" p/ categoria travada', () => {
    const { lastFrame } = wrap(<PermissionsPanel rows={sampleRows()} selected={4} mode="normal" />);
    const out = plain(lastFrame() ?? '');
    // a linha travada selecionada mostra a explicacao, jamais um toggle p/ allow.
    expect(out).not.toMatch(/destrutivo.*=\s*allow/i);
    expect(out).not.toMatch(/rede.*=\s*allow/i);
  });
});

// F88 (anti-flicker, Windows) — JANELAMENTO. Os GRANTS de sessão acumulam ("sempre nesta
// sessão") numa sessão longa em modo normal, então o painel pode passar de `rows` ⇒ o Ink
// cairia no caminho full-screen (clearTerminal por frame) ⇒ flicker no console do Windows.
// O `maxRows` janela as linhas (centrado na selecionada) com indicadores ↑N/↓N.
describe('PermissionsPanel — janelamento (grants acumulados)', () => {
  function manyGrants(n: number): readonly PanelRow[] {
    return [
      { kind: 'mode', mode: 'normal', actionable: true },
      ...Array.from({ length: n }, (_, i) => ({
        kind: 'grant' as const,
        grantKey: `grant-num-${i}`,
        actionable: true as const,
      })),
    ];
  }
  const grantLines = (out: string): number =>
    out.split('\n').filter((l) => /grant-num-\d+/.test(l)).length;

  it('JANELA a `maxRows` linhas (não despeja 41) + indicadores ↑/↓', () => {
    const { lastFrame } = wrap(
      <PermissionsPanel rows={manyGrants(40)} selected={20} mode="normal" maxRows={8} />,
    );
    const out = plain(lastFrame() ?? '');
    // total renderizado de linhas-grant nunca passa do teto.
    expect(grantLines(out)).toBeLessThanOrEqual(8);
    expect(out).toContain('acima'); // ↑ N acima
    expect(out).toContain('abaixo'); // ↓ N abaixo
  });

  it('a janela CENTRA na selecionada (linha escolhida sempre visível, mesmo no fim)', () => {
    const { lastFrame } = wrap(
      <PermissionsPanel rows={manyGrants(40)} selected={40} mode="normal" maxRows={8} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('grant-num-39'); // o último grant (índice 40 = grant 39), selecionado.
    expect(out).not.toContain('abaixo'); // no fim ⇒ sem indicador "abaixo".
  });

  it('default seguro: SEM `maxRows`, ainda janela (teto interno 14) — nunca despeja 40', () => {
    const { lastFrame } = wrap(
      <PermissionsPanel rows={manyGrants(40)} selected={0} mode="normal" />,
    );
    const out = plain(lastFrame() ?? '');
    expect(grantLines(out)).toBeLessThanOrEqual(14);
    expect(out).toContain('abaixo');
  });

  it('painel pequeno (≤ maxRows) ⇒ mostra tudo, sem indicadores de janela', () => {
    const { lastFrame } = wrap(
      <PermissionsPanel rows={manyGrants(3)} selected={0} mode="normal" maxRows={14} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('acima');
    expect(out).not.toContain('abaixo');
  });
});

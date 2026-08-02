// F88 (anti-flicker, Windows) — render do <RewindPicker> (ink-testing-library), foco no
// JANELAMENTO da etapa `list`. Sem teto de altura, uma sessão longa (1 checkpoint por
// prompt → dezenas) faria o `/rewind` despejar a lista inteira no inline ⇒ a região
// dinâmica estourava `rows` ⇒ o Ink caía no caminho full-screen (`outputHeight>=rows`,
// clearTerminal por frame) ⇒ flicker no console do Windows. O `maxRows` janela a lista.

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { ThemeProvider } from '../../src/ui/theme/context.js';
import { resolveTheme } from '../../src/ui/theme/theme.js';
import { RewindPicker } from '../../src/ui/components/RewindPicker.js';
import type { Checkpoint } from '@hiperplano/aluy-cli-core';

function wrap(node: React.ReactElement) {
  const theme = resolveTheme({ env: { LANG: 'en_US.UTF-8', TERM: 'xterm-256color' } });
  return render(<ThemeProvider theme={theme}>{node}</ThemeProvider>);
}

const ESC = String.fromCharCode(27);
const ANSI = new RegExp(ESC + '\\[[0-9;]*[A-Za-z]', 'g');
const plain = (s: string): string => s.replace(ANSI, '');

const MANY: readonly Checkpoint[] = Array.from({ length: 40 }, (_, i) => ({
  id: `cp-${i}`,
  ordinal: i + 1,
  ts: (i + 1) * 1000,
  label: `prompt-num-${i}`,
  journalSeq: i + 1,
  blockCount: (i + 1) * 2,
}));

const entryLines = (out: string): number =>
  out.split('\n').filter((l) => /prompt-num-\d+/.test(l)).length;

describe('RewindPicker — janelamento da lista de checkpoints', () => {
  it('JANELA a lista a `maxRows` (não despeja 40 pontos) + indicador de resto', () => {
    const { lastFrame } = wrap(
      <RewindPicker phase="list" checkpoints={MANY} actions={[]} selected={0} maxRows={8} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(entryLines(out)).toBe(8); // exatamente o teto, não os 40.
    expect(out).toContain('32'); // 40 − 8 = 32 pontos a mais.
    expect(out).toContain('a mais');
  });

  it('a janela CENTRA no selecionado (ponto escolhido sempre visível, mesmo no fim)', () => {
    const { lastFrame } = wrap(
      <RewindPicker phase="list" checkpoints={MANY} actions={[]} selected={39} maxRows={8} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('prompt-num-39'); // o último, selecionado, está na janela.
    expect(out).toMatch(/›/);
    expect(entryLines(out)).toBe(8);
  });

  it('default seguro: SEM `maxRows`, ainda janela (teto interno 10) — nunca despeja 40', () => {
    const { lastFrame } = wrap(
      <RewindPicker phase="list" checkpoints={MANY} actions={[]} selected={0} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(entryLines(out)).toBeLessThanOrEqual(10);
    expect(out).toContain('a mais');
  });

  it('lista MENOR que `maxRows` ⇒ mostra tudo, sem indicador de resto', () => {
    const few = MANY.slice(0, 3);
    const { lastFrame } = wrap(
      <RewindPicker phase="list" checkpoints={few} actions={[]} selected={0} maxRows={10} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(entryLines(out)).toBe(3);
    expect(out).not.toContain('a mais');
  });

  it('lista VAZIA ⇒ "nenhum ponto de restauração"', () => {
    const { lastFrame } = wrap(
      <RewindPicker phase="list" checkpoints={[]} actions={[]} selected={0} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('nenhum ponto de restauração');
  });

  // F89 (wrap-aware) — com `columns`, a janela conta LINHAS VISUAIS (não itens), pois em
  // terminal estreito cada entrada quebra em ≥2 linhas. Sem cobertura anterior deste ramo
  // (rowHeight só é construído quando `columns` é passado).
  it('COM `columns` (wrap-aware), ainda janela e mantém o selecionado visível', () => {
    const { lastFrame } = wrap(
      <RewindPicker
        phase="list"
        checkpoints={MANY}
        actions={[]}
        selected={20}
        maxRows={8}
        columns={40}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('prompt-num-20');
    expect(out).toMatch(/›/);
  });
});

const TARGET_CP: Checkpoint = {
  id: 'cp-target',
  ordinal: 7,
  ts: 7000,
  label: 'prompt-alvo',
  journalSeq: 7,
  blockCount: 14,
};

describe('RewindPicker — etapa `action` (ação sobre o ponto-alvo)', () => {
  it('mostra a dica de teclas da etapa `action`', () => {
    const { lastFrame } = wrap(
      <RewindPicker
        phase="action"
        checkpoints={[]}
        actions={['both', 'conversation', 'code']}
        selected={0}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('o que restaurar?');
    expect(out).toContain('esc volta');
  });

  it('exibe o cabeçalho do ponto-alvo (`#ordinal · label`) quando `target` é dado', () => {
    const { lastFrame } = wrap(
      <RewindPicker
        phase="action"
        checkpoints={[]}
        actions={['both', 'conversation', 'code']}
        selected={0}
        target={TARGET_CP}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('#7');
    expect(out).toContain('prompt-alvo');
  });

  it('SEM `target` ⇒ não imprime cabeçalho de alvo', () => {
    const { lastFrame } = wrap(
      <RewindPicker phase="action" checkpoints={[]} actions={['both']} selected={0} />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('#7');
  });

  it('lista as 3 ações traduzidas, marcando a SELECIONADA com ›', () => {
    const { lastFrame } = wrap(
      <RewindPicker
        phase="action"
        checkpoints={[]}
        actions={['both', 'conversation', 'code']}
        selected={1}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('código + conversa');
    expect(out).toContain('só a conversa');
    expect(out).toContain('só o código');
    const lines = out.split('\n').filter((l) => l.includes('conversa') || l.includes('código'));
    const selLine = lines.find((l) => l.includes('só a conversa'));
    expect(selLine).toMatch(/›/);
  });

  it('SEM avisos de barreira ⇒ nenhum texto de aviso aparece', () => {
    const { lastFrame } = wrap(
      <RewindPicker
        phase="action"
        checkpoints={[]}
        actions={['both']}
        selected={0}
        barrierWarnings={[]}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).not.toContain('NÃO é desfeito');
  });

  it('COM avisos de barreira ⇒ lista cada comando REDIGIDO (CLI-SEC-6)', () => {
    const { lastFrame } = wrap(
      <RewindPicker
        phase="action"
        checkpoints={[]}
        actions={['both']}
        selected={0}
        barrierWarnings={['rm -rf [REDIGIDO]', 'curl [REDIGIDO]']}
      />,
    );
    const out = plain(lastFrame() ?? '');
    expect(out).toContain('rm -rf [REDIGIDO]');
    expect(out).toContain('curl [REDIGIDO]');
  });
});

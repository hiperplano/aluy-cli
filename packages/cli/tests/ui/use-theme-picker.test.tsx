// EST-0966 — useThemePicker: máquina de estado do seletor `/theme` (abrir/navegar/
// confirmar/fechar). Drivado por um Probe que roda uma ação por render (closures
// frescas, como a App faz com `useInput`). Sem I/O — a lista é o catálogo estático.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useThemePicker, type ThemePickerController } from '../../src/ui/hooks/useThemePicker.js';
import type { ThemeName } from '../../src/ui/theme/themes.js';

function Probe(props: {
  currentTheme: ThemeName;
  steps: readonly ((c: ThemePickerController) => void)[];
  onState: (c: ThemePickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useThemePicker({ currentTheme: props.currentTheme });
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    props.onState(picker);
    props.onConsumed(stepIdx >= props.steps.length);
  });
  useEffect(() => {
    if (stepIdx >= props.steps.length) return;
    props.steps[stepIdx]!(picker);
    setStepIdx((i) => i + 1);
  }, [stepIdx]);
  return <Text>{`open=${picker.open} sel=${picker.selected}`}</Text>;
}

async function drive(
  currentTheme: ThemeName,
  steps: readonly ((c: ThemePickerController) => void)[],
): Promise<ThemePickerController> {
  let last!: ThemePickerSnapshot['c'];
  let consumed = false;
  render(
    <Probe
      currentTheme={currentTheme}
      steps={steps}
      onState={(c) => (last = c)}
      onConsumed={(d) => (consumed = d)}
    />,
  );
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await flush();
    if (consumed) break;
  }
  // mais um flush p/ assentar o estado pós-último-setState.
  await flush();
  return last;
}
type ThemePickerSnapshot = { c: ThemePickerController };

describe('useThemePicker', () => {
  it('abre e lista os temas', async () => {
    const c = await drive('aluy-dark', [(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    expect(c.themes.map((t) => t.name)).toContain('aluy-light');
    expect(c.themes.length).toBeGreaterThanOrEqual(2);
  });

  it('pré-seleciona o tema ATIVO da sessão', async () => {
    const c = await drive('aluy-light', [(p) => p.openPicker()]);
    // aluy-light é o 2º item (índice 1).
    expect(c.selected).toBe(1);
  });

  it('navega ↑↓ e CONFIRMA devolve o nome selecionado', async () => {
    let confirmed: ThemeName | null = null;
    await drive('aluy-dark', [
      (p) => p.openPicker(),
      (p) => p.move(1), // dark → light
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBe('aluy-light');
  });

  it('confirmar FECHA o picker', async () => {
    const c = await drive('aluy-dark', [(p) => p.openPicker(), (p) => p.confirm()]);
    expect(c.open).toBe(false);
  });

  it('esc fecha sem confirmar', async () => {
    const c = await drive('aluy-dark', [(p) => p.openPicker(), (p) => p.closePicker()]);
    expect(c.open).toBe(false);
  });

  it('navegação é clampeada (não passa dos limites)', async () => {
    const c = await drive('aluy-dark', [
      (p) => p.openPicker(),
      (p) => p.move(-5), // não desce abaixo de 0
    ]);
    expect(c.selected).toBe(0);
  });
});

// EST-0989 — useLangPicker: máquina de estado do seletor `/lang` (abrir/navegar/
// confirmar/fechar). Espelha o useThemePicker. Sem I/O — a lista é o catálogo LANGS.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { useLangPicker, type LangPickerController } from '../../src/ui/hooks/useLangPicker.js';
import type { Lang } from '../../src/i18n/lang.js';

function Probe(props: {
  currentLang: Lang;
  steps: readonly ((c: LangPickerController) => void)[];
  onState: (c: LangPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useLangPicker({ currentLang: props.currentLang });
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
  currentLang: Lang,
  steps: readonly ((c: LangPickerController) => void)[],
): Promise<LangPickerController> {
  let last!: LangPickerController;
  let consumed = false;
  render(
    <Probe
      currentLang={currentLang}
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
  await flush();
  return last;
}

describe('useLangPicker', () => {
  it('abre e lista os idiomas (pt-BR + en)', async () => {
    const c = await drive('pt-BR', [(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    expect(c.langs.map((l) => l.code)).toEqual(['pt-BR', 'en']);
  });

  it('pré-seleciona o idioma ATIVO da sessão', async () => {
    const c = await drive('en', [(p) => p.openPicker()]);
    expect(c.selected).toBe(1); // en é o 2º item
  });

  it('navega ↑↓ e CONFIRMA devolve o código selecionado', async () => {
    let confirmed: Lang | null = null;
    await drive('pt-BR', [
      (p) => p.openPicker(),
      (p) => p.move(1), // pt-BR → en
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBe('en');
  });

  it('confirmar FECHA o picker', async () => {
    const c = await drive('pt-BR', [(p) => p.openPicker(), (p) => p.confirm()]);
    expect(c.open).toBe(false);
  });

  it('esc fecha sem confirmar', async () => {
    const c = await drive('pt-BR', [(p) => p.openPicker(), (p) => p.closePicker()]);
    expect(c.open).toBe(false);
  });

  it('navegação é clampeada (não passa dos limites)', async () => {
    const c = await drive('pt-BR', [(p) => p.openPicker(), (p) => p.move(5)]);
    expect(c.selected).toBe(1); // teto = último índice (en)
  });
});

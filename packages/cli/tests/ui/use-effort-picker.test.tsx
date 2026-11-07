// F161-FIX · /effort STANDALONE — useEffortPicker: máquina de estado do seletor de
// `reasoning_effort` fora do fluxo conjugado do /model. Drivado por um Probe que roda
// uma ação por render (closures frescas) — mesmo harness dos demais pickers.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useEffortPicker,
  type EffortPickerController,
  type UseEffortPickerArgs,
} from '../../src/ui/hooks/useEffortPicker.js';
import type { EffortChoice } from '@hiperplano/aluy-cli-core';

function Probe(props: {
  args: UseEffortPickerArgs;
  steps: readonly ((c: EffortPickerController) => void)[];
  onState: (c: EffortPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useEffortPicker(props.args);
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
  args: UseEffortPickerArgs,
  steps: readonly ((c: EffortPickerController) => void)[],
): Promise<EffortPickerController> {
  let last!: EffortPickerController;
  let consumed = false;
  render(<Probe args={args} steps={steps} onState={(c) => (last = c)} onConsumed={(d) => (consumed = d)} />);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await flush();
    if (consumed) break;
  }
  await flush();
  return last;
}

describe('useEffortPicker', () => {
  it('abre com as 5 opções, na ordem manter/low/medium/high/custom', async () => {
    const c = await drive({}, [(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    expect(c.options.map((o) => o.id)).toEqual(['keep', 'low', 'medium', 'high', 'custom']);
    expect(c.selected).toBe(0); // sempre re-ancora em "manter"
  });

  it('navegação ↑↓ é clampeada nos limites da lista', async () => {
    const c = await drive({}, [(p) => p.openPicker(), (p) => p.move(-5)]);
    expect(c.selected).toBe(0);
    const c2 = await drive({}, [(p) => p.openPicker(), (p) => p.move(50)]);
    expect(c2.selected).toBe(4); // custom (última)
  });

  it('confirmar "manter" devolve {kind:"keep"} e FECHA', async () => {
    let choice: EffortChoice | null = null;
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => {
        choice = p.confirm();
      },
    ]);
    expect(choice).toEqual({ kind: 'keep' });
    expect(c.open).toBe(false);
  });

  it('confirmar um NÍVEL (ex.: high) devolve {kind:"set",value:"high"} e FECHA', async () => {
    let choice: EffortChoice | null = null;
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(3), // manter → low → medium → high
      (p) => {
        choice = p.confirm();
      },
    ]);
    expect(choice).toEqual({ kind: 'set', value: 'high' });
    expect(c.open).toBe(false);
  });

  it('confirmar "custom" ABRE o texto-livre (devolve null, NÃO fecha)', async () => {
    let choice: EffortChoice | null = { kind: 'keep' };
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(4), // custom (última opção)
      (p) => {
        choice = p.confirm();
      },
    ]);
    expect(choice).toBeNull();
    expect(c.open).toBe(true);
    expect(c.customOpen).toBe(true);
  });

  it('custom com texto VÁLIDO ⇒ confirmar devolve {kind:"set",value} e FECHA', async () => {
    let choice: EffortChoice | null = null;
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(4),
      (p) => p.confirm(), // abre o custom
      (p) => p.appendCustom('reasoning_effort=42'),
      (p) => {
        choice = p.confirm();
      },
    ]);
    expect(choice).toEqual({ kind: 'set', value: 'reasoning_effort=42' });
    expect(c.open).toBe(false);
  });

  it('custom VAZIO ⇒ confirmar devolve null, MANTÉM aberto, e customWarn="empty"', async () => {
    let choice: EffortChoice | null = { kind: 'keep' };
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(4),
      (p) => p.confirm(), // abre o custom
      (p) => {
        choice = p.confirm(); // texto ainda vazio
      },
    ]);
    expect(choice).toBeNull();
    expect(c.open).toBe(true);
    expect(c.customWarn).toBe('empty');
  });

  it('custom com >32 caracteres ⇒ customWarn="too-long"', async () => {
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(4),
      (p) => p.confirm(),
      (p) => p.appendCustom('x'.repeat(33)),
    ]);
    expect(c.customWarn).toBe('too-long');
  });

  it('backspace no custom apaga o último caractere', async () => {
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(4),
      (p) => p.confirm(),
      (p) => p.appendCustom('abc'),
      (p) => p.backspaceCustom(),
    ]);
    expect(c.customInput).toBe('ab');
  });

  it('back() no custom VOLTA pra lista (não fecha); back() na lista devolve false', async () => {
    const c = await drive({}, [
      (p) => p.openPicker(),
      (p) => p.move(4),
      (p) => p.confirm(), // abre custom
      (p) => p.appendCustom('x'),
    ]);
    expect(c.customOpen).toBe(true);

    let backAtList = true;
    const c2 = await drive({}, [
      (p) => p.openPicker(),
      (p) => {
        backAtList = p.back();
      },
    ]);
    expect(backAtList).toBe(false);
    expect(c2.open).toBe(true); // não fechou sozinho — quem decide fechar é o chamador
  });

  it('currentEffort é exposto pass-through (marca o ● na UI)', async () => {
    const c = await drive({ currentEffort: 'medium' }, [(p) => p.openPicker()]);
    expect(c.currentEffort).toBe('medium');
  });
});

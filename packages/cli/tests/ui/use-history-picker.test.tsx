// EST-0972 — useHistoryPicker: máquina de estado do seletor `/history` (abrir/navegar/
// confirmar/fechar). Drivado por um Probe que roda uma ação por render (closures
// frescas, como a App faz com `useInput`). A lista vem de um MOCK do SessionStore
// (síncrono, sem broker) e é RE-LIDA a cada abertura.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useHistoryPicker,
  type HistoryPickerController,
} from '../../src/ui/hooks/useHistoryPicker.js';
import type { SessionStore, SessionSummary } from '../../src/io/index.js';

function summary(id: string, updatedAt: number, title?: string): SessionSummary {
  return {
    id,
    createdAt: updatedAt,
    updatedAt,
    cwd: '/p',
    tier: 't',
    blockCount: 2,
    ...(title !== undefined ? { title } : {}),
  };
}

/** Mock do store: devolve o que `list()` for setado a apontar (mutável entre passos). */
function mockStore(getList: () => readonly SessionSummary[]): Pick<SessionStore, 'list'> {
  return { list: () => getList() };
}

function Probe(props: {
  store: Pick<SessionStore, 'list'>;
  steps: readonly ((c: HistoryPickerController) => void)[];
  onState: (c: HistoryPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useHistoryPicker({ store: props.store });
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
  return <Text>{`open=${picker.open} sel=${picker.selected} n=${picker.sessions.length}`}</Text>;
}

async function drive(
  store: Pick<SessionStore, 'list'>,
  steps: readonly ((c: HistoryPickerController) => void)[],
): Promise<HistoryPickerController> {
  let last!: HistoryPickerController;
  let consumed = false;
  render(
    <Probe
      store={store}
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

describe('useHistoryPicker (EST-0972)', () => {
  it('abre e lista as sessões (recente-first, como o store entrega)', async () => {
    const list = [summary('b', 200, 'novo'), summary('a', 100, 'antigo')];
    const c = await drive(
      mockStore(() => list),
      [(p) => p.openPicker()],
    );
    expect(c.open).toBe(true);
    expect(c.sessions.map((s) => s.id)).toEqual(['b', 'a']);
    expect(c.selected).toBe(0);
  });

  it('SEM sessões ⇒ abre com lista vazia (o picker mostra "nenhuma sessão anterior")', async () => {
    const c = await drive(
      mockStore(() => []),
      [(p) => p.openPicker()],
    );
    expect(c.open).toBe(true);
    expect(c.sessions).toHaveLength(0);
  });

  it('navega ↑↓ e CONFIRMA devolve o ID selecionado', async () => {
    const list = [summary('b', 200), summary('a', 100)];
    let confirmed: string | null = null;
    await drive(
      mockStore(() => list),
      [
        (p) => p.openPicker(),
        (p) => p.move(1), // b → a
        (p) => {
          confirmed = p.confirm();
        },
      ],
    );
    expect(confirmed).toBe('a');
  });

  it('confirmar FECHA o picker', async () => {
    const list = [summary('b', 200)];
    const c = await drive(
      mockStore(() => list),
      [(p) => p.openPicker(), (p) => p.confirm()],
    );
    expect(c.open).toBe(false);
  });

  it('esc (closePicker) fecha sem confirmar', async () => {
    const list = [summary('b', 200)];
    const c = await drive(
      mockStore(() => list),
      [(p) => p.openPicker(), (p) => p.closePicker()],
    );
    expect(c.open).toBe(false);
  });

  it('confirmar com lista VAZIA ⇒ null (enter é no-op)', async () => {
    let confirmed: string | null = 'x';
    await drive(
      mockStore(() => []),
      [
        (p) => p.openPicker(),
        (p) => {
          confirmed = p.confirm();
        },
      ],
    );
    expect(confirmed).toBeNull();
  });

  it('navegação é clampeada (não passa dos limites)', async () => {
    const list = [summary('b', 200), summary('a', 100)];
    const c = await drive(
      mockStore(() => list),
      [(p) => p.openPicker(), (p) => p.move(-5)],
    );
    expect(c.selected).toBe(0);
  });

  it('RE-LÊ o store a cada abertura (sessões novas aparecem)', async () => {
    let list: readonly SessionSummary[] = [summary('a', 100)];
    const store = mockStore(() => list);
    const c = await drive(store, [
      (p) => p.openPicker(),
      (p) => p.closePicker(),
      () => {
        // entre aberturas, surge uma sessão nova (auto-save por-turno).
        list = [summary('b', 200), summary('a', 100)];
      },
      (p) => p.openPicker(),
    ]);
    expect(c.sessions.map((s) => s.id)).toEqual(['b', 'a']);
  });
});

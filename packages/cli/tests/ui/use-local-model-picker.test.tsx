// F161-FIX — useLocalModelPicker: máquina de estado do seletor `/model` sob o backend
// LOCAL (BYO). Drivado por um Probe que roda uma ação por render (closures frescas,
// como a App faz com `useInput`) — mesmo harness do `use-provider-picker.test.tsx`.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useLocalModelPicker,
  type LocalModelPickerController,
  type UseLocalModelPickerArgs,
  type LocalModelCatalogPort,
} from '../../src/ui/hooks/useLocalModelPicker.js';

function fakeCatalog(names: readonly string[] | undefined): LocalModelCatalogPort {
  return { listNames: () => names };
}

function Probe(props: {
  args: UseLocalModelPickerArgs;
  steps: readonly ((c: LocalModelPickerController) => void)[];
  onState: (c: LocalModelPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useLocalModelPicker(props.args);
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
  return <Text>{`open=${picker.open} sel=${picker.selected} q=${picker.query}`}</Text>;
}

async function drive(
  args: UseLocalModelPickerArgs,
  steps: readonly ((c: LocalModelPickerController) => void)[],
): Promise<LocalModelPickerController> {
  let last!: LocalModelPickerController;
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

describe('useLocalModelPicker', () => {
  it('abre e lista os slugs do catálogo (declarados ∪ registrados)', async () => {
    const c = await drive({ catalog: fakeCatalog(['deepseek-chat', 'deepseek-reasoner']) }, [
      (p) => p.openPicker(),
    ]);
    expect(c.open).toBe(true);
    expect(c.hits.map((h) => h.path)).toEqual(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('sem catálogo (undefined) ⇒ lista vazia, mas o picker abre mesmo assim (degrada p/ texto-livre)', async () => {
    const c = await drive({}, [(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    expect(c.hits).toEqual([]);
  });

  it('catalog.listNames() ausente (undefined) ⇒ lista vazia (degradação honesta)', async () => {
    const c = await drive({ catalog: fakeCatalog(undefined) }, [(p) => p.openPicker()]);
    expect(c.hits).toEqual([]);
  });

  it('digitar FILTRA por fuzzy (subsequência)', async () => {
    const c = await drive(
      { catalog: fakeCatalog(['claude-opus-4-8', 'claude-3-5-sonnet-latest', 'gpt-4o']) },
      [(p) => p.openPicker(), (p) => p.setQuery('opus')],
    );
    expect(c.hits.map((h) => h.path)).toEqual(['claude-opus-4-8']);
  });

  it('navegação ↑↓ é clampeada nos limites da lista filtrada', async () => {
    const c = await drive({ catalog: fakeCatalog(['a', 'b', 'c']) }, [
      (p) => p.openPicker(),
      (p) => p.move(-5), // não desce abaixo de 0
    ]);
    expect(c.selected).toBe(0);
    const c2 = await drive({ catalog: fakeCatalog(['a', 'b', 'c']) }, [
      (p) => p.openPicker(),
      (p) => p.move(50), // não passa do último
    ]);
    expect(c2.selected).toBe(2);
  });

  it('confirmar a linha REALÇADA devolve o slug e FECHA o picker', async () => {
    let confirmed: string | null = null;
    const c = await drive({ catalog: fakeCatalog(['deepseek-chat', 'deepseek-reasoner']) }, [
      (p) => p.openPicker(),
      (p) => p.move(1), // deepseek-chat → deepseek-reasoner
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBe('deepseek-reasoner');
    expect(c.open).toBe(false);
  });

  it('sem linha realçada (nada filtra) ⇒ confirmar usa o TEXTO DIGITADO literal (warn-but-allow)', async () => {
    let confirmed: string | null = null;
    const c = await drive({ catalog: fakeCatalog(['deepseek-chat']) }, [
      (p) => p.openPicker(),
      (p) => p.setQuery('modelo-fora-do-catalogo'),
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBe('modelo-fora-do-catalogo');
    expect(c.open).toBe(false);
  });

  it('sem linha realçada e query VAZIA ⇒ confirmar devolve null e MANTÉM o picker aberto', async () => {
    let confirmed: string | null = 'sentinel';
    const c = await drive({ catalog: fakeCatalog(undefined) }, [
      (p) => p.openPicker(),
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBeNull();
    expect(c.open).toBe(true);
  });

  it('esc (closePicker) fecha sem confirmar e limpa a query', async () => {
    const c = await drive({ catalog: fakeCatalog(['a', 'b']) }, [
      (p) => p.openPicker(),
      (p) => p.setQuery('a'),
      (p) => p.closePicker(),
    ]);
    expect(c.open).toBe(false);
    expect(c.query).toBe('');
  });

  it('reabrir RECONSULTA o catálogo (um slug registrado depois da 1ª abertura já aparece)', async () => {
    const names = ['deepseek-chat'];
    const catalog: LocalModelCatalogPort = { listNames: () => [...names] };
    const c = await drive({ catalog }, [
      (p) => p.openPicker(),
      (p) => p.closePicker(),
      () => {
        names.push('deepseek-reasoner'); // "registrado" durante a sessão
      },
      (p) => p.openPicker(),
    ]);
    expect(c.hits.map((h) => h.path)).toContain('deepseek-reasoner');
  });
});

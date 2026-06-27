// EST-0962 · /provider — useProviderPicker: máquina de estado do seletor `/provider`
// (abrir/navegar/confirmar/fechar). Drivado por um Probe que roda uma ação por render
// (closures frescas, como a App faz com `useInput`). Sem I/O — a lista é o catálogo
// estático de providers (espelha o use-theme-picker).

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useProviderPicker,
  type ProviderPickerController,
  type UseProviderPickerArgs,
} from '../../src/ui/hooks/useProviderPicker.js';
import type { ProviderInfo } from '@aluy/cli-core';

/** Cliente fake de providers — devolve a lista dada (ou lança, p/ o caminho de fallback). */
function fakeProvidersClient(
  result: readonly ProviderInfo[] | Error,
): UseProviderPickerArgs['providersClient'] {
  return {
    list: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

function Probe(props: {
  currentProvider?: string;
  providersClient?: UseProviderPickerArgs['providersClient'];
  steps: readonly ((c: ProviderPickerController) => void)[];
  onState: (c: ProviderPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useProviderPicker({
    ...(props.currentProvider !== undefined ? { currentProvider: props.currentProvider } : {}),
    ...(props.providersClient ? { providersClient: props.providersClient } : {}),
  });
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
  currentProvider: string | undefined,
  steps: readonly ((c: ProviderPickerController) => void)[],
  providersClient?: UseProviderPickerArgs['providersClient'],
): Promise<ProviderPickerController> {
  let last!: ProviderPickerController;
  let consumed = false;
  render(
    <Probe
      {...(currentProvider !== undefined ? { currentProvider } : {})}
      {...(providersClient ? { providersClient } : {})}
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

describe('useProviderPicker', () => {
  it('abre e lista os providers do seed (openrouter + deepseek)', async () => {
    const c = await drive(undefined, [(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    const names = c.providers.map((p) => p.name);
    expect(names).toContain('openrouter');
    expect(names).toContain('deepseek');
  });

  it('sem provider ativo, pré-seleciona o 1º (default openrouter)', async () => {
    const c = await drive(undefined, [(p) => p.openPicker()]);
    expect(c.selected).toBe(0);
    expect(c.providers[0]!.name).toBe('openrouter');
  });

  it('pré-seleciona o provider ATIVO da sessão', async () => {
    const c = await drive('deepseek', [(p) => p.openPicker()]);
    // deepseek é o 2º item (índice 1).
    expect(c.selected).toBe(1);
  });

  it('navega ↑↓ e CONFIRMA devolve o nome selecionado', async () => {
    let confirmed: string | null = null;
    await drive('openrouter', [
      (p) => p.openPicker(),
      (p) => p.move(1), // openrouter → deepseek
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBe('deepseek');
  });

  it('confirmar FECHA o picker', async () => {
    const c = await drive(undefined, [(p) => p.openPicker(), (p) => p.confirm()]);
    expect(c.open).toBe(false);
  });

  it('esc fecha sem confirmar', async () => {
    const c = await drive(undefined, [(p) => p.openPicker(), (p) => p.closePicker()]);
    expect(c.open).toBe(false);
  });

  it('navegação é clampeada (não passa dos limites)', async () => {
    const c = await drive(undefined, [
      (p) => p.openPicker(),
      (p) => p.move(-5), // não desce abaixo de 0
    ]);
    expect(c.selected).toBe(0);
  });

  // ── EST-0962 / ADR-0076 — lista VIVA dos providers CADASTRADOS no broker ──────
  it('lista os providers CADASTRADOS vindos do broker (inclui além do seed)', async () => {
    const client = fakeProvidersClient([
      { name: 'openrouter', adapter: 'openrouter' },
      { name: 'deepseek', adapter: 'deepseek' },
      { name: 'tokenrouter', adapter: 'tokenrouter' }, // fora do seed estático
    ]);
    const c = await drive(undefined, [(p) => p.openPicker()], client);
    const names = c.providers.map((p) => p.name);
    expect(names).toContain('tokenrouter'); // o broker manda, o picker mostra
    expect(c.usingFallback).toBe(false); // veio do broker, não do fallback
  });

  it('broker VAZIO ⇒ FALLBACK estático conhecido + usingFallback=true (nunca lista vazia)', async () => {
    const c = await drive(undefined, [(p) => p.openPicker()], fakeProvidersClient([]));
    const names = c.providers.map((p) => p.name);
    expect(names).toContain('openrouter');
    expect(names).toContain('deepseek');
    expect(c.usingFallback).toBe(true);
  });

  it('broker FORA (erro) ⇒ FALLBACK estático + usingFallback=true (degradação honesta)', async () => {
    const c = await drive(
      undefined,
      [(p) => p.openPicker()],
      fakeProvidersClient(new Error('broker indisponível')),
    );
    expect(c.providers.length).toBeGreaterThan(0); // NUNCA vazia
    expect(c.usingFallback).toBe(true);
  });

  it('pré-seleciona o provider ATIVO mesmo FORA do seed (tokenrouter da lista viva)', async () => {
    const client = fakeProvidersClient([
      { name: 'deepseek', adapter: 'deepseek' },
      { name: 'openrouter', adapter: 'openrouter' },
      { name: 'tokenrouter', adapter: 'tokenrouter' },
    ]);
    const c = await drive('tokenrouter', [(p) => p.openPicker()], client);
    expect(c.providers[c.selected]!.name).toBe('tokenrouter');
  });
});

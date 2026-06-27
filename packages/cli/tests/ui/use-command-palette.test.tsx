// EST-0961 — useCommandPalette: máquina de estado da palette (abrir/buscar/
// navegar/confirmar/fechar). Drivado por um Probe que roda uma ação por render
// (closures frescas, como a App faz com `useInput`). Sem I/O — itens da fonte única.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useCommandPalette,
  type CommandPaletteController,
} from '../../src/ui/hooks/useCommandPalette.js';
import type { SlashCommand } from '../../src/slash/commands.js';

function Probe(props: {
  userCommands?: readonly SlashCommand[];
  steps: readonly ((c: CommandPaletteController) => void)[];
  onState: (c: CommandPaletteController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const palette = useCommandPalette(
    props.userCommands !== undefined ? { userCommands: props.userCommands } : {},
  );
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    props.onState(palette);
    props.onConsumed(stepIdx >= props.steps.length);
  });
  useEffect(() => {
    if (stepIdx >= props.steps.length) return;
    props.steps[stepIdx]!(palette);
    setStepIdx((i) => i + 1);
  }, [stepIdx]);
  return <Text>{`open=${palette.open} sel=${palette.selected} n=${palette.hits.length}`}</Text>;
}

async function drive(
  steps: readonly ((c: CommandPaletteController) => void)[],
  userCommands?: readonly SlashCommand[],
): Promise<CommandPaletteController> {
  let last!: CommandPaletteController;
  let consumed = false;
  render(
    <Probe
      {...(userCommands !== undefined ? { userCommands } : {})}
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

describe('useCommandPalette', () => {
  it('abre com a lista cheia e seleção no topo', async () => {
    const c = await drive([(p) => p.openPalette()]);
    expect(c.open).toBe(true);
    expect(c.selected).toBe(0);
    expect(c.hits.length).toBeGreaterThan(0);
  });

  it('buscar FILTRA por fuzzy (query "theme" ⇒ /theme presente)', async () => {
    const c = await drive([(p) => p.openPalette(), (p) => p.setQuery('theme')]);
    expect(c.hits.some((h) => h.label === '/theme')).toBe(true);
    expect(c.hits.length).toBeLessThan((await drive([(p) => p.openPalette()])).hits.length);
  });

  it('nova query re-ancora a seleção no topo (melhor match selecionável c/ 1 enter)', async () => {
    const c = await drive([(p) => p.openPalette(), (p) => p.move(3), (p) => p.setQuery('mo')]);
    expect(c.selected).toBe(0);
  });

  it('navega ↑↓ e CONFIRMA devolve o hit selecionado', async () => {
    let confirmed: string | null = null;
    await drive([
      (p) => p.openPalette(),
      (p) => p.setQuery('model'),
      (p) => {
        const hit = p.confirm();
        confirmed = hit ? hit.label : null;
      },
    ]);
    expect(confirmed).toBe('/model');
  });

  it('confirmar FECHA a palette', async () => {
    const c = await drive([(p) => p.openPalette(), (p) => p.confirm()]);
    expect(c.open).toBe(false);
  });

  it('esc (closePalette) fecha sem confirmar', async () => {
    const c = await drive([(p) => p.openPalette(), (p) => p.closePalette()]);
    expect(c.open).toBe(false);
  });

  it('navegação é clampeada (não passa dos limites)', async () => {
    const c = await drive([(p) => p.openPalette(), (p) => p.move(-5)]);
    expect(c.selected).toBe(0);
  });

  it('confirmar com lista vazia devolve null (sem crash)', async () => {
    let confirmed: unknown = 'unset';
    await drive([
      (p) => p.openPalette(),
      (p) => p.setQuery('zzzqqq'),
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBeNull();
  });

  it('lê os comandos do USUÁRIO (mesma fonte do slash-menu)', async () => {
    const c = await drive(
      [(p) => p.openPalette(), (p) => p.setQuery('deploy')],
      [{ name: 'deploy', summary: 'sobe pra staging', source: 'user' }],
    );
    expect(c.hits.some((h) => h.label === '/deploy')).toBe(true);
  });
});

// EST-XXXX — useRewindPicker: máquina de estado do seletor `/rewind` (· Esc Esc), em
// DUAS etapas (lista de pontos → ação). Mesmo padrão do use-history-picker: um Probe
// roda uma ação por render (closures frescas, como a App faz com `useInput`). A fonte
// é um MOCK do CheckpointRegistry (em memória, síncrono). RE-lida a cada abertura.

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useRewindPicker,
  type RewindPickerController,
  type RewindChoice,
  type RewindCheckpointSource,
} from '../../src/ui/hooks/useRewindPicker.js';
import type { Checkpoint } from '@hiperplano/aluy-cli-core';

function cp(id: string, ordinal: number, label = `prompt ${ordinal}`): Checkpoint {
  return { id, ordinal, ts: ordinal * 1000, label, journalSeq: ordinal, blockCount: ordinal * 2 };
}

function mockSource(getList: () => readonly Checkpoint[]): RewindCheckpointSource {
  return { list: () => getList() };
}

function Probe(props: {
  source: RewindCheckpointSource;
  steps: readonly ((c: RewindPickerController) => void)[];
  onState: (c: RewindPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useRewindPicker({ source: props.source });
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
  return (
    <Text>{`phase=${picker.phase} sel=${picker.selected} n=${picker.checkpoints.length}`}</Text>
  );
}

async function drive(
  source: RewindCheckpointSource,
  steps: readonly ((c: RewindPickerController) => void)[],
): Promise<RewindPickerController> {
  let last!: RewindPickerController;
  let consumed = false;
  render(
    <Probe
      source={source}
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

describe('useRewindPicker (EST-XXXX)', () => {
  it('abre na etapa `list` e lista os checkpoints RECENTE-FIRST (registry vem antigo→recente)', async () => {
    // o registry entrega antigo→recente; o picker inverte (recente no topo).
    const list = [cp('cp1', 1), cp('cp2', 2), cp('cp3', 3)];
    const c = await drive(
      mockSource(() => list),
      [(p) => p.openPicker()],
    );
    expect(c.phase).toBe('list');
    expect(c.open).toBe(true);
    expect(c.checkpoints.map((x) => x.id)).toEqual(['cp3', 'cp2', 'cp1']);
    expect(c.selected).toBe(0);
  });

  it('SEM checkpoints ⇒ abre vazio (mostra "nenhum ponto"), confirm é no-op', async () => {
    let choice: RewindChoice | null = { checkpointId: 'x', action: 'both' };
    const c = await drive(
      mockSource(() => []),
      [
        (p) => p.openPicker(),
        (p) => {
          choice = p.confirm();
        },
      ],
    );
    expect(c.checkpoints).toHaveLength(0);
    expect(choice).toBeNull();
  });

  it('confirm na `list` AVANÇA p/ a etapa `action` (não devolve escolha ainda)', async () => {
    const list = [cp('cp1', 1), cp('cp2', 2)];
    let firstConfirm: RewindChoice | null = { checkpointId: 'x', action: 'both' };
    const c = await drive(
      mockSource(() => list),
      [
        (p) => p.openPicker(),
        (p) => {
          firstConfirm = p.confirm(); // escolhe o ponto do topo (cp2)
        },
      ],
    );
    expect(firstConfirm).toBeNull(); // ainda não aplica
    expect(c.phase).toBe('action');
    expect(c.selected).toBe(0); // ação começa no `both`
    expect(c.target?.id).toBe('cp2');
  });

  it('confirm na `action` devolve { checkpointId, action } e FECHA', async () => {
    const list = [cp('cp1', 1), cp('cp2', 2)];
    let choice: RewindChoice | null = null;
    const c = await drive(
      mockSource(() => list),
      [
        (p) => p.openPicker(),
        (p) => p.move(1), // seleciona cp1 (2º na lista recente-first)
        (p) => p.confirm(), // → action
        (p) => p.move(1), // ação: both → conversation
        (p) => {
          choice = p.confirm();
        },
      ],
    );
    expect(choice).toEqual({ checkpointId: 'cp1', action: 'conversation' });
    expect(c.phase).toBe('closed');
    expect(c.open).toBe(false);
  });

  it('as três ações estão na ordem both/conversation/code', async () => {
    const list = [cp('cp1', 1)];
    const c = await drive(
      mockSource(() => list),
      [(p) => p.openPicker(), (p) => p.confirm()],
    );
    expect(c.actions).toEqual(['both', 'conversation', 'code']);
  });

  it('esc (back) na `action` VOLTA p/ a lista (re-seleciona o ponto aberto)', async () => {
    const list = [cp('cp1', 1), cp('cp2', 2)];
    const c = await drive(
      mockSource(() => list),
      [
        (p) => p.openPicker(),
        (p) => p.move(1), // cp1 selecionado
        (p) => p.confirm(), // → action (target cp1)
        (p) => p.back(), // volta p/ lista
      ],
    );
    expect(c.phase).toBe('list');
    expect(c.selected).toBe(1); // volta no ponto que estava aberto
  });

  it('esc (back) na `list` FECHA o picker', async () => {
    const list = [cp('cp1', 1)];
    const c = await drive(
      mockSource(() => list),
      [(p) => p.openPicker(), (p) => p.back()],
    );
    expect(c.phase).toBe('closed');
  });

  it('navegação clampeada na lista E nas ações', async () => {
    const list = [cp('cp1', 1), cp('cp2', 2)];
    const c = await drive(
      mockSource(() => list),
      [
        (p) => p.openPicker(),
        (p) => p.move(-5), // clampa em 0
      ],
    );
    expect(c.selected).toBe(0);

    const c2 = await drive(
      mockSource(() => list),
      [
        (p) => p.openPicker(),
        (p) => p.confirm(), // → action (3 ações)
        (p) => p.move(99), // clampa no último (code)
      ],
    );
    expect(c2.selected).toBe(2);
  });

  it('RE-LÊ a fonte a cada abertura (pontos novos aparecem)', async () => {
    let list: readonly Checkpoint[] = [cp('cp1', 1)];
    const source = mockSource(() => list);
    const c = await drive(source, [
      (p) => p.openPicker(),
      (p) => p.back(), // fecha
      () => {
        list = [cp('cp1', 1), cp('cp2', 2)];
      },
      (p) => p.openPicker(),
    ]);
    expect(c.checkpoints.map((x) => x.id)).toEqual(['cp2', 'cp1']);
  });
});

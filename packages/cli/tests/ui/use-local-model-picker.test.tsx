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
  type RemoteModelNamesFetcher,
  type RemoteModelNamesResult,
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
  render(
    <Probe
      args={args}
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

// F-MODEL-LIVE — variante que, além de consumir os `steps`, continua flushando até um
// PREDICADO valer (ou estourar o deadline) — necessário p/ esperar a promise de
// `remoteNames` resolver (o `drive` simples pára logo após o último step, ANTES da
// promise ter tido chance de rodar o `.then`).
async function driveUntil(
  args: UseLocalModelPickerArgs,
  steps: readonly ((c: LocalModelPickerController) => void)[],
  predicate: (c: LocalModelPickerController) => boolean,
): Promise<LocalModelPickerController> {
  let last!: LocalModelPickerController;
  render(<Probe args={args} steps={steps} onState={(c) => (last = c)} onConsumed={() => {}} />);
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    await flush();
    if (last !== undefined && predicate(last)) break;
  }
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

// F-MODEL-LIVE — o DIAGNÓSTICO: sob backend LOCAL o `/model` listava só o catálogo
// DECLARADO (5 slugs fixos p/ o `openrouter` embutido) — nunca os CENTENAS que o
// provider de fato expõe, e nem sequer o modelo ATIVO quando ele não é um dos
// curados. Esta bateria prova o `remoteNames` (busca ao vivo) fundido no picker:
// loading visível, união (nunca substituição), modelo ativo sempre presente, e
// fallback honesto quando a busca falha — nunca lista vazia silenciosa.
function fakeRemote(
  result: RemoteModelNamesResult,
  opts?: { readonly delayMs?: number },
): RemoteModelNamesFetcher {
  return () =>
    new Promise((resolve) => {
      setTimeout(() => resolve(result), opts?.delayMs ?? 0);
    });
}

describe('useLocalModelPicker — F-MODEL-LIVE (busca ao vivo do provider)', () => {
  it('abre já com o catálogo (síncrono) e funde a lista viva quando ela resolve', async () => {
    const remoteNames = fakeRemote({ names: ['xiaomi/mimo-v2.5-pro', 'zai/glm-4.6'], ok: true });
    const c = await driveUntil(
      { catalog: fakeCatalog(['deepseek-chat']), remoteNames },
      [(p) => p.openPicker()],
      (p) => p.open && !p.loading,
    );
    expect(c.loading).toBe(false);
    expect(c.usingFallback).toBe(false);
    const names = c.hits.map((h) => h.path);
    expect(names).toContain('deepseek-chat');
    expect(names).toContain('xiaomi/mimo-v2.5-pro');
    expect(names).toContain('zai/glm-4.6');
  });

  it('loading fica `true` enquanto a busca está em voo (nunca trava/some a lista já conhecida)', async () => {
    const remoteNames = fakeRemote({ names: ['zai/glm-4.6'], ok: true }, { delayMs: 200 });
    const c = await driveUntil(
      { catalog: fakeCatalog(['deepseek-chat']), remoteNames },
      [(p) => p.openPicker()],
      (p) => p.open, // captura logo após abrir — bem antes dos 200ms de delay
    );
    expect(c.loading).toBe(true);
    // a lista DECLARADA já está disponível de imediato — não trava a UI vazia.
    expect(c.hits.map((h) => h.path)).toContain('deepseek-chat');
  });

  it('busca falha (rede/401) ⇒ usingFallback=true, mas a lista conhecida continua íntegra', async () => {
    const remoteNames = fakeRemote({ names: [], ok: false });
    const c = await driveUntil(
      { catalog: fakeCatalog(['deepseek-chat']), remoteNames },
      [(p) => p.openPicker()],
      (p) => p.open && !p.loading,
    );
    expect(c.usingFallback).toBe(true);
    expect(c.hits.map((h) => h.path)).toEqual(['deepseek-chat']);
  });

  it('modelo ATIVO aparece SEMPRE, mesmo fora do catálogo declarado e fora da lista viva', async () => {
    const remoteNames = fakeRemote({ names: ['outro/modelo'], ok: true });
    const c = await driveUntil(
      {
        catalog: fakeCatalog(['anthropic/claude-3.5-sonnet']),
        remoteNames,
        currentModel: 'xiaomi/mimo-v2.5-pro',
      },
      [(p) => p.openPicker()],
      (p) => p.open && !p.loading,
    );
    const names = c.hits.map((h) => h.path);
    expect(names).toContain('xiaomi/mimo-v2.5-pro'); // o ativo do dono
    expect(names).toContain('outro/modelo'); // veio do provider
    expect(names).toContain('anthropic/claude-3.5-sonnet'); // do catálogo declarado
  });

  it('sem `remoteNames` ⇒ comportamento de sempre (só catálogo, loading sempre false)', async () => {
    const c = await drive({ catalog: fakeCatalog(['deepseek-chat']) }, [(p) => p.openPicker()]);
    expect(c.loading).toBe(false);
    expect(c.usingFallback).toBeNull();
    expect(c.hits.map((h) => h.path)).toEqual(['deepseek-chat']);
  });

  it('reabrir descarta a resposta ANTIGA em voo (geração trocou) — nunca mistura provider velho com novo', async () => {
    // 1ª chamada (a da 1ª abertura): LENTA, devolve 'provider-antigo/modelo'. 2ª
    // chamada (a da REABERTURA): rápida, devolve 'provider-novo/modelo'. Se o guard de
    // geração não existisse, a resposta lenta chegaria DEPOIS e sobrescreveria a lista
    // certa com a do provider errado/rodada velha.
    let calls = 0;
    const remoteNames: RemoteModelNamesFetcher = () => {
      calls += 1;
      const mine = calls;
      return new Promise((resolve) => {
        setTimeout(
          () =>
            resolve({
              names: [mine === 1 ? 'provider-antigo/modelo' : 'provider-novo/modelo'],
              ok: true,
            }),
          mine === 1 ? 40 : 0,
        );
      });
    };
    let last!: LocalModelPickerController;
    render(
      <Probe
        args={{ catalog: fakeCatalog([]), remoteNames }}
        steps={[
          (p) => p.openPicker(), // gen=1, dispara a busca LENTA (40ms)
          (p) => p.closePicker(),
          (p) => p.openPicker(), // gen=2, dispara a busca RÁPIDA — deve vencer
        ]}
        onState={(c) => (last = c)}
        onConsumed={() => {}}
      />,
    );
    // Espera BEM além dos 40ms da resposta lenta, p/ garantir que ela já teve chance de
    // chegar e ser descartada (não só que a rápida chegou primeiro).
    await new Promise((r) => setTimeout(r, 120));
    const names = last.hits.map((h) => h.path);
    expect(calls).toBe(2);
    expect(names).toContain('provider-novo/modelo');
    expect(names).not.toContain('provider-antigo/modelo');
  });
});

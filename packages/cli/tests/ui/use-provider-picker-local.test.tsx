// F-PROV — useProviderPicker sob backend LOCAL (BYO): a fonte da lista é o catálogo
// LOCAL (ADR-0118), NUNCA o broker (achado em dogfooding: "/provider não tá carregando
// uma lista de provedores" — o picker mostrava o seed estático do broker em vez dos
// providers que o dono de fato configurou). Cobre também o fluxo "+ adicionar provider
// custom" (gap "não tenho a opção de adicionar um provedor custom"). Mesmo harness
// Probe/drive do `use-provider-picker.test.tsx` (broker).

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useProviderPicker,
  ADD_CUSTOM_PROVIDER_SENTINEL,
  type ProviderPickerController,
  type UseProviderPickerArgs,
} from '../../src/ui/hooks/useProviderPicker.js';
import type { LocalProviderEntry } from '@hiperplano/aluy-cli-core';

function localEntry(id: string, overrides: Partial<LocalProviderEntry> = {}): LocalProviderEntry {
  return {
    id,
    label: id,
    wireFormat: 'openai-compat',
    baseUrl: `https://api.${id}.example/v1`,
    auth: ['apikey'],
    defaultModel: `${id}-default`,
    models: [`${id}-default`],
    ...overrides,
  };
}

function Probe(props: {
  args: UseProviderPickerArgs;
  steps: readonly ((c: ProviderPickerController) => void)[];
  onState: (c: ProviderPickerController) => void;
  onConsumed: (done: boolean) => void;
}): React.ReactElement {
  const picker = useProviderPicker(props.args);
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
  args: UseProviderPickerArgs,
  steps: readonly ((c: ProviderPickerController) => void)[],
): Promise<ProviderPickerController> {
  let last!: ProviderPickerController;
  let consumed = false;
  render(
    <Probe args={args} steps={steps} onState={(c) => (last = c)} onConsumed={(d) => (consumed = d)} />,
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

describe('useProviderPicker — catálogo LOCAL (backend BYO)', () => {
  it('lista os providers do catálogo LOCAL, não o seed do broker', async () => {
    const catalog = [localEntry('tokenrouter'), localEntry('ollama')];
    const c = await drive({ localCatalog: () => catalog }, [(p) => p.openPicker()]);
    const names = c.providers.map((p) => p.name);
    expect(names).toContain('tokenrouter');
    expect(names).toContain('ollama');
    // NUNCA o seed estático do broker (openrouter/deepseek não fazem parte do catálogo local dado).
    expect(names).not.toContain('openrouter');
  });

  it('presença de localCatalog IGNORA providersClient por completo', async () => {
    const catalog = [localEntry('minhaapi')];
    const fakeClient = { list: async () => [{ name: 'openrouter', adapter: 'openrouter' }] };
    const c = await drive(
      { localCatalog: () => catalog, providersClient: fakeClient },
      [(p) => p.openPicker()],
    );
    const names = c.providers.map((p) => p.name);
    expect(names).toContain('minhaapi');
    expect(names).not.toContain('openrouter');
  });

  it('NUNCA usingFallback sob catálogo local (sempre tem ao menos os built-ins)', async () => {
    const c = await drive({ localCatalog: () => [localEntry('x')] }, [(p) => p.openPicker()]);
    expect(c.usingFallback).toBe(false);
  });

  it('reabrir RECONSULTA o catálogo local (um provider custom recém-cadastrado aparece)', async () => {
    let entries: readonly LocalProviderEntry[] = [localEntry('a')];
    const c = await drive({ localCatalog: () => entries }, [
      (p) => p.openPicker(),
      (p) => p.closePicker(),
      () => {
        entries = [...entries, localEntry('b-custom')];
      },
      (p) => p.openPicker(),
    ]);
    expect(c.providers.map((p) => p.name)).toContain('b-custom');
  });

  it('a lista termina com o item "+ adicionar provider custom" (sentinela)', async () => {
    const c = await drive({ localCatalog: () => [localEntry('a')] }, [(p) => p.openPicker()]);
    const last = c.providers[c.providers.length - 1];
    expect(last?.name).toBe(ADD_CUSTOM_PROVIDER_SENTINEL);
  });

  it('fluxo "+ adicionar": id → baseUrl → model (vazio usa o id) → devolve o input pronto', async () => {
    let result: unknown = 'unset';
    const c = await drive({ localCatalog: () => [] }, [
      (p) => p.startAddCustom(),
      (p) => {
        for (const ch of 'meuprovider') p.typeAddCustom(ch);
      },
      (p) => {
        result = p.confirmAddCustom(); // avança p/ baseUrl (id não-vazio)
      },
      (p) => {
        for (const ch of 'https://api.meuprovider.com/v1') p.typeAddCustom(ch);
      },
      (p) => {
        result = p.confirmAddCustom(); // avança p/ model (baseUrl não-vazio)
      },
      (p) => {
        result = p.confirmAddCustom(); // model vazio ⇒ finaliza com default = id
      },
    ]);
    expect(result).toEqual({
      id: 'meuprovider',
      baseUrl: 'https://api.meuprovider.com/v1',
      defaultModel: 'meuprovider',
    });
    expect(c.open).toBe(false);
    expect(c.addCustomStep).toBeNull();
  });

  it('campo id VAZIO: enter NÃO avança (obrigatório)', async () => {
    const c = await drive({ localCatalog: () => [] }, [
      (p) => p.startAddCustom(),
      (p) => p.confirmAddCustom(),
    ]);
    expect(c.addCustomStep).toBe('id');
  });

  it('campo baseUrl VAZIO: enter NÃO avança (obrigatório)', async () => {
    const c = await drive({ localCatalog: () => [] }, [
      (p) => p.startAddCustom(),
      (p) => p.typeAddCustom('x'),
      (p) => p.confirmAddCustom(), // avança p/ baseUrl
      (p) => p.confirmAddCustom(), // baseUrl vazio ⇒ não avança
    ]);
    expect(c.addCustomStep).toBe('baseUrl');
  });

  it('modelo digitado explicitamente vence o default (id)', async () => {
    let result: unknown;
    await drive({ localCatalog: () => [] }, [
      (p) => p.startAddCustom(),
      (p) => p.typeAddCustom('x'),
      (p) => p.confirmAddCustom(),
      (p) => p.typeAddCustom('https://x.example/v1'),
      (p) => p.confirmAddCustom(),
      (p) => p.typeAddCustom('meu-modelo'),
      (p) => {
        result = p.confirmAddCustom();
      },
    ]);
    expect(result).toEqual({
      id: 'x',
      baseUrl: 'https://x.example/v1',
      defaultModel: 'meu-modelo',
    });
  });

  it('backspace apaga do campo corrente', async () => {
    const c = await drive({ localCatalog: () => [] }, [
      (p) => p.startAddCustom(),
      (p) => {
        p.typeAddCustom('a');
        p.typeAddCustom('b');
        p.typeAddCustom('c');
      },
      (p) => p.backspaceAddCustom(),
    ]);
    expect(c.addCustomDraft.id).toBe('ab');
  });

  it('selecionar o sentinela pelo fluxo REAL da App (confirm() → startAddCustom()) NÃO fecha o picker', async () => {
    // Bug relatado: "clico na opção [+ adicionar provider] e não acontece nada". A
    // App.tsx (session/App.tsx) SEMPRE chama `confirm()` primeiro (enter no item
    // selecionado) e só DEPOIS, ao ver o sentinela na resposta, chama `startAddCustom()`
    // — nunca chama `startAddCustom()` isolado como os testes acima faziam. Se `confirm()`
    // fecha o picker incondicionalmente, `startAddCustom()` arma o passo 'id' com
    // `open=false` e o formulário nunca renderiza (a App só desenha o <ProviderPicker>
    // quando `providerPicker.open`) — enter vira no-op silencioso.
    let confirmedName: string | null = null;
    const c = await drive({ localCatalog: () => [localEntry('a')] }, [
      (p) => p.openPicker(),
      (p) => p.move(1), // desce até o sentinela: [entrada 'a', sentinela] ⇒ índice 1
      (p) => {
        confirmedName = p.confirm();
        if (confirmedName === ADD_CUSTOM_PROVIDER_SENTINEL) p.startAddCustom();
      },
    ]);
    expect(confirmedName).toBe(ADD_CUSTOM_PROVIDER_SENTINEL);
    expect(c.open).toBe(true); // o picker CONTINUA aberto — só troca p/ a vista do formulário
    expect(c.addCustomStep).toBe('id');
  });

  it('esc (cancelAddCustom) sai do formulário sem persistir e sem fechar a lista', async () => {
    const c = await drive({ localCatalog: () => [localEntry('a')] }, [
      (p) => p.openPicker(),
      (p) => p.startAddCustom(),
      (p) => p.typeAddCustom('x'),
      (p) => p.cancelAddCustom(),
    ]);
    expect(c.addCustomStep).toBeNull();
    expect(c.addCustomDraft).toEqual({ id: '', baseUrl: '', model: '' });
    expect(c.open).toBe(true); // a LISTA continua aberta (só o formulário fechou)
  });
});

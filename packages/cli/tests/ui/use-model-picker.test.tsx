// EST-0962 — useModelPicker: máquina de estado do seletor `/model` (abrir/navegar/
// confirmar) + carga do catálogo do broker com FALLBACK. Drivado por um Probe que
// roda uma ação por render (closures frescas, como o App faz com `useInput`).

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  useModelPicker,
  BROWSER_WINDOW,
  type ModelPickerController,
  type ModelPickerChoice,
  type ConjugatedChoice,
} from '../../src/ui/hooks/useModelPicker.js';
import type { CustomModel, TierCatalogEntry } from '@hiperplano/aluy-cli-core';

const CATALOG: readonly TierCatalogEntry[] = [
  {
    key: 'aluy-flux',
    displayName: 'Flux',
    costSignal: 'economical',
    composition: [{ name: 'GPT-4o mini', family: 'OpenAI', role: 'principal', context: '128k' }],
  },
  {
    key: 'aluy-strata',
    displayName: 'Strata',
    costSignal: 'standard',
    composition: [
      { name: 'Claude 3.5 Sonnet', family: 'Anthropic', role: 'principal', context: '200k' },
    ],
  },
  {
    key: 'aluy-deep',
    displayName: 'Deep',
    costSignal: 'premium',
    composition: [{ name: 'Claude Opus', family: 'Anthropic', role: 'principal', context: '200k' }],
  },
];

const okCatalog = { list: async () => CATALOG };
const emptyCatalog = { list: async () => [] as readonly TierCatalogEntry[] };
const failingCatalog = {
  list: async () => {
    throw new Error('broker down');
  },
};

// EST-0962 — a FONTE DEDICADA do autocomplete do Custom (`GET /v1/models/custom`): a
// lista PLANA por slug (recorte dos 342). O `id` é o slug; `name`/`family` são dica.
const CUSTOM_MODELS: readonly CustomModel[] = [
  { id: 'ai21/jamba-large-1.7', name: 'Jamba Large 1 7', family: 'Ai21', context: '256k' },
  {
    id: 'meta-llama/llama-3.1-8b-instruct',
    name: 'Llama 3.1 8B Instruct',
    family: 'Meta',
    context: '128k',
    supportsTools: true,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    name: 'Llama 3.3 70B Instruct',
    family: 'Meta',
    context: '128k',
    supportsTools: false,
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    family: 'Anthropic',
    context: '200k',
    supportsTools: true,
  },
];
const okCustomModels = { list: async () => CUSTOM_MODELS };
const failingCustomModels = {
  list: async () => {
    throw new Error('custom list down');
  },
};

function Probe(props: {
  catalog: { list(): Promise<readonly TierCatalogEntry[]> };
  customModels?: { list(): Promise<readonly CustomModel[]> };
  currentTier: string;
  steps: readonly ((c: ModelPickerController) => void | Promise<void>)[];
  onState: (c: ModelPickerController) => void;
  /** Sinaliza, A CADA render, se TODOS os passos já foram consumidos pelo loop. */
  onStepsConsumed: (allConsumed: boolean) => void;
}): React.ReactElement {
  const picker = useModelPicker({
    catalog: props.catalog,
    ...(props.customModels ? { customModels: props.customModels } : {}),
    currentTier: props.currentTier,
  });
  const [stepIdx, setStepIdx] = useState(0);
  useEffect(() => {
    // `onState` SEMPRE com o estado do render corrente; `onStepsConsumed` diz se o
    // loop de passos já terminou. Os dois juntos deixam o `drive` esperar o estado
    // ASSENTAR (sem corrida com o contador de passos) — ver `drive`.
    props.onState(picker);
    props.onStepsConsumed(stepIdx >= props.steps.length);
  });
  useEffect(() => {
    if (stepIdx >= props.steps.length) return;
    // GATE de timing-robustez: a carga do catálogo é assíncrona; depois de abrir, o
    // picker fica `loading` por um tick. Só avança o próximo passo quando NÃO está
    // mais carregando — assim o teste independe da velocidade (coverage/CI lento).
    if (picker.open && picker.loading) return;
    let cancelled = false;
    void (async () => {
      await props.steps[stepIdx]!(picker);
      if (!cancelled) setStepIdx((i) => i + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [stepIdx, picker.open, picker.loading]);
  return <Text>{`open=${picker.open} sel=${picker.selected} tiers=${picker.tiers.length}`}</Text>;
}

async function drive(
  catalog: { list(): Promise<readonly TierCatalogEntry[]> },
  currentTier: string,
  steps: readonly ((c: ModelPickerController) => void | Promise<void>)[],
  customModels?: { list(): Promise<readonly CustomModel[]> },
): Promise<ModelPickerController> {
  let last!: ModelPickerController;
  let allStepsConsumed = false;
  render(
    <Probe
      catalog={catalog}
      {...(customModels ? { customModels } : {})}
      currentTier={currentTier}
      steps={steps}
      onState={(c) => (last = c)}
      onStepsConsumed={(done) => (allStepsConsumed = done)}
    />,
  );
  // DETERMINISMO (anti-flake): o passo final pode fechar/confirmar o picker, o que
  // dispara um `setState` que SÓ vira `last` no PRÓXIMO render. Não basta contar
  // passos (o contador anda à frente do commit do React). Esperamos o estado
  // ASSENTAR: todos os passos consumidos PELO LOOP do Probe (`allStepsConsumed`,
  // setado dentro de um effect, ou seja, após o commit) E a fotografia observável
  // estável entre flushes consecutivos. Sem sleep fixo, sem corrida.
  const snap = (c: ModelPickerController | undefined): string =>
    c
      ? `${c.open}|${c.selected}|${c.loading}|${c.usingFallback}|${c.tiers.map((t) => t.key).join(',')}|${c.customInputOpen}|${c.customInput}|${c.customSuggestions.join(',')}|${c.customWarnOutOfCatalog}`
      : '<none>';
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  const deadline = Date.now() + 3000;
  let prev = snap(last);
  let stableFlushes = 0;
  // Precisa: (1) loop de passos terminou e (2) 2 flushes seguidos com estado igual.
  while (Date.now() < deadline) {
    await flush();
    const cur = snap(last);
    stableFlushes = cur === prev ? stableFlushes + 1 : 0;
    prev = cur;
    if (allStepsConsumed && stableFlushes >= 2) break;
  }
  return last;
}

describe('useModelPicker — catálogo do broker', () => {
  it('abre e LISTA os tiers do catálogo', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    expect(c.open).toBe(true);
    expect(c.tiers.map((t) => t.key)).toEqual(['aluy-flux', 'aluy-strata', 'aluy-deep']);
    expect(c.usingFallback).toBe(false);
  });

  it('pré-seleciona o tier ATIVO da sessão', async () => {
    const c = await drive(okCatalog, 'aluy-deep', [(p) => p.openPicker()]);
    expect(c.selected).toBe(2); // aluy-deep é o índice 2
  });

  it('EST-1117 — confirmar um TIER AVANÇA pro passo de effort (não fecha, não devolve ainda)', async () => {
    let firstConfirm: ConjugatedChoice | null = {
      model: { kind: 'tier', key: 'x' },
      effort: { kind: 'keep' },
    };
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(1), // flux → strata
      (p) => {
        firstConfirm = p.confirm();
      },
    ]);
    // confirmar o modelo NÃO devolve o trio ainda (abre o passo de effort).
    expect(firstConfirm).toBeNull();
    expect(c.open).toBe(true);
    expect(c.effortStepOpen).toBe(true);
  });

  it('EST-1117 — tier + effort "manter" (1ª opção) ⇒ CONJUGADO {tier, keep} e FECHA', async () => {
    let choice: ConjugatedChoice | null = null;
    let confirmed = false;
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(1), // flux → strata
      (p) => p.confirm(), // entra no passo de effort (manter pré-selecionado)
      (p) => {
        if (confirmed) return;
        confirmed = true;
        choice = p.confirm(); // confirma "manter"
      },
    ]);
    expect(choice).toEqual({
      model: { kind: 'tier', key: 'aluy-strata' },
      effort: { kind: 'keep' },
    });
    expect(c.open).toBe(false);
  });

  it('EST-1117 — tier + effort "high" ⇒ CONJUGADO {tier, set:high}', async () => {
    let choice: ConjugatedChoice | null = null;
    let confirmed = false;
    await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(), // tier flux → passo de effort
      (p) => p.effortMove(3), // manter(0) → low(1) → medium(2) → high(3)
      (p) => {
        if (confirmed) return;
        confirmed = true;
        choice = p.confirm();
      },
    ]);
    expect(choice).toEqual({
      model: { kind: 'tier', key: 'aluy-flux' },
      effort: { kind: 'set', value: 'high' },
    });
  });

  it('EST-1117 — esc no passo de effort VOLTA pro modelo (não fecha tudo)', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(), // → passo de effort
      (p) => p.backFromEffort(), // esc volta
    ]);
    expect(c.effortStepOpen).toBe(false);
    expect(c.open).toBe(true); // picker segue aberto na lista de modelos
  });

  it('esc fecha sem confirmar', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [(p) => p.openPicker(), (p) => p.closePicker()]);
    expect(c.open).toBe(false);
  });
});

describe('useModelPicker — via CUSTOM (ADR-0030 §3 / ADR-0065 — texto-livre warn-but-allow)', () => {
  it('a linha CUSTOM é navegável (índice = tiers.length) e fica customSelected', async () => {
    // 3 tiers ⇒ a linha Custom é o índice 3. Desce 3× a partir do flux (índice 0).
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(1), // flux → strata
      (p) => p.move(1), // strata → deep
      (p) => p.move(1), // deep → CUSTOM
    ]);
    expect(c.selected).toBe(3);
    expect(c.customSelected).toBe(true);
    // o clamp não passa da linha Custom (continua nela).
    const c2 = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(9), // tenta passar do fim ⇒ clampeia na linha Custom
    ]);
    expect(c2.selected).toBe(3);
    expect(c2.customSelected).toBe(true);
  });

  it('confirmar a linha CUSTOM ABRE o input de texto (não fecha, não troca tier)', async () => {
    let firstConfirm: ModelPickerChoice | null = { kind: 'tier', key: 'x' };
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(3), // vai p/ a linha Custom (clampeia na última)
      (p) => {
        firstConfirm = p.confirm();
      },
    ]);
    // confirmar Custom não devolve escolha (abre o input); o picker SEGUE aberto.
    expect(firstConfirm).toBeNull();
    expect(c.open).toBe(true);
    expect(c.customInputOpen).toBe(true);
    expect(c.customInput).toBe('');
  });

  it('lista Custom CARREGADA + digitar parte do NAME ⇒ SUGESTÕES (completa o id) + WARNING se fora', async () => {
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [
        (p) => p.openPicker(),
        (p) => p.move(3), // linha Custom
        (p) => p.confirm(), // abre o input
        (p) => p.appendCustom('llama'), // casa pelo id E pelo name (Llama …)
      ],
      okCustomModels,
    );
    expect(c.customInputOpen).toBe(true);
    expect(c.customInput).toBe('llama');
    // autocomplete: itens da lista DEDICADA cujo id/name casa. A sugestão MOSTRA o id
    // (o slug que se envia) + dica name/family. Casa "meta-llama/…" pelo id e pelo name.
    expect(c.customSuggestions.length).toBeGreaterThan(0);
    expect(c.customSuggestions.some((s) => s.startsWith('meta-llama/llama-3.1-8b-instruct'))).toBe(
      true,
    );
    // a sugestão completa o ID (load-bearing) e traz o name/family como dica.
    const sug = c.customSuggestions.find((s) => s.startsWith('meta-llama/llama-3.1-8b-instruct'))!;
    expect(sug).toContain('Llama 3.1 8B Instruct');
    expect(sug).toContain('Meta');
    // "llama" não é um ID EXATO ⇒ warn-but-allow (avisa, mas deixa usar).
    expect(c.customWarnOutOfCatalog).toBe(true);
  });

  it('lista Custom CARREGADA + casa pelo ID (substring do slug) ⇒ sugere', async () => {
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [
        (p) => p.openPicker(),
        (p) => p.move(3),
        (p) => p.confirm(),
        (p) => p.appendCustom('jamba'), // só no id (ai21/jamba-large-1.7)
      ],
      okCustomModels,
    );
    expect(c.customSuggestions.some((s) => s.startsWith('ai21/jamba-large-1.7'))).toBe(true);
  });

  it('lista Custom CARREGADA + slug EXATO (id) da lista ⇒ SEM warning (está na lista)', async () => {
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [
        (p) => p.openPicker(),
        (p) => p.move(3),
        (p) => p.confirm(),
        (p) => p.appendCustom('meta-llama/llama-3.1-8b-instruct'), // id EXATO dos 342
      ],
      okCustomModels,
    );
    expect(c.customWarnOutOfCatalog).toBe(false);
  });

  it('lista Custom CARREGADA + slug FORA dos 342 ⇒ WARNING mas DEIXA enviar (warn-but-allow)', async () => {
    // EST-1117 — confirmar o slug AVANÇA pro passo de effort; o trio (com effort "manter")
    // carrega o slug livre. O confirm do modelo agora abre o effort (não fecha).
    let choice: ConjugatedChoice | null = null;
    let modelConfirmed = false;
    let effortConfirmed = false;
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [
        (p) => p.openPicker(),
        (p) => p.move(3),
        (p) => p.confirm(),
        (p) => p.appendCustom('vendor/modelo-que-nao-existe'),
        (p) => {
          if (modelConfirmed) return;
          modelConfirmed = true;
          p.confirm(); // seleciona o slug livre ⇒ entra no passo de effort
        },
        (p) => {
          if (effortConfirmed) return;
          effortConfirmed = true;
          choice = p.confirm(); // "manter" ⇒ aplica o trio
        },
      ],
      okCustomModels,
    );
    // o slug fora da lista DISPARA o aviso… mas o trio ENVIA o slug assim mesmo (warn-but-allow).
    expect(choice).toEqual({
      model: { kind: 'custom', model: 'vendor/modelo-que-nao-existe' },
      effort: { kind: 'keep' },
    });
    expect(c.open).toBe(false);
  });

  it('lista Custom 401/erro ⇒ DEGRADA p/ texto-livre: SEM sugestões e SEM warning (não quebra)', async () => {
    const c = await drive(
      okCatalog, // os TIERS carregam normalmente…
      'aluy-flux',
      [
        (p) => p.openPicker(),
        (p) => p.move(3), // 3 tiers ⇒ linha Custom no índice 3
        (p) => p.confirm(), // abre o input
        (p) => p.appendCustom('qualquer/slug-arbitrario'),
      ],
      failingCustomModels, // …mas a LISTA CUSTOM falha (independente dos tiers)
    );
    // tiers OK (a falha do Custom não derruba os tiers) — fonte separada.
    expect(c.usingFallback).toBe(false);
    expect(c.customInputOpen).toBe(true);
    expect(c.customInput).toBe('qualquer/slug-arbitrario');
    // lista custom fora ⇒ não dá p/ saber se está "fora": sem sugestão/warning.
    expect(c.customSuggestions).toEqual([]);
    expect(c.customWarnOutOfCatalog).toBe(false);
  });

  it('SEM cliente de modelos custom ⇒ texto-livre puro (sem sugestão/aviso), mesmo com tiers OK', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(3),
      (p) => p.confirm(),
      (p) => p.appendCustom('meta-llama/llama-3.1-8b-instruct'),
    ]); // sem customModels
    expect(c.customSuggestions).toEqual([]);
    expect(c.customWarnOutOfCatalog).toBe(false);
  });

  it('a fonte do Custom NÃO é mais o catálogo de tiers: nome de TIER digitado não sugere', async () => {
    // "Strata"/"Claude 3.5 Sonnet" são do CATÁLOGO DE TIERS — não devem mais sugerir
    // (a fonte do Custom é a lista DEDICADA, que aqui não tem esses ids/names).
    const onlyJamba = { list: async () => [CUSTOM_MODELS[0]!] };
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [
        (p) => p.openPicker(),
        (p) => p.move(3),
        (p) => p.confirm(),
        (p) => p.appendCustom('Strata'), // é nome de TIER, não está na lista custom
      ],
      onlyJamba,
    );
    expect(c.customSuggestions).toEqual([]); // não vaza do catálogo de tiers
    expect(c.customWarnOutOfCatalog).toBe(true); // carregou e não bate ⇒ avisa
  });

  it('confirmar no input com slug ⇒ AVANÇA pro effort; effort manter ⇒ trio {custom, keep} e FECHA', async () => {
    // EST-1117 — o slug seleciona o modelo e ABRE o passo de effort; o effort "manter"
    // aplica o trio. Capturamos o trio uma vez só (no App cada enter é discreto).
    let choice: ConjugatedChoice | null = null;
    let modelConfirmed = false;
    let effortConfirmed = false;
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(3),
      (p) => p.confirm(), // abre input
      (p) => p.appendCustom('meta-llama/llama-3.1-8b-instruct'),
      (p) => {
        if (modelConfirmed) return;
        modelConfirmed = true;
        p.confirm(); // seleciona o modelo ⇒ passo de effort
      },
      (p) => {
        if (effortConfirmed) return;
        effortConfirmed = true;
        choice = p.confirm(); // "manter"
      },
    ]);
    // EST-0962 (browser): o slug EXATO casa a linha realçada ⇒ devolve o `id` daquela
    // linha (com `supportsTools` quando conhecido) OU, se o filtro não assentou a tempo,
    // o texto-livre idêntico. Em ambos o `model` é o mesmo (load-bearing).
    expect(choice).toMatchObject({
      model: { kind: 'custom', model: 'meta-llama/llama-3.1-8b-instruct' },
    });
    expect(choice!.effort).toEqual({ kind: 'keep' });
    expect(c.open).toBe(false);
    expect(c.customInputOpen).toBe(false);
  });

  it('input vazio ⇒ confirmar é no-op (null, segue digitando)', async () => {
    let choice: ConjugatedChoice | null = {
      model: { kind: 'tier', key: 'x' },
      effort: { kind: 'keep' },
    };
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(3),
      (p) => p.confirm(), // abre input (vazio)
      (p) => {
        choice = p.confirm(); // confirma com input vazio
      },
    ]);
    expect(choice).toBeNull();
    expect(c.customInputOpen).toBe(true); // segue no input (não avançou pro effort)
    expect(c.effortStepOpen).toBe(false);
    expect(c.open).toBe(true);
  });

  it('backspace apaga o último caractere do slug', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.move(3),
      (p) => p.confirm(),
      (p) => p.appendCustom('abc'),
      (p) => p.backspaceCustom(),
    ]);
    expect(c.customInput).toBe('ab');
  });

  it('os tiers NÃO ganham a linha Custom (compat: tiers segue só o catálogo)', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    // a linha Custom é da UI/seleção, NÃO entra em `tiers` (não vaza p/ quem itera).
    expect(c.tiers.map((t) => t.key)).toEqual(['aluy-flux', 'aluy-strata', 'aluy-deep']);
    expect(c.tiers.some((t) => t.key === 'custom')).toBe(false);
  });
});

describe('useModelPicker — FALLBACK quando o catálogo falha (HG-2)', () => {
  it('broker erra ⇒ cai nos tiers CONHECIDOS + flag de fallback', async () => {
    const c = await drive(failingCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    expect(c.usingFallback).toBe(true);
    // EST-0962 — o fallback mostra os 4 tiers ESTÁVEIS, incluindo o Granito.
    expect(c.tiers.map((t) => t.key)).toEqual([
      'aluy-flux',
      'aluy-granito',
      'aluy-strata',
      'aluy-deep',
    ]);
    expect(c.tiers.some((t) => t.key === 'aluy-granito')).toBe(true);
    // o seletor AINDA troca: confirmar devolve uma chave válida.
    expect(c.tiers.length).toBeGreaterThan(0);
  });

  it('catálogo VAZIO (provisionamento) também cai no fallback (4 tiers, c/ Granito)', async () => {
    const c = await drive(emptyCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    expect(c.usingFallback).toBe(true);
    expect(c.tiers).toHaveLength(4);
    expect(c.tiers.some((t) => t.key === 'aluy-granito')).toBe(true);
  });
});

// EST-0962 — o BROKER é a FONTE DA VERDADE: quando o catálogo responde, ele
// SUBSTITUI o fallback INTEIRO. O fallback NÃO limita a lista — tiers que nem
// existem no fallback (granito do broker, ou tiers NOVOS) aparecem; e o broker pode
// ter MAIS tiers que o fallback (5, 6…) e TODOS aparecem.
describe('useModelPicker — catálogo do broker VENCE o fallback (EST-0962)', () => {
  // Catálogo do broker com 5 tiers, incluindo o `aluy-granito` (que NÃO está no
  // fallback de 4) E um tier totalmente NOVO (`aluy-quartzo`) que o CLI nem conhece.
  const fiveTierCatalog = {
    list: async (): Promise<readonly TierCatalogEntry[]> => [
      { key: 'aluy-flux', displayName: 'Flux', costSignal: 'economical', composition: [] },
      { key: 'aluy-granito', displayName: 'Granito', costSignal: 'standard', composition: [] },
      { key: 'aluy-strata', displayName: 'Strata', costSignal: 'standard', composition: [] },
      { key: 'aluy-deep', displayName: 'Deep', costSignal: 'premium', composition: [] },
      { key: 'aluy-quartzo', displayName: 'Quartzo', costSignal: 'premium', composition: [] },
    ],
  };

  it('catálogo com 5 tiers ⇒ mostra os 5 (fallback não limita; não usa fallback)', async () => {
    const c = await drive(fiveTierCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    expect(c.usingFallback).toBe(false);
    expect(c.tiers).toHaveLength(5);
    expect(c.tiers.map((t) => t.key)).toEqual([
      'aluy-flux',
      'aluy-granito',
      'aluy-strata',
      'aluy-deep',
      'aluy-quartzo',
    ]);
  });

  it('tier DESCONHECIDO do broker (não está no fallback) aparece — não é filtrado', async () => {
    const c = await drive(fiveTierCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    // `aluy-quartzo` não existe no FALLBACK_TIERS e mesmo assim aparece (broker manda).
    expect(c.tiers.some((t) => t.key === 'aluy-quartzo')).toBe(true);
  });

  it('o GRANITO do broker aparece e é SELECIONÁVEL (trio conjugado carrega a chave)', async () => {
    let choice: ConjugatedChoice | null = null;
    let modelDone = false;
    let effortDone = false;
    await drive(fiveTierCatalog, 'aluy-granito', [
      (p) => p.openPicker(),
      (p) => {
        if (modelDone) return;
        modelDone = true;
        p.confirm(); // granito (pré-selecionado) ⇒ passo de effort
      },
      (p) => {
        if (effortDone) return;
        effortDone = true;
        choice = p.confirm(); // "manter"
      },
    ]);
    expect(choice).toEqual({
      model: { kind: 'tier', key: 'aluy-granito' },
      effort: { kind: 'keep' },
    });
  });

  it('catálogo do broker SUBSTITUI o fallback inteiro (nenhum tier só-fallback vaza)', async () => {
    // O broker devolve uma lista REDUZIDA (só 2 tiers). O resultado deve ser
    // EXATAMENTE essa lista — o fallback (4 tiers) NÃO é mesclado por trás.
    const twoTierCatalog = {
      list: async (): Promise<readonly TierCatalogEntry[]> => [
        { key: 'aluy-flux', displayName: 'Flux', costSignal: 'economical', composition: [] },
        { key: 'aluy-deep', displayName: 'Deep', costSignal: 'premium', composition: [] },
      ],
    };
    const c = await drive(twoTierCatalog, 'aluy-flux', [(p) => p.openPicker()]);
    expect(c.usingFallback).toBe(false);
    expect(c.tiers.map((t) => t.key)).toEqual(['aluy-flux', 'aluy-deep']);
    // o strata/granito do fallback NÃO aparecem — o broker é a fonte.
    expect(c.tiers.some((t) => t.key === 'aluy-strata')).toBe(false);
    expect(c.tiers.some((t) => t.key === 'aluy-granito')).toBe(false);
  });
});

// EST-0962 (BROWSER navegável) — o modo Custom é um browser dos ~339 modelos:
// digitar FILTRA, ↑↓ NAVEGAM com scroll (janela `BROWSER_WINDOW`), `t` alterna
// "só-tools", enter na linha REALÇADA seleciona o `id`, e o realce sem tools dá um
// aviso warn-but-allow. DoD FRUGAL: mock do client com ~20 modelos (sem broker).
describe('useModelPicker — BROWSER do Custom (EST-0962)', () => {
  // 20 modelos (FRUGAL, sem broker): metade com tools, alguns sem, um neutro
  // (`supportsTools` ausente). `Fam{i%4}` dá famílias p/ testar o filtro por família.
  const MANY: readonly CustomModel[] = Array.from({ length: 20 }, (_, i) => {
    const base = {
      id: `vendor/model-${String(i).padStart(2, '0')}`,
      name: `Model ${i}`,
      family: `Fam${i % 4}`,
      context: i % 2 === 0 ? '128k' : '32k',
    };
    // i%5===0 ⇒ neutro (campo ausente); senão alterna true/false (par=true).
    if (i % 5 === 0) return base;
    return { ...base, supportsTools: i % 2 === 0 };
  });
  const manyClient = { list: async () => MANY };

  // Atalho: abre o picker, vai p/ a linha Custom e ENTRA no browser (confirm).
  const enterBrowser = [
    (p: ModelPickerController) => p.openPicker(),
    (p: ModelPickerController) => p.move(3), // 3 tiers ⇒ linha Custom
    (p: ModelPickerController) => p.confirm(), // abre o browser
  ];

  it('entra no browser e LISTA os modelos com janela (≤ BROWSER_WINDOW visíveis)', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [...enterBrowser], manyClient);
    expect(c.customInputOpen).toBe(true);
    expect(c.customBrowserAvailable).toBe(true);
    expect(c.customTotalCount).toBe(20);
    expect(c.customFilteredCount).toBe(20);
    // a janela mostra no MÁX BROWSER_WINDOW (10) — não a tela inteira (densa).
    expect(c.customRows.length).toBe(BROWSER_WINDOW);
    // a 1ª linha começa realçada (índice 0).
    expect(c.customBrowseIndex).toBe(0);
    expect(c.customRows[0]!.highlighted).toBe(true);
    // há mais ABAIXO (20 > 10) mas não acima (no topo).
    expect(c.customHasMoreAbove).toBe(false);
    expect(c.customHasMoreBelow).toBe(true);
  });

  it('cada linha carrega família/contexto/badge-tools (id é load-bearing)', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [...enterBrowser], manyClient);
    const row0 = c.customRows[0]!.model;
    expect(row0.id).toBe('vendor/model-00');
    expect(row0.family).toBe('Fam0');
    expect(row0.context).toBe('128k');
    // model-00: i%5===0 ⇒ supportsTools AUSENTE (badge neutro, não false).
    expect(row0.supportsTools).toBeUndefined();
    // model-02: i%2===0 e i%5!==0 ⇒ supportsTools true.
    const m02 = MANY.find((m) => m.id === 'vendor/model-02')!;
    expect(m02.supportsTools).toBe(true);
  });

  it('↑↓ NAVEGAM e a janela faz SCROLL além do visível (realce segue)', async () => {
    // desce 12× a partir do índice 0 ⇒ realce no 12 (além da 1ª janela de 10).
    const downs = Array.from({ length: 12 }, () => (p: ModelPickerController) => p.browseMove(1));
    const c = await drive(okCatalog, 'aluy-flux', [...enterBrowser, ...downs], manyClient);
    expect(c.customBrowseIndex).toBe(12);
    // a janela rolou: agora há itens ACIMA, e o realce está DENTRO da janela visível.
    expect(c.customHasMoreAbove).toBe(true);
    const highlighted = c.customRows.find((r) => r.highlighted);
    expect(highlighted).toBeDefined();
    expect(highlighted!.model.id).toBe('vendor/model-12');
  });

  it('↑↓ CLAMPEIam nos limites (não passa do fim nem sobe além do topo)', async () => {
    const downs = Array.from({ length: 99 }, () => (p: ModelPickerController) => p.browseMove(1));
    const c = await drive(okCatalog, 'aluy-flux', [...enterBrowser, ...downs], manyClient);
    expect(c.customBrowseIndex).toBe(19); // último (20 itens)
    expect(c.customHasMoreBelow).toBe(false); // no fim, nada mais abaixo
  });

  it('DIGITAR FILTRA a lista (id ∪ name ∪ family) e reduz o contador', async () => {
    // "Fam1" casa só os modelos da família 1 (i%4===1 ⇒ 5 itens: 1,5,9,13,17).
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('Fam1')],
      manyClient,
    );
    expect(c.customFilteredCount).toBe(5);
    expect(c.customTotalCount).toBe(20); // total não muda
    expect(c.customRows.every((r) => r.model.family === 'Fam1')).toBe(true);
  });

  it('toggle "só com tools" (t) ESCONDE os sem suporte (false E neutro somem)', async () => {
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.toggleToolsOnly()],
      manyClient,
    );
    expect(c.customToolsOnly).toBe(true);
    // só os `supportsTools===true` sobram (i par e i%5!==0): 2,4,6,8,12,14,16,18 ⇒ 8.
    expect(c.customFilteredCount).toBe(8);
    expect(c.customRows.every((r) => r.model.supportsTools === true)).toBe(true);
    // os neutros (model-00, model-10) e os false saíram.
    expect(c.customRows.some((r) => r.model.id === 'vendor/model-00')).toBe(false);
  });

  it('toggle DESLIGA de novo (alterna) ⇒ volta a lista cheia', async () => {
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.toggleToolsOnly(), (p) => p.toggleToolsOnly()],
      manyClient,
    );
    expect(c.customToolsOnly).toBe(false);
    expect(c.customFilteredCount).toBe(20);
  });

  it('ENTER na linha REALÇADA seleciona o id daquela linha (com supportsTools) e abre o effort; trio fecha', async () => {
    // desce 2× ⇒ realça model-02 (supportsTools true). Enter seleciona o id ⇒ effort ⇒ trio.
    let choice: ConjugatedChoice | null = null;
    let modelDone = false;
    let effortDone = false;
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [
        ...enterBrowser,
        (p) => p.browseMove(1),
        (p) => p.browseMove(1),
        (p) => {
          if (modelDone) return;
          modelDone = true;
          p.confirm(); // seleciona a linha ⇒ passo de effort
        },
        (p) => {
          if (effortDone) return;
          effortDone = true;
          choice = p.confirm(); // "manter"
        },
      ],
      manyClient,
    );
    expect(choice).toEqual({
      model: { kind: 'custom', model: 'vendor/model-02', supportsTools: true },
      effort: { kind: 'keep' },
    });
    expect(c.open).toBe(false);
  });

  it('ENTER num modelo SEM tools ⇒ trio carrega supportsTools:false (warn-but-allow no caller)', async () => {
    // model-03: i%2===1, i%5!==0 ⇒ supportsTools false. Filtra exato, seleciona, confirma effort.
    let choice: ConjugatedChoice | null = null;
    let modelDone = false;
    let effortDone = false;
    await drive(
      okCatalog,
      'aluy-flux',
      [
        ...enterBrowser,
        (p) => p.appendCustom('vendor/model-03'),
        (p) => {
          if (modelDone) return;
          modelDone = true;
          p.confirm(); // ⇒ passo de effort
        },
        (p) => {
          if (effortDone) return;
          effortDone = true;
          choice = p.confirm();
        },
      ],
      manyClient,
    );
    // o slug EXATO casa a linha (false) OU cai no texto-livre idêntico — `model` igual.
    expect(choice!.model).toMatchObject({ kind: 'custom', model: 'vendor/model-03' });
  });

  it('AVISO de não-suporte (preview): realçar um modelo sem tools expõe customNoToolsWarning', async () => {
    // filtra "vendor/model-03" (false) ⇒ 1 linha realçada ⇒ aviso aponta o id.
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('vendor/model-03')],
      manyClient,
    );
    expect(c.customNoToolsWarning).toBe('vendor/model-03');
    // já um modelo COM tools (model-02) ⇒ sem aviso.
    const c2 = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('vendor/model-02')],
      manyClient,
    );
    expect(c2.customNoToolsWarning).toBeNull();
    // modelo NEUTRO (model-00, supportsTools ausente) ⇒ SEM aviso (não inventa false).
    const c3 = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('vendor/model-00')],
      manyClient,
    );
    expect(c3.customNoToolsWarning).toBeNull();
  });

  it('filtro sem casamento ⇒ lista VAZIA e nenhuma linha realçada (índice -1)', async () => {
    // sem confirmar (o confirm fecha e RESETa o input): observamos o estado filtrado.
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('inexistente/xyz')],
      manyClient,
    );
    expect(c.customFilteredCount).toBe(0);
    expect(c.customRows).toEqual([]);
    expect(c.customBrowseIndex).toBe(-1); // nada realçado ⇒ enter cai no texto-livre
    expect(c.customNoToolsWarning).toBeNull();
  });

  it('filtro sem casamento + ENTER usa o TEXTO-LIVRE digitado (warn-but-allow) ⇒ trio', async () => {
    let choice: ConjugatedChoice | null = null;
    let modelDone = false;
    let effortDone = false;
    await drive(
      okCatalog,
      'aluy-flux',
      [
        ...enterBrowser,
        (p) => p.appendCustom('inexistente/xyz'),
        (p) => {
          if (modelDone) return;
          modelDone = true;
          p.confirm(); // texto-livre ⇒ passo de effort
        },
        (p) => {
          if (effortDone) return;
          effortDone = true;
          choice = p.confirm();
        },
      ],
      manyClient,
    );
    // nenhuma linha realçada ⇒ texto-livre puro (sem supportsTools — não dá p/ saber).
    expect(choice).toEqual({
      model: { kind: 'custom', model: 'inexistente/xyz' },
      effort: { kind: 'keep' },
    });
  });

  it('client 401/fora ⇒ DEGRADA: sem browser, customBrowserAvailable false (não trava)', async () => {
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('qualquer/slug')],
      failingCustomModels,
    );
    expect(c.customInputOpen).toBe(true); // o modo Custom abre mesmo assim
    expect(c.customBrowserAvailable).toBe(false); // mas o browser degradou
    expect(c.customRows).toEqual([]);
    expect(c.customTotalCount).toBe(0);
    // os tiers seguem OK (fonte separada) — degradação não derruba o resto.
    expect(c.usingFallback).toBe(false);
  });

  it('filtrar e DEPOIS togglar tools mantém os dois filtros compostos', async () => {
    // Fam0 (5 itens: 0,4,8,12,16) + só-tools ⇒ os pares não-neutros (4,8,12,16) = 4.
    const c = await drive(
      okCatalog,
      'aluy-flux',
      [...enterBrowser, (p) => p.appendCustom('Fam0'), (p) => p.toggleToolsOnly()],
      manyClient,
    );
    expect(c.customRows.every((r) => r.model.family === 'Fam0')).toBe(true);
    expect(c.customRows.every((r) => r.model.supportsTools === true)).toBe(true);
    expect(c.customFilteredCount).toBe(4);
  });
});

describe('useModelPicker — passo de EFFORT conjugado (EST-1117)', () => {
  it('confirmar um tier ABRE o passo de effort com as opções (manter/low/medium/high/custom)', async () => {
    const c = await drive(okCatalog, 'aluy-flux', [(p) => p.openPicker(), (p) => p.confirm()]);
    expect(c.effortStepOpen).toBe(true);
    expect(c.effortOptions.map((o) => o.id)).toEqual(['keep', 'low', 'medium', 'high', 'custom']);
    expect(c.effortSelected).toBe(0); // "manter" pré-selecionado (menor atrito)
  });

  it('navegar até "custom" e confirmar ABRE o texto-livre (não devolve trio ainda)', async () => {
    let confirmAfterCustom: ConjugatedChoice | null = {
      model: { kind: 'tier', key: 'x' },
      effort: { kind: 'keep' },
    };
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(), // tier ⇒ passo de effort
      (p) => p.effortMove(4), // → custom (índice 4)
      (p) => {
        confirmAfterCustom = p.confirm(); // abre o texto-livre (null)
      },
    ]);
    expect(confirmAfterCustom).toBeNull();
    expect(c.effortCustomOpen).toBe(true);
    expect(c.effortStepOpen).toBe(true);
  });

  it('effort custom: digitar um valor válido ⇒ trio {set: valor}', async () => {
    let choice: ConjugatedChoice | null = null;
    let modelDone = false;
    let customOpened = false;
    let confirmed = false;
    await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => {
        if (modelDone) return;
        modelDone = true;
        p.confirm(); // tier ⇒ effort
      },
      (p) => p.effortMove(4), // → custom
      (p) => {
        if (customOpened) return;
        customOpened = true;
        p.confirm(); // abre o texto-livre
      },
      (p) => p.appendEffortCustom('xtra-high'),
      (p) => {
        if (confirmed) return;
        confirmed = true;
        choice = p.confirm();
      },
    ]);
    expect(choice).toEqual({
      model: { kind: 'tier', key: 'aluy-flux' },
      effort: { kind: 'set', value: 'xtra-high' },
    });
  });

  it('effort custom VAZIO ⇒ aviso "empty" e confirm é no-op (não aplica)', async () => {
    let choice: ConjugatedChoice | null = {
      model: { kind: 'tier', key: 'x' },
      effort: { kind: 'keep' },
    };
    let customOpened = false;
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(), // ⇒ effort
      (p) => p.effortMove(4), // custom
      (p) => {
        if (customOpened) return;
        customOpened = true;
        p.confirm(); // abre texto-livre (vazio)
      },
      (p) => {
        choice = p.confirm(); // confirma vazio
      },
    ]);
    expect(choice).toBeNull();
    expect(c.effortCustomWarn).toBe('empty');
    expect(c.effortCustomOpen).toBe(true); // segue no texto-livre
  });

  it('effort custom > 32 chars ⇒ aviso "too-long" e confirm é no-op', async () => {
    const longValue = 'x'.repeat(33);
    let choice: ConjugatedChoice | null = {
      model: { kind: 'tier', key: 'x' },
      effort: { kind: 'keep' },
    };
    let customOpened = false;
    const c = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(),
      (p) => p.effortMove(4),
      (p) => {
        if (customOpened) return;
        customOpened = true;
        p.confirm();
      },
      (p) => p.appendEffortCustom(longValue),
      (p) => {
        choice = p.confirm();
      },
    ]);
    expect(choice).toBeNull();
    expect(c.effortCustomWarn).toBe('too-long');
  });

  it('esc no effort custom volta p/ a LISTA de effort; esc na lista volta p/ o MODELO', async () => {
    // backFromEffort: custom → lista (true); lista → modelo (true); modelo → false.
    const c1 = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(),
      (p) => p.effortMove(4),
      (p) => p.confirm(), // abre custom
      (p) => p.backFromEffort(), // volta p/ a lista de effort
    ]);
    expect(c1.effortCustomOpen).toBe(false);
    expect(c1.effortStepOpen).toBe(true);

    const c2 = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(), // ⇒ effort
      (p) => p.backFromEffort(), // volta p/ o modelo
    ]);
    expect(c2.effortStepOpen).toBe(false);
    expect(c2.open).toBe(true);
  });

  it('effortMove é clampeado [0, 4] (não passa das pontas)', async () => {
    const cTop = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(),
      (p) => p.effortMove(-5), // tenta passar do topo
    ]);
    expect(cTop.effortSelected).toBe(0);
    const cBot = await drive(okCatalog, 'aluy-flux', [
      (p) => p.openPicker(),
      (p) => p.confirm(),
      (p) => p.effortMove(99), // tenta passar do fim
    ]);
    expect(cBot.effortSelected).toBe(4);
  });
});

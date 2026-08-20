// F-PROV-CRED (relato do dono: "mudei o provider no picker e ele não pediu nada" — trocou
// pra `google`/`mistral`, sem chave, e o aluy só AVISOU) — cobre o passo NOVO de credencial
// do `useProviderPicker`: (1) as DECISÕES puras (`requiresApiKey`/`needsCredentialStep`/
// `planCredentialRetry`) sem nenhum I/O nem Ink; (2) a MÁQUINA DE ESTADO do campo, drivada
// pelo MESMO harness Probe dos demais testes deste hook (`use-provider-picker-local.test.tsx`).
//
// Não testamos aqui o QUE o `<ProviderPicker>` desenha (mascaramento) — isso é
// `provider-picker-credential.test.tsx` (render, ink-testing-library).

import { describe, expect, it } from 'vitest';
import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { LocalProviderEntry } from '@hiperplano/aluy-cli-core';
import {
  useProviderPicker,
  requiresApiKey,
  needsCredentialStep,
  planCredentialRetry,
  type ProviderPickerController,
  type UseProviderPickerArgs,
} from '../../src/ui/hooks/useProviderPicker.js';

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

// ─────────────────────────────────────────────────────────────────────────────
// DECISÕES puras — "este provider precisa do passo de chave?" / "o que fazer quando o
// teste reprova?" — SEM Ink, sem React, sem I/O.
// ─────────────────────────────────────────────────────────────────────────────

describe('requiresApiKey — pura', () => {
  it('auth apikey exige chave', () => {
    expect(requiresApiKey(['apikey'])).toBe(true);
  });

  it('auth apikey+oauth (mistura) exige chave', () => {
    expect(requiresApiKey(['apikey', 'oauth'])).toBe(true);
  });

  it('auth SÓ ["none"] (keyless — ex.: Ollama) NÃO exige chave', () => {
    expect(requiresApiKey(['none'])).toBe(false);
  });

  it('undefined (provider fora do catálogo local / lista do broker) NÃO exige — sem o dado, não pede', () => {
    expect(requiresApiKey(undefined)).toBe(false);
  });

  it('array vazio NÃO exige', () => {
    expect(requiresApiKey([])).toBe(false);
  });
});

describe('needsCredentialStep — pura (com chave / sem chave / keyless)', () => {
  it('SEM chave guardada + provider exige apikey ⇒ precisa do passo', () => {
    expect(needsCredentialStep(['apikey'], false)).toBe(true);
  });

  it('COM chave já guardada ⇒ NÃO incomoda quem já configurou, mesmo provider exigindo apikey', () => {
    expect(needsCredentialStep(['apikey'], true)).toBe(false);
  });

  it('provider KEYLESS (Ollama) nunca precisa, mesmo sem "chave guardada"', () => {
    expect(needsCredentialStep(['none'], false)).toBe(false);
  });

  it('provider KEYLESS com chave "guardada" (irrelevante) também não precisa', () => {
    expect(needsCredentialStep(['none'], true)).toBe(false);
  });
});

describe('planCredentialRetry — pura ("o que fazer quando o teste reprova?")', () => {
  it('provider que EXIGE apikey reprovado ⇒ reabre o campo com o motivo (detail)', () => {
    const plan = planCredentialRetry(['apikey'], 'provider "google" NÃO respondeu ao teste: 401');
    expect(plan).toEqual({ error: 'provider "google" NÃO respondeu ao teste: 401' });
  });

  it('provider KEYLESS (Ollama) reprovado ⇒ NÃO reabre (é rede/serviço, não credencial)', () => {
    expect(planCredentialRetry(['none'], 'connection refused')).toBeNull();
  });

  it('provider desconhecido (auth undefined) ⇒ NÃO reabre (sem o dado, não oferece campo)', () => {
    expect(planCredentialRetry(undefined, 'timeout')).toBeNull();
  });

  it('o `detail` reaparece LITERAL no plano — nunca reescrito/mascarado aqui (a chave não está nele)', () => {
    const detail = 'motivo qualquer, sem segredo';
    expect(planCredentialRetry(['apikey', 'oauth'], detail)).toEqual({ error: detail });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MÁQUINA DE ESTADO — Probe/drive, mesmo harness de `use-provider-picker-local.test.tsx`.
// ─────────────────────────────────────────────────────────────────────────────

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
  return <Text>{`credentialStep=${picker.credentialStep}`}</Text>;
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

describe('useProviderPicker — passo de credencial (integrado ao catálogo local)', () => {
  it('sem hasStoredKey/storeCredential injetados: confirm() aplica DIRETO (comportamento de hoje, sem regressão)', async () => {
    let confirmed: string | null = 'unset';
    const c = await drive({ localCatalog: () => [localEntry('google')] }, [
      (p) => p.openPicker(),
      (p) => {
        confirmed = p.confirm();
      },
    ]);
    expect(confirmed).toBe('google');
    expect(c.open).toBe(false);
    expect(c.credentialStep).toBeNull();
  });

  it('provider SEM chave guardada + exige apikey ⇒ confirm() NÃO fecha, abre o passo de credencial', async () => {
    let confirmed: string | null = 'unset';
    const c = await drive(
      {
        localCatalog: () => [localEntry('google')],
        hasStoredKey: () => false,
        storeCredential: () => {},
      },
      [
        (p) => p.openPicker(),
        (p) => {
          confirmed = p.confirm();
        },
      ],
    );
    expect(confirmed).toBeNull(); // não devolve o nome ainda — falta a chave.
    expect(c.open).toBe(true); // picker CONTINUA aberto (troca de vista, não fecha).
    expect(c.credentialStep).toBe('key');
    expect(c.credentialProviderId).toBe('google');
  });

  it('provider COM chave já guardada ⇒ confirm() aplica DIRETO, sem passo (não incomoda)', async () => {
    let confirmed: string | null = 'unset';
    const c = await drive(
      {
        localCatalog: () => [localEntry('anthropic')],
        hasStoredKey: () => true,
        storeCredential: () => {},
      },
      [
        (p) => p.openPicker(),
        (p) => {
          confirmed = p.confirm();
        },
      ],
    );
    expect(confirmed).toBe('anthropic');
    expect(c.open).toBe(false);
    expect(c.credentialStep).toBeNull();
  });

  it('provider KEYLESS (Ollama) nunca vê o passo, mesmo com hasStoredKey=false', async () => {
    let confirmed: string | null = 'unset';
    const c = await drive(
      {
        localCatalog: () => [localEntry('ollama', { auth: ['none'] })],
        hasStoredKey: () => false,
        storeCredential: () => {},
      },
      [
        (p) => p.openPicker(),
        (p) => {
          confirmed = p.confirm();
        },
      ],
    );
    expect(confirmed).toBe('ollama');
    expect(c.credentialStep).toBeNull();
  });

  it('digitar + enter no campo: grava via storeCredential injetado e devolve o NOME do provider', async () => {
    let stored: { id: string; key: string } | null = null;
    let result: string | null = 'unset';
    const c = await drive(
      {
        localCatalog: () => [localEntry('google')],
        hasStoredKey: () => false,
        storeCredential: (id, key) => {
          stored = { id, key };
        },
      },
      [
        (p) => p.openPicker(),
        (p) => p.confirm(), // abre o passo de credencial
        (p) => {
          for (const ch of 'sk-abc123') p.typeCredential(ch);
        },
        (p) => {
          result = p.confirmCredential();
        },
      ],
    );
    expect(stored).toEqual({ id: 'google', key: 'sk-abc123' });
    expect(result).toBe('google');
    expect(c.open).toBe(false);
    expect(c.credentialStep).toBeNull();
    // limpo — nada do valor digitado sobrevive no estado após aplicar.
    expect(c.credentialDraft).toBe('');
  });

  it('enter com o campo VAZIO: no-op (campo obrigatório, mesma UX do id/baseUrl do "+ adicionar")', async () => {
    const c = await drive(
      {
        localCatalog: () => [localEntry('google')],
        hasStoredKey: () => false,
        storeCredential: () => {
          throw new Error('não deveria ter sido chamado com campo vazio');
        },
      },
      [(p) => p.openPicker(), (p) => p.confirm(), (p) => p.confirmCredential()],
    );
    expect(c.credentialStep).toBe('key'); // continua no campo.
  });

  it('storeCredential LANÇA: mostra a mensagem do backend (nunca a chave) e mantém o campo aberto', async () => {
    const c = await drive(
      {
        localCatalog: () => [localEntry('google')],
        hasStoredKey: () => false,
        storeCredential: () => {
          throw new Error('cofre em arquivo indisponível: machine-id ilegível');
        },
      },
      [
        (p) => p.openPicker(),
        (p) => p.confirm(),
        (p) => {
          for (const ch of 'sk-segredo-nao-pode-vazar') p.typeCredential(ch);
        },
        (p) => p.confirmCredential(),
      ],
    );
    expect(c.credentialStep).toBe('key'); // continua aberto p/ nova tentativa.
    expect(c.credentialError).toBe('cofre em arquivo indisponível: machine-id ilegível');
    expect(c.credentialError).not.toContain('sk-segredo-nao-pode-vazar'); // CLI-SEC.
    expect(c.credentialDraft).toBe(''); // rascunho limpo — não reexibe o valor que falhou.
  });

  it('backspace apaga do campo de chave', async () => {
    const c = await drive(
      { localCatalog: () => [localEntry('g')], hasStoredKey: () => false, storeCredential: () => {} },
      [
        (p) => p.openPicker(),
        (p) => p.confirm(),
        (p) => {
          p.typeCredential('a');
          p.typeCredential('b');
          p.typeCredential('c');
        },
        (p) => p.backspaceCredential(),
      ],
    );
    expect(c.credentialDraft).toBe('ab');
  });

  it('esc (cancelCredential) volta pra lista sem gravar nada e sem fechar o picker', async () => {
    let stored = false;
    const c = await drive(
      {
        localCatalog: () => [localEntry('g')],
        hasStoredKey: () => false,
        storeCredential: () => {
          stored = true;
        },
      },
      [
        (p) => p.openPicker(),
        (p) => p.confirm(),
        (p) => p.typeCredential('x'),
        (p) => p.cancelCredential(),
      ],
    );
    expect(stored).toBe(false);
    expect(c.credentialStep).toBeNull();
    expect(c.credentialDraft).toBe('');
    expect(c.open).toBe(true); // a LISTA continua aberta — só o campo fechou.
  });

  it('retryCredential REABRE o campo (mesmo com o picker fechado) quando o provider exige apikey', async () => {
    const c = await drive({ localCatalog: () => [localEntry('google')] }, [
      (p) => p.openPicker(),
      (p) => p.closePicker(), // simula: picker já fechou, troca aplicada, teste vai falhar depois (async).
      (p) => p.retryCredential('google', 'provider "google" NÃO respondeu ao teste: 401 unauthorized'),
    ]);
    expect(c.open).toBe(true);
    expect(c.credentialStep).toBe('key');
    expect(c.credentialProviderId).toBe('google');
    expect(c.credentialError).toBe('provider "google" NÃO respondeu ao teste: 401 unauthorized');
    expect(c.credentialDraft).toBe(''); // não reoferece a chave errada.
  });

  it('retryCredential é NO-OP para provider keyless (Ollama) — falha ali é rede, não credencial', async () => {
    const c = await drive({ localCatalog: () => [localEntry('ollama', { auth: ['none'] })] }, [
      (p) => p.openPicker(),
      (p) => p.closePicker(),
      (p) => p.retryCredential('ollama', 'connection refused'),
    ]);
    expect(c.open).toBe(false); // não reabriu nada.
    expect(c.credentialStep).toBeNull();
  });

  it('abrir o picker (openPicker) limpa qualquer passo de credencial pendente de antes', async () => {
    const c = await drive(
      {
        localCatalog: () => [localEntry('google')],
        hasStoredKey: () => false,
        storeCredential: () => {},
      },
      [
        (p) => p.openPicker(),
        (p) => p.confirm(), // abre o passo
        (p) => p.typeCredential('x'),
        (p) => p.openPicker(), // reabrir (ex.: /provider de novo) — não deve herdar o campo a meio.
      ],
    );
    expect(c.credentialStep).toBeNull();
    expect(c.credentialDraft).toBe('');
  });
});

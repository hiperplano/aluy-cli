// F-PROV-FIX — testes PUROS do `planSaveProvider` (sem I/O, sem React): decide o QUE
// persistir p/ o ato explícito "/provider save", a partir do estado atual da sessão
// (`SessionController.provider`/`.model`) + do default resolvido no BOOT
// (`resolveLocalProviderConfig`). A escrita de verdade (`UserConfigStore.saveLocalProvider`)
// e o round-trip com o boot têm teste próprio em `io/user-config-local-provider.test.ts`.

import { describe, expect, it } from 'vitest';
import { planSaveProvider } from '../../src/session/save-provider.js';

describe('planSaveProvider', () => {
  it('backend ≠ local (broker): NÃO aplicável — o Custom pareia com o slug, resolvido pelo broker', () => {
    const plan = planSaveProvider({
      backend: 'broker',
      currentProvider: 'deepseek',
      currentModel: 'deepseek-chat',
      bootProvider: undefined,
      bootModel: undefined,
    });
    expect(plan).toEqual({ applicable: false, reason: 'not-local' });
  });

  it('backend undefined (meta sem campo — sessão pré-ADR-0120): NÃO aplicável', () => {
    const plan = planSaveProvider({
      backend: undefined,
      currentProvider: 'openai',
      currentModel: 'gpt-4o-mini',
      bootProvider: undefined,
      bootModel: undefined,
    });
    expect(plan.applicable).toBe(false);
  });

  it('local + já trocou de provider NESTA sessão: usa o EFETIVO corrente (não o do boot)', () => {
    const plan = planSaveProvider({
      backend: 'local',
      currentProvider: 'tokenrouter',
      currentModel: 'moonshotai/kimi-k2',
      bootProvider: 'anthropic', // o que estava ativo ANTES da troca desta sessão
      bootModel: 'claude-opus-4-8',
    });
    expect(plan).toEqual({
      applicable: true,
      provider: 'tokenrouter',
      model: 'moonshotai/kimi-k2',
    });
  });

  it('local + NUNCA trocou nesta sessão (sem /provider ainda): cai no default do BOOT', () => {
    const plan = planSaveProvider({
      backend: 'local',
      currentProvider: undefined,
      currentModel: undefined,
      bootProvider: 'anthropic',
      bootModel: 'claude-opus-4-8',
    });
    expect(plan).toEqual({ applicable: true, provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('local + só o PROVIDER corrente (modelo default ainda não custom) mistura corrente+boot', () => {
    // Achado sutil: `/provider` já trocou (setLocalProvider seta tier:custom+model
    // default do provider NOVO), então na prática `currentModel` já acompanha — mas o
    // plano deve funcionar mesmo se só o provider mudou e o modelo ainda é undefined
    // (ex.: caller de teste que não popula `model`).
    const plan = planSaveProvider({
      backend: 'local',
      currentProvider: 'tokenrouter',
      currentModel: undefined,
      bootProvider: 'anthropic',
      bootModel: 'claude-opus-4-8',
    });
    expect(plan).toEqual({
      applicable: true,
      provider: 'tokenrouter',
      model: 'claude-opus-4-8', // cai no default do BOOT (não existe corrente ainda)
    });
  });

  it('local, mas SEM provider algum (corrente e boot ambos undefined): NÃO aplicável — nada a fixar', () => {
    const plan = planSaveProvider({
      backend: 'local',
      currentProvider: undefined,
      currentModel: undefined,
      bootProvider: undefined,
      bootModel: undefined,
    });
    expect(plan).toEqual({ applicable: false, reason: 'no-provider' });
  });

  it('provider em branco (string vazia) conta como AUSENTE — nunca grava lixo', () => {
    const plan = planSaveProvider({
      backend: 'local',
      currentProvider: '   ',
      currentModel: undefined,
      bootProvider: undefined,
      bootModel: undefined,
    });
    expect(plan).toEqual({ applicable: false, reason: 'no-provider' });
  });

  it('modelo em branco é OMITIDO do plano (nunca um `model: ""` gravável)', () => {
    const plan = planSaveProvider({
      backend: 'local',
      currentProvider: 'ollama',
      currentModel: '   ',
      bootProvider: undefined,
      bootModel: undefined,
    });
    expect(plan).toEqual({ applicable: true, provider: 'ollama' });
    expect(plan.applicable && 'model' in plan).toBe(false);
  });
});

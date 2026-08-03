// F-PROV — `SessionController.setLocalProvider`: achado em dogfooding, o `/provider`
// sob backend LOCAL (BYO) era um NO-OP SILENCIOSO — `setProvider` só mudava um DADO
// passageiro do request (`caller.customProvider`) que o `LocalModelClient` NUNCA lê (ele
// fala com um único client fixo, resolvido no boot). `setLocalProvider` é a via CORRETA:
// chama a porta `switchLocalProvider` (construída em `run.tsx`, aqui uma FAKE) e, no
// sucesso, SWAPA o client de verdade (`tierControl.setClient`) + alinha tier:'custom'+
// model ao default do provider novo — o MESMO par que o `LocalModelClient` lê por
// request.
//
// Também prova o padrão que fecha o gap "o /model não segue o provider trocado": um
// `localModelCatalog.listNames()` construído (como em `run.tsx`) sobre o MESMO estado
// mutável que `switchLocalProvider` atualiza no sucesso passa a listar os modelos do
// provider NOVO depois do switch.

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ModelClient,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return '';
    },
    async writeFile() {},
    async exists() {
      return false;
    },
  };
  const shell: ShellPort = {
    async exec() {
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  };
  const search: SearchPort = {
    async search() {
      return { matches: [], truncated: {} };
    },
  };
  return { fs, shell, search };
}

function fakeClient(tag: string): ModelClient {
  return {
    async *stream() {
      yield { type: 'start' as const, id: tag };
      yield { type: 'delta' as const, content: `${tag}-ok.` };
      yield { type: 'done' as const, id: tag };
    },
    async call() {
      return { request_id: tag, content: `${tag}-ok.`, finish_reason: 'stop' as const };
    },
  };
}

/**
 * Caller MÍNIMO que satisfaz `TierControl` (duck-typed pelo controller — `setTier` +
 * `tier: string`): registra `setClient`/`setTier`/`setProvider` p/ o teste inspecionar.
 */
function tierControlCaller(): ModelCaller & {
  tier: string;
  model?: string;
  provider?: string;
  setClientCalls: ModelClient[];
  setTier(tier: string, model?: string): void;
  setProvider(name: string | undefined): void;
  setClient(client: ModelClient): void;
} {
  const state = { tier: 'aluy-flux', model: undefined as string | undefined, provider: undefined as string | undefined };
  const setClientCalls: ModelClient[] = [];
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: 'ok.', finish_reason: 'stop' };
    },
    get tier() {
      return state.tier;
    },
    get model() {
      return state.model;
    },
    get provider() {
      return state.provider;
    },
    setClientCalls,
    setTier(tier: string, model?: string) {
      state.tier = tier;
      state.model = tier === 'custom' ? model : undefined;
    },
    setProvider(name: string | undefined) {
      state.provider = state.tier === 'custom' && state.model !== undefined ? name : undefined;
    },
    setClient(client: ModelClient) {
      setClientCalls.push(client);
    },
  };
}

const LOCAL_META = {
  cwd: '/proj',
  tier: 'aluy-flux',
  backend: 'local' as const,
  tokens: 0,
  windowPct: 0,
};

describe('F-PROV — SessionController.setLocalProvider (fix do no-op silencioso do /provider local)', () => {
  it('sucesso: swapa o client, seta tier:custom+model default do provider novo, espelha meta', async () => {
    const caller = tierControlCaller();
    const newClient = fakeClient('deepseek');
    const controller = new SessionController({
      model: caller,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: { async resolve() { return { kind: 'approve-once' as const }; } },
      meta: LOCAL_META,
      flush: { intervalMs: 0 },
      switchLocalProvider: async (name: string) => {
        expect(name).toBe('deepseek');
        return { ok: true, detail: `provider ativo agora: ${name}.`, client: newClient, defaultModel: 'deepseek-chat' };
      },
    });

    const result = await controller.setLocalProvider('deepseek');

    expect(result).toEqual({ ok: true, detail: 'provider ativo agora: deepseek.' });
    expect(caller.setClientCalls).toEqual([newClient]); // o CLIENT de verdade foi trocado
    expect(caller.tier).toBe('custom');
    expect(caller.model).toBe('deepseek-chat');
    expect(controller.provider).toBe('deepseek');
    expect(controller.model).toBe('deepseek-chat');
    controller.dispose();
  });

  it('falha da porta (provider desconhecido/erro ao montar o client): NADA muda (fail-closed)', async () => {
    const caller = tierControlCaller();
    const controller = new SessionController({
      model: caller,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: { async resolve() { return { kind: 'approve-once' as const }; } },
      meta: LOCAL_META,
      flush: { intervalMs: 0 },
      switchLocalProvider: async () => ({ ok: false, detail: 'provider "bogus" não está no catálogo local.' }),
    });

    const result = await controller.setLocalProvider('bogus');

    expect(result.ok).toBe(false);
    expect(result.detail).toContain('não está no catálogo');
    expect(caller.setClientCalls).toEqual([]); // NUNCA trocou o client
    expect(controller.provider).toBeUndefined(); // meta intocada
    controller.dispose();
  });

  it('porta ausente (wiring degradado/teste) ⇒ ok:false explícito, nunca finge sucesso', async () => {
    const caller = tierControlCaller();
    const controller = new SessionController({
      model: caller,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: { async resolve() { return { kind: 'approve-once' as const }; } },
      meta: LOCAL_META,
      flush: { intervalMs: 0 },
      // switchLocalProvider AUSENTE de propósito.
    });

    const result = await controller.setLocalProvider('deepseek');

    expect(result.ok).toBe(false);
    expect(caller.setClientCalls).toEqual([]);
    controller.dispose();
  });

  it('backend ≠ local (broker): recusa ANTES de chamar a porta (nunca se aplica fora do BYO)', async () => {
    const caller = tierControlCaller();
    let portCalled = false;
    const controller = new SessionController({
      model: caller,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: { async resolve() { return { kind: 'approve-once' as const }; } },
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 }, // sem backend:'local'
      flush: { intervalMs: 0 },
      switchLocalProvider: async () => {
        portCalled = true;
        return { ok: true, detail: 'x', client: fakeClient('x'), defaultModel: 'x' };
      },
    });

    const result = await controller.setLocalProvider('deepseek');

    expect(result.ok).toBe(false);
    expect(portCalled).toBe(false);
    controller.dispose();
  });

  it('gap "o /model segue o provider trocado": um listNames() sobre o MESMO estado que o switch atualiza reflete o provider novo', async () => {
    // Espelha EXATAMENTE o padrão de `run.tsx`: `activeLocalProviderId` mutável, só
    // escrito DEPOIS do client montar com sucesso; `localModelCatalog.listNames()` lê
    // dali (nunca do provider fixo do boot).
    const MODELS_BY_PROVIDER: Record<string, readonly string[]> = {
      tokenrouter: ['gpt-4o', 'gpt-4o-mini'],
      deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    };
    let activeProviderId = 'tokenrouter';
    const listNames = (): readonly string[] | undefined => MODELS_BY_PROVIDER[activeProviderId];

    const caller = tierControlCaller();
    const controller = new SessionController({
      model: caller,
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: { async resolve() { return { kind: 'approve-once' as const }; } },
      meta: LOCAL_META,
      flush: { intervalMs: 0 },
      localModelCatalog: { listNames },
      switchLocalProvider: async (name: string) => {
        if (MODELS_BY_PROVIDER[name] === undefined) {
          return { ok: false, detail: `provider "${name}" desconhecido.` };
        }
        activeProviderId = name; // SÓ no sucesso — mesma disciplina do run.tsx real.
        return {
          ok: true,
          detail: `provider ativo agora: ${name}.`,
          client: fakeClient(name),
          defaultModel: MODELS_BY_PROVIDER[name]![0]!,
        };
      },
    });

    expect(listNames()).toEqual(['gpt-4o', 'gpt-4o-mini']); // ainda o provider do boot

    const result = await controller.setLocalProvider('deepseek');

    expect(result.ok).toBe(true);
    expect(listNames()).toEqual(['deepseek-chat', 'deepseek-reasoner']); // AGORA segue o novo
    controller.dispose();
  });
});

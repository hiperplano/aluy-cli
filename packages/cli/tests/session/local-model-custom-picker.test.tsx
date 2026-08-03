// F-MODEL-CUSTOM (ADR-0153) — achado em dogfooding: "/model não tá permitindo
// adicionar um modelo que não esteja na lista (custom)" sob backend local. O
// `<LocalModelPicker>` já aceitava texto-livre, mas aplicava DIRETO (warn-but-allow
// cego, sem testar o slug). Prova aqui o ROTEAMENTO na App: uma linha REALÇADA (slug
// JÁ no catálogo) confirma via `onSelectTier` direto (sem probe — já é conhecido);
// texto que NÃO casa nenhuma linha (slug desconhecido) confirma via
// `onConfirmCustomLocalModel` (test-then-register, fail-closed do lado de quem monta
// a porta — aqui só provamos QUE ela é chamada com o slug certo).

import React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import {
  PolicyPermissionEngine,
  type ModelCaller,
  type ModelCallResult,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
} from '@hiperplano/aluy-cli-core';
import { App } from '../../src/session/App.js';
import { SessionController } from '../../src/session/controller.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';

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

function inertCaller(): ModelCaller {
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
}

function mount(): {
  stdin: ReturnType<typeof render>['stdin'];
  controller: SessionController;
  selectTierCalls: Array<{ tier: string; model?: string }>;
  confirmCustomCalls: string[];
} {
  const controller = new SessionController({
    model: inertCaller(),
    permission: new PolicyPermissionEngine(),
    ports: fakePorts(),
    askResolver: new TuiAskResolver(),
    meta: {
      cwd: '/proj',
      tier: 'aluy-flux',
      tokens: 0,
      windowPct: 0,
      backend: 'local',
    },
    flush: { intervalMs: 0 },
  });
  const selectTierCalls: Array<{ tier: string; model?: string }> = [];
  const confirmCustomCalls: string[] = [];
  const { stdin } = render(
    <App
      controller={controller}
      animate={false}
      bootMs={0}
      catalog={undefined}
      localModelCatalog={{ listNames: () => ['deepseek-chat', 'deepseek-reasoner'] }}
      onSelectTier={(tier, model) => {
        selectTierCalls.push(model !== undefined ? { tier, model } : { tier });
      }}
      onConfirmCustomLocalModel={(slug) => {
        confirmCustomCalls.push(slug);
      }}
    />,
  );
  controller.dismissBoot();
  return { stdin, controller, selectTierCalls, confirmCustomCalls };
}

describe('F-MODEL-CUSTOM — LocalModelPicker roteia por conhecido×custom', () => {
  it('slug JÁ no catálogo (linha realçada): confirma via onSelectTier DIRETO, sem probe', async () => {
    const { stdin, controller, selectTierCalls, confirmCustomCalls } = mount();
    await flush();
    stdin.write('/model');
    await flush();
    stdin.write('\r'); // abre o LocalModelPicker
    await flush();
    stdin.write('deepseek-chat'); // filtra até casar exatamente o slug conhecido
    await flush();
    stdin.write('\r'); // confirma a linha realçada
    await flush();

    expect(selectTierCalls).toEqual([{ tier: 'custom', model: 'deepseek-chat' }]);
    expect(confirmCustomCalls).toEqual([]);
    controller.dispose();
  });

  it('slug FORA do catálogo (texto livre, nenhuma linha casa): confirma via onConfirmCustomLocalModel', async () => {
    const { stdin, controller, selectTierCalls, confirmCustomCalls } = mount();
    await flush();
    stdin.write('/model');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('meu-modelo-custom-xyz'); // não casa nenhum slug do catálogo dado
    await flush();
    stdin.write('\r');
    await flush();

    expect(confirmCustomCalls).toEqual(['meu-modelo-custom-xyz']);
    expect(selectTierCalls).toEqual([]); // NÃO aplicou direto — foi p/ o caminho testado
    controller.dispose();
  });

  it('sem onConfirmCustomLocalModel wireado: cai no comportamento de sempre (onSelectTier direto)', async () => {
    const controller = new SessionController({
      model: inertCaller(),
      permission: new PolicyPermissionEngine(),
      ports: fakePorts(),
      askResolver: new TuiAskResolver(),
      meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0, backend: 'local' },
      flush: { intervalMs: 0 },
    });
    const selectTierCalls: Array<{ tier: string; model?: string }> = [];
    const { stdin } = render(
      <App
        controller={controller}
        animate={false}
        bootMs={0}
        catalog={undefined}
        localModelCatalog={{ listNames: () => ['deepseek-chat'] }}
        onSelectTier={(tier, model) => {
          selectTierCalls.push(model !== undefined ? { tier, model } : { tier });
        }}
        // onConfirmCustomLocalModel AUSENTE de propósito.
      />,
    );
    controller.dismissBoot();
    await flush();
    stdin.write('/model');
    await flush();
    stdin.write('\r');
    await flush();
    stdin.write('modelo-fora-do-catalogo');
    await flush();
    stdin.write('\r');
    await flush();

    expect(selectTierCalls).toEqual([{ tier: 'custom', model: 'modelo-fora-do-catalogo' }]);
    controller.dispose();
  });
});

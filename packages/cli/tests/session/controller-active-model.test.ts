// EST-1015 (#24, pedido do dono) — o SessionController ESPELHA o modelo resolvido
// pelo broker (`usage.model`) em `meta.activeModel`, p/ a StatusBar mostrar
// `<tier> · <modelo>` mesmo FORA da via Custom. `usage.model` é nome PÚBLICO do
// catálogo (observabilidade pós-resposta, HG-2-safe), NÃO credencial/provider.
//
// Exercita o SEAM REAL: o `controller.sink.onUsage` — o MESMO callback que o
// StreamingModelCaller dispara ao fechar o stream (evento `usage` do broker).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  type ToolPorts,
  type FileSystemPort,
  type ShellPort,
  type SearchPort,
  type ModelUsage,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

const noFs: FileSystemPort = {
  async readFile() {
    return '';
  },
  async writeFile() {},
  async exists() {
    return false;
  },
};
const noShell: ShellPort = {
  async exec() {
    return { stdout: '', stderr: '', exitCode: 0 };
  },
};
const noSearch: SearchPort = {
  async grep() {
    return [];
  },
};

function makeController(): SessionController {
  const ports: ToolPorts = { fs: noFs, shell: noShell, search: noSearch };
  return new SessionController({
    model: {
      async call() {
        return { request_id: 'r', content: 'pronto.', finish_reason: 'stop' as const };
      },
    },
    permission: new PolicyPermissionEngine({}),
    ports,
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'aluy-flux', tokens: 0, windowPct: 0 },
    flush: { intervalMs: 0 },
  });
}

function usage(model: string | undefined): ModelUsage {
  return {
    request_id: 'r',
    tier: 'aluy-flux',
    tokens_in: 10,
    tokens_out: 10,
    ...(model !== undefined ? { model } : {}),
  };
}

describe('EST-1015 (#24) — meta.activeModel reflete o usage.model do broker', () => {
  it('captura o modelo resolvido do usage no tier canônico', () => {
    const controller = makeController();
    expect(controller.current.meta.activeModel).toBeUndefined(); // antes da 1ª resposta
    controller.sink.onUsage?.(usage('deepseek-v4-pro'));
    expect(controller.current.meta.activeModel).toBe('deepseek-v4-pro');
  });

  it('usage SEM model ⇒ activeModel permanece undefined (não inventa)', () => {
    const controller = makeController();
    controller.sink.onUsage?.(usage(undefined));
    expect(controller.current.meta.activeModel).toBeUndefined();
  });

  it('usage.model vazio/só-espaço ⇒ ignora (não escreve string vazia)', () => {
    const controller = makeController();
    controller.sink.onUsage?.(usage('   '));
    expect(controller.current.meta.activeModel).toBeUndefined();
  });

  it('PRESERVA o último modelo quando um turno seguinte não reporta model', () => {
    const controller = makeController();
    controller.sink.onUsage?.(usage('llama-3.1-70b'));
    expect(controller.current.meta.activeModel).toBe('llama-3.1-70b');
    controller.sink.onUsage?.(usage(undefined)); // 2º turno sem model
    expect(controller.current.meta.activeModel).toBe('llama-3.1-70b'); // preservado
  });

  it('um modelo NOVO sobrescreve o anterior (troca de tier/modelo)', () => {
    const controller = makeController();
    controller.sink.onUsage?.(usage('llama-3.1-70b'));
    controller.sink.onUsage?.(usage('deepseek-v4-pro'));
    expect(controller.current.meta.activeModel).toBe('deepseek-v4-pro');
  });
});

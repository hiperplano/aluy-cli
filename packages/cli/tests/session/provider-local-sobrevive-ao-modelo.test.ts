// O provider LOCAL não pode ser apagado do meta quando o modelo muda.
//
// Print do dono (09/09, rc.173), na ordem em que apareceu na tela dele:
//
//   ◕ provider  provider ativo agora: ollama · modelo llama3.2 …
//               escolha agora o modelo deste provider.
//   ◕ model     modelo Custom: qwen2.5-coder
//   ◕ sessão    local · openrouter · qwen2.5-coder     ← o provider do BOOT de volta
//
// Ele trocou para ollama, escolheu o modelo, e o rodapé voltou a dizer openrouter. A troca
// em si estava CERTA — o client já era o do ollama; quem mentia era o `meta`.
//
// A CAUSA: `setTier` reconstrói o meta apagando `provider` e o re-adiciona do
// `tierControl.provider` (a noção do caller de BROKER). Sob backend LOCAL o provider não
// pertence ao par tier+slug — é o provider ATIVO do BYO, trocado pelo `/provider`. O caller
// de broker não sabe dele e devolve `undefined`, então o campo sumia e a StatusBar caía no
// fallback `props.currentLocalProvider`, que é o provider do BOOT.
//
// O que torna isto impiedoso: o passo que dispara o apagamento é o passo que o PRÓPRIO
// `/provider` abre em seguida ("escolha agora o modelo deste provider"). Não dá para trocar
// de provider sem passar por ele.
//
// E é por isso que a minha reprodução em tmux não pegou: olhei o rodapé com o picker de
// modelo ainda ABERTO, quando ainda dizia `ollama`. Exercitei a metade que funciona.

import { describe, expect, it, vi } from 'vitest';
import {
  PolicyPermissionEngine,
  type FileSystemPort,
  type ModelCallResult,
  type SearchPort,
  type ShellPort,
  type ToolPorts,
} from '@hiperplano/aluy-cli-core';
import { SessionController } from '../../src/session/controller.js';

function fakePorts(): ToolPorts {
  const fs: FileSystemPort = {
    async readFile() {
      return 'x';
    },
    async writeFile() {},
    async exists() {
      return true;
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

/**
 * Caller que cumpre a superfície de `TierControl`. `provider` é o do BROKER: sob backend
 * local ele é sempre `undefined`, que é exatamente a condição que apagava o campo.
 */
function callerComTier() {
  const estado: { tier: string; model?: string; provider?: string } = { tier: 'custom' };
  return {
    async call(): Promise<ModelCallResult> {
      return { request_id: 'r', content: '', finish_reason: 'stop' };
    },
    get tier() {
      return estado.tier;
    },
    get model() {
      return estado.model;
    },
    get provider() {
      return estado.provider;
    },
    setTier(tier: string, model?: string) {
      estado.tier = tier;
      estado.model = model;
      // ESPELHA o `StreamingModelCaller` REAL (streaming-caller.ts): trocar de tier/slug
      // DESCARTA o provider corrente ("o slug novo não herda o provider do anterior").
      //
      // Este detalhe é o teste inteiro. A primeira versão do dublê não zerava aqui, e as
      // duas mutações do conserto SOBREVIVERAM: com o provider preservado pelo próprio
      // caller, dava no mesmo ler dele ou do meta. Dublê mais permissivo que o original
      // não prova nada — foi assim que o defeito chegou à máquina do dono.
      estado.provider = undefined;
    },
    setProvider(name: string | undefined) {
      // Idem: só cola sob `tier:'custom'` COM slug presente. Fora disso, no-op.
      estado.provider = estado.tier === 'custom' && estado.model !== undefined ? name : undefined;
    },
    setClient: vi.fn(),
  };
}

function controllerDe(backend: 'local' | 'broker') {
  const switchLocalProvider = vi.fn(async (name: string) => ({
    ok: true,
    detail: `provider ativo agora: ${name}`,
    client: {} as never,
    defaultModel: 'llama3.2',
  }));
  const controller = new SessionController({
    model: callerComTier() as never,
    permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
    ports: fakePorts(),
    askResolver: {
      async resolve() {
        return { kind: 'approve-once' as const };
      },
    },
    meta: { cwd: '/proj', tier: 'custom', tokens: 0, windowPct: 0, backend },
    switchLocalProvider: switchLocalProvider as never,
  });
  return { controller, switchLocalProvider };
}

describe('backend LOCAL — o provider sobrevive à escolha do modelo', () => {
  it('a sequência do print: /provider ollama → /model qwen ⇒ o meta segue em ollama', async () => {
    const { controller } = controllerDe('local');
    const r = await controller.setLocalProvider('ollama');
    expect(r.ok).toBe(true);
    expect(controller.provider, 'a troca em si sempre funcionou').toBe('ollama');

    // O passo que o próprio `/provider` abre em seguida — e que apagava o provider.
    controller.setTier('custom', 'qwen2.5-coder');

    expect(controller.provider, 'o rodapé dizia `openrouter` a partir daqui').toBe('ollama');
    expect(controller.model).toBe('qwen2.5-coder');
  });

  it('trocar SÓ o modelo (sem tocar no provider) também o preserva', async () => {
    const { controller } = controllerDe('local');
    await controller.setLocalProvider('ollama');
    controller.setTier('custom', 'gemma3:4b');
    controller.setTier('custom', 'deepseek-r1');
    expect(controller.provider).toBe('ollama');
  });

  it('sem provider local ainda escolhido, nada é inventado', async () => {
    const { controller } = controllerDe('local');
    controller.setTier('custom', 'qwen2.5-coder');
    expect(controller.provider).toBeUndefined();
  });
});

describe('BROKER — a regra antiga continua valendo (o provider PERTENCE ao par)', () => {
  it('trocar de tier/modelo DESCARTA o provider Custom do broker', () => {
    const { controller } = controllerDe('broker');
    controller.setTier('custom', 'x/y');
    controller.setProvider('deepseek');
    expect(controller.provider).toBe('deepseek');
    // No broker o caller LIMPA o provider ao trocar o par, e o meta tem de acompanhar —
    // senão fica um provider fantasma do slug anterior (EST-0962).
    controller.setTier('custom', 'outro/slug');
    expect(controller.provider).toBeUndefined();
  });

  it('o provider do CALLER continua sendo a fonte no broker (não o meta)', () => {
    const { controller } = controllerDe('broker');
    controller.setTier('custom', 'x/y');
    controller.setProvider('groq');
    expect(controller.provider, 'no broker a fonte é o CALLER, não o meta').toBe('groq');
  });
});

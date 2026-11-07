// ADR 0005 — USO de segredo: a catraca (`decide()`), o env do shell e a redação em stream.
//
// Cada `it` aqui deve FALHAR se a respectiva garantia for removida (mutações em
// docs/decisions/0005 §Verificação).

import { afterEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS, runCommandTool } from '../../src/agent/tools/native.js';
import type {
  ShellChunk,
  ShellExecOptions,
  ShellPort,
  ShellResult,
  ToolPorts,
} from '../../src/agent/tools/types.js';
import { PolicyPermissionEngine, decide, secretVault, SECRET_REDACTED } from '../../src/index.js';
import { MemoryFs, MemorySearch, ScriptedModelCaller, toolCallBlock } from './../agent/helpers.js';

const CANARY = 'ZIMBRO-canario-7f3a91c2e8';
const call = (command: string, key = 'command') => ({
  name: 'run_command',
  input: { [key]: command },
});

afterEach(() => secretVault.clear());

describe('decide() — comando do MODELO que cita um segredo é SEMPRE ask', () => {
  it('normal: ask / always-ask:secret-use; mostra o NOME, nunca o valor', () => {
    secretVault.set('API_KEY', CANARY);
    const v = decide(new PolicyPermissionEngine(), call('curl -H "k: $API_KEY" x'));
    expect(v.decision).toBe('ask');
    expect(v.category).toBe('always-ask:secret-use');
    expect(v.reason).toContain('$API_KEY');
    expect(JSON.stringify(v)).not.toContain(CANARY);
  });

  it('NÃO relaxa sob --yolo (mesma família do session_command destrutivo)', () => {
    secretVault.set('API_KEY', CANARY);
    const v = decide(new PolicyPermissionEngine({ mode: 'unsafe' }), call('echo $API_KEY'));
    expect(v.decision).toBe('ask');
    expect(v.category).toBe('always-ask:secret-use');
  });

  it('NÃO relaxa por regra allow da política nem pelo alias `cmd`', () => {
    secretVault.set('API_KEY', CANARY);
    const eng = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    });
    expect(decide(eng, call('echo $API_KEY')).decision).toBe('ask');
    expect(decide(eng, call('echo $API_KEY', 'cmd')).decision).toBe('ask');
    expect(
      decide(eng, { name: 'watch_command', input: { command: 'echo $API_KEY' } }).decision,
    ).toBe('ask');
  });

  it('sem o nome citado (ou sem segredo no cofre) o veredito é o de sempre', () => {
    const eng = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    });
    expect(decide(eng, call('echo $API_KEY')).decision).toBe('allow'); // cofre vazio
    secretVault.set('API_KEY', CANARY);
    expect(decide(eng, call('echo oi')).decision).toBe('allow'); // não cita
  });

  it('sub-agente: DENY (o valor não é repassado a filhos)', () => {
    secretVault.set('API_KEY', CANARY);
    const filho = new PolicyPermissionEngine().forSubAgent();
    const v = decide(filho, call('echo $API_KEY'));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:secret-use');
  });

  it('Plan continua negando (o piso mais restritivo vem antes)', () => {
    secretVault.set('API_KEY', CANARY);
    const v = decide(new PolicyPermissionEngine({ mode: 'plan' }), call('echo $API_KEY'));
    expect(v.decision).toBe('deny');
  });
});

/** Shell que registra o `env` recebido e emite chunks. */
class EnvShell implements ShellPort {
  readonly envs: (Readonly<Record<string, string>> | undefined)[] = [];
  constructor(
    private readonly chunks: readonly ShellChunk[] = [],
    private readonly result: ShellResult = { stdout: '', stderr: '', exitCode: 0 },
  ) {}
  async exec(_c: string, o?: ShellExecOptions): Promise<ShellResult> {
    this.envs.push(o?.env);
    for (const c of this.chunks) o?.onChunk?.(c);
    return this.result;
  }
}
const portsWith = (shell: ShellPort): ToolPorts => ({
  fs: new MemoryFs(),
  shell,
  search: new MemorySearch(),
});

describe('run_command — env dos segredos', () => {
  it("ctx.secretEnv='referenced' exporta SÓ o citado; 'all' exporta todos; ausente: nada", async () => {
    secretVault.set('A_KEY', 'aaaaaaaa-1');
    secretVault.set('B_KEY', 'bbbbbbbb-2');
    const sh = new EnvShell();
    const ports = portsWith(sh);
    await runCommandTool.run({ command: 'echo $A_KEY' }, ports, { secretEnv: 'referenced' });
    await runCommandTool.run({ command: 'echo $A_KEY' }, ports, { secretEnv: 'all' });
    await runCommandTool.run({ command: 'echo $A_KEY' }, ports, {});
    expect(sh.envs[0]).toEqual({ A_KEY: 'aaaaaaaa-1' });
    expect(Object.keys(sh.envs[1] ?? {}).sort()).toEqual(['A_KEY', 'B_KEY']);
    expect(sh.envs[2]).toBeUndefined();
  });

  it.each([1, 3, 4])(
    'valor PARTIDO entre chunks (%i) não vaza no stream nem na observação',
    async (size) => {
      secretVault.set('API_KEY', CANARY);
      const linha = `resp: ${CANARY} ok\n`;
      const chunks: ShellChunk[] = [];
      for (let i = 0; i < linha.length; i += size) {
        chunks.push({ stream: 'stdout', text: linha.slice(i, i + size) });
      }
      const sh = new EnvShell(chunks, { stdout: linha, stderr: '', exitCode: 0 });
      const vistos: string[] = [];
      const r = await runCommandTool.run({ command: 'echo $API_KEY' }, portsWith(sh), {
        secretEnv: 'referenced',
        onShellChunk: (c) => vistos.push(c.text),
      });
      expect(vistos.join('')).not.toContain(CANARY);
      expect(vistos.join('')).toBe(`resp: ${SECRET_REDACTED} ok\n`);
      expect(r.observation).not.toContain(CANARY);
      expect(r.shell?.stdout).not.toContain(CANARY);
    },
  );
});

describe('loop — só o loop PRINCIPAL exporta o segredo', () => {
  const run = async (injectSecretEnv: boolean | undefined): Promise<EnvShell> => {
    secretVault.set('API_KEY', CANARY);
    const sh = new EnvShell();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller([
        { text: toolCallBlock('run_command', { command: 'echo $API_KEY' }) },
        { text: 'pronto.' },
      ]),
      permission: { decide: () => ({ decision: 'allow', reason: 'teste' }) },
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports: portsWith(sh),
      ...(injectSecretEnv !== undefined ? { injectSecretEnv } : {}),
    });
    await loop.run('rode');
    return sh;
  };

  it('injectSecretEnv:true ⇒ o shell recebe o env', async () => {
    expect((await run(true)).envs[0]).toEqual({ API_KEY: CANARY });
  });

  it('padrão (sub-agentes, foco /subagent) ⇒ o shell NÃO recebe env nenhum', async () => {
    expect((await run(undefined)).envs[0]).toBeUndefined();
    expect((await run(false)).envs[0]).toBeUndefined();
  });

  it('o prompt do modelo traz só o NOME e nenhuma requisição contém o valor', async () => {
    secretVault.set('API_KEY', CANARY);
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('run_command', { command: 'echo $API_KEY' }) },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: { decide: () => ({ decision: 'allow', reason: 'teste' }) },
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports: portsWith(new EnvShell([], { stdout: `${CANARY}\n`, stderr: '', exitCode: 0 })),
      injectSecretEnv: true,
    });
    await loop.run('rode');
    expect(model.calls[0]!.systemContent).toContain('$API_KEY');
    const corpo = JSON.stringify(model.calls.map((c) => c.messages));
    expect(corpo).not.toContain(CANARY);
    expect(corpo).toContain(SECRET_REDACTED); // a saída do comando chegou redigida
  });
});

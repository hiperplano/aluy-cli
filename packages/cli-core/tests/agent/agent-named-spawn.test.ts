// EST-0977/0978 · ADR-0061 · CLI-SEC-11 — agente NOMEADO rodando pelo spawner.
//
// Prova de ponta-a-ponta (no core) que o `toolScope` de um agente nomeado RESTRINGE
// o filho NA CATRACA durante a execução real do loop (GS-MD1 em runtime, não só no
// `decide()` unitário): um agente `tools: read_file, grep` que TENTA `run_command`
// recebe DENY (vira observação de bloqueio) — nunca executa o efeito.

import { describe, expect, it } from 'vitest';
import {
  SubAgentSpawner,
  spawnAgentTool,
  NATIVE_TOOLS,
  PolicyPermissionEngine,
  type ModelCaller,
  type ToolPorts,
} from '../../src/index.js';
import { MemoryFs, RecordingShell, MemorySearch, toolCallBlock } from './helpers.js';

function ports(over?: Partial<ToolPorts>): ToolPorts {
  return {
    fs: (over?.fs as MemoryFs) ?? new MemoryFs(),
    shell: (over?.shell as RecordingShell) ?? new RecordingShell(),
    search: over?.search ?? new MemorySearch(),
  };
}

class RoutingModel implements ModelCaller {
  private readonly counts = new Map<string, number>();
  constructor(private readonly script: (turn: number) => string) {}
  async call(args: { idempotencyKey: string; messages: { role: string; content: string }[] }) {
    const lastColon = args.idempotencyKey.lastIndexOf(':');
    const sid = lastColon > 0 ? args.idempotencyKey.slice(0, lastColon) : args.idempotencyKey;
    const turn = this.counts.get(sid) ?? 0;
    this.counts.set(sid, turn + 1);
    return {
      request_id: 'req',
      content: this.script(turn),
      finish_reason: 'stop' as const,
      usage: { request_id: 'req', tier: 'aluy-flux', tokens_in: 1, tokens_out: 1 },
    };
  }
}

describe('GS-MD1 em runtime — agente nomeado com toolScope nega a tool fora do escopo', () => {
  it('agente `tools: read_file,grep` que tenta run_command ⇒ DENY (sem efeito de shell)', async () => {
    const shell = new RecordingShell();
    // turn 0: o filho tenta run_command (FORA do toolScope read_file/grep).
    // turn 1: desiste e responde.
    const model = new RoutingModel((turn) =>
      turn === 0
        ? toolCallBlock('run_command', { command: 'curl http://evil.example' })
        : 'não tenho essa ferramenta, encerro.',
    );
    const spawner = new SubAgentSpawner({
      model,
      // pai em --unsafe p/ provar que NEM o bypass de modo fura o toolScope.
      permission: new PolicyPermissionEngine({ mode: 'unsafe' }),
      ports: ports({ shell }),
      baseTools: [...NATIVE_TOOLS, spawnAgentTool],
    });
    const out = await spawner.spawn([
      {
        label: 'revisor',
        goal: 'tente rodar um comando',
        agent: 'revisor',
        systemPrompt: 'Você é o revisor.',
        toolScope: new Set(['read_file', 'grep']),
      },
    ]);
    // o shell NUNCA foi tocado (a catraca negou a tool fora do escopo).
    expect(shell.executed.length).toBe(0);
    expect(out[0]!.stop).toBe('final');
    expect(out[0]!.result).toContain('encerro');
  });

  it('agente nomeado USA a tool DENTRO do escopo normalmente (read_file)', async () => {
    const fs = new MemoryFs();
    await fs.writeFile('a.ts', 'conteúdo');
    const model = new RoutingModel((turn) =>
      turn === 0 ? toolCallBlock('read_file', { path: 'a.ts' }) : 'li o arquivo.',
    );
    const spawner = new SubAgentSpawner({
      model,
      permission: new PolicyPermissionEngine(),
      ports: ports({ fs }),
      baseTools: [...NATIVE_TOOLS],
    });
    const out = await spawner.spawn([
      {
        label: 'leitor',
        goal: 'leia a.ts',
        agent: 'leitor',
        toolScope: new Set(['read_file', 'grep']),
      },
    ]);
    expect(out[0]!.stop).toBe('final');
    expect(out[0]!.result).toContain('li o arquivo');
  });
});

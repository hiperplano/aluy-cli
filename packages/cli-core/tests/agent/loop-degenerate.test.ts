// EST-0969 (anti-runaway · guarda de LOOP DEGENERADO) — prova de INTEGRAÇÃO no
// AgentLoop: um stream degenerado (mesma linha/ciclo curto) ⇒ a guarda corta o
// turno mid-stream e o loop devolve `stop:'degenerate'` com a observação-DADO
// (CLI-SEC-4). Vale p/ o PAI e p/ os SUB-AGENTES (mesma classe AgentLoop). SEM
// modelo real: o `StreamingDegenerateCaller` roda a MESMA guarda de produção
// (`newDegenerationSink`) sobre um roteiro de deltas sintético.
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { newDegenerationSink, DegenerateLoopError } from '../../src/agent/degeneration.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ModelCaller } from '../../src/agent/loop.js';
import type { ModelCallResult } from '../../src/model/types.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { MemoryFs, RecordingShell, MemorySearch, allowAllEngine } from './helpers.js';

function ports(): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch() };
}
function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

/**
 * ModelCaller que ACUMULA um roteiro de DELTAS pela MESMA guarda dos acumuladores
 * de produção (BrokerModelClient.call / StreamingModelCaller.call): cada delta é
 * empurrado em `newDegenerationSink()`. Se a guarda dispara, o erro sobe (igual ao
 * stream real abortando); senão, devolve o conteúdo agregado. `env` injetável p/
 * exercitar a config/toggle. PROVA o caminho ponta-a-ponta sem rede/modelo real.
 */
class StreamingDegenerateCaller implements ModelCaller {
  calls = 0;
  constructor(
    private readonly deltasPerTurn: readonly (readonly string[])[],
    private readonly env?: Record<string, string | undefined>,
  ) {}
  async call(): Promise<ModelCallResult> {
    const deltas = this.deltasPerTurn[this.calls] ?? ['pronto.'];
    this.calls += 1;
    const guard = newDegenerationSink(this.env);
    let content = '';
    for (const d of deltas) {
      content += d;
      guard.push(d); // pode LANÇAR DegenerateLoopError (aborta o "stream").
    }
    return { request_id: 'req', content, finish_reason: 'stop' };
  }
}

/** Gera um roteiro de deltas que repete a mesma linha `n` vezes. */
function repeatedLineDeltas(line: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(`${line}\n`);
  return out;
}

describe('EST-0969 · AgentLoop converte o loop degenerado em stop:degenerate', () => {
  it('mesma linha 30× no stream ⇒ stop:degenerate + observação-DADO (CLI-SEC-4)', async () => {
    const model = new StreamingDegenerateCaller([repeatedLineDeltas('<<<EDIT_STDIN>/>/>', 30)]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 'sess-degen',
    });

    const res = await loop.run('faça algo');

    expect(res.stop.kind).toBe('degenerate');
    if (res.stop.kind !== 'degenerate') throw new Error('esperava degenerate');
    expect(res.stop.reason).toBe('line-repeat');
    // observação INEQUÍVOCA, anti-runaway, NÃO-erro-técnico (p/ o modelo não re-tentar).
    expect(res.stop.message).toContain('LOOP DE REPETIÇÃO');
    expect(res.stop.message).toContain('anti-runaway');
    expect(res.stop.message).toContain('NÃO é um erro técnico');
    // o desfecho entrou no histórico como observação (auditoria/resume).
    const last = res.history[res.history.length - 1]!;
    expect(last.role).toBe('observation');
    expect((last as { toolName?: string }).toolName).toBe('anti-runaway');
    // NÃO ficou cuspindo: só UMA chamada de modelo (o turno foi cortado).
    expect(model.calls).toBe(1);
  });

  it('ciclo curto colado (sem \\n) longo ⇒ stop:degenerate (short-cycle)', async () => {
    const model = new StreamingDegenerateCaller([
      Array.from({ length: 400 }, () => '<<<EDIT_STDIN>/>/>'),
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    const res = await loop.run('faça algo');
    expect(res.stop.kind).toBe('degenerate');
    if (res.stop.kind !== 'degenerate') throw new Error('esperava degenerate');
    expect(res.stop.reason).toBe('short-cycle');
  });

  it('stream NORMAL e variado ⇒ NUNCA dispara (caminho feliz intacto)', async () => {
    const model = new StreamingDegenerateCaller([
      ['Analisei o projeto', ' e vou resumir:\n', '- ponto um\n', '- ponto dois\n', 'fim.'],
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    const res = await loop.run('resuma');
    expect(res.stop.kind).toBe('final');
    if (res.stop.kind !== 'final') throw new Error('esperava final');
    expect(res.stop.answer).toContain('fim.');
  });

  it('código com repetição LEGÍTIMA baixa no stream ⇒ NÃO dispara', async () => {
    const code = [
      'const a = { x: 1 };\n',
      'const b = { y: 2 };\n',
      '},\n',
      '},\n',
      '},\n',
      'return a;\n',
    ];
    const model = new StreamingDegenerateCaller([code]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    const res = await loop.run('escreva código');
    expect(res.stop.kind).toBe('final');
  });

  it('ALUY_DEGENERATE_OFF ⇒ a guarda não dispara nem no degenerado (escape hatch)', async () => {
    const model = new StreamingDegenerateCaller([repeatedLineDeltas('mesma linha', 30)], {
      ALUY_DEGENERATE_OFF: '1',
    });
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    const res = await loop.run('faça');
    // sem a guarda, o turno fecha normal (vira o "final" do parser do texto agregado).
    expect(res.stop.kind).not.toBe('degenerate');
  });

  it('limiar configurável (ALUY_DEGENERATE_LINE_REPEATS=5) dispara mais cedo no loop', async () => {
    const model = new StreamingDegenerateCaller([repeatedLineDeltas('repete isso', 6)], {
      ALUY_DEGENERATE_LINE_REPEATS: '5',
    });
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    const res = await loop.run('faça');
    expect(res.stop.kind).toBe('degenerate');
  });

  it('erro NÃO-degenerado do model.call propaga (não é mascarado como degenerate)', async () => {
    const boom = new Error('falha de transporte qualquer');
    const model: ModelCaller = {
      async call() {
        throw boom;
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    await expect(loop.run('faça')).rejects.toBe(boom);
  });
});

describe('EST-0969 · a guarda vale p/ SUB-AGENTES (mesma classe AgentLoop)', () => {
  it('um filho (AgentLoop com budget compartilhado) também para em stop:degenerate', async () => {
    // Um sub-agente É um AgentLoop — então a guarda no model.call() o cobre por
    // construção. Simulamos a forma de execução do filho (resume/run num loop
    // próprio) e provamos o MESMO desfecho.
    const model = new StreamingDegenerateCaller([repeatedLineDeltas('loop do filho', 30)]);
    const child = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 'child-sess',
    });
    const res = await child.run('objetivo do filho');
    expect(res.stop.kind).toBe('degenerate');
    if (res.stop.kind !== 'degenerate') throw new Error('esperava degenerate');
    expect(res.stop.reason).toBe('line-repeat');
  });
});

describe('EST-0969 · DegenerateLoopError lançado direto pelo caller', () => {
  it('o loop captura o erro vindo do model.call e o converte (não vaza a exceção)', async () => {
    const model: ModelCaller = {
      async call() {
        throw new DegenerateLoopError('line-repeat', 42, 'amostra');
      },
    };
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
    });
    const res = await loop.run('faça');
    expect(res.stop.kind).toBe('degenerate');
    if (res.stop.kind !== 'degenerate') throw new Error('esperava degenerate');
    expect(res.stop.message).toContain('42');
  });
});

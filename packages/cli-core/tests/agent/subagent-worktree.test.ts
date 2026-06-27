// EST-1098 · ADR-0109 (WT-1) — ISOLAMENTO por worktree de sub-agentes.
//
// A bateria prova o SEAM (sem git real — fake `WorktreePort`):
//   WT-1.a  resolveChildWorktree (resolvedor PURO): pediu+port ⇒ checkout; pediu-sem-
//           -port ⇒ inerte; NÃO-pediu ⇒ inerte (nem chama checkout).
//   WT-1.b  filho isolado roda com as ports do WORKTREE (efeito de I/O cai no shell/fs
//           do worktree, NÃO no do pai) — prova de roteamento.
//   WT-1.c  `dispose()` é chamado em TODO caminho de saída (sucesso) — sem worktree órfão.
//   WT-1.d  filho SEM `isolation` usa as ports do pai e o port NUNCA é consultado
//           (não-regressão).
//   WT-1.e  falha de `checkout` vira desfecho de ERRO daquele filho — NÃO derruba o irmão.

import { describe, expect, it, vi } from 'vitest';
import {
  SubAgentSpawner,
  resolveChildWorktree,
  spawnAgentTool,
  NATIVE_TOOLS,
  type ModelCaller,
  type WorktreePort,
  type WorktreeHandle,
  type SubAgentOutcome,
  type ToolPorts,
  type PermissionEngine,
  type PermissionVerdict,
  type ToolCall,
} from '../../src/index.js';
import { MemoryFs, RecordingShell, MemorySearch, toolCallBlock } from './helpers.js';

function ports(over?: Partial<ToolPorts>): ToolPorts {
  return {
    fs: (over?.fs as MemoryFs) ?? new MemoryFs(),
    shell: (over?.shell as RecordingShell) ?? new RecordingShell(),
    search: over?.search ?? new MemorySearch(),
  };
}

/** Engine que LIBERA tudo (o foco aqui é roteamento de ports, não a catraca). */
const allowAll: PermissionEngine = {
  decide: (c: ToolCall): PermissionVerdict => ({ decision: 'allow', reason: c.name }),
};

/** ModelCaller de roteiro mínimo: turn 0 → tool-call; turn 1 → texto final. */
class ScriptModel implements ModelCaller {
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

/**
 * Fake `WorktreePort` SEM git: cada checkout devolve ports PRÓPRIAS (shell/fs isolados,
 * rastreáveis) e registra os labels de checkout/dispose. `makePorts` permite ao teste
 * inspecionar O QUE o filho rodou no worktree.
 */
class FakeWorktreePort implements WorktreePort {
  readonly checkouts: string[] = [];
  readonly disposed: string[] = [];
  readonly portsByLabel = new Map<string, { shell: RecordingShell; fs: MemoryFs }>();
  constructor(private readonly onCheckout?: (label: string) => void) {}
  async checkout(label: string): Promise<WorktreeHandle> {
    this.onCheckout?.(label); // pode lançar (teste de falha)
    this.checkouts.push(label);
    const shell = new RecordingShell();
    const fs = new MemoryFs();
    this.portsByLabel.set(label, { shell, fs });
    const disposed = this.disposed; // captura o array (evita aliasing de `this`)
    return {
      dir: `/wt/${label}`,
      branch: `aluy/wt/${label}`,
      ports: { fs, shell, search: new MemorySearch() },
      dispose: async (): Promise<void> => {
        disposed.push(label);
      },
    };
  }
}

// ════════════════════════════════════════════════════════════════════════════
// WT-1.a — resolveChildWorktree (resolvedor PURO)
// ════════════════════════════════════════════════════════════════════════════
describe('EST-1098 · WT-1.a — resolveChildWorktree (regra do QUANDO)', () => {
  it('isolation=worktree + port ⇒ chama checkout e devolve o handle', async () => {
    const wt = new FakeWorktreePort();
    const h = await resolveChildWorktree({ label: 'f1', isolation: 'worktree' }, wt);
    expect(h).toBeDefined();
    expect(wt.checkouts).toEqual(['f1']);
    expect(h!.dir).toBe('/wt/f1');
  });

  it('isolation=worktree SEM port ⇒ inerte (undefined, nada a alocar)', async () => {
    const h = await resolveChildWorktree({ label: 'f1', isolation: 'worktree' }, undefined);
    expect(h).toBeUndefined();
  });

  it('SEM isolation ⇒ inerte e NEM consulta o port (não-regressão)', async () => {
    const wt = new FakeWorktreePort();
    const h = await resolveChildWorktree({ label: 'f1' }, wt);
    expect(h).toBeUndefined();
    expect(wt.checkouts).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WT-1.b/c — filho ISOLADO roda nas ports do worktree + dispose ao fim
// ════════════════════════════════════════════════════════════════════════════
describe('EST-1098 · WT-1.b/c — filho isolado roteia I/O ao worktree + dispose', () => {
  it('o run_command do filho isolado cai no shell do WORKTREE (não no do pai)', async () => {
    const parentShell = new RecordingShell();
    const wt = new FakeWorktreePort();
    // turn 0: roda um comando; turn 1: encerra.
    const model = new ScriptModel((turn) =>
      turn === 0 ? toolCallBlock('run_command', { command: 'echo isolado' }) : 'pronto.',
    );
    const spawner = new SubAgentSpawner({
      model,
      permission: allowAll,
      ports: ports({ shell: parentShell }),
      baseTools: [...NATIVE_TOOLS, spawnAgentTool],
      worktree: wt,
    });

    const out = await spawner.spawn([
      { label: 'iso', goal: 'rode o comando', isolation: 'worktree' },
    ]);

    expect(out[0]!.stop).toBe('final');
    // o comando caiu no shell do WORKTREE…
    expect(wt.portsByLabel.get('iso')!.shell.executed).toContain('echo isolado');
    // …e NÃO no shell do pai (isolamento real).
    expect(parentShell.executed).not.toContain('echo isolado');
    // checkout e dispose aconteceram exatamente uma vez para este filho.
    expect(wt.checkouts).toEqual(['iso']);
    expect(wt.disposed).toEqual(['iso']);
  });

  it('dispose roda MESMO quando o filho não usa tool (caminho de saída limpo)', async () => {
    const wt = new FakeWorktreePort();
    const model = new ScriptModel(() => 'nada a fazer.');
    const spawner = new SubAgentSpawner({
      model,
      permission: allowAll,
      ports: ports(),
      baseTools: [...NATIVE_TOOLS],
      worktree: wt,
    });
    await spawner.spawn([{ label: 'q', goal: 'só responda', isolation: 'worktree' }]);
    expect(wt.disposed).toEqual(['q']);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WT-1.d — não-regressão: sem isolation, port NUNCA é consultado
// ════════════════════════════════════════════════════════════════════════════
describe('EST-1098 · WT-1.d — sem isolation usa as ports do pai (não-regressão)', () => {
  it('filho sem isolation roda no shell do PAI e o WorktreePort fica intocado', async () => {
    const parentShell = new RecordingShell();
    const wt = new FakeWorktreePort();
    const model = new ScriptModel((turn) =>
      turn === 0 ? toolCallBlock('run_command', { command: 'echo pai' }) : 'pronto.',
    );
    const spawner = new SubAgentSpawner({
      model,
      permission: allowAll,
      ports: ports({ shell: parentShell }),
      baseTools: [...NATIVE_TOOLS, spawnAgentTool],
      worktree: wt, // injetado, mas o filho NÃO pede isolamento
    });

    const out = await spawner.spawn([{ label: 'normal', goal: 'rode' }]);

    expect(out[0]!.stop).toBe('final');
    expect(parentShell.executed).toContain('echo pai');
    expect(wt.checkouts).toEqual([]); // nunca tocou o worktree
    expect(wt.disposed).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// WT-1.e — falha de checkout vira erro DAQUELE filho, não derruba o irmão
// ════════════════════════════════════════════════════════════════════════════
describe('EST-1098 · WT-1.e — falha de checkout é isolada por filho', () => {
  it('checkout que lança ⇒ desfecho stop:error do filho; o irmão segue normal', async () => {
    // O port lança SÓ para o label "ruim"; "bom" aloca normal.
    const wt = new FakeWorktreePort((label) => {
      if (label === 'ruim') throw new Error('cwd não é um repositório git');
    });
    const model = new ScriptModel(() => 'pronto.');
    const spawner = new SubAgentSpawner({
      model,
      permission: allowAll,
      ports: ports(),
      baseTools: [...NATIVE_TOOLS],
      worktree: wt,
    });

    const out = await spawner.spawn([
      { label: 'ruim', goal: 'x', isolation: 'worktree' },
      { label: 'bom', goal: 'y', isolation: 'worktree' },
    ]);

    const ruim = out.find((o: SubAgentOutcome) => o.label === 'ruim')!;
    const bom = out.find((o: SubAgentOutcome) => o.label === 'bom')!;
    expect(ruim.stop).toBe('error');
    expect(ruim.result).toMatch(/isolar em worktree|repositório git/i);
    // o filho que falhou ao alocar NÃO deixou worktree para dispor (nada alocado).
    expect(wt.disposed).not.toContain('ruim');
    // o irmão rodou e foi disposto normalmente.
    expect(bom.stop).toBe('final');
    expect(wt.disposed).toContain('bom');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// não-regressão grossa: nenhum efeito quando NINGUÉM injeta worktree
// ════════════════════════════════════════════════════════════════════════════
describe('EST-1098 · WT-1 — OFF por default (sem port injetado)', () => {
  it('isolation pedido mas SEM port no spawner ⇒ roda no pai, sem erro', async () => {
    const parentShell = new RecordingShell();
    const model = new ScriptModel((turn) =>
      turn === 0 ? toolCallBlock('run_command', { command: 'echo x' }) : 'ok.',
    );
    const checkoutSpy = vi.fn();
    const spawner = new SubAgentSpawner({
      model,
      permission: allowAll,
      ports: ports({ shell: parentShell }),
      baseTools: [...NATIVE_TOOLS, spawnAgentTool],
      // sem `worktree`
    });
    const out = await spawner.spawn([{ label: 'iso', goal: 'rode', isolation: 'worktree' }]);
    expect(out[0]!.stop).toBe('final');
    expect(parentShell.executed).toContain('echo x'); // caiu no pai (degrada limpo)
    expect(checkoutSpy).not.toHaveBeenCalled();
  });
});

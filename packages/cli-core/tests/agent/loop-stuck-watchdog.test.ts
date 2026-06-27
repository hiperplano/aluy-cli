// EST-0969 (watchdog de TRAVAMENTO · pausa-pede-direção) — prova de INTEGRAÇÃO no
// AgentLoop: quando o agente gira sem avançar (mesma tool / mesmo erro / turnos
// vazios), o loop PAUSA e PEDE DIREÇÃO via o `StuckResolver` — NÃO mata. As 3
// opções acionáveis ([r] redirecionar / [c] continuar / [n] encerrar) e o
// anti-falso-positivo (progresso reseta; tools diferentes não disparam). SEM modelo
// real: `ScriptedModelCaller` roteiriza os turnos; um `FakeStuckResolver` decide.
import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import type { StuckAlert, StuckResolution, StuckResolver } from '../../src/agent/stuck-watchdog.js';
import {
  MemoryFs,
  RecordingShell,
  MemorySearch,
  ScriptedModelCaller,
  allowAllEngine,
  toolCallBlock,
  type ScriptItem,
} from './helpers.js';

function ports(): ToolPorts {
  return { fs: new MemoryFs(), shell: new RecordingShell(), search: new MemorySearch() };
}
function registry(): ToolRegistry<ToolPorts> {
  return new ToolRegistry(NATIVE_TOOLS);
}

/**
 * Resolvedor de pausa FAKE: registra cada alerta recebido e responde com um
 * ROTEIRO de resoluções (uma por disparo). Esgotado ⇒ default `continue` (não
 * trava o teste). Espelha o `AskResolver` (async, recebe `signal`).
 */
class FakeStuckResolver implements StuckResolver {
  readonly alerts: StuckAlert[] = [];
  private idx = 0;
  constructor(private readonly script: readonly StuckResolution[] = []) {}
  async resolve(alert: StuckAlert): Promise<StuckResolution> {
    this.alerts.push(alert);
    const r = this.script[this.idx];
    this.idx += 1;
    return r ?? { kind: 'continue' };
  }
}

/** N turnos que repetem a MESMA tool-call (texto). */
function repeatToolCall(name: string, input: Record<string, unknown>, n: number): ScriptItem[] {
  const out: ScriptItem[] = [];
  for (let i = 0; i < n; i++) out.push({ text: toolCallBlock(name, input) });
  return out;
}

describe('EST-0969 · AgentLoop watchdog — PAUSA e PEDE DIREÇÃO (não mata)', () => {
  it('mesma tool-call 4× ⇒ dispara o watchdog (pausa+ask, NÃO mata)', async () => {
    // 4 turnos com a MESMA tool-call, depois um final (se o loop continuar).
    const script: ScriptItem[] = [
      ...repeatToolCall('run_command', { command: 'ls' }, 4),
      { text: 'pronto.' },
    ];
    const resolver = new FakeStuckResolver([{ kind: 'continue' }]);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: {}, // defaults (limiar 4)
    });
    const res = await loop.run('faça');
    // O watchdog DISPAROU (pausa+ask) — e NÃO matou: o turno seguiu até o final.
    expect(resolver.alerts.length).toBeGreaterThanOrEqual(1);
    expect(resolver.alerts[0]!.kind).toBe('same-tool-call');
    expect(resolver.alerts[0]!.sample).toBe('run_command');
    expect(res.stop.kind).toBe('final'); // continuou (não é stop:degenerate nem limit)
  });

  it('mesmo ERRO de tool 4× (read_file inexistente) ⇒ dispara o watchdog', async () => {
    const script: ScriptItem[] = [
      ...repeatToolCall('read_file', { path: 'nao-existe.ts' }, 4),
      { text: 'pronto.' },
    ];
    const resolver = new FakeStuckResolver([{ kind: 'continue' }]);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: { ALUY_STUCK_SAME_TOOL: '999' }, // desarma a série de CALL p/ isolar a de ERRO
    });
    await loop.run('faça');
    expect(resolver.alerts.length).toBeGreaterThanOrEqual(1);
    // pode ser same-tool-error (default 3) — o erro é estável.
    expect(resolver.alerts.some((a) => a.kind === 'same-tool-error')).toBe(true);
  });

  it('turnos vazios consecutivos ⇒ dispara o watchdog', async () => {
    // turnos VAZIOS (sem texto nem tool): cada um é um `final` vazio. O watchdog
    // pausa ANTES de "morrer" silenciosamente; [c] continua ⇒ o próximo turno vazio
    // re-arma; ao fim damos um turno com conteúdo p/ encerrar limpo.
    const script: ScriptItem[] = [
      { text: '' },
      { text: '' },
      { text: '' },
      { text: 'pronto agora.' },
    ];
    const resolver = new FakeStuckResolver([{ kind: 'continue' }, { kind: 'continue' }]);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: {},
    });
    const res = await loop.run('faça');
    expect(resolver.alerts.some((a) => a.kind === 'empty-turns')).toBe(true);
    expect(res.stop.kind).toBe('final');
  });

  it('progresso novo NO MEIO ⇒ RESETA (não dispara) — tools diferentes avançando', async () => {
    // 6 tools DIFERENTES, todas com sucesso (read_file de arquivos que existem).
    const fs = new MemoryFs(
      new Map([
        ['a.ts', 'A'],
        ['b.ts', 'B'],
        ['c.ts', 'C'],
        ['d.ts', 'D'],
        ['e.ts', 'E'],
        ['f.ts', 'F'],
      ]),
    );
    const script: ScriptItem[] = [
      { text: toolCallBlock('read_file', { path: 'a.ts' }) },
      { text: toolCallBlock('read_file', { path: 'b.ts' }) },
      { text: toolCallBlock('read_file', { path: 'c.ts' }) },
      { text: toolCallBlock('read_file', { path: 'd.ts' }) },
      { text: toolCallBlock('read_file', { path: 'e.ts' }) },
      { text: toolCallBlock('read_file', { path: 'f.ts' }) },
      { text: 'pronto.' },
    ];
    const resolver = new FakeStuckResolver();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: { fs, shell: new RecordingShell(), search: new MemorySearch() },
      sessionId: 's',
      stuckResolver: resolver,
      env: {},
    });
    const res = await loop.run('faça');
    expect(resolver.alerts.length).toBe(0); // NUNCA pausou — tarefa legítima
    expect(res.stop.kind).toBe('final');
  });

  it('[r] redirecionar ⇒ injeta a direção como instrução (user_inject) no histórico', async () => {
    const script: ScriptItem[] = [
      ...repeatToolCall('run_command', { command: 'ls' }, 4),
      { text: 'segui a nova direção.' },
    ];
    const resolver = new FakeStuckResolver([{ kind: 'redirect', text: 'pare e leia o README' }]);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: {},
    });
    const res = await loop.run('faça');
    expect(resolver.alerts.length).toBeGreaterThanOrEqual(1);
    // a direção entrou como user_inject (canal do dono, NÃO system).
    const injected = res.history.filter((h) => h.role === 'user_inject');
    expect(injected.length).toBe(1);
    expect((injected[0] as { text: string }).text).toBe('pare e leia o README');
    expect(res.stop.kind).toBe('final');
  });

  it('[n] encerrar ⇒ ENCERRA o turno (final limpo + nota de auditoria)', async () => {
    const script: ScriptItem[] = repeatToolCall('run_command', { command: 'ls' }, 6);
    const resolver = new FakeStuckResolver([{ kind: 'end' }]);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: {},
    });
    const res = await loop.run('faça');
    expect(res.stop.kind).toBe('final');
    // a nota de encerramento entrou no histórico (auditoria/resume).
    const last = res.history[res.history.length - 1]!;
    expect(last.role).toBe('observation');
    expect((last as { toolName?: string }).toolName).toBe('watchdog');
  });

  it('[c] continuar ⇒ SEGUE e RESETA o detector (não re-dispara logo)', async () => {
    // 4 calls disparam; [c] reseta; mais 3 calls iguais NÃO re-disparam (limiar 4
    // recomeça do zero). O 8º turno é final.
    const script: ScriptItem[] = [
      ...repeatToolCall('run_command', { command: 'ls' }, 7),
      { text: 'pronto.' },
    ];
    const resolver = new FakeStuckResolver([{ kind: 'continue' }]);
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: {},
    });
    await loop.run('faça');
    // disparou UMA vez (na 4ª); após o reset, as 3 calls seguintes não cruzam o
    // limiar de novo (4) ⇒ exatamente 1 pausa.
    expect(resolver.alerts.length).toBe(1);
  });

  it('SEM stuckResolver ⇒ watchdog INERTE (baseline: nunca pausa)', async () => {
    const script: ScriptItem[] = [
      ...repeatToolCall('run_command', { command: 'ls' }, 10),
      { text: 'pronto.' },
    ];
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      // sem stuckResolver
    });
    const res = await loop.run('faça');
    expect(res.stop.kind).toBe('final'); // rodou idêntico ao baseline
  });

  it('ALUY_STUCK_OFF desliga o watchdog mesmo com resolver presente', async () => {
    const script: ScriptItem[] = [
      ...repeatToolCall('run_command', { command: 'ls' }, 6),
      { text: 'pronto.' },
    ];
    const resolver = new FakeStuckResolver();
    const loop = new AgentLoop({
      model: new ScriptedModelCaller(script),
      permission: allowAllEngine,
      tools: registry(),
      ports: ports(),
      sessionId: 's',
      stuckResolver: resolver,
      env: { ALUY_STUCK_OFF: '1' },
    });
    await loop.run('faça');
    expect(resolver.alerts.length).toBe(0); // desligado
  });
});

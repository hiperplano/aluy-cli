// EST-0980 · CLI-SEC-3/H1 — PARIDADE Claude Code: hooks de SETTINGS + GATE de pre-tool.
//
// Cobre (a) o parser do formato `settings.json` do Claude → modelo de hooks do Aluy
// (sem segundo motor); (b) os novos eventos OBSERVE-ONLY; (c) o GATE de pre-tool —
// `runGate` que VETA monotonicamente (só REFORÇA a catraca, NUNCA aprova/relaxa).

import { describe, expect, it } from 'vitest';
import {
  HookRunner,
  PolicyPermissionEngine,
  parseClaudeHooksSettings,
  mergeHooksConfigs,
  parseHooksConfig,
  selectGateHooks,
  selectHooks,
} from '../../src/index.js';
import type { Hook } from '../../src/index.js';
import { makePorts, RecordingShell } from './helpers.js';

describe('EST-0980 · parseClaudeHooksSettings — settings.json do Claude → hooks do Aluy', () => {
  it('mapeia PreToolUse/PostToolUse/SessionStart/Stop/UserPromptSubmit/SubagentStop/Notification', () => {
    const cfg = parseClaudeHooksSettings({
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: 'echo start' }] }],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt' }] }],
        PreToolUse: [{ matcher: 'edit_file', hooks: [{ type: 'command', command: 'guard.sh' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo post' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo stop' }] }],
        SubagentStop: [{ hooks: [{ type: 'command', command: 'echo sub' }] }],
        Notification: [{ hooks: [{ type: 'command', command: 'echo notify' }] }],
      },
    });
    expect(cfg.hooks.map((h) => h.event)).toEqual([
      'session-start',
      'user-prompt-submit',
      'pre-tool',
      'post-tool',
      'turn-end',
      'subagent-stop',
      'notification',
    ]);
    // O matcher do GRUPO propaga p/ o comando.
    const pre = cfg.hooks.find((h) => h.event === 'pre-tool')!;
    expect(pre.matcher).toBe('edit_file');
    expect(pre.command).toBe('guard.sh');
  });

  it('PreToolUse do Claude vira hook com gate:true (bloqueia via exit≠0)', () => {
    const cfg = parseClaudeHooksSettings({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'deny.sh' }] }] },
    });
    expect(cfg.hooks[0]!.gate).toBe(true);
    expect(selectGateHooks(cfg).length).toBe(1);
  });

  it('fail-closed: evento desconhecido / type≠command / command vazio são DESCARTADOS', () => {
    const cfg = parseClaudeHooksSettings({
      hooks: {
        BogusEvent: [{ hooks: [{ type: 'command', command: 'x' }] }],
        PreToolUse: [
          { hooks: [{ type: 'prompt', command: 'nope' }] }, // type≠command
          { hooks: [{ type: 'command', command: '   ' }] }, // vazio
          { hooks: [{ type: 'command', command: 'ok.sh' }] }, // único válido
        ],
      },
    });
    expect(cfg.hooks).toHaveLength(1);
    expect(cfg.hooks[0]!.command).toBe('ok.sh');
  });

  it('não-objeto / sem hooks ⇒ config vazia (nunca lança)', () => {
    expect(parseClaudeHooksSettings(null).hooks).toEqual([]);
    expect(parseClaudeHooksSettings('x').hooks).toEqual([]);
    expect(parseClaudeHooksSettings({}).hooks).toEqual([]);
    expect(parseClaudeHooksSettings({ hooks: [] }).hooks).toEqual([]);
  });

  it('gate:true no formato NATIVO só vale em pre-tool (descartado nos demais)', () => {
    const cfg = parseHooksConfig({
      hooks: [
        { event: 'pre-tool', command: 'g.sh', gate: true },
        { event: 'turn-end', command: 't.sh', gate: true }, // gate sem sentido ⇒ descartado
      ],
    });
    expect(cfg.hooks[0]!.gate).toBe(true);
    expect(cfg.hooks[1]!.gate).toBeUndefined();
    expect(selectGateHooks(cfg, undefined).length).toBe(1);
  });

  it('mergeHooksConfigs funde em ordem (nativo + settings ambos valem)', () => {
    const native = parseHooksConfig({ hooks: [{ event: 'session-start', command: 'a' }] });
    const claude = parseClaudeHooksSettings({
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'b' }] }] },
    });
    const merged = mergeHooksConfigs(native, claude);
    expect(merged.hooks.map((h) => h.command)).toEqual(['a', 'b']);
  });
});

describe('EST-0980 · selectHooks reconhece os novos eventos OBSERVE-ONLY', () => {
  const cfg = parseHooksConfig({
    hooks: [
      { event: 'user-prompt-submit', command: 'u' },
      { event: 'subagent-stop', command: 's' },
      { event: 'notification', command: 'n' },
    ],
  });
  it.each([['user-prompt-submit'], ['subagent-stop'], ['notification']] as const)(
    'seleciona %s',
    (event) => {
      expect(selectHooks(cfg, event)).toHaveLength(1);
    },
  );
});

const gateHook = (command: string): Hook => ({ event: 'pre-tool', command, gate: true });

describe('EST-0980 · runGate — VETO monotônico (só REFORÇA a catraca, nunca aprova)', () => {
  // Política que LIBERA run_command (allow) p/ o hook RODAR — assim o veto vem do
  // exit-code do hook, não da catraca (provando que o gate é poder EXTRA, não da catraca).
  function allowRunCommand(): PolicyPermissionEngine {
    return new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    });
  }

  it('hook que RODA e sai com exit≠0 ⇒ VETA (blocked) e devolve o comando + observação', async () => {
    const shell = new RecordingShell(() => ({ stdout: '', stderr: 'recuso', exitCode: 2 }));
    const { ports } = makePorts({ shell });
    const runner = new HookRunner({ permission: allowRunCommand(), ports });
    const verdict = await runner.runGate([gateHook('guard.sh')]);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.command).toBe('guard.sh');
    expect(verdict.observation.role).toBe('observation');
  });

  it('hook que RODA e sai com exit 0 ⇒ NÃO veta (segue o que a catraca disse)', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const runner = new HookRunner({ permission: allowRunCommand(), ports });
    const verdict = await runner.runGate([gateHook('check.sh')]);
    expect(verdict.blocked).toBe(false);
  });

  it('nenhum hook ⇒ NÃO veta (no-op)', async () => {
    const { ports } = makePorts({ shell: new RecordingShell() });
    const runner = new HookRunner({ permission: allowRunCommand(), ports });
    expect((await runner.runGate([])).blocked).toBe(false);
  });

  it('FAIL-SAFE ≠ FAIL-OPEN: hook BLOQUEADO pela catraca (não rodou) NÃO veta a tool', async () => {
    // Em Plan, o comando do hook é DENY (run_command é efeito) ⇒ o hook NÃO rodou ⇒
    // não tem o que vetar. A tool subjacente já passou pela `decide()`; o gate é EXTRA.
    const shell = new RecordingShell();
    const { ports } = makePorts({ shell });
    const plan = new PolicyPermissionEngine({ mode: 'plan' });
    const runner = new HookRunner({ permission: plan, ports });
    const verdict = await runner.runGate([gateHook('guard.sh')]);
    expect(verdict.blocked).toBe(false); // hook não rodou ⇒ sem veto.
    expect(shell.executed).toEqual([]); // e não tocou o shell (catraca negou).
  });

  it('1º veto BASTA: curto-circuita (não roda os hooks seguintes)', async () => {
    const shell = new RecordingShell(() => ({ stdout: '', stderr: '', exitCode: 1 }));
    const { ports } = makePorts({ shell });
    const runner = new HookRunner({ permission: allowRunCommand(), ports });
    const verdict = await runner.runGate([gateHook('first.sh'), gateHook('second.sh')]);
    expect(verdict.blocked).toBe(true);
    if (!verdict.blocked) return;
    expect(verdict.command).toBe('first.sh');
    expect(shell.executed).toEqual(['first.sh']); // o 2º NÃO rodou.
  });

  it('NUNCA aprova: o veredito não carrega allow — só {blocked:false} ou {blocked:true,...}', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const runner = new HookRunner({ permission: allowRunCommand(), ports });
    const verdict = await runner.runGate([gateHook('ok.sh')]);
    // O tipo só admite blocked:false|true — nenhuma forma de "promover" a tool.
    expect(Object.keys(verdict)).toEqual(['blocked']);
  });
});

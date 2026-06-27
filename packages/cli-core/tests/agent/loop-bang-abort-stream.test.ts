// EST-0982 — propagação do ABORT + STREAMING do loop e do `!comando` até a porta.
//
// O DoD exige que o MESMO `signal` do loop/root-flow desça até `ShellPort.exec`
// (p/ matar o processo) e que a saída ao vivo (`onToolChunk`) flua. Estes testes
// provam a COSTURA (sem modelo real): o loop monta o ctx e o repassa à tool; o
// `BangExecutor` faz o mesmo no atalho do usuário.

import { describe, expect, it } from 'vitest';
import { AgentLoop, type ToolLifecycleObserver } from '../../src/agent/loop.js';
import { BangExecutor } from '../../src/agent/bang.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { PolicyPermissionEngine } from '../../src/permission/engine.js';
import { REDACTED } from '../../src/agent/journal/redact.js';
import type { ToolCall, ShellChunk } from '../../src/index.js';
import {
  RecordingShell,
  StreamingShell,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

describe('EST-0982 — loop propaga signal + onToolChunk ao run_command', () => {
  it('o MESMO signal do loop chega à porta de shell (kill dirigido)', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'done', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('run_command', { command: 'sleep 1' }) },
      { text: 'pronto.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports,
    });
    const ac = new AbortController();
    await loop.run('rode', ac.signal);
    // O signal que o loop recebeu foi propagado intacto à porta via a tool.
    expect(shell.lastSignal[0]).toBe(ac.signal);
  });

  it('onToolChunk do observer recebe a saída ao vivo, JÁ redigida (CLI-SEC-6)', async () => {
    const raw: ShellChunk[] = [
      { stream: 'stdout', text: 'token=ghp_abcdefghijklmnopqrstuvwxyz0123\n' },
    ];
    const shell = new StreamingShell(raw, { stdout: raw[0]!.text, stderr: '', exitCode: 0 });
    const { ports } = makePorts({ shell });
    const seen: { call: ToolCall; chunk: ShellChunk }[] = [];
    const observer: ToolLifecycleObserver = {
      onToolChunk: (call, chunk) => seen.push({ call, chunk }),
    };
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('run_command', { command: 'env' }) },
      { text: 'ok.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports,
      toolObserver: observer,
    });
    await loop.run('rode');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.call.name).toBe('run_command'); // o chunk vem rotulado pela tool-call
    const streamed = seen.map((s) => s.chunk.text).join('');
    expect(streamed).toContain(REDACTED);
    expect(streamed).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
  });

  it('sem onToolChunk no observer ⇒ a tool roda igual (sem streaming) — não-regressão', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'x', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const model = new ScriptedModelCaller([
      { text: toolCallBlock('run_command', { command: 'ls' }) },
      { text: 'fim.' },
    ]);
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports,
      toolObserver: { onToolStart: () => {} }, // sem onToolChunk
    });
    await loop.run('rode');
    expect(shell.lastHadOnChunk[0]).toBe(false); // nenhum onChunk repassado à porta
  });
});

describe('EST-0982 — BangExecutor propaga signal + onChunk (atalho do usuário)', () => {
  function allowEngine(): PolicyPermissionEngine {
    // política allow p/ run_command (sem isto, run_command = ask por default) — o
    // MESMO padrão do bang.test.ts. O foco aqui é a PROPAGAÇÃO (signal/onChunk), não
    // o veredito (já coberto pelos testes de não-bypass da EST-0958).
    return new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'run_command', decision: 'allow' }] },
    });
  }

  it('o signal e o onChunk passam pela tool até a porta', async () => {
    const shell = new RecordingShell(() => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
    const { ports } = makePorts({ shell });
    const bang = new BangExecutor({ permission: allowEngine(), ports });
    const ac = new AbortController();
    const outcome = await bang.run('ls', ac.signal, () => {});
    expect(outcome.kind).toBe('ran');
    expect(shell.lastSignal[0]).toBe(ac.signal);
    expect(shell.lastHadOnChunk[0]).toBe(true);
  });

  it('a saída streamada do `!comando` é redigida (CLI-SEC-6)', async () => {
    const raw: ShellChunk[] = [
      { stream: 'stdout', text: 'Authorization: Bearer sk-secret-abcdef0123456789\n' },
    ];
    const shell = new StreamingShell(raw, { stdout: raw[0]!.text, stderr: '', exitCode: 0 });
    const { ports } = makePorts({ shell });
    const bang = new BangExecutor({ permission: allowEngine(), ports });
    const received: ShellChunk[] = [];
    // Comando NÃO-rede/NÃO-destrutivo (a redação é da SAÍDA, não do comando): assim a
    // catraca `allow` deixa rodar e o foco fica na redação do stream.
    const outcome = await bang.run('cat config', undefined, (c) => received.push(c));
    expect(outcome.kind).toBe('ran');
    const streamed = received.map((c) => c.text).join('');
    expect(streamed).toContain(REDACTED);
    expect(streamed).not.toContain('sk-secret-abcdef0123456789');
  });
});

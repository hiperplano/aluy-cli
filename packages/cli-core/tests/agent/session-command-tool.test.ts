// ADR-0147 — testes da tool `session_command` (núcleo portável): validação de input,
// fail-safe SEM porta injetada, e delegação correta à `SessionCommandPort`.

import { describe, expect, it } from 'vitest';
import {
  sessionCommandTool,
  SESSION_COMMAND_TOOL_NAME,
  type SessionCommandOutcome,
  type SessionCommandPort,
} from '../../src/agent/tools/session-command.js';
import type { ToolPorts } from '../../src/agent/tools/types.js';
import { MemoryFs, RecordingShell, MemorySearch } from './helpers.js';

function makePorts(port?: SessionCommandPort): ToolPorts {
  return {
    fs: new MemoryFs(),
    shell: new RecordingShell(),
    search: new MemorySearch(),
    ...(port !== undefined ? { sessionCommand: port } : {}),
  };
}

describe('sessionCommandTool — nome/efeito estáveis', () => {
  it('name é "session_command"', () => {
    expect(sessionCommandTool.name).toBe(SESSION_COMMAND_TOOL_NAME);
    expect(sessionCommandTool.name).toBe('session_command');
  });
});

describe('sessionCommandTool — guards de input', () => {
  it('sem "command" ⇒ ok:false, observação orienta o campo obrigatório', async () => {
    const result = await sessionCommandTool.run({}, makePorts());
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/command/);
  });

  it('"command" vazio/whitespace ⇒ ok:false', async () => {
    const result = await sessionCommandTool.run({ command: '   ' }, makePorts());
    expect(result.ok).toBe(false);
  });

  it('normaliza: lowercase + strip da barra inicial', async () => {
    let captured: { command: string; args: string } | undefined;
    const port: SessionCommandPort = {
      async run(command, args): Promise<SessionCommandOutcome> {
        captured = { command, args };
        return { ok: true, text: 'ok' };
      },
    };
    await sessionCommandTool.run({ command: '/DOCTOR' }, makePorts(port));
    expect(captured).toEqual({ command: 'doctor', args: '' });
  });
});

describe('sessionCommandTool — fail-safe SEM porta injetada', () => {
  it('devolve erro claro (nenhum efeito) quando ports.sessionCommand está ausente', async () => {
    const result = await sessionCommandTool.run({ command: 'doctor' }, makePorts());
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/indisponível/i);
  });
});

describe('sessionCommandTool — delega à porta', () => {
  it('repassa command+args e devolve o outcome da porta como observation', async () => {
    const port: SessionCommandPort = {
      async run(command, args): Promise<SessionCommandOutcome> {
        return { ok: true, text: `rodei ${command} com "${args}"` };
      },
    };
    const result = await sessionCommandTool.run(
      { command: 'cycle', args: '5m "revisar os testes"' },
      makePorts(port),
    );
    expect(result.ok).toBe(true);
    expect(result.observation).toBe('rodei cycle com "5m "revisar os testes""');
  });

  it('porta que lança ⇒ ok:false, observação NÃO propaga exceção crua ao loop', async () => {
    const port: SessionCommandPort = {
      async run(): Promise<SessionCommandOutcome> {
        throw new Error('boom');
      },
    };
    const result = await sessionCommandTool.run({ command: 'doctor' }, makePorts(port));
    expect(result.ok).toBe(false);
    expect(result.observation).toMatch(/boom/);
  });
});

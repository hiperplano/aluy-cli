// ADR aluy-cli 0002 — "lembrar esta decisão" persiste em permissions.alwaysAllow.

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UserConfigStore } from '../../src/io/user-config.js';
import { TuiAskResolver } from '../../src/ask/ask-resolver.js';
import type { AskRequest } from '@hiperplano/aluy-cli-core';

describe('permissions.alwaysAllow', () => {
  it('grava, deduplica e sobrevive a um novo load', () => {
    const store = new UserConfigStore({ baseDir: mkdtempSync(join(tmpdir(), 'aluy-aa-')) });
    expect(store.saveAlwaysAllowTool('spawn_agent')).toBe(true);
    expect(store.saveAlwaysAllowTool('spawn_agent')).toBe(true);
    expect(store.saveAlwaysAllowTool('agent_send')).toBe(true);
    expect(store.load().permissions?.alwaysAllow).toEqual(['spawn_agent', 'agent_send']);
  });

  it('recusa run_command/edit_file/write_file (piso CLI-SEC-3), inclusive se vier no arquivo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aluy-aa-'));
    const store = new UserConfigStore({ baseDir: dir });
    expect(store.saveAlwaysAllowTool('run_command')).toBe(false);
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        permissions: { alwaysAllow: ['run_command', 'edit_file', 'spawn_agent', 7] },
      }),
    );
    expect(store.load().permissions?.alwaysAllow).toEqual(['spawn_agent']);
  });
});

describe('TuiAskResolver — approve-always', () => {
  const req = (name: string, alwaysAsk: boolean): AskRequest =>
    ({
      call: { name, input: {} },
      effect: { kind: 'command', exact: 'x' },
      category: 'default',
      reason: 'r',
      alwaysAsk,
    }) as unknown as AskRequest;

  async function resolveWith(request: AskRequest): Promise<string> {
    const r = new TuiAskResolver();
    const out = r.resolve(request);
    r.pending?.resolve({ kind: 'approve-always' });
    return (await out).kind;
  }

  it('vale para tool comum, é rebaixado p/ sessão em run_command e p/ once em sempre-ask', async () => {
    expect(await resolveWith(req('spawn_agent', false))).toBe('approve-always');
    expect(await resolveWith(req('run_command', false))).toBe('approve-session');
    expect(await resolveWith(req('spawn_agent', true))).toBe('approve-once');
  });
});

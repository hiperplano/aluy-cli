// EST-0974 · ADR-0053 §2.2 / CLI-SEC-3 — config PURA de HOOKS (`~/.aluy/hooks.json`).
//
// Provas do parser/seleção puros: forma válida vira `Hook[]`; entradas inválidas
// (evento fora da allow-list, sem command) são DESCARTADAS (fail-closed, nunca um
// hook "meio-válido"); `selectHooks` casa evento + matcher de tool.

import { describe, expect, it } from 'vitest';
import { parseHooksConfig, selectHooks, EMPTY_HOOKS_CONFIG, HOOK_EVENTS } from '../../src/index.js';

describe('EST-0974 · parseHooksConfig — fail-closed', () => {
  it('forma válida ⇒ Hook[] (evento, command, matcher opcional)', () => {
    const cfg = parseHooksConfig({
      hooks: [
        { event: 'session-start', command: 'echo oi' },
        { event: 'pre-tool', command: 'lint', matcher: 'edit_file' },
      ],
    });
    expect(cfg.hooks).toHaveLength(2);
    expect(cfg.hooks[0]).toEqual({ event: 'session-start', command: 'echo oi' });
    expect(cfg.hooks[1]).toEqual({ event: 'pre-tool', command: 'lint', matcher: 'edit_file' });
  });

  it('evento DESCONHECIDO ⇒ descartado (allow-list fechada)', () => {
    const cfg = parseHooksConfig({ hooks: [{ event: 'on-rm-rf', command: 'evil' }] });
    expect(cfg.hooks).toHaveLength(0);
  });

  it('entrada sem `command` (ou vazio) ⇒ descartada', () => {
    const cfg = parseHooksConfig({
      hooks: [{ event: 'turn-end' }, { event: 'turn-end', command: '   ' }],
    });
    expect(cfg.hooks).toHaveLength(0);
  });

  it('não-objeto / sem `hooks` array ⇒ config vazia (nunca lança)', () => {
    expect(parseHooksConfig(null)).toEqual(EMPTY_HOOKS_CONFIG);
    expect(parseHooksConfig('nope')).toEqual(EMPTY_HOOKS_CONFIG);
    expect(parseHooksConfig({ hooks: 'x' })).toEqual(EMPTY_HOOKS_CONFIG);
    expect(parseHooksConfig({})).toEqual(EMPTY_HOOKS_CONFIG);
  });

  it('a allow-list de eventos é fechada e conhecida (EST-0974 + EST-0980)', () => {
    expect([...HOOK_EVENTS].sort()).toEqual([
      'notification',
      'post-tool',
      'pre-tool',
      'session-start',
      'subagent-stop',
      'turn-end',
      'user-prompt-submit',
    ]);
  });
});

describe('EST-0974 · selectHooks — evento + matcher', () => {
  const cfg = parseHooksConfig({
    hooks: [
      { event: 'pre-tool', command: 'a' }, // sem matcher ⇒ casa qualquer tool
      { event: 'pre-tool', command: 'b', matcher: 'edit_file' }, // casa só edit_file
      { event: 'turn-end', command: 'c' },
    ],
  });

  it('pre-tool sem toolName ⇒ só os sem matcher', () => {
    expect(selectHooks(cfg, 'pre-tool').map((h) => h.command)).toEqual(['a']);
  });
  it('pre-tool com toolName=edit_file ⇒ o sem matcher E o que casa', () => {
    expect(selectHooks(cfg, 'pre-tool', 'edit_file').map((h) => h.command)).toEqual(['a', 'b']);
  });
  it('pre-tool com toolName=run_command ⇒ só o sem matcher', () => {
    expect(selectHooks(cfg, 'pre-tool', 'run_command').map((h) => h.command)).toEqual(['a']);
  });
  it('turn-end ⇒ ignora toolName', () => {
    expect(selectHooks(cfg, 'turn-end').map((h) => h.command)).toEqual(['c']);
  });
});

// Auditoria — self-check enxuto: o PADRÃO é 1 passada (o teste antigo comparava com a própria
// constante) e casos do livro-caixa que as mutações deixaram passar (edição que falhou não é
// efeito, edição sem caminho é efeito não atribuível).

import { describe, expect, it } from 'vitest';
import { VerificationLedger } from '../../src/agent/verification-ledger.js';
import { resolveSelfCheck } from '../../src/agent/self-check.js';
import { AgentLoop } from '../../src/agent/loop.js';
import { ToolRegistry } from '../../src/agent/tools/registry.js';
import { NATIVE_TOOLS } from '../../src/agent/tools/native.js';
import { SELF_CHECK_MARKER } from '../../src/agent/self-check.js';
import {
  MemoryFs,
  ScriptedModelCaller,
  allowAllEngine,
  makePorts,
  toolCallBlock,
} from './helpers.js';

describe('self-check · padrão de UMA passada', () => {
  it('sem env nem config, a config resolvida tem maxVerifications = 1 (literal)', () => {
    expect(resolveSelfCheck({ tier: 'custom' }).maxVerifications).toBe(1);
  });

  it('env e config sobem o teto (env vence config); o clamp segura valores absurdos', () => {
    expect(resolveSelfCheck({ tier: 'custom', maxVerificationsConfig: 3 }).maxVerifications).toBe(
      3,
    );
    expect(
      resolveSelfCheck({ tier: 'custom', maxVerificationsEnv: '2', maxVerificationsConfig: 3 })
        .maxVerifications,
    ).toBe(2);
    expect(
      resolveSelfCheck({ tier: 'custom', maxVerificationsEnv: '9999' }).maxVerifications,
    ).toBeLessThanOrEqual(10);
  });

  it('no loop, a config padrão resolvida faz exatamente UMA sonda mesmo com o modelo sempre dizendo "pronto"', async () => {
    const cfg = resolveSelfCheck({ tier: 'custom' });
    const fs = new MemoryFs(new Map([['a.txt', 'x']]));
    const { ports } = makePorts({ fs });
    const w = toolCallBlock('write_file', { path: 'b.txt', content: 'X' });
    const model = new ScriptedModelCaller(
      [w, 'pronto', 'pronto', 'pronto', 'pronto'].map((text) => ({ text })),
    );
    const loop = new AgentLoop({
      model,
      permission: allowAllEngine,
      tools: new ToolRegistry(NATIVE_TOOLS),
      ports,
      sessionId: 's',
      selfCheck: { ...cfg, reanchorEveryK: 1000 },
    });
    await loop.run('crie b.txt');
    const ultimo = model.calls[model.calls.length - 1]!;
    const sondas = ultimo.messages.filter(
      (x) => x.role === 'assistant' && x.content.includes(SELF_CHECK_MARKER),
    ).length;
    expect(sondas).toBe(1);
  });
});

describe('VerificationLedger · casos finos', () => {
  const rec = (l: VerificationLedger, name: string, input: unknown, ok = true): void =>
    l.record(name, input, ok);

  it('edição que FALHOU não é efeito: reler depois não faz o ledger "pular" a sonda', () => {
    const l = new VerificationLedger();
    rec(l, 'edit_file', { path: 'a.ts' }, false);
    rec(l, 'read_file', { path: 'a.ts' });
    expect(l.canSkip()).toBe(false);
    expect(VerificationLedger.isEffect('edit_file', { path: 'a.ts' })).toBe(true);
  });

  it('edição SEM caminho é efeito não atribuível: reler outro arquivo não limpa', () => {
    const l = new VerificationLedger();
    rec(l, 'write_file', { content: 'x' });
    rec(l, 'read_file', { path: 'a.ts' });
    expect(l.canSkip()).toBe(false);
  });

  it('só um teste passante limpa o efeito não atribuível', () => {
    const l = new VerificationLedger();
    rec(l, 'write_file', { content: 'x' });
    rec(l, 'run_tests', { command: 'npm test' });
    expect(l.canSkip()).toBe(true);
  });

  it('isEffect: leitura/busca/teste NÃO são efeito; escrita, comando mutador e MCP são', () => {
    expect(VerificationLedger.isEffect('read_file', { path: 'a' })).toBe(false);
    expect(VerificationLedger.isEffect('grep', { pattern: 'x' })).toBe(false);
    expect(VerificationLedger.isEffect('run_tests', { command: 'npm test' })).toBe(false);
    expect(VerificationLedger.isEffect('run_command', { command: 'ls' })).toBe(false);
    expect(VerificationLedger.isEffect('write_file', { path: 'a', content: 'x' })).toBe(true);
    expect(VerificationLedger.isEffect('run_command', { command: 'rm -rf x' })).toBe(true);
    expect(VerificationLedger.isEffect('mcp__s__t', {})).toBe(true);
  });
});

// EST-1012 · cobertura da linha 68 de policy.ts: o branch
// `if (rule.tool !== name) continue;` — uma regra cujo `tool` NÃO bate com o
// `name` deve ser PULADA (skip), sem casar.

import { describe, expect, it } from 'vitest';
import { evaluatePolicyRules } from '../../src/permission/policy.js';
import type { PermissionPolicy } from '../../src/permission/policy.js';

describe('evaluatePolicyRules — tool mismatch (EST-1012)', () => {
  // Caso (A): policy com UMA regra para tool 'bash', avaliada contra
  // name='read_file' e arg='x'. A regra de bash é PULADA por tool diferente
  // (cobre a linha 68: `if (rule.tool !== name) continue;`).
  // Retorno esperado: undefined (nenhuma regra casou).
  it('(A) regra de tool diferente é pulada — retorna undefined', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'bash', match: '*', decision: 'deny' }],
    };
    const result = evaluatePolicyRules(policy, 'read_file', 'x');
    expect(result).toBeUndefined();
  });

  // Caso (B): policy com DUAS regras:
  //   1. { tool: 'bash',   match: '*', decision: 'deny' }
  //   2. { tool: 'read_file', match: '*', decision: 'ask' }
  // Avaliada contra name='read_file', arg='y'.
  // A 1ª regra é PULADA (tool bash !== read_file — linha 68).
  // A 2ª regra casa (tool casa E match casa).
  // Retorno esperado: a SEGUNDA regra.
  it('(B) pula regra que não casa tool, casa a seguinte — retorna a 2ª regra', () => {
    const policy: PermissionPolicy = {
      rules: [
        { tool: 'bash', match: '*', decision: 'deny' },
        { tool: 'read_file', match: '*', decision: 'ask' },
      ],
    };
    const result = evaluatePolicyRules(policy, 'read_file', 'y');
    expect(result).toBeDefined();
    expect(result!.tool).toBe('read_file');
    expect(result!.match).toBe('*');
    expect(result!.decision).toBe('ask');
  });
});

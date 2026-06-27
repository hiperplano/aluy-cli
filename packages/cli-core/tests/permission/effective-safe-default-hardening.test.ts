// EST-1012 · CLI-SEC-H1 — HARDENING de `PolicyPermissionEngine.effectiveSafeDefault`.
//
// Testes ADVERSARIAIS da PRECEDÊNCIA de leitura do default efetivo (o que o painel
// `/permissions` exibe): overlay de sessão → `policy.defaults` (config) → piso
// seguro da engine (read-only ⇒ allow; resto ⇒ ask). Cada `it` MATA uma mutação:
//
//  (1) inverter o ramo `policy.defaults` — ler config quando NÃO devia, ou ignorá-la.
//  (2) trocar a precedência overlay > config (overlay deve VENCER a config).
//  (3) frouxar o guard `fromConfig === 'allow' || fromConfig === 'ask'` (um valor
//      de config FORA do par seguro NÃO deve vazar; cai no piso).
//  (4) inverter o piso `READ_TOOLS ⇒ allow : ask`.

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, type PermissionPolicy, type ToolCall } from '../../src/index.js';

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { name, input };
}

describe('EST-1012 — sempre-deny de `~/.aluy`/`.ssh` NÃO relaxa por allow-list/config', () => {
  // ── MUTAÇÃO: rebaixar o DENY do journal/config `~/.aluy` ou do sensitive-read
  //    crítico (.ssh) p/ `ask`, OU deixar uma regra de allow do usuário (precedência
  //    6) vencer a fronteira (0.b) / a categoria-deny (3). A fronteira é INTOCÁVEL
  //    fora do YOLO — uma allow-rule do usuário NÃO pode liberar `~/.aluy` nem `.ssh`.

  it('leitura de `~/.aluy/undo/x` ⇒ DENY mesmo com regra allow do usuário p/ read_file', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'read_file', match: '*', decision: 'allow' }],
    };
    const e = new PolicyPermissionEngine({ policy });
    const v = e.decide(call('read_file', { path: '~/.aluy/undo/blob' }));
    // Mata a relaxação deny→ask/allow: a fronteira 0.b vence a allow-rule (6).
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:journal-read-deny');
  });

  it('escrita (edit_file) em `~/.aluy/hooks.json` ⇒ DENY mesmo com allow-rule', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'edit_file', match: '*', decision: 'allow' }],
    };
    const e = new PolicyPermissionEngine({ policy });
    const v = e.decide(call('edit_file', { path: '~/.aluy/hooks.json', content: 'x' }));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:aluy-config-write-deny');
  });

  it('leitura de `~/.ssh/id_rsa` ⇒ DENY (sensitive-read crítico) apesar de allow-rule', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'read_file', match: '*', decision: 'allow' }],
    };
    const e = new PolicyPermissionEngine({ policy });
    const v = e.decide(call('read_file', { path: '~/.ssh/id_rsa' }));
    // sensitive-read com deny=true ⇒ categoria deny (precedência 3) vence a allow-rule.
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:sensitive-read');
  });

  it('tool MCP que mente "readonly" tocando `~/.aluy/` ⇒ DENY (E-B1/E-B2), não relaxa', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'mcp__x__y', match: '*', decision: 'allow' }],
    };
    const e = new PolicyPermissionEngine({ policy });
    const v = e.decide(call('mcp__x__y', { path: '~/.aluy/config' }));
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:aluy-config-write-deny');
  });

  it('ESPELHO: um path benigno do workspace COM allow-rule ⇒ allow (não super-bloqueia)', () => {
    // Prova que o DENY é específico de `~/.aluy`/`.ssh` e não um deny-tudo: um
    // read_file normal com allow-rule segue allow (o piso de leitura já daria allow).
    const policy: PermissionPolicy = {
      rules: [{ tool: 'read_file', match: '*', decision: 'allow' }],
    };
    const e = new PolicyPermissionEngine({ policy });
    expect(e.decide(call('read_file', { path: 'src/app.ts' })).decision).toBe('allow');
  });
});

describe('effectiveSafeDefault — precedência e piso (EST-1012)', () => {
  // ── (4) PISO: read-only ⇒ allow; o resto ⇒ ask (sem overlay nem config) ──
  it('piso: tool de LEITURA pura ⇒ allow (READ_TOOLS)', () => {
    const e = new PolicyPermissionEngine();
    expect(e.effectiveSafeDefault('read_file')).toBe('allow');
    expect(e.effectiveSafeDefault('grep')).toBe('allow');
    expect(e.effectiveSafeDefault('glob')).toBe('allow');
  });

  it('piso: tool NÃO-leitura (sem config/overlay) ⇒ ask (deny-default)', () => {
    const e = new PolicyPermissionEngine();
    // Mata a inversão do ternário do piso: edit_file/run_command NÃO são allow.
    expect(e.effectiveSafeDefault('edit_file')).toBe('ask');
    expect(e.effectiveSafeDefault('run_command')).toBe('ask');
    expect(e.effectiveSafeDefault('tool_desconhecida')).toBe('ask');
  });

  // ── (1) RAMO `policy.defaults`: a config muda o default efetivo ──
  it('config `defaults` allow sobe uma tool não-leitura de ask→allow', () => {
    const policy: PermissionPolicy = { rules: [], defaults: { run_command: 'allow' } };
    const e = new PolicyPermissionEngine({ policy });
    // Mata a mutação que IGNORA policy.defaults (continuaria 'ask').
    expect(e.effectiveSafeDefault('run_command')).toBe('allow');
  });

  it('config `defaults` ask rebaixa uma tool de LEITURA de allow→ask', () => {
    const policy: PermissionPolicy = { rules: [], defaults: { read_file: 'ask' } };
    const e = new PolicyPermissionEngine({ policy });
    // Mata a mutação que pula a config p/ tools de leitura (voltaria 'allow').
    expect(e.effectiveSafeDefault('read_file')).toBe('ask');
  });

  // ── (3) GUARD `=== 'allow' || === 'ask'`: valores fora do par NÃO vazam ──
  it('config com valor FORA do par {allow,ask} (ex.: deny) ⇒ cai no PISO, não vaza', () => {
    // `deny` é PermissionDecision válido em `defaults`, mas effectiveSafeDefault só
    // aceita allow/ask (é p/ o painel de tools SEGURAS). Um `deny` NÃO deve virar o
    // default efetivo; o guard o descarta e cai no piso seguro.
    const policy: PermissionPolicy = {
      rules: [],
      defaults: { read_file: 'deny', run_command: 'deny' },
    };
    const e = new PolicyPermissionEngine({ policy });
    // read_file: piso = allow (deny descartado). run_command: piso = ask.
    // Mata a mutação que afrouxa o guard e deixa `deny` vazar como SafeToolDecision.
    expect(e.effectiveSafeDefault('read_file')).toBe('allow');
    expect(e.effectiveSafeDefault('run_command')).toBe('ask');
  });

  // ── (2) PRECEDÊNCIA: overlay de sessão VENCE a config ──
  it('overlay de sessão (painel) VENCE policy.defaults', () => {
    const policy: PermissionPolicy = { rules: [], defaults: { read_file: 'ask' } };
    const e = new PolicyPermissionEngine({ policy });
    expect(e.effectiveSafeDefault('read_file')).toBe('ask'); // config valendo
    const changed = e.setSafeToolDefault('read_file', 'allow'); // painel sobrepõe
    expect(changed).toBe(true);
    // Mata a inversão de precedência (config venceria o overlay).
    expect(e.effectiveSafeDefault('read_file')).toBe('allow');
  });

  it('overlay vale também SEM config (piso é o fallback, overlay no topo)', () => {
    const e = new PolicyPermissionEngine();
    e.setSafeToolDefault('grep', 'ask'); // rebaixa uma leitura via painel
    expect(e.effectiveSafeDefault('grep')).toBe('ask');
    // e outra tool de leitura intocada permanece no piso allow (overlay é por-tool).
    expect(e.effectiveSafeDefault('read_file')).toBe('allow');
  });
});

// EST-0970 · ADR-0058 · CLI-SEC-12 — PROVA da catraca p/ tools MCP (gate FORTE).
//
// Toda tool MCP passa pelo MESMO `decide()` (CLI-SEC-H1), classificada por SINAIS
// do input (E-B2), NUNCA pelo rótulo `readonly` auto-declarado. Aqui provamos:
//   • MCP desconhecida ⇒ ask (efeito por padrão; nunca allow silencioso).
//   • `readonly` MENTIROSO (input com path/rede) ⇒ ainda ask/deny.
//   • escrita em `~/.aluy/` ⇒ DENY, acima até do `--unsafe`.
//   • path sensível (.ssh) ⇒ DENY.
//   • Plan ⇒ DENY toda tool MCP (não está na allow-list fechada de leitura local).
//   • allow-list/hook do usuário NÃO relaxam (categoria sempre-ask).

import { describe, expect, it } from 'vitest';
import {
  PolicyPermissionEngine,
  classifyAlwaysAsk,
  type PermissionPolicy,
  type ToolCall,
} from '../../src/index.js';

const mcpRead: ToolCall = { name: 'mcp__fs__read', input: { path: './notes.txt' } };
const mcpHttp: ToolCall = { name: 'mcp__net__get', input: { url: 'https://evil.example/x' } };
const mcpSsh: ToolCall = { name: 'mcp__fs__read', input: { path: '~/.ssh/id_rsa' } };
const mcpAluyWrite: ToolCall = {
  name: 'mcp__fs__write',
  input: { path: '~/.aluy/hooks.json', content: 'x' },
};

describe('classifier — toda tool MCP é EFEITO por padrão (E-B2)', () => {
  it('MCP sem sinal ⇒ always-ask:mcp-effect (ask)', () => {
    const cats = classifyAlwaysAsk('mcp__x__do', { foo: 'bar' }).map((c) => c.category);
    expect(cats).toContain('always-ask:mcp-effect');
  });

  it('sinal de REDE no input ⇒ +always-ask:network (mesmo que a tool se diga readonly)', () => {
    const cats = classifyAlwaysAsk('mcp__net__get', { url: 'https://x/' }).map((c) => c.category);
    expect(cats).toContain('always-ask:mcp-effect');
    expect(cats).toContain('always-ask:network');
  });

  it('path `~/.aluy/` no input ⇒ aluy-config-write-deny (DENY)', () => {
    const m = classifyAlwaysAsk('mcp__fs__write', { path: '~/.aluy/hooks.json' });
    const deny = m.find((c) => c.category === 'always-ask:aluy-config-write-deny');
    expect(deny?.deny).toBe(true);
  });

  it('path `.ssh` no input ⇒ sensitive-read (DENY)', () => {
    const m = classifyAlwaysAsk('mcp__fs__read', { path: '~/.ssh/id_rsa' });
    const deny = m.find((c) => c.category === 'always-ask:sensitive-read');
    expect(deny?.deny).toBe(true);
  });
});

describe('engine — veredito por modo', () => {
  it('normal: MCP desconhecida ⇒ ask (nunca allow silencioso)', () => {
    const e = new PolicyPermissionEngine();
    expect(e.decide(mcpRead).decision).toBe('ask');
  });

  it('normal: MCP com URL ⇒ ask (categoria network não-relaxável)', () => {
    const e = new PolicyPermissionEngine();
    expect(e.decide(mcpHttp).decision).toBe('ask');
  });

  it('normal: MCP que lê `.ssh` ⇒ DENY', () => {
    const e = new PolicyPermissionEngine();
    const v = e.decide(mcpSsh);
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:sensitive-read');
  });

  it('normal: MCP que escreve `~/.aluy/` ⇒ DENY (E-B1)', () => {
    const e = new PolicyPermissionEngine();
    const v = e.decide(mcpAluyWrite);
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('always-ask:aluy-config-write-deny');
  });

  // ── readonly MENTIROSO: nenhum rótulo do server muda o veredito (E-B2) ────────
  it('`readonly:true` auto-declarado NÃO vira allow — o input manda', () => {
    const e = new PolicyPermissionEngine();
    // o input carrega a "verdade auto-declarada" do server; a engine a IGNORA.
    const lyingReadonly: ToolCall = {
      name: 'mcp__fs__list',
      input: { readonly: true, effect: 'read', path: '~/.ssh/id_rsa' },
    };
    const v = e.decide(lyingReadonly);
    expect(v.decision).toBe('deny'); // .ssh ainda DENY, apesar do "readonly:true"
  });

  it('`readonly:true` mas faz POST (url no input) ⇒ ainda ask', () => {
    const e = new PolicyPermissionEngine();
    const v = e.decide({
      name: 'mcp__net__post',
      input: { readonly: true, url: 'https://evil/collect' },
    });
    expect(v.decision).toBe('ask');
  });

  // ── Plan nega toda tool MCP de efeito ────────────────────────────────────────
  it('Plan: MCP ⇒ DENY (não está na allow-list fechada de leitura local)', () => {
    const e = new PolicyPermissionEngine({ mode: 'plan' });
    expect(e.decide(mcpRead).decision).toBe('deny');
    expect(e.decide(mcpRead).category).toBe('mode:plan-deny');
  });

  // ── EST-0991 · ADR-0072 — YOLO = PERMISSÃO COMPLETA: libera EFEITO E os pisos de
  //    `~/.aluy` (Alternativa C, do dono). Em `normal`/`plan` os pisos PERMANECEM
  //    (provado acima: linha 71 normal-DENY, linha 100 Plan-DENY) — não-regressão.
  it('YOLO: MCP comum ⇒ allow (permissão completa)', () => {
    const e = new PolicyPermissionEngine({ mode: 'unsafe' });
    expect(e.decide(mcpRead).decision).toBe('allow');
  });
  it('YOLO: MCP escrevendo `~/.aluy/` ⇒ ALLOW (piso derrubado — ADR-0072)', () => {
    const e = new PolicyPermissionEngine({ mode: 'unsafe' });
    expect(e.decide(mcpAluyWrite).decision).toBe('allow');
  });
  it('NÃO-REGRESSÃO — `normal`: MCP escrevendo `~/.aluy/` ⇒ DENY', () => {
    const e = new PolicyPermissionEngine();
    expect(e.decide(mcpAluyWrite).decision).toBe('deny');
  });

  // ── allow-list/hook do usuário NÃO relaxam a categoria sempre-ask ─────────────
  it('regra allow do usuário NÃO sobrepõe mcp-effect (sempre-ask)', () => {
    const policy: PermissionPolicy = {
      rules: [{ tool: 'mcp__fs__read', decision: 'allow' }],
    };
    const e = new PolicyPermissionEngine({ policy });
    expect(e.decide(mcpRead).decision).toBe('ask');
  });

  it('grantSession recusa gravar grant p/ MCP (cada chamada re-pergunta)', () => {
    const e = new PolicyPermissionEngine();
    expect(e.grantSession(mcpRead)).toBe(false);
  });
});

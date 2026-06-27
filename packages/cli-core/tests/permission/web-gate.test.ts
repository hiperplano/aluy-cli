// EST-0971 · CLI-SEC-13 — as tools de rede PASSAM pela catraca:
//   - normal ⇒ always-ask:network (não-relaxável por allow-list/hook).
//   - Plan   ⇒ DENY (rede = exfiltração; ADR-0055). Zero fetch/search em Plan.
//   - --unsafe ⇒ allow (bypass total, igual a qualquer efeito).

import { describe, expect, it } from 'vitest';
import { PolicyPermissionEngine, classifyAlwaysAsk, type ToolCall } from '../../src/index.js';

const fetchCall: ToolCall = { name: 'web_fetch', input: { url: 'https://example.com/' } };
const searchCall: ToolCall = { name: 'web_search', input: { query: 'aluy' } };

describe('classifier — web_fetch/web_search ⇒ always-ask:network', () => {
  it('web_fetch casa always-ask:network (pelo NOME, input=url)', () => {
    const cats = classifyAlwaysAsk('web_fetch', { url: 'https://x/' }).map((c) => c.category);
    expect(cats).toContain('always-ask:network');
  });
  it('web_search casa always-ask:network (pelo NOME, input=query)', () => {
    const cats = classifyAlwaysAsk('web_search', { query: 'x' }).map((c) => c.category);
    expect(cats).toContain('always-ask:network');
  });
});

describe('engine NORMAL — rede ⇒ ask, com a URL/destino no efeito (CLI-SEC-9)', () => {
  const engine = new PolicyPermissionEngine();
  it('web_fetch ⇒ ask + efeito network com a URL exata', () => {
    const v = engine.decide(fetchCall);
    expect(v.decision).toBe('ask');
    expect(v.category).toBe('always-ask:network');
    expect(v.effect?.kind).toBe('network');
    expect(v.effect?.target).toBe('https://example.com/');
  });
  it('web_search ⇒ ask (destino = duckduckgo.com)', () => {
    const v = engine.decide(searchCall);
    expect(v.decision).toBe('ask');
    expect(v.effect?.target).toBe('duckduckgo.com');
  });
});

describe('engine — allow-list/hook NÃO relaxam a rede (não-relaxável)', () => {
  it('regra allow do usuário NÃO baixa web_fetch p/ allow', () => {
    const engine = new PolicyPermissionEngine({
      policy: { rules: [{ tool: 'web_fetch', decision: 'allow' }] },
    });
    expect(engine.decide(fetchCall).decision).toBe('ask'); // categoria vence a regra
  });
  it('hook allow NÃO baixa web_search p/ allow', () => {
    const engine = new PolicyPermissionEngine({
      hooks: [() => ({ decision: 'allow', reason: 'teste' })],
    });
    expect(engine.decide(searchCall).decision).toBe('ask');
  });
});

describe('PLAN — zero fetch/search (DENY, não ask)', () => {
  const engine = new PolicyPermissionEngine({ mode: 'plan' });
  it('web_fetch em Plan ⇒ DENY', () => {
    const v = engine.decide(fetchCall);
    expect(v.decision).toBe('deny');
    expect(v.category).toBe('mode:plan-deny');
  });
  it('web_search em Plan ⇒ DENY', () => {
    expect(engine.decide(searchCall).decision).toBe('deny');
  });
});

describe('--unsafe — rede liberada (bypass total, igual a qualquer efeito)', () => {
  const engine = new PolicyPermissionEngine({ mode: 'unsafe' });
  it('web_fetch sob --unsafe ⇒ allow', () => {
    expect(engine.decide(fetchCall).decision).toBe('allow');
  });
});

// EST-0970 — teste do parseMcpRefresh: parseia `/mcp reload|reconnect [all|<nome>]`.
// PURO (sem rede, sem processo, sem modelo).

import { describe, expect, it } from 'vitest';
import { parseMcpRefresh, isMcpReload, mcpReloadStubNote } from '../../src/slash/handlers.js';

describe('parseMcpRefresh', () => {
  it('"reconnect" → {kind:"reconnect", scope:"all"}', () => {
    expect(parseMcpRefresh('reconnect')).toEqual({ kind: 'reconnect', scope: 'all' });
  });

  it('"reconnect playwright" → {kind:"reconnect", scope:"playwright"}', () => {
    expect(parseMcpRefresh('reconnect playwright')).toEqual({
      kind: 'reconnect',
      scope: 'playwright',
    });
  });

  it('"reload all" → {kind:"reload", scope:"all"}', () => {
    expect(parseMcpRefresh('reload all')).toEqual({ kind: 'reload', scope: 'all' });
  });

  it('"reload everything" → {kind:"reload", scope:"everything"}', () => {
    expect(parseMcpRefresh('reload everything')).toEqual({
      kind: 'reload',
      scope: 'everything',
    });
  });

  it('case-insensitive: "RECONNECT" → {kind:"reconnect", scope:"all"}', () => {
    expect(parseMcpRefresh('RECONNECT')).toEqual({ kind: 'reconnect', scope: 'all' });
  });

  it('case-insensitive: "ReLoad" → {kind:"reload", scope:"all"}', () => {
    expect(parseMcpRefresh('ReLoad')).toEqual({ kind: 'reload', scope: 'all' });
  });

  it('"reload" (sem scope) → {kind:"reload", scope:"all"}', () => {
    expect(parseMcpRefresh('reload')).toEqual({ kind: 'reload', scope: 'all' });
  });

  it('texto qualquer → null', () => {
    expect(parseMcpRefresh('')).toBeNull();
    expect(parseMcpRefresh('search github')).toBeNull();
    expect(parseMcpRefresh('add something')).toBeNull();
    expect(parseMcpRefresh('  ')).toBeNull();
  });

  it('prefixo parcial não casa ("recon", "rel")', () => {
    expect(parseMcpRefresh('recon')).toBeNull();
    expect(parseMcpRefresh('rel')).toBeNull();
  });
});

// Back-compat: isMcpReload e mcpReloadStubNote ainda existem (testes antigos).
describe('isMcpReload (back-compat)', () => {
  it('"reload" → true', () => {
    expect(isMcpReload('reload')).toBe(true);
    expect(isMcpReload('  reload  ')).toBe(true);
  });

  it('outros → false', () => {
    expect(isMcpReload('')).toBe(false);
    expect(isMcpReload('reconnect')).toBe(false);
    expect(isMcpReload('search')).toBe(false);
  });
});

describe('mcpReloadStubNote (back-compat)', () => {
  it('ainda devolve nota com título "mcp"', () => {
    const note = mcpReloadStubNote();
    expect(note.title).toBe('mcp');
    expect(note.lines.length).toBeGreaterThan(0);
  });
});

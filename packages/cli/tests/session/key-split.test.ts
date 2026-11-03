import { describe, expect, it } from 'vitest';
import { createKeySplitter, splitKeys } from '../../src/session/key-split.js';
import { createCsiUFilter, installCsiUGuard } from '../../src/session/csi-u-guard.js';

describe('F7 — splitKeys', () => {
  it('quebra várias setas num chunk só', () => {
    expect(splitKeys('\x1b[D\x1b[D\x1b[D')).toEqual(['\x1b[D', '\x1b[D', '\x1b[D']);
  });
  it('combos: seta com modificador, SS3, Alt+tecla, Alt+Enter, Alt+seta', () => {
    expect(splitKeys('\x1b[1;5C\x1bOA\x1bb\x1b\r\x1b\x1b[D')).toEqual([
      '\x1b[1;5C',
      '\x1bOA',
      '\x1bb',
      '\x1b\r',
      '\x1b\x1b[D',
    ]);
  });
  it('texto puro (inclusive com Enter grudado) segue UM token', () => {
    expect(splitKeys('abc\r')).toEqual(['abc\r']);
    expect(splitKeys('ab\x1b[Dcd')).toEqual(['ab', '\x1b[D', 'cd']);
  });
  it('Esc solto no fim e sequência cortada não somem', () => {
    expect(splitKeys('a\x1b')).toEqual(['a', '\x1b']);
    expect(splitKeys('\x1b[1;')).toEqual(['\x1b[1;']);
  });
  it('bracketed paste passa INTEIRO (inclusive em chunks separados)', () => {
    const sp = createKeySplitter();
    expect(sp.split('\x1b[200~a\x1b[31mb\nc\x1b[201~')).toHaveLength(1);
    expect(sp.split('\x1b[200~a\x1b[31m')).toHaveLength(1);
    expect(sp.split('b\x1b[0m\x1b[D')).toHaveLength(1); // ainda dentro do paste
    expect(sp.split('x\x1b[201~')).toHaveLength(1);
    expect(sp.split('\x1b[D\x1b[D')).toHaveLength(2); // fora do paste: volta a quebrar
  });
});

describe('F2 — Shift+Enter vira Alt+Enter (nova linha)', () => {
  it('kitty CSI-u e modifyOtherKeys', () => {
    const f = createCsiUFilter();
    expect(f.feed('a\x1b[13;2ub')).toBe('a\x1b\rb');
    expect(f.feed('\x1b[27;2;13~')).toBe('\x1b\r');
  });
});

describe('F7 — interpositor de read() entrega 1 tecla por chamada', () => {
  it('três setas num chunk viram três reads', () => {
    const chunks: unknown[] = ['\x1b[D\x1b[D\x1b[D', null];
    const stdin = { read: () => chunks.shift() ?? null };
    installCsiUGuard(stdin);
    expect(stdin.read()).toBe('\x1b[D');
    expect(stdin.read()).toBe('\x1b[D');
    expect(stdin.read()).toBe('\x1b[D');
    expect(stdin.read()).toBeNull();
  });
});

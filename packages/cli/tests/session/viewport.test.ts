// EST-1000 · ADR-0076 §4 — VIEWPORT/scroll próprio (pgup/pgdn/↑↓) — PURO.

import { describe, expect, it } from 'vitest';
import { resolveViewport, scrollOffset } from '../../src/session/viewport.js';

describe('resolveViewport — janela da cauda + clamp', () => {
  it('offset 0 = colado na cauda (mostra o fim)', () => {
    const vp = resolveViewport(10, 3, 0);
    expect(vp).toMatchObject({ start: 7, end: 10, hiddenAbove: 7, hiddenBelow: 0 });
  });

  it('offset rola p/ cima (vê linhas mais antigas)', () => {
    const vp = resolveViewport(10, 3, 4);
    expect(vp).toMatchObject({ start: 3, end: 6, hiddenAbove: 3, hiddenBelow: 4 });
  });

  it('clampa o offset no topo (não rola além do começo)', () => {
    const vp = resolveViewport(10, 3, 999);
    expect(vp.start).toBe(0);
    expect(vp.offset).toBe(7); // maxOffset = total - visible
    expect(vp.hiddenAbove).toBe(0);
  });

  it('total <= visible ⇒ tudo visível, sem scroll', () => {
    const vp = resolveViewport(2, 10, 5);
    expect(vp).toMatchObject({ start: 0, end: 2, hiddenAbove: 0, hiddenBelow: 0, offset: 0 });
  });
});

describe('scrollOffset — passo das teclas', () => {
  it('up aumenta o offset (vê mais antigo); down diminui (vai à cauda)', () => {
    expect(scrollOffset('up', 0, 100, 10)).toBe(1);
    expect(scrollOffset('down', 5, 100, 10)).toBe(4);
  });

  it('down não vai abaixo de 0 (cauda)', () => {
    expect(scrollOffset('down', 0, 100, 10)).toBe(0);
  });

  it('pageUp/pageDown movem uma página (visible-1)', () => {
    expect(scrollOffset('pageUp', 0, 100, 10)).toBe(9);
    expect(scrollOffset('pageDown', 20, 100, 10)).toBe(11);
  });

  it('home vai ao topo (maxOffset); end vai à cauda (0)', () => {
    expect(scrollOffset('home', 0, 100, 10)).toBe(90);
    expect(scrollOffset('end', 90, 100, 10)).toBe(0);
  });

  it('clampa no topo (não passa do começo)', () => {
    expect(scrollOffset('up', 90, 100, 10)).toBe(90);
    expect(scrollOffset('pageUp', 88, 100, 10)).toBe(90);
  });
});

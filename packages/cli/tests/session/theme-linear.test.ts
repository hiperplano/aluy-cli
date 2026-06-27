// EST-0966 — `/theme` puro: buildThemeEffect (lista/troca/inválido) + runThemeLinear
// (não-TTY, §9). Sem picker, sem OSC 11 (não há terminal a quem perguntar).

import { describe, expect, it } from 'vitest';
import { buildThemeEffect } from '../../src/slash/handlers.js';
import { runThemeLinear, type LinearOut } from '../../src/session/linear.js';

function makeOut(): { out: LinearOut; text: () => string } {
  let buf = '';
  return { out: { write: (c) => (buf += c) }, text: () => buf };
}

describe('buildThemeEffect', () => {
  it('sem arg ⇒ LISTA os temas, marca o ativo, não troca', () => {
    const e = buildThemeEffect('', 'aluy-dark');
    expect(e.kind).toBe('theme');
    if (e.kind === 'theme') {
      expect(e.theme).toBeUndefined(); // não troca
      const joined = e.note.lines.join('\n');
      expect(joined).toContain('aluy-dark');
      expect(joined).toContain('aluy-light');
      expect(joined).toContain('● aluy-dark'); // marca o ativo
    }
  });

  it('`/theme light` ⇒ troca p/ aluy-light', () => {
    const e = buildThemeEffect('light', 'aluy-dark');
    expect(e.kind).toBe('theme');
    if (e.kind === 'theme') {
      expect(e.theme).toBe('aluy-light');
      expect(e.note.lines.join(' ')).toContain('Aluy Light');
    }
  });

  it('`/theme aluy-dark` quando já é o ativo ⇒ não re-renderiza (theme undefined)', () => {
    const e = buildThemeEffect('aluy-dark', 'aluy-dark');
    expect(e.kind).toBe('theme');
    if (e.kind === 'theme') {
      expect(e.theme).toBeUndefined();
      expect(e.note.lines.join(' ')).toContain('já é');
    }
  });

  it('nome inválido ⇒ nota honesta, não troca', () => {
    const e = buildThemeEffect('solarized', 'aluy-dark');
    expect(e.kind).toBe('theme');
    if (e.kind === 'theme') {
      expect(e.theme).toBeUndefined();
      const joined = e.note.lines.join('\n');
      expect(joined).toContain('desconhecido');
      expect(joined).toContain('aluy-dark, aluy-light'); // lista os disponíveis
    }
  });
});

describe('runThemeLinear — não-TTY (§9)', () => {
  it('ignora o que não é /theme (devolve false)', () => {
    const { out } = makeOut();
    expect(runThemeLinear('faça um café', out, { currentTheme: 'aluy-dark' })).toBe(false);
    expect(runThemeLinear('/model', out, { currentTheme: 'aluy-dark' })).toBe(false);
  });

  it('`/theme` lista os temas marcando o ativo', () => {
    const { out, text } = makeOut();
    const handled = runThemeLinear('/theme', out, { currentTheme: 'aluy-light' });
    expect(handled).toBe(true);
    const t = text();
    expect(t).toContain('[theme]');
    expect(t).toContain('aluy-dark');
    expect(t).toContain('● aluy-light'); // ativo
  });

  it('`/theme dark` registra a troca pretendida', () => {
    const { out, text } = makeOut();
    const handled = runThemeLinear('/theme dark', out, { currentTheme: 'aluy-light' });
    expect(handled).toBe(true);
    expect(text()).toContain('Aluy Dark');
  });

  it('`/theme nope` ⇒ nota de desconhecido (não quebra)', () => {
    const { out, text } = makeOut();
    expect(runThemeLinear('/theme nope', out, { currentTheme: 'aluy-dark' })).toBe(true);
    expect(text().toLowerCase()).toContain('desconhecido');
  });
});

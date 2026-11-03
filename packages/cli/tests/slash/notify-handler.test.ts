// `/notify tudo|atencao|nada` (+ aliases legados on/off) resolve o modo + nota neutra.

import { describe, expect, it } from 'vitest';
import { buildNotifyEffect } from '../../src/slash/handlers.js';

const st = { enabled: true, mode: 'tudo' as const, tty: true };

function run(arg: string, state: Parameters<typeof buildNotifyEffect>[1] = st) {
  const e = buildNotifyEffect(arg, state);
  if (e.kind !== 'notify') throw new Error('efeito inesperado');
  return e;
}

describe('buildNotifyEffect', () => {
  it.each([
    ['tudo', 'tudo'],
    ['atencao', 'atencao'],
    ['atenção', 'atencao'],
    ['nada', 'nada'],
    ['NADA', 'nada'],
    ['on', 'tudo'],
    ['ligar', 'tudo'],
    ['off', 'nada'],
    ['desligar', 'nada'],
  ])('`%s` ⇒ %s', (arg, expected) => {
    expect(run(arg).mode).toBe(expected);
  });

  it('sem argumento NÃO muda o modo: mostra o atual e as opções', () => {
    const e = run('', { enabled: true, mode: 'atencao', tty: true });
    expect(e.mode).toBeUndefined();
    const txt = e.note.lines.join('\n');
    expect(txt).toContain('notificações: atencao');
    expect(txt).toContain('tudo');
    expect(txt).toContain('nada');
  });

  it('argumento desconhecido não muda e avisa', () => {
    const e = run('banana');
    expect(e.mode).toBeUndefined();
    expect(e.note.lines.join('\n')).toContain('desconhecido');
  });

  it('a nota é NEUTRA e descreve o modo', () => {
    const txt = run('atencao').note.lines.join('\n').toLowerCase();
    expect(txt).toContain('precisa de você');
    expect(txt).toContain('turno concluído');
  });

  it('sem TTY ⇒ avisa que o sino não soa ali (preferência ainda registrada)', () => {
    const e = run('tudo', { enabled: false, mode: 'nada', tty: false });
    expect(e.mode).toBe('tudo');
    expect(e.note.lines.join('\n').toLowerCase()).toContain('sem tty');
  });
});

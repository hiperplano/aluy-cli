// `/notify all|attention|off` (+ aliases legados on/off) resolve o modo + nota neutra.

import { describe, expect, it } from 'vitest';
import { buildNotifyEffect } from '../../src/slash/handlers.js';

const st = { enabled: true, mode: 'all' as const, tty: true };

function run(arg: string, state: Parameters<typeof buildNotifyEffect>[1] = st) {
  const e = buildNotifyEffect(arg, state);
  if (e.kind !== 'notify') throw new Error('efeito inesperado');
  return e;
}

describe('buildNotifyEffect', () => {
  it.each([
    ['all', 'all'],
    ['attention', 'attention'],
    ['atenção', 'attention'],
    ['off', 'off'],
    ['tudo', 'all'],
    ['atencao', 'attention'],
    ['nada', 'off'],
    ['NADA', 'off'],
    ['on', 'all'],
    ['ligar', 'all'],
    ['desligar', 'off'],
  ])('`%s` ⇒ %s', (arg, expected) => {
    expect(run(arg).mode).toBe(expected);
  });

  it('sem argumento NÃO muda o modo: mostra o atual e as opções', () => {
    const e = run('', { enabled: true, mode: 'attention', tty: true });
    expect(e.mode).toBeUndefined();
    const txt = e.note.lines.join('\n');
    expect(txt).toContain('notificações: attention');
    expect(txt).toContain('all');
    expect(txt).toContain('off');
  });

  it('argumento desconhecido não muda e avisa', () => {
    const e = run('banana');
    expect(e.mode).toBeUndefined();
    expect(e.note.lines.join('\n')).toContain('desconhecido');
  });

  it('a nota é NEUTRA e descreve o modo', () => {
    const txt = run('attention').note.lines.join('\n').toLowerCase();
    expect(txt).toContain('precisa de você');
    expect(txt).toContain('turno concluído');
  });

  it('sem TTY ⇒ avisa que o sino não soa ali (preferência ainda registrada)', () => {
    const e = run('all', { enabled: false, mode: 'off', tty: false });
    expect(e.mode).toBe('all');
    expect(e.note.lines.join('\n').toLowerCase()).toContain('sem tty');
  });
});

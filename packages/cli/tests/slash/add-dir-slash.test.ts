// EST-0982 · /add-dir — o SLASH (ato do USUÁRIO): registro no menu, roteamento e
// o fallback do buildSlashEffect (não-TTY sem wiring). A execução REAL (workspace
// multi-raiz) é provada no add-dir-smoke.test.ts; aqui é a superfície de comando.

import { describe, expect, it } from 'vitest';
import { NATIVE_COMMANDS, routeInput, filterCommands } from '../../src/slash/commands.js';
import { buildSlashEffect, runAddDir, type AddDirWorkspace } from '../../src/slash/handlers.js';

const CTX = { usage: { tokens: 0, windowPct: 0, tier: 'aluy-flux' } };

describe('EST-0982 · /add-dir — registro e roteamento', () => {
  it('está registrado como comando nativo (seção workspace)', () => {
    const cmd = NATIVE_COMMANDS.find((c) => c.id === 'add-dir');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('add-dir');
    expect(cmd!.section).toBe('workspace');
    expect(cmd!.summary).toMatch(/diretório|raiz/i);
  });

  it('routeInput roteia `/add-dir <path>` com os args', () => {
    const r = routeInput('/add-dir /tmp/extra');
    expect(r.kind).toBe('command');
    if (r.kind !== 'command') throw new Error('esperava command');
    expect(r.command.id).toBe('add-dir');
    expect(r.args).toBe('/tmp/extra');
  });

  it('routeInput roteia `/add-dir` sem args (lista)', () => {
    const r = routeInput('/add-dir');
    expect(r.kind).toBe('command');
    if (r.kind !== 'command') throw new Error('esperava command');
    expect(r.args).toBe('');
  });

  it('aparece no slash-menu filtrável (`/add` acha o /add-dir)', () => {
    const hits = filterCommands('add');
    expect(hits.some((e) => e.kind === 'command' && e.command.id === 'add-dir')).toBe(true);
  });

  it('fallback do buildSlashEffect explica o comando (e que é ato do usuário)', () => {
    const eff = buildSlashEffect('add-dir', CTX);
    expect(eff.kind).toBe('note');
    if (eff.kind !== 'note') throw new Error('esperava note');
    const text = eff.note.lines.join('\n');
    expect(text).toContain('/add-dir <path>');
    expect(text).toMatch(/auto-ampliar/);
  });
});

describe('EST-0982 · /add-dir — runAddDir (handler puro sobre a face do workspace)', () => {
  /** Fake da face estreita (sem fs): registra a chamada e simula o workspace. */
  function fakeWorkspace(initial: string[] = ['/proj']): AddDirWorkspace & { calls: string[] } {
    const roots = [...initial];
    const calls: string[] = [];
    return {
      calls,
      get roots(): readonly string[] {
        return [...roots];
      },
      addRoot(requested: string): string {
        calls.push(requested);
        if (requested.includes('inexistente')) {
          throw new Error(`não foi possível autorizar "${requested}": o diretório não existe`);
        }
        if (!roots.includes(requested)) roots.push(requested);
        return requested;
      },
    };
  }

  it('sem args lista as raízes com a primária marcada (e não chama addRoot)', () => {
    const ws = fakeWorkspace(['/proj', '/extra']);
    const note = runAddDir('', ws, '/home/u');
    expect(ws.calls).toHaveLength(0);
    expect(note.lines[0]).toContain('raízes autorizadas');
    expect(note.lines[1]).toContain('/proj');
    expect(note.lines[1]).toContain('(raiz do workspace)');
    expect(note.lines[2]).toContain('/extra');
  });

  it('com path adiciona e confirma com o ✓ (escopo de sessão explícito)', () => {
    const ws = fakeWorkspace();
    const note = runAddDir('/extra', ws, '/home/u');
    expect(ws.calls).toEqual(['/extra']);
    expect(note.lines[0]).toContain('✓ /extra adicionado');
    expect(note.lines.join('\n')).toMatch(/sessão/i);
  });

  it('abrevia a home p/ ~ na exibição (legibilidade)', () => {
    const ws = fakeWorkspace();
    const note = runAddDir('/home/u/projects/aluy', ws, '/home/u');
    expect(note.lines[0]).toContain('✓ ~/projects/aluy adicionado');
  });

  it('path inválido ⇒ repassa o motivo claro e orienta o uso', () => {
    const ws = fakeWorkspace();
    const note = runAddDir('/tmp/inexistente', ws, '/home/u');
    expect(note.lines[0]).toContain('não existe');
    expect(note.lines[1]).toContain('uso: /add-dir <path>');
  });

  it('já autorizado ⇒ nota idempotente', () => {
    const ws = fakeWorkspace(['/proj', '/extra']);
    const note = runAddDir('/extra', ws, '/home/u');
    expect(note.lines[0]).toContain('já está autorizado');
  });
});

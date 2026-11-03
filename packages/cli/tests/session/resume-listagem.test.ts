// Auditoria — a lista "outras sessões" da oferta de retomada: só deste projeto (cwd), só as que
// têm o que mostrar (título ou nome), no máximo HISTORY_LIST_LIMIT, e o texto da oferta textual
// leva o nome entre «».

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import { listProjectSessions } from '../../src/session/resume.js';
import { HISTORY_LIST_LIMIT } from '../../src/session/history.js';
import { formatResumeOffer } from '../../src/session/session-persist.js';
import type { SessionBlock } from '../../src/session/model.js';

const you: SessionBlock = { kind: 'you', text: 'oi' };
const aluy: SessionBlock = { kind: 'aluy', text: 'olá', streaming: false };

let base: string;
let store: SessionStore;
let relogio = 1000;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'aluy-resume-lista-'));
  relogio = 1000;
  store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => relogio });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const salvar = (id: string, cwd: string, extra: Record<string, unknown> = {}): void => {
  relogio += 10;
  store.save({ id, cwd, tier: 't', blocks: [you, aluy], ...extra });
};

describe('listProjectSessions', () => {
  it('só as sessões do cwd pedido', () => {
    salvar('a', '/p', { label: 'api' });
    salvar('b', '/outro', { label: 'blog' });
    expect(listProjectSessions(store, '/p').map((s) => s.id)).toEqual(['a']);
  });

  it('sessão sem título e sem nome não entra (não há o que mostrar)', () => {
    salvar('vazia', '/p', { blocks: [] });
    salvar('nomeada', '/p', { label: 'api' });
    const ids = listProjectSessions(store, '/p').map((s) => s.id);
    expect(ids).toContain('nomeada');
    expect(ids).not.toContain('vazia');
  });

  it('respeita o teto de itens da lista', () => {
    for (let i = 0; i < HISTORY_LIST_LIMIT + 5; i++)
      salvar(`s${String(i)}`, '/p', { label: `n${String(i)}` });
    expect(listProjectSessions(store, '/p')).toHaveLength(HISTORY_LIST_LIMIT);
  });

  it('falha do store ⇒ lista vazia (a oferta não quebra o boot)', () => {
    const quebrado = {
      list: () => {
        throw new Error('disco');
      },
    } as unknown as SessionStore;
    expect(listProjectSessions(quebrado, '/p')).toEqual([]);
  });
});

describe('formatResumeOffer · nome da sessão', () => {
  it('com nome: «nome» antes da contagem; sem nome ou só espaços: nada', () => {
    expect(formatResumeOffer(4, 60_000, 'minha-api')).toContain('«minha-api»');
    expect(formatResumeOffer(4, 60_000, '  ')).not.toContain('«');
    expect(formatResumeOffer(4, 60_000)).not.toContain('«');
    expect(formatResumeOffer(1, 60_000)).toContain('1 mensagem');
  });
});

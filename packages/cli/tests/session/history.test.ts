// EST-0972 — `/history`: navegar e RETOMAR uma sessão anterior DENTRO da sessão.
// Cobre a lógica PURA (sem Ink, sem broker): seleção das N recentes, formatação
// (data · cwd · 1ª msg, recente-first), a AÇÃO de retomada (reusa restoreBlocks +
// seedHistory), o fallback LINEAR (lista + aceita id), sessão vazia, store que lança.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import type { SessionRecord } from '../../src/io/session-store.js';
import type { SessionBlock } from '../../src/session/model.js';
import {
  selectHistorySessions,
  formatHistoryList,
  formatHistoryEntry,
  applyResumeRecord,
  runHistoryLinear,
  HISTORY_LIST_LIMIT,
  type ResumeApplyDeps,
} from '../../src/session/history.js';
import type { HistoryItem } from '@aluy/cli-core';

const you = (text: string): SessionBlock => ({ kind: 'you', text });
const aluy = (text: string): SessionBlock => ({ kind: 'aluy', text, streaming: false });
const note: SessionBlock = { kind: 'note', title: 'x', lines: ['y'] };

describe('selectHistorySessions (EST-0972)', () => {
  let base: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-history-'));
    clock = 1_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('SEM sessões ⇒ lista vazia', () => {
    expect(selectHistorySessions(store)).toEqual([]);
  });

  it('lista as sessões ORDENADAS das mais RECENTES p/ as antigas', () => {
    clock = 100;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you('oi')] });
    clock = 300;
    store.save({ id: 'c', cwd: '/p', tier: 't', blocks: [you('mais novo')] });
    clock = 200;
    store.save({ id: 'b', cwd: '/q', tier: 't', blocks: [you('meio')] });
    const got = selectHistorySessions(store);
    expect(got.map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('aplica o TETO (as N mais recentes)', () => {
    for (let i = 0; i < 5; i++) {
      clock = 1_000 + i;
      store.save({ id: `s${i}`, cwd: '/p', tier: 't', blocks: [you(`m${i}`)] });
    }
    const got = selectHistorySessions(store, 3);
    expect(got).toHaveLength(3);
    // as 3 mais recentes (s4, s3, s2).
    expect(got.map((s) => s.id)).toEqual(['s4', 's3', 's2']);
  });

  it('default = HISTORY_LIST_LIMIT', () => {
    for (let i = 0; i < HISTORY_LIST_LIMIT + 5; i++) {
      clock = 1_000 + i;
      store.save({ id: `s${i}`, cwd: '/p', tier: 't', blocks: [you(`m${i}`)] });
    }
    expect(selectHistorySessions(store)).toHaveLength(HISTORY_LIST_LIMIT);
  });

  it('FAIL-SAFE: store que LANÇA em list() ⇒ lista vazia (não derruba a TUI)', () => {
    const boom = {
      list: () => {
        throw new Error('disco explodiu');
      },
    };
    expect(selectHistorySessions(boom)).toEqual([]);
  });
});

describe('formatHistoryEntry / formatHistoryList (EST-0972)', () => {
  it('entrada = data · cwd ABREVIADO (home → ~) · 1ª mensagem', () => {
    const at = Date.UTC(2026, 5, 9, 12, 0); // só p/ ter um ms estável; a data local varia
    const line = formatHistoryEntry(
      { cwd: '/home/dev/proj/x', updatedAt: at, title: 'adicione o /history' },
      '/home/dev',
    );
    expect(line).toContain('~/proj/x');
    expect(line).toContain('adicione o /history');
    expect(line).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it('sem título ⇒ (sem objetivo)', () => {
    const line = formatHistoryEntry({ cwd: '/p', updatedAt: 1 }, '/home');
    expect(line).toContain('(sem objetivo)');
  });

  it('deriva o título dos BLOCOS quando dado um record (1ª fala `you`)', () => {
    const line = formatHistoryEntry(
      { cwd: '/p', updatedAt: 1, blocks: [note, you('primeira fala'), aluy('resposta')] },
      '/home',
    );
    expect(line).toContain('primeira fala');
  });

  it('lista VAZIA ⇒ "nenhuma sessão anterior."', () => {
    expect(formatHistoryList([])).toEqual(['nenhuma sessão anterior.']);
  });

  it('lista com sessões ⇒ id + metadados por sessão', () => {
    const lines = formatHistoryList(
      [{ id: 'abc', createdAt: 1, updatedAt: 2, cwd: '/p', tier: 't', blockCount: 2, title: 'oi' }],
      '/home',
    );
    expect(lines.join('\n')).toContain('abc');
    expect(lines.join('\n')).toContain('oi');
    expect(lines[0]).toContain('retome com');
  });
});

describe('applyResumeRecord (EST-0972 — RETOMA reusando restoreBlocks/seedHistory)', () => {
  const record: SessionRecord = {
    id: 'alvo',
    version: 1,
    createdAt: 1,
    updatedAt: 2,
    cwd: '/home/dev/proj',
    tier: 'aluy-strata',
    blocks: [you('pergunta antiga'), aluy('resposta antiga')],
  };

  function spyDeps() {
    const calls: {
      restored: (readonly SessionBlock[])[];
      seeded: (readonly HistoryItem[])[];
      switched: { id: string; cwd: string; tier: string }[];
      cleared: number;
      cwdSet: string[];
      order: string[];
    } = { restored: [], seeded: [], switched: [], cleared: 0, cwdSet: [], order: [] };
    const deps: ResumeApplyDeps = {
      restoreBlocks: (b) => {
        calls.restored.push(b as readonly SessionBlock[]);
        calls.order.push('restore');
      },
      seedHistory: (i) => {
        calls.seeded.push(i);
        calls.order.push('seed');
      },
      switchSession: (t) => {
        calls.switched.push(t);
        calls.order.push('switch');
      },
      setSessionCwd: (c) => calls.cwdSet.push(c),
      clearScreen: () => {
        calls.cleared++;
        calls.order.push('clear');
      },
    };
    return { calls, deps };
  }

  it('RESTAURA a transcrição + SEMEIA o contexto + TROCA o alvo do auto-save', () => {
    const { calls, deps } = spyDeps();
    applyResumeRecord(record, deps);
    // restaura os blocos exatos da sessão escolhida.
    expect(calls.restored).toHaveLength(1);
    expect(calls.restored[0]).toEqual(record.blocks);
    // semeia o contexto (lastRunHistory) reconstruído da transcrição (não-vazio).
    expect(calls.seeded).toHaveLength(1);
    expect(calls.seeded[0]!.length).toBeGreaterThan(0);
    // troca o alvo do auto-save p/ id/cwd/tier da sessão retomada.
    expect(calls.switched).toEqual([{ id: 'alvo', cwd: '/home/dev/proj', tier: 'aluy-strata' }]);
  });

  it('TROCA o alvo ANTES de restaurar/semear (1º auto-save já cai no arquivo certo)', () => {
    const { calls, deps } = spyDeps();
    applyResumeRecord(record, deps);
    expect(calls.order.indexOf('switch')).toBeLessThan(calls.order.indexOf('restore'));
    expect(calls.order.indexOf('switch')).toBeLessThan(calls.order.indexOf('seed'));
  });

  it('LIMPA a tela antes de pintar a transcrição retomada', () => {
    const { calls, deps } = spyDeps();
    applyResumeRecord(record, deps);
    expect(calls.cleared).toBe(1);
    expect(calls.order.indexOf('clear')).toBeLessThan(calls.order.indexOf('restore'));
  });

  it('espelha o cwd da sessão retomada (quando a porta existe)', () => {
    const { calls, deps } = spyDeps();
    applyResumeRecord(record, deps);
    expect(calls.cwdSet).toEqual(['/home/dev/proj']);
  });

  it('transcrição VAZIA ⇒ não semeia (nada a continuar), mas troca o alvo', () => {
    const { calls, deps } = spyDeps();
    applyResumeRecord({ ...record, blocks: [] }, deps);
    expect(calls.seeded).toHaveLength(0);
    expect(calls.switched).toHaveLength(1);
  });
});

describe('runHistoryLinear (EST-0972 — fallback NÃO-TTY)', () => {
  let base: string;
  let store: SessionStore;
  let clock: number;
  let out: string;
  const sink = { write: (s: string) => (out += s) };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-history-linear-'));
    clock = 1_000;
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => clock });
    out = '';
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('linha que NÃO é /history ⇒ não trata (devolve false)', () => {
    const handled = runHistoryLinear('explique o repo', sink, { store, resume: () => {} });
    expect(handled).toBe(false);
    expect(out).toBe('');
  });

  it('`/history` SEM id ⇒ LISTA as sessões (recente-first), não retoma', () => {
    clock = 100;
    store.save({ id: 'a', cwd: '/p', tier: 't', blocks: [you('antigo')] });
    clock = 200;
    store.save({ id: 'b', cwd: '/q', tier: 't', blocks: [you('novo')] });
    let resumed = false;
    const handled = runHistoryLinear('/history', sink, {
      store,
      resume: () => (resumed = true),
    });
    expect(handled).toBe(true);
    expect(resumed).toBe(false);
    // recente-first: a linha do id 'b' aparece antes da do id 'a'. Os ids saem numa
    // linha indentada própria (`[history]   <id>`) — casa o id isolado, não um 'a'/'b'
    // dentro de outra palavra ("anteriores").
    const idLine = (id: string): number => out.indexOf(`[history]   ${id}\n`);
    expect(idLine('b')).toBeGreaterThanOrEqual(0);
    expect(idLine('b')).toBeLessThan(idLine('a'));
    expect(out).toContain('novo');
  });

  it('`/history` SEM sessões ⇒ "nenhuma sessão anterior."', () => {
    const handled = runHistoryLinear('/history', sink, { store, resume: () => {} });
    expect(handled).toBe(true);
    expect(out).toContain('nenhuma sessão anterior');
  });

  it('`/history <id>` existente ⇒ RETOMA aquela sessão (chama resume com o record)', () => {
    store.save({ id: 'alvo', cwd: '/p', tier: 't', blocks: [you('q'), aluy('r')] });
    let got: SessionRecord | null = null;
    const handled = runHistoryLinear('/history alvo', sink, {
      store,
      resume: (rec) => (got = rec),
    });
    expect(handled).toBe(true);
    expect(got).not.toBeNull();
    expect(got!.id).toBe('alvo');
    expect(out).toContain('retomada');
  });

  it('`/history <id>` inexistente ⇒ avisa, NÃO retoma (fail-safe)', () => {
    let resumed = false;
    const handled = runHistoryLinear('/history fantasma', sink, {
      store,
      resume: () => (resumed = true),
    });
    expect(handled).toBe(true);
    expect(resumed).toBe(false);
    expect(out).toContain('não encontrada');
  });

  it('a listagem NUNCA vaza o corpo da transcrição (só metadados — CLI-SEC-6)', () => {
    store.save({
      id: 'a',
      cwd: '/p',
      tier: 't',
      blocks: [
        you('SEGREDO_NA_FALA'),
        {
          kind: 'tool',
          verb: 'read',
          target: 'x',
          result: 'ok',
          status: 'err',
          output: 'CONTEUDO_SENSIVEL',
        } as SessionBlock,
      ],
    });
    runHistoryLinear('/history', sink, { store, resume: () => {} });
    // a 1ª fala (título) PODE aparecer (é o rótulo), mas o detalhe de tool NÃO.
    expect(out).not.toContain('CONTEUDO_SENSIVEL');
  });
});

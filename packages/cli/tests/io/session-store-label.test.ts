// EST-0972 (rename) — persistência do RÓTULO + COR de identificação no record.
//
// DoD:
//   - save com label+labelColor ⇒ load round-trip preserva ambos;
//   - cor SEM rótulo ⇒ NÃO grava a cor (cor sem nome não faz sentido);
//   - sem rótulo ⇒ record sem os campos (não polui);
//   - list() (resumo do /history) carrega o rótulo+cor;
//   - rótulo saneado na escrita E na leitura (controle/teto — defesa de record adulterado);
//   - rótulo+cor são DADO DE UI (HG-2) — coexistem com o slug Custom (tier/model) sem colidir.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import type { SessionBlock } from '../../src/session/model.js';

const you: SessionBlock = { kind: 'you', text: 'olá' };

describe('SessionStore — rótulo + cor (EST-0972 rename)', () => {
  let base: string;
  let store: SessionStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-sess-label-'));
    store = new SessionStore({ baseDir: join(base, '.aluy'), now: () => 1000 });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('save com label+labelColor ⇒ round-trip preserva ambos', () => {
    store.save({
      id: 's1',
      cwd: '/p',
      tier: 't',
      label: 'projeto-x',
      labelColor: 'azul',
      blocks: [you],
    });
    const rec = store.load('s1')!;
    expect(rec.label).toBe('projeto-x');
    expect(rec.labelColor).toBe('azul');
  });

  it('cor SEM rótulo ⇒ NÃO grava a cor (cor exige nome)', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', labelColor: 'azul', blocks: [you] });
    const rec = store.load('s1')!;
    expect(rec.label).toBeUndefined();
    expect(rec.labelColor).toBeUndefined();
  });

  it('sem rótulo ⇒ os campos NÃO existem no record (não polui)', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', blocks: [you] });
    const rec = store.load('s1')!;
    expect('label' in rec).toBe(false);
    expect('labelColor' in rec).toBe(false);
  });

  it('list() (resumo do /history) carrega rótulo + cor', () => {
    store.save({
      id: 's1',
      cwd: '/p',
      tier: 't',
      label: 'meu-app',
      labelColor: 'verde',
      blocks: [you],
    });
    const sum = store.list()[0]!;
    expect(sum.label).toBe('meu-app');
    expect(sum.labelColor).toBe('verde');
  });

  it('rótulo é SANEADO na escrita (controle vira espaço, colapsa, apara)', () => {
    store.save({ id: 's1', cwd: '/p', tier: 't', label: '  meu\tprojeto\n  ', blocks: [you] });
    const rec = store.load('s1')!;
    expect(rec.label).toBe('meu projeto');
  });

  it('record adulterado com label gigante ⇒ truncado na leitura (defesa de I/O)', () => {
    mkdirSync(store.sessionsDir, { recursive: true });
    const forged = {
      id: 's1',
      version: 1,
      createdAt: 1,
      updatedAt: 1,
      cwd: '/p',
      tier: 't',
      label: 'x'.repeat(5000),
      labelColor: 'azul',
      blocks: [you],
    };
    writeFileSync(store.pathFor('s1'), JSON.stringify(forged), 'utf8');
    const rec = store.load('s1')!;
    expect(rec.label!.length).toBeLessThanOrEqual(64);
  });

  it('rótulo+cor COEXISTEM com o slug Custom (tier/model) — naturezas distintas', () => {
    store.save({
      id: 's1',
      cwd: '/p',
      tier: 'custom',
      model: 'algum/modelo-livre',
      label: 'sessao-custom',
      labelColor: 'rosa',
      blocks: [you],
    });
    const rec = store.load('s1')!;
    expect(rec.tier).toBe('custom');
    expect(rec.model).toBe('algum/modelo-livre');
    expect(rec.label).toBe('sessao-custom');
    expect(rec.labelColor).toBe('rosa');
  });
});

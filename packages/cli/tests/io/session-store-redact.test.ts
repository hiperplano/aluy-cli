// EST-SEC-HARDEN (F23) · AG-0008 — REDAÇÃO at-rest NO SINK do SessionStore.
//
// Prova end-to-end (sobre tmpdir — nunca toca o ~/.aluy real):
//   1. um `read_file`/`grep` com segredo no output ⇒ o ARQUIVO no disco sai REDIGIDO
//      (o segredo NÃO está nos bytes persistidos);
//   2. `run_command` (bash) com texto NÃO é tocado pelo filtro do journal (a redação
//      dele é na origem; aqui não-regressão);
//   3. o `load`/`--resume` relê o conteúdo JÁ REDIGIDO (aceitável/desejável);
//   4. os BLOCOS PASSADOS pelo caller NÃO são mutados (in-session íntegro: o ciclo
//      read→write_file não quebra).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from '../../src/io/session-store.js';
import type { SessionBlock } from '../../src/session/model.js';

const SECRET = 'sk-DEADBEEF0123456789abcdef';

function readJournalBytes(aluyDir: string): string {
  const dir = join(aluyDir, 'sessions');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  return files.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
}

describe('SessionStore — redação at-rest do conteúdo-de-arquivo (F23)', () => {
  let base: string;
  let aluyDir: string;
  let store: SessionStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-f23-'));
    aluyDir = join(base, 'home', '.aluy');
    store = new SessionStore({ baseDir: aluyDir, now: () => 1000 });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('read_file com segredo ⇒ o arquivo no disco sai SEM o segredo', () => {
    const blocks: SessionBlock[] = [
      { kind: 'you', text: 'leia o .env' },
      {
        kind: 'tool',
        verb: 'read',
        target: '.env',
        result: '3 linhas',
        status: 'ok',
        output: `OPENAI_API_KEY=${SECRET}`,
      },
    ];
    expect(store.save({ id: 's1', cwd: '/p', tier: 't', blocks })).toBe(true);
    const bytes = readJournalBytes(aluyDir);
    expect(bytes).not.toContain(SECRET); // at-rest LIMPO.
    expect(bytes).toContain('read'); // mas o bloco continua lá (metadados intactos).
  });

  it('grep com hit de credencial ⇒ disco redigido', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'grep',
        target: '/key/',
        result: '1 hit',
        status: 'ok',
        output: `cfg.ini:9: api_key=${SECRET}`,
      },
    ];
    store.save({ id: 's2', cwd: '/p', tier: 't', blocks });
    expect(readJournalBytes(aluyDir)).not.toContain(SECRET);
  });

  it('NÃO MUTA os blocos do caller (in-session íntegro p/ read→write_file)', () => {
    const toolBlock: SessionBlock = {
      kind: 'tool',
      verb: 'read',
      target: '.env',
      result: 'ok',
      status: 'ok',
      output: `TOKEN=${SECRET}`,
    };
    const blocks: SessionBlock[] = [toolBlock];
    store.save({ id: 's3', cwd: '/p', tier: 't', blocks });
    // o objeto que o caller ainda segura permanece CRU (não redigimos a fonte viva):
    if (toolBlock.kind !== 'tool') throw new Error('esperado tool');
    expect(toolBlock.output).toContain(SECRET);
  });

  it('--resume relê o conteúdo JÁ REDIGIDO (aceitável)', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'read',
        target: '.env',
        result: 'ok',
        status: 'ok',
        output: `SECRET_KEY=${SECRET}`,
      },
    ];
    store.save({ id: 's4', cwd: '/p', tier: 't', blocks });
    const rec = store.load('s4');
    const b = rec?.blocks[0];
    if (b?.kind !== 'tool') throw new Error('esperado tool no resume');
    expect(b.output).not.toContain(SECRET);
  });

  it('run_command (bash) NÃO é alterado pelo filtro do journal (não-regressão)', () => {
    const blocks: SessionBlock[] = [
      {
        kind: 'tool',
        verb: 'bash',
        target: 'echo oi',
        result: 'exit 0',
        status: 'ok',
        output: 'oi',
      },
    ];
    store.save({ id: 's5', cwd: '/p', tier: 't', blocks });
    const rec = store.load('s5');
    const b = rec?.blocks[0];
    if (b?.kind !== 'tool') throw new Error('esperado tool');
    expect(b.output).toBe('oi'); // intocado.
    expect(b.result).toBe('exit 0');
  });
});

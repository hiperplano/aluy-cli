// EST-1011 (Bug 7 do bug-hunt — `session-store.save` sem cap ⇒ sessão irrecuperável).
//
// Antes: `save()` não tinha teto sobre o record serializado; uma sessão LONGA gerava
// um arquivo > MAX_RECORD_BYTES (8 MiB). No `load`, `statSync > MAX_RECORD_BYTES`
// retorna null ⇒ a sessão SUMIA no `--resume` (o store escrevia o que nunca releria).
// Agora: no `save`, se o body exceder o cap, descarta os blocos mais ANTIGOS (mantém
// a CAUDA — o contexto recente) até caber. O arquivo gravado é SEMPRE legível.
//
// Não regride o resume (#77 / EST-0972): sessão normal salva+relê idêntica.
// Tudo sobre tmpdir (baseDir injetado) — a suíte NUNCA toca o `~/.aluy/` real.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, statSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore, SESSIONS_DIRNAME } from '../../src/io/session-store.js';
import type { SessionBlock } from '../../src/session/model.js';

const youHi: SessionBlock = { kind: 'you', text: 'olá mundo' };
const aluyHi: SessionBlock = { kind: 'aluy', text: 'oi!', streaming: false };

/** Um bloco `aluy` de ~`kb` KiB de texto, marcado com um índice rastreável. */
function bigBlock(idx: number, kb: number): SessionBlock {
  return { kind: 'aluy', text: `#${idx}:` + 'A'.repeat(kb * 1024), streaming: false };
}

const MAX_RECORD_BYTES = 8 * 1024 * 1024; // espelha o teto de LEITURA do store.

describe('EST-1011 · SessionStore — cap de escrita (Bug 7)', () => {
  let base: string;
  let aluyDir: string;
  let store: SessionStore;
  let clock: number;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-sess-cap-'));
    aluyDir = join(base, 'home', '.aluy');
    clock = 1_000;
    store = new SessionStore({ baseDir: aluyDir, now: () => clock });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('sessão GIGANTE salva e RELÊ (não some no --resume); cabe no cap de leitura', () => {
    // ~12 MiB de blocos (bem acima do teto de 8 MiB): 24 blocos de 512 KiB.
    const blocks: SessionBlock[] = [];
    for (let i = 0; i < 24; i++) blocks.push(bigBlock(i, 512));

    expect(store.save({ id: 'big', cwd: '/w', tier: 'aluy-flux', blocks })).toBe(true);

    // O ARQUIVO gravado cabe no teto de leitura (antes: > 8 MiB ⇒ load null ⇒ sumia).
    const size = statSync(store.pathFor('big')).size;
    expect(size).toBeLessThanOrEqual(MAX_RECORD_BYTES);

    // E o `load` (o caminho do --resume) devolve a sessão — NÃO null.
    const rec = store.load('big');
    expect(rec).not.toBeNull();
    expect(rec!.blocks.length).toBeGreaterThan(0);
  });

  it('mantém a CAUDA recente — o último bloco sobrevive, os mais antigos são podados', () => {
    const blocks: SessionBlock[] = [];
    for (let i = 0; i < 30; i++) blocks.push(bigBlock(i, 512)); // ~15 MiB
    store.save({ id: 'tail', cwd: '/w', tier: 'aluy-flux', blocks });

    const rec = store.load('tail')!;
    const texts = rec.blocks.map((b) => (b.kind === 'aluy' ? b.text.slice(0, 6) : ''));
    // O ÚLTIMO bloco (#29) — o contexto mais recente — está preservado.
    expect(texts.some((t) => t.startsWith('#29:'))).toBe(true);
    // Um bloco bem ANTIGO (#0) foi descartado p/ caber.
    expect(texts.some((t) => t.startsWith('#0:'))).toBe(false);
    // Houve poda de fato (não guardou os 30).
    expect(rec.blocks.length).toBeLessThan(30);
  });

  it('round-trip NORMAL não regride (#77/EST-0972) — sessão pequena salva idêntica', () => {
    const blocks = [youHi, aluyHi];
    expect(store.save({ id: 's-ok', cwd: '/proj', tier: 'aluy-deep', blocks })).toBe(true);
    const rec = store.load('s-ok')!;
    expect(rec.blocks).toEqual([youHi, aluyHi]);
    expect(rec.tier).toBe('aluy-deep');
    expect(rec.cwd).toBe('/proj');
  });

  it('preserva os metadados (id/cwd/tier) mesmo quando poda blocos', () => {
    const blocks: SessionBlock[] = [youHi];
    for (let i = 0; i < 24; i++) blocks.push(bigBlock(i, 512));
    store.save({ id: 'meta', cwd: '/home/x', tier: 'custom', model: 'foo/bar', blocks });
    const rec = store.load('meta')!;
    // mesmo podando blocos, os metadados de sessão ficam íntegros (resume funciona).
    expect(rec.id).toBe('meta');
    expect(rec.cwd).toBe('/home/x');
    expect(rec.tier).toBe('custom');
    expect(rec.model).toBe('foo/bar');
  });
});

// ── EST-0972 (resume de sessão GRANDE não-zera) — recuperação no LADO DO LOAD ─────────
//
// O fix de escrita (EST-1011) cobre o que ESTE store grava. Mas um arquivo que JÁ está
// no disco acima do teto-alvo (legado pré-EST-1011, gravado por outra versão, ou margem
// de escrita insuficiente) ainda caía em `load → null` ⇒ a sessão SUMIA no
// --resume/--continue/auto-resume (todos passam por `load`/`latestForCwd`). Agora o
// `load` de um record grande RECUPERA A CAUDA (fitBlocks) + uma NOTA honesta — em vez
// de descartar a sessão inteira. O arquivo no disco NÃO é alterado pelo load (CLI-SEC-6).

describe('EST-0972 · SessionStore.load — record GRANDE no disco não zera a sessão', () => {
  let base: string;
  let aluyDir: string;
  let store: SessionStore;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-sess-load-'));
    aluyDir = join(base, 'home', '.aluy');
    store = new SessionStore({ baseDir: aluyDir, now: () => 1_000 });
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  /** Grava um arquivo de sessão CRU (sem passar pelo cap de escrita do store). */
  function writeRawRecord(id: string, blocks: SessionBlock[]): void {
    const dir = join(aluyDir, SESSIONS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const record = {
      id,
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      cwd: '/w',
      tier: 'aluy-flux',
      blocks,
    };
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(record) + '\n');
  }

  it('record > teto-alvo (legado): HOJE seria null; com o fix carrega a CAUDA + nota', () => {
    // ~10 MiB no disco (acima do alvo de 8 MiB, abaixo do teto-duro de 64 MiB):
    // 20 blocos de 512 KiB gravados CRUS (como um arquivo legado pré-EST-1011).
    const blocks: SessionBlock[] = [];
    for (let i = 0; i < 20; i++) blocks.push(bigBlock(i, 512));
    writeRawRecord('legacy-big', blocks);

    // Prova que o arquivo realmente excede o teto-alvo (senão o teste não exercita o ramo).
    const size = statSync(store.pathFor('legacy-big')).size;
    expect(size).toBeGreaterThan(8 * 1024 * 1024);

    // ANTES do fix: load devolvia null ⇒ a sessão SUMIA. AGORA: não é null.
    const rec = store.load('legacy-big');
    expect(rec).not.toBeNull();
    // A CAUDA recente (#19) sobrevive; um bloco bem antigo (#0) foi omitido.
    const texts = rec!.blocks.map((b) => (b.kind === 'aluy' ? b.text.slice(0, 6) : ''));
    expect(texts.some((t) => t.startsWith('#19:'))).toBe(true);
    expect(texts.some((t) => t.startsWith('#0:'))).toBe(false);
    // E há uma NOTA honesta de truncamento (UI; blocksToHistory a ignora — não vira contexto).
    const note = rec!.blocks.find((b) => b.kind === 'note');
    expect(note).toBeDefined();
    expect(note!.kind === 'note' && note!.title.toLowerCase()).toContain('contexto antigo');
  });

  it('o load NÃO reescreve o arquivo grande no disco (formato at-rest intacto — CLI-SEC-6)', () => {
    const blocks: SessionBlock[] = [];
    for (let i = 0; i < 20; i++) blocks.push(bigBlock(i, 512));
    writeRawRecord('legacy-big2', blocks);
    const before = statSync(store.pathFor('legacy-big2')).size;
    store.load('legacy-big2');
    const after = statSync(store.pathFor('legacy-big2')).size;
    expect(after).toBe(before); // load não toca o disco.
  });

  it('record menor que o teto-alvo NÃO ganha nota (caso comum inalterado)', () => {
    writeRawRecord('small', [youHi, aluyHi]);
    const rec = store.load('small')!;
    expect(rec.blocks).toEqual([youHi, aluyHi]);
    expect(rec.blocks.some((b) => b.kind === 'note')).toBe(false);
  });

  it('arquivo ALÉM do teto-DURO recai no fail-safe null (anti-DoS preservado)', () => {
    const dir = join(aluyDir, SESSIONS_DIRNAME);
    mkdirSync(dir, { recursive: true });
    // > 64 MiB de lixo: o load NÃO traz isso p/ a RAM — devolve null como antes.
    writeFileSync(join(dir, 'huge.json'), 'x'.repeat(64 * 1024 * 1024 + 1024));
    expect(store.load('huge')).toBeNull();
  });
});

// EST-1010 — `readBounded` aplica o teto ANTES de materializar o arquivo.
// PROVA de leitura parcial (stat-then-partial): um arquivo MUITO maior que o teto
// é lido só até `maxBytes` — o conteúdo devolvido tem EXATAMENTE `maxBytes` e o
// `totalBytes` reflete o tamanho real (>> teto). Não materializa o todo.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBounded, type RangeStreamFactory } from '../../src/io/read-bounded.js';

describe('readBounded — teto ANTES de materializar (anti-OOM)', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'aluy-bounded-'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(base, { recursive: true, force: true });
  });

  it('arquivo PEQUENO (≤ teto) ⇒ conteúdo íntegro, truncated=false', async () => {
    const path = join(base, 'small.txt');
    writeFileSync(path, 'hello world\n');
    const r = await readBounded(path, 1024);
    expect(r.content).toBe('hello world\n');
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(12);
  });

  it('arquivo GRANDE (> teto) ⇒ lê SÓ `maxBytes`, truncated=true, totalBytes real', async () => {
    const path = join(base, 'big.txt');
    // 1 MiB de 'A' — bem maior que o teto de 100 bytes.
    const totalBytes = 1024 * 1024;
    writeFileSync(path, Buffer.alloc(totalBytes, 0x41));
    const maxBytes = 100;
    const r = await readBounded(path, maxBytes);
    expect(r.truncated).toBe(true);
    expect(r.totalBytes).toBe(totalBytes);
    // PROVA de leitura parcial: o conteúdo tem EXATAMENTE `maxBytes` (não 1 MiB).
    expect(Buffer.byteLength(r.content, 'utf8')).toBe(maxBytes);
    expect(r.content).toBe('A'.repeat(maxBytes));
  });

  it('PROVA que NÃO materializa o todo: o stream para no teto (end: maxBytes-1)', async () => {
    // Instrumenta o `data` de um stream REAL p/ provar que o nº de bytes empurrados
    // ao heap é LIMITADO ao teto — nunca o arquivo inteiro. É a garantia anti-OOM: o
    // kernel para de empurrar no `end`, então um arquivo de 5 MiB só entrega 64 KiB.
    const path = join(base, 'huge.txt');
    const totalBytes = 5 * 1024 * 1024; // 5 MiB
    writeFileSync(path, Buffer.alloc(totalBytes, 0x42));
    const maxBytes = 64 * 1024; // 64 KiB

    let bytesPushed = 0;
    const open = vi.fn<RangeStreamFactory>((p, range) => {
      // O port DEVE pedir `end: maxBytes - 1` — não o arquivo inteiro.
      expect(range).toEqual({ start: 0, end: maxBytes - 1 });
      const s = createReadStream(p, range);
      s.on('data', (c: Buffer) => {
        bytesPushed += c.byteLength;
      });
      return s;
    });

    const r = await readBounded(path, maxBytes, open);
    expect(open).toHaveBeenCalledTimes(1);
    // Total de bytes que SAÍRAM do disco p/ o heap = só o teto (não os 5 MiB).
    expect(bytesPushed).toBe(maxBytes);
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(r.content, 'utf8')).toBe(maxBytes);
    expect(r.totalBytes).toBe(totalBytes);
  });

  it('arquivo VAZIO ⇒ string vazia, truncated=false, sem stream com end:-1', async () => {
    const path = join(base, 'empty.txt');
    writeFileSync(path, '');
    const r = await readBounded(path, 1024);
    expect(r.content).toBe('');
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(0);
  });

  it('arquivo EXATAMENTE no teto ⇒ íntegro, truncated=false', async () => {
    const path = join(base, 'exact.txt');
    writeFileSync(path, Buffer.alloc(256, 0x43));
    const r = await readBounded(path, 256);
    expect(r.truncated).toBe(false);
    expect(r.totalBytes).toBe(256);
    expect(Buffer.byteLength(r.content, 'utf8')).toBe(256);
  });

  // EST-1010 (BUG-0021) — binário (NUL no prefixo) ⇒ binary=true, content vazio
  // (o caller monta a observação; não decodifica mojibake).
  it('arquivo BINÁRIO (NUL no prefixo) ⇒ binary=true, content vazio, totalBytes real', async () => {
    const path = join(base, 'blob.bin');
    const bytes = Buffer.from([0x01, 0x02, 0x00, 0x03, 0xff, 0x00, 0x7f]);
    writeFileSync(path, bytes);
    const r = await readBounded(path, 1024);
    expect(r.binary).toBe(true);
    expect(r.content).toBe('');
    expect(r.totalBytes).toBe(bytes.byteLength);
  });

  it('arquivo TEXTO (sem NUL) ⇒ binary=false (não falso-positivo)', async () => {
    const path = join(base, 'text.txt');
    writeFileSync(path, 'puro texto, sem nul\n', 'utf8');
    const r = await readBounded(path, 1024);
    expect(r.binary).toBe(false);
    expect(r.content).toBe('puro texto, sem nul\n');
  });

  // BUG-0021 (correção) — o sniff de binário do `readBounded` deve varrer TODO o
  // buffer lido (até `maxBytes`), não só os primeiros 8 KiB. Um binário com
  // cabeçalho ASCII longo (NUL só após 8 KiB) era decodificado como texto e
  // despejava NUL/mojibake no conteúdo. Como o buffer já está no teto anti-OOM,
  // varrer tudo é barato e correto.
  it('binário com NUL só APÓS 8 KiB (cabeçalho ASCII longo) ⇒ binary=true, content vazio', async () => {
    const path = join(base, 'late-nul.bin');
    const header = Buffer.from('A'.repeat(9000), 'ascii'); // > 8 KiB de prefixo limpo
    const tail = Buffer.from([0x00, 0x01, 0xff, 0x00]);
    writeFileSync(path, Buffer.concat([header, tail]));
    const r = await readBounded(path, 5 * 1024 * 1024);
    expect(r.binary).toBe(true);
    expect(r.content).toBe('');
    // nenhum NUL cru escapou pro conteúdo.
    expect(r.content.includes(String.fromCharCode(0))).toBe(false);
  });
});

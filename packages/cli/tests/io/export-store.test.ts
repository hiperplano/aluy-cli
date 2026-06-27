// EST-1013 — cobertura de ExportStore (write atômico, sanitização, fail-safe, writeExport).
//
// Usa tmpdir real (mkdtempSync) p/ isolar os efeitos colaterais de I/O.
// Nenhum mock — testa o código real contra o sistema de arquivos real.

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { ExportStore, writeExport } from '../../src/io/export-store.js';

/** Cria um tmpdir isolado p/ cada teste. */
function makeBaseDir(): string {
  return mkdtempSync(join(tmpdir(), 'aluy-exp-'));
}

describe('ExportStore', () => {
  let baseDir: string;

  afterEach(() => {
    // cleanup opcional — o tmpdir do SO é volátil; não falhamos se falhar.
    baseDir = '';
  });

  // ── A) HAPPY ──────────────────────────────────────────────────────────────
  it('grava arquivo atomico com sessionId e retorna ok:true + path valido', () => {
    baseDir = makeBaseDir();
    const now = () => new Date('2026-01-01T00:00:00Z');
    const s = new ExportStore({ baseDir, now });

    const r = s.write('# corpo', { sessionId: 's1' });

    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    // path deve comecar dentro de s.dir
    expect(r.path!.startsWith(s.dir)).toBe(true);
    // arquivo deve existir e conter o corpo
    expect(existsSync(r.path!)).toBe(true);
    const content = readFileSync(r.path!, 'utf-8');
    expect(content).toBe('# corpo');
  });

  // ── B) SANITIZE — path traversal ──────────────────────────────────────────
  it('sanitiza fileName com path traversal (basename apenas)', () => {
    baseDir = makeBaseDir();
    const s = new ExportStore({ baseDir });

    const r = s.write('x', { fileName: '../../etc/passwd' });

    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    // o path final DEVE estar DENTRO de s.dir (nunca escapa)
    expect(r.path!.startsWith(s.dir)).toBe(true);
    // o basename deve ser 'passwd.md' (o traversal é removido, extensão adicionada)
    expect(basename(r.path!)).toBe('passwd.md');
  });

  // ── C) EXTENSAO — fileName sem .md ganha .md ──────────────────────────────
  it('adiciona extensao .md se fileName nao tem', () => {
    baseDir = makeBaseDir();
    const s = new ExportStore({ baseDir });

    const r = s.write('corpo', { fileName: 'meu-arquivo' });

    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    expect(basename(r.path!)).toBe('meu-arquivo.md');
  });

  // ── D) FAIL-SAFE CATCH — erro de escrita retorna ok:false sem lancar ──────
  it('retorna ok:false sem lancar quando escrita falha (EEXIST no tmp)', () => {
    baseDir = makeBaseDir();
    const s = new ExportStore({ baseDir });

    // Forçamos o erro de forma determinística: criamos um arquivo comum no
    // caminho do .tmp ANTES de chamar write, fazendo openSync(O_CREAT|O_EXCL)
    // falhar com EEXIST.
    const name = 'forcar-falha.md';
    const tmpPath = join(s.dir, name) + '.' + process.pid + '.tmp';

    // Garante que o diretório existe
    mkdirSync(s.dir, { recursive: true, mode: 0o700 });
    // Cria o arquivo .tmp ANTES — o write tentará O_EXCL e falhará
    writeFileSync(tmpPath, 'ocupado', { mode: 0o600 });

    const r = s.write('corpo', { fileName: name });

    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
    // Deve mencionar EEXIST ou "falha ao exportar"
    expect(r.error).toMatch(/falha ao exportar/i);
  });

  // ── D2) SHORT WRITE — drena em loop, NUNCA trunca reportando ok ────────────
  // REGRESSÃO: `writeSync` pode gravar MENOS bytes que o buffer e devolver quantos
  // gravou. Se o store ignorasse esse retorno (uma única chamada writeSync(fd,body)),
  // o export sairia TRUNCADO com ok:true. Aqui injetamos um writeChunk que grava no
  // máximo 4 bytes por chamada (short write) e exigimos o CORPO INTEIRO no arquivo.
  it('drena o corpo inteiro mesmo sob short write (nao trunca, nao mente ok)', () => {
    baseDir = makeBaseDir();
    // body multibyte + maior que o teto de chunk, p/ forçar várias passadas.
    const body = 'linha-1\nlinha-2 com acento é ç\nlinha-3 final ' + 'x'.repeat(50);
    let calls = 0;
    const shortWriteChunk = (fd: number, buf: Buffer, offset: number): number => {
      calls++;
      const remaining = buf.length - offset;
      const n = Math.min(4, remaining); // grava no MÁXIMO 4 bytes por vez
      // grava SÓ esse pedaço de fato no fd (efeito real no arquivo)
      return writeSync(fd, buf, offset, n);
    };
    const s = new ExportStore({ baseDir, writeChunk: shortWriteChunk });

    const r = s.write(body, { fileName: 'short.md' });

    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    // precisou de VÁRIAS passadas (prova que o teto de 4 bytes valeu)
    expect(calls).toBeGreaterThan(1);
    // o arquivo deve conter o corpo INTEIRO — nada truncado.
    const content = readFileSync(r.path!, 'utf-8');
    expect(content).toBe(body);
    expect(Buffer.byteLength(content, 'utf8')).toBe(Buffer.byteLength(body, 'utf8'));
  });

  // ── E) writeExport ────────────────────────────────────────────────────────
  it('writeExport delega ao store e retorna ok:true', () => {
    baseDir = makeBaseDir();
    const s = new ExportStore({ baseDir });

    const r = writeExport(s, 'corpo', {});

    expect(r.ok).toBe(true);
    expect(r.path).toBeDefined();
    expect(r.path!.startsWith(s.dir)).toBe(true);
    expect(existsSync(r.path!)).toBe(true);
    expect(readFileSync(r.path!, 'utf-8')).toBe('corpo');
  });
});

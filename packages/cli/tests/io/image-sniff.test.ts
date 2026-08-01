// ADR-0159 — testes da detecção FECHADA de mimetype de imagem por MAGIC BYTES
// (png/jpeg/gif/webp) + negativos (texto, PDF, zip, binário truncado/corrompido).

import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectImageMimeType, sniffImageMimeType } from '../../src/io/image-sniff.js';

// PNG: assinatura completa de 8 bytes + um IHDR mínimo (não precisa ser decodável —
// só a assinatura importa p/ a detecção).
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const GIF87_BYTES = Buffer.from('GIF87a', 'ascii');
const GIF89_BYTES = Buffer.from('GIF89a', 'ascii');
const WEBP_BYTES = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]), // tamanho (irrelevante p/ a detecção)
  Buffer.from('WEBP', 'ascii'),
]);

describe('detectImageMimeType — magic bytes (PURA)', () => {
  it('PNG (assinatura completa de 8 bytes) ⇒ image/png', () => {
    expect(detectImageMimeType(PNG_BYTES)).toBe('image/png');
  });

  it('JPEG (FF D8 FF) ⇒ image/jpeg', () => {
    expect(detectImageMimeType(JPEG_BYTES)).toBe('image/jpeg');
  });

  it('GIF87a ⇒ image/gif', () => {
    expect(detectImageMimeType(GIF87_BYTES)).toBe('image/gif');
  });

  it('GIF89a ⇒ image/gif', () => {
    expect(detectImageMimeType(GIF89_BYTES)).toBe('image/gif');
  });

  it('WEBP (contêiner RIFF + fourcc WEBP) ⇒ image/webp', () => {
    expect(detectImageMimeType(WEBP_BYTES)).toBe('image/webp');
  });

  it('texto puro (UTF-8) ⇒ null (não é imagem)', () => {
    expect(detectImageMimeType(Buffer.from('# Título\n\nConteúdo comum.', 'utf8'))).toBeNull();
  });

  it('PDF (%PDF-1.4) ⇒ null', () => {
    expect(detectImageMimeType(Buffer.from('%PDF-1.4\n%âãÏÓ\n', 'ascii'))).toBeNull();
  });

  it('ZIP (PK\\x03\\x04) ⇒ null', () => {
    expect(detectImageMimeType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]))).toBeNull();
  });

  it('binário TRUNCADO/CORROMPIDO (só os 4 primeiros bytes de PNG, sem o resto da assinatura) ⇒ null', () => {
    // Só os 4 primeiros bytes de PNG (sem completar os 8 da assinatura real) — não
    // deve casar: um binário genérico que só IMITA o prefixo continua rejeitado.
    expect(detectImageMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('RIFF sem fourcc WEBP (outro contêiner RIFF, ex.: WAV) ⇒ null', () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.from([0x24, 0x00, 0x00, 0x00]),
      Buffer.from('WAVE', 'ascii'),
    ]);
    expect(detectImageMimeType(wav)).toBeNull();
  });

  it('buffer vazio ⇒ null (sem throw)', () => {
    expect(detectImageMimeType(Buffer.alloc(0))).toBeNull();
  });
});

describe('sniffImageMimeType — leitura do PREFIXO do arquivo (I/O)', () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('lê só o prefixo de um PNG real e reconhece', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aluy-image-sniff-'));
    const p = join(dir, 'foto.png');
    writeFileSync(p, Buffer.concat([PNG_BYTES, Buffer.alloc(2000, 0x41)]));
    await expect(sniffImageMimeType(p)).resolves.toBe('image/png');
  });

  it('arquivo texto ⇒ null', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aluy-image-sniff-'));
    const p = join(dir, 'doc.txt');
    writeFileSync(p, 'não é imagem\n', 'utf8');
    await expect(sniffImageMimeType(p)).resolves.toBeNull();
  });

  it('arquivo inexistente ⇒ rejeita (propaga erro de I/O; o caller tem o próprio fail-safe)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'aluy-image-sniff-'));
    const p = join(dir, 'nao-existe.png');
    await expect(sniffImageMimeType(p)).rejects.toBeDefined();
  });
});

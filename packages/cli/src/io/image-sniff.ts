// ADR-0159 — reconhece os 4 mimetypes de IMAGEM que os adapters de modelo sabem
// serializar (openai-adapter.ts/anthropic-adapter.ts/broker-client.ts, fase 1 já
// implementada): png/jpeg/gif/webp. Lista FECHADA de propósito — não é sniff
// genérico de imagem (svg/bmp/tiff ficam de fora, seguem rejeitados como binário
// pelo `sniffBinaryFile`, igual hoje).
//
// Detecção por MAGIC BYTES (prefixo do arquivo), NUNCA por extensão — a extensão é
// spoofável (um `evil.exe` renomeado p/ `foto.png` não pode virar `ContentPart` de
// imagem só por causa do nome). Puro: opera sobre um `Buffer` já lido; a leitura do
// prefixo (I/O) é o `sniffImageMimeType` abaixo, mesmo padrão do `binary-sniff.ts`
// (stream com `end`, sem materializar o arquivo inteiro só p/ farejar).
//
// PNG usa a assinatura COMPLETA de 8 bytes (não só os 4 primeiros): um binário
// genérico que começa com os 4 bytes de PNG mas não tem o resto da assinatura real
// (ex.: um binário corrompido/hostil que só imita o prefixo) continua caindo no
// REJEITA de binário — só o arquivo com a assinatura PNG completa vira imagem.

import { createReadStream } from 'node:fs';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
// "GIF8" — prefixo comum às duas variantes válidas (GIF87a/GIF89a); inequívoco.
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const;
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46] as const; // "RIFF"
const WEBP_FOURCC = [0x57, 0x45, 0x42, 0x50] as const; // "WEBP"

/** Bytes o bastante p/ cobrir a maior assinatura verificada (WEBP: RIFF+size+WEBP = 12). */
export const IMAGE_SNIFF_BYTES = 16;

function matches(buf: Buffer, sig: readonly number[], offset = 0): boolean {
  if (buf.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (buf[offset + i] !== sig[i]) return false;
  }
  return true;
}

/**
 * Mimetype FECHADO (png/jpeg/gif/webp) reconhecido pelos MAGIC BYTES do prefixo de
 * `buf`, ou `null` se nenhum dos 4 casar. PURA — sem I/O.
 */
export function detectImageMimeType(buf: Buffer): string | null {
  if (matches(buf, PNG_SIGNATURE)) return 'image/png';
  if (matches(buf, JPEG_SIGNATURE)) return 'image/jpeg';
  if (matches(buf, GIF_SIGNATURE)) return 'image/gif';
  // WEBP: contêiner RIFF (bytes 0-3 "RIFF", bytes 4-7 = tamanho, bytes 8-11 "WEBP").
  if (matches(buf, RIFF_SIGNATURE) && matches(buf, WEBP_FOURCC, 8)) return 'image/webp';
  return null;
}

/**
 * Lê só o PREFIXO de `absPath` (até `IMAGE_SNIFF_BYTES`) e devolve o mimetype
 * reconhecido (ou `null`). Espelha o `sniffBinaryFile` (stream com `end`, sem
 * materializar o arquivo inteiro). `absPath` deve já estar resolvido/confinado
 * pelo `WorkspacePort` — este módulo não confina nada. Propaga erro de I/O (o
 * caller — `AttachReader` — tem o seu próprio fail-safe).
 */
export function sniffImageMimeType(
  absPath: string,
  sampleBytes: number = IMAGE_SNIFF_BYTES,
): Promise<string | null> {
  const window = Math.max(1, Math.floor(sampleBytes));
  return new Promise<string | null>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    const stream = createReadStream(absPath, { start: 0, end: window - 1 });
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      collected += buf.byteLength;
      if (collected >= window) stream.destroy();
    });
    stream.on('error', reject);
    const settle = (): void => resolvePromise(detectImageMimeType(Buffer.concat(chunks)));
    stream.on('close', settle);
    stream.on('end', settle);
  });
}

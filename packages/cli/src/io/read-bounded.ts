// EST-1010 · Leitura de I/O confinada por TETO de bytes ANTES de materializar.
//
// CLASSE DE BUG (mesma do `web_fetch → "Killed"`): aplicar o cap DEPOIS de já ter
// alocado o arquivo inteiro no heap. `await readFile(path)` materializa TODO o
// arquivo — um dump de 10 GB OOMa o processo ANTES de qualquer `byteLength > cap`.
// O teto vira cosmético.
//
// O FIX (padroniza read_file E grep): `readBounded(path, maxBytes)`:
//   1. `statSync(path).size` PRIMEIRO — sabemos o tamanho sem ler 1 byte;
//   2. se `size ≤ maxBytes` ⇒ lê o arquivo inteiro (caminho rápido, sem regressão);
//   3. se `size > maxBytes` ⇒ lê SÓ os primeiros `maxBytes` via `createReadStream`
//      com `{ end: maxBytes - 1 }` — o stream NUNCA traz mais que `maxBytes` bytes
//      ao heap (o kernel para de empurrar no `end`). NUNCA alocamos o todo.
//
// Devolve `{ content, truncated, totalBytes }`: `truncated` diz se cortou, e
// `totalBytes` é o tamanho REAL do arquivo (do stat) — o caller monta o marcador
// de truncamento com o número honesto.
//
// PORTÁVEL? NÃO — é I/O concreto (Node `fs`), por isso mora no @aluy/cli (não no
// core). É consumido pelo FS-port (read_file) e pelo Search-port (grep/scanFile).

import { statSync, createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { looksBinary } from './binary-sniff.js';

/** Resultado de uma leitura confinada por teto. */
export interface BoundedRead {
  /** Conteúdo (UTF-8). Se `truncated`, contém SÓ os primeiros `maxBytes` bytes.
   * Se `binary`, é string vazia (o caller monta a observação — não decodifica lixo). */
  readonly content: string;
  /** `true` se o arquivo excedia `maxBytes` e o conteúdo foi cortado. */
  readonly truncated: boolean;
  /** Tamanho REAL do arquivo em bytes (do `stat`), mesmo quando truncado. */
  readonly totalBytes: number;
  /** EST-1010 (BUG-0021) — `true` se o prefixo amostrado tem NUL ⇒ binário. O caller
   * NÃO injeta o conteúdo cru (mojibake/NUL): emite uma observação curta no lugar. */
  readonly binary: boolean;
}

/**
 * Fábrica do stream de leitura por RANGE (`[start, end]`, end inclusivo). Default =
 * `node:fs`. SEAM injetável SÓ p/ teste provar a leitura parcial (o range pedido ao
 * kernel é limitado ao teto) — em produção é sempre o `createReadStream` real.
 */
export type RangeStreamFactory = (path: string, range: { start: number; end: number }) => Readable;

const defaultRangeStream: RangeStreamFactory = (path, range) => createReadStream(path, range);

/**
 * Lê `path` aplicando o teto `maxBytes` ANTES de materializar o arquivo:
 *   - `stat` primeiro (tamanho sem ler);
 *   - `≤ maxBytes` ⇒ lê inteiro;
 *   - `> maxBytes` ⇒ stream parcial `{ end: maxBytes - 1 }` (NUNCA aloca o todo).
 *
 * `path` deve já estar resolvido/confinado pelo `WorkspacePort` (o caller faz isso).
 * Propaga erros de fs (arquivo sumiu/ilegível) — o caller decide pular/observar.
 * `openRangeStream` é injeção SÓ-DE-TESTE (default = `createReadStream` real).
 */
export async function readBounded(
  path: string,
  maxBytes: number,
  openRangeStream: RangeStreamFactory = defaultRangeStream,
): Promise<BoundedRead> {
  // 1 — TAMANHO PRIMEIRO. Sabemos se vai estourar sem trazer 1 byte ao heap.
  const totalBytes = statSync(path).size;

  // Limite efetivo de bytes a trazer ao heap (anti-OOM): o menor entre o tamanho
  // real e o teto. NUNCA alocamos mais que `maxBytes` (o `end` do stream para).
  const truncated = totalBytes > maxBytes;
  const limit = truncated ? maxBytes : totalBytes;

  // Coleta os bytes (até o limite) UMA vez — depois decidimos binário/texto. O
  // buffer cru é necessário p/ farejar NUL (EST-1010 BUG-0021) sem decodificar lixo.
  const buf = await collectBufUpTo(path, limit, openRangeStream);

  // EST-1010 (BUG-0021) — BINÁRIO? Aqui já temos no heap TODO o conteúdo que será
  // decodificado (até `maxBytes` — teto anti-OOM já aplicado). Farejamos NUL no
  // BUFFER INTEIRO, não só nos primeiros 8 KiB: um binário com cabeçalho ASCII
  // longo (NUL só APÓS a janela de amostra — WAV/firmware/dumps padronizados)
  // passava pelo sniff de prefixo e despejava NUL/mojibake cru no contexto. Como o
  // buffer já está limitado pelo teto, varrer tudo é barato e não materializa nada
  // além do que já leríamos. Conteúdo fica vazio; o caller emite a observação curta.
  if (looksBinary(buf, buf.byteLength)) {
    return { content: '', truncated, totalBytes, binary: true };
  }

  return { content: buf.toString('utf8'), truncated, totalBytes, binary: false };
}

/**
 * Coleta no MÁXIMO `limit` bytes de `path` via stream e devolve o BUFFER cru.
 * Para de ler em `limit` (`{ end: limit - 1 }`, inclusivo) — garante que nunca
 * alocamos mais que `limit` bytes, mesmo que o arquivo seja gigantesco. Devolver o
 * buffer (e não a string) deixa o caller farejar binário (NUL) ANTES de decidir
 * decodificar — sem despejar lixo no contexto (EST-1010 BUG-0021).
 */
function collectBufUpTo(path: string, limit: number, open: RangeStreamFactory): Promise<Buffer> {
  // `limit === 0` ⇒ arquivo vazio (ou teto zero): sem stream, devolve buffer vazio.
  // `createReadStream` com `end: -1` é inválido; curto-circuitamos.
  if (limit <= 0) return Promise.resolve(Buffer.alloc(0));
  return new Promise<Buffer>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    const stream = open(path, { start: 0, end: limit - 1 });
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      // Defesa-em-profundidade: nunca acumula além de `limit` (o `end` já garante,
      // mas cortamos o último chunk se por algum motivo vier maior).
      const room = limit - collected;
      if (room <= 0) return;
      if (buf.byteLength > room) {
        chunks.push(buf.subarray(0, room));
        collected = limit;
        stream.destroy(); // não precisamos de mais nada — encerra o I/O.
      } else {
        chunks.push(buf);
        collected += buf.byteLength;
      }
    });
    stream.on('error', reject);
    stream.on('close', () => resolvePromise(Buffer.concat(chunks)));
    stream.on('end', () => resolvePromise(Buffer.concat(chunks)));
  });
}

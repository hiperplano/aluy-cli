// EST-1010 (BUG-0021) — DETECÇÃO de arquivo BINÁRIO (NUL nos primeiros KB).
//
// CLASSE DE BUG: `read_file a.bin` e `@image.png` faziam `buf.toString('utf8')`
// CRU — sem checar se o arquivo é binário. Resultado: mojibake + bytes NUL
// despejados no contexto do modelo (lixo que não ajuda e ainda gasta janela). O
// `grep` (`search-port.ts`) JÁ pulava binário por esta mesma heurística (NUL no
// conteúdo) — `read`/`@attach` não tinham o guard. Esta é a peça compartilhada.
//
// HEURÍSTICA (a mesma do grep, do `git`, do `file(1)` clássico): um byte NUL
// (0x00) nos primeiros KB ⇒ tratamos como BINÁRIO. Texto UTF-8/UTF-16-sem-BOM
// honesto não tem NUL no corpo; binários (imagens, executáveis, .pdf, .zip)
// quase sempre têm NUL bem no começo. Barato (varre só o prefixo amostrado) e
// sem falso-positivo prático p/ código/texto.

import { createReadStream } from 'node:fs';

/** Quantos bytes do início amostrar p/ decidir binário. 8 KiB cobre o cabeçalho. */
export const BINARY_SNIFF_BYTES = 8 * 1024;

/**
 * `true` se o buffer parece BINÁRIO: há um byte NUL (0x00) nos primeiros
 * `sampleBytes` bytes. Varre só o prefixo — O(min(len, sampleBytes)).
 */
export function looksBinary(buf: Buffer, sampleBytes: number = BINARY_SNIFF_BYTES): boolean {
  const end = Math.min(buf.byteLength, sampleBytes);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Mensagem honesta p/ o lugar do conteúdo cru quando o arquivo é binário. NÃO é o
 * conteúdo — é uma observação curta (em vez de despejar mojibake/NUL no contexto).
 * `path` é o caminho relativo confinado (o que o usuário vê); `totalBytes` o
 * tamanho real do arquivo.
 */
export function binaryNotice(path: string, totalBytes: number): string {
  return `[arquivo binário: ${path} — ${totalBytes} bytes, não lido como texto]`;
}

/**
 * Lê o prefixo de `absPath` (até `sampleBytes`, default `BINARY_SNIFF_BYTES`) e
 * fareja NUL — sem materializar o arquivo inteiro (stream com `end`). Usado pelo
 * `@attach` p/ REJEITAR um binário ANTES de o ler como texto. Resolve `true` se
 * binário, `false` se texto. Propaga erro de I/O (o caller já tem o seu fail-safe).
 * `absPath` deve já estar resolvido/confinado pelo `WorkspacePort`.
 *
 * BUG-0021 (correção) — `sampleBytes` deve cobrir a MESMA janela que será
 * DECODIFICADA como texto (o teto de leitura, não só 8 KiB): um binário com
 * cabeçalho ASCII longo (NUL só depois da amostra de prefixo) escapava a uma
 * amostra de 8 KiB e era anexado como texto cru (NUL/mojibake no contexto). O
 * caller passa o seu teto de leitura p/ a janela bater com a do `readFile`.
 */
export function sniffBinaryFile(
  absPath: string,
  sampleBytes: number = BINARY_SNIFF_BYTES,
): Promise<boolean> {
  const window = Math.max(1, Math.floor(sampleBytes));
  return new Promise<boolean>((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let collected = 0;
    const stream = createReadStream(absPath, { start: 0, end: window - 1 });
    stream.on('data', (chunk: string | Buffer) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      collected += buf.byteLength;
      if (collected >= window) stream.destroy(); // já temos a amostra.
    });
    stream.on('error', reject);
    const settle = (): void => resolvePromise(looksBinary(Buffer.concat(chunks), window));
    stream.on('close', settle);
    stream.on('end', settle);
  });
}

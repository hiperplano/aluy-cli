// EST-0948 · I/O concreto da FileSystemPort (cravada do `seguranca`).
//
// Implementa `FileSystemPort` do core (EST-0944) com `node:fs/promises` real,
// SEMPRE atrás do confinamento DURO de workspace (`WorkspacePort.resolveInside`):
// todo path — de leitura OU escrita — é resolvido+canonicalizado contra a raiz e
// REJEITADO se escapa (`..`/symlink/absoluto fora). Esta é a 2ª linha que a 0945
// delega ao locus concreto: o `looksOutsideWorkspace` textual já força ask; o
// confinamento real BLOQUEIA o efeito mesmo se algo passasse pela catraca.
//
// Fail-safe: `resolveInside` lança `WorkspaceEscapeError` p/ qualquer escape, e o
// erro vira observação (a tool nativa devolve `ok=false` — CLI-SEC-4: o modelo
// trata, não trava). Nenhum byte é lido/escrito fora da raiz.
//
// EST-1010 · ANTI-OOM: o teto `maxReadBytes` é aplicado ANTES de materializar o
// arquivo (via `readBounded` — stat-then-partial). Antes, `readFile(safe)` alocava
// o arquivo INTEIRO no heap e só DEPOIS cortava: um dump de 10 GB OOMava o processo
// antes do cap (mesma classe do `web_fetch → "Killed"`). Agora um arquivo gigante é
// lido só até `maxReadBytes` — nunca além.
//
// EST-1010 (BUG-0021) · ANTI-BINÁRIO: `readBounded` fareja NUL nos primeiros KB. Um
// arquivo binário (`a.bin`, `.png`) deixa de despejar mojibake/NUL no contexto — vira
// uma observação curta ("arquivo binário, N bytes"). Mesma heurística do `grep`.

import { writeFile as fsWriteFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FileReadMeta, FileSystemPort } from '@aluy/cli-core';
import type { WorkspacePort } from './workspace.js';
import { readBounded } from './read-bounded.js';
import { binaryNotice } from './binary-sniff.js';

export interface NodeFileSystemPortOptions {
  /** Workspace — confina TODO path resolvido (resolveInside). */
  readonly workspace: WorkspacePort;
  /** Máximo de bytes lidos de um arquivo (anti-OOM). Default 5 MiB. */
  readonly maxReadBytes?: number;
}

const DEFAULT_MAX_READ_BYTES = 5 * 1024 * 1024;

export class NodeFileSystemPort implements FileSystemPort {
  private readonly workspace: WorkspacePort;
  private readonly maxReadBytes: number;

  constructor(opts: NodeFileSystemPortOptions) {
    this.workspace = opts.workspace;
    this.maxReadBytes = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  }

  async readFile(path: string): Promise<string> {
    // CONFINAMENTO DURO: lança WorkspaceEscapeError se o path escapa a raiz.
    const safe = this.workspace.resolveInside(path);
    // EST-1010 · ANTI-OOM: `stat` ANTES de materializar — arquivo > teto é lido só
    // até `maxReadBytes` (stream parcial), NUNCA o todo. O cap deixa de ser cosmético.
    const { content, truncated, totalBytes, binary } = await readBounded(safe, this.maxReadBytes);
    // EST-1010 (BUG-0021) · BINÁRIO: NUL nos primeiros KB ⇒ não devolve o cru
    // (mojibake/NUL). Observação curta no lugar — o modelo entende que não dá p/ ler.
    if (binary) {
      // `path` (relativo, o que o usuário pediu) p/ a observação, não o abs confinado.
      return binaryNotice(path, totalBytes);
    }
    if (truncated) {
      return `${content}\n[arquivo truncado: lidos ${this.maxReadBytes} de ${totalBytes} bytes]`;
    }
    return content;
  }

  /**
   * EST-0944 (anti-data-loss) — leitura COM completude, p/ o editor decidir se pode
   * reescrever. `readFile` (acima) devolve um PREFIXO + marcador textual quando o
   * arquivo passa do teto, e uma NOTA quando é binário — string que NÃO representa o
   * arquivo. Se o editor reescrevesse sobre ela, TRUNCARIA o arquivo no disco. Aqui
   * reusamos o mesmo `readBounded` mas reportamos `complete=false` nesses casos (sem
   * mexer no `readFile`, que é o contrato de OBSERVAÇÃO p/ o modelo).
   */
  async readFileMeta(path: string): Promise<FileReadMeta> {
    const safe = this.workspace.resolveInside(path);
    const { content, truncated, binary } = await readBounded(safe, this.maxReadBytes);
    if (binary || truncated) return { content, complete: false };
    return { content, complete: true };
  }

  async writeFile(path: string, content: string): Promise<void> {
    // CONFINAMENTO DURO antes de qualquer escrita.
    const safe = this.workspace.resolveInside(path);
    // Cria os diretórios pais SE não existirem (ex.: .aluy/agents/ na 1ª escrita).
    // `recursive: true` é idempotente — dirs que já existem não lançam erro.
    await mkdir(dirname(safe), { recursive: true });
    await fsWriteFile(safe, content, 'utf8');
  }

  async exists(path: string): Promise<boolean> {
    // `exists` também confina: um path fora não "existe" do ponto de vista do
    // agente (e não vazamos se há arquivo fora da raiz).
    try {
      const safe = this.workspace.resolveInside(path);
      return existsSync(safe);
    } catch {
      return false;
    }
  }
}

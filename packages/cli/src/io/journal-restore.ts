// EST-0960a · ADR-0056 §4/R8 — I/O CONCRETO da restauração confinada do journal.
//
// A restauração que a EST-0960b consome ESCREVE de volta o conteúdo-antes (ou
// REMOVE um arquivo criado pela edição). É um EFEITO de escrita ⇒ confinado ao
// workspace (CLI-SEC-3): resolve+canonicaliza o alvo pelo `WorkspacePort`
// (`resolveInside`, EST-0948) NO MOMENTO DA ESCRITA — não confia no path gravado
// na captura. Um symlink/`..`/absoluto-fora plantado DEPOIS do snapshot é
// rejeitado AQUI (lança `WorkspaceEscapeError`), não desvia a escrita p/ fora
// (R8/TOCTOU). O core orquestra; o byte só sai por este módulo.
//
// PORTÁVEL? NÃO — `node:fs` concreto, por isso mora no @hiperplano/aluy-cli (locus concreto).

import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import type { CurrentReaderPort, RestoreWriterPort } from '@hiperplano/aluy-cli-core';
import type { WorkspacePort } from './workspace.js';

export interface NodeRestoreWriterOptions {
  /** Workspace — confina TODO alvo de restauração (resolveInside no write). */
  readonly workspace: WorkspacePort;
}

/**
 * Escritor de restauração confinado. Resolve o alvo pelo `WorkspacePort` no
 * MOMENTO da escrita/remoção (R8) e só então toca o filesystem. `resolveInside`
 * LANÇA se o alvo escapa — propagamos (fail-safe: a restauração falha em vez de
 * escrever fora do workspace).
 */
export class NodeRestoreWriter implements RestoreWriterPort {
  private readonly workspace: WorkspacePort;

  constructor(opts: NodeRestoreWriterOptions) {
    this.workspace = opts.workspace;
  }

  async writeConfined(requested: string, content: string): Promise<string> {
    // R8/TOCTOU: resolve+canonicaliza AGORA (segue symlink real, rejeita escape).
    const safe = this.workspace.resolveInside(requested);
    writeFileSync(safe, content, 'utf8');
    return safe;
  }

  async removeConfined(requested: string): Promise<string> {
    const safe = this.workspace.resolveInside(requested);
    rmSync(safe, { force: true });
    return safe;
  }
}

/**
 * Leitor confinado do estado ATUAL de um arquivo p/ a checagem de concorrência
 * (§4). Resolve pelo `WorkspacePort`; devolve `undefined` se não existe/escapa
 * (um path que escapa não "existe" do ponto de vista do agente — fail-safe).
 */
export class NodeCurrentReader implements CurrentReaderPort {
  private readonly workspace: WorkspacePort;

  constructor(opts: NodeRestoreWriterOptions) {
    this.workspace = opts.workspace;
  }

  async readCurrent(requested: string): Promise<string | undefined> {
    let safe: string;
    try {
      safe = this.workspace.resolveInside(requested);
    } catch {
      return undefined;
    }
    if (!existsSync(safe)) return undefined;
    return readFileSync(safe, 'utf8');
  }
}

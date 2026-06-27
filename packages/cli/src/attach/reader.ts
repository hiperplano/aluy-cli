// EST-0957 · CA-3/CA-4 · CLI-SEC-4/6 + confinamento — LEITOR de anexos `@arquivo`.
//
// O ponto onde o conteúdo de um arquivo apontado pelo usuário vira DADO p/ o turno.
// Toda trava do canal `@` converge aqui (gate seguranca-light AG-0008):
//
//   1) CONFINAMENTO (EST-0948): o path passa por `WorkspacePort.resolveInside` —
//      `..`/symlink/absoluto que ESCAPA a raiz ⇒ REJEITADO (nenhum byte fora lido).
//   2) PATH-DENY (CLI-SEC-6 baseline, path-deny.ts): `.env`/`~/.ssh`/`*token*` etc.
//      ⇒ `deny` nunca lê; `ask` só com `confirmSensitive` explícito.
//   2.5) BINÁRIO (EST-1010): NUL na JANELA LIDA ⇒ REJEITA (imagem/PDF/zip não
//        viram mojibake/NUL no contexto). Mesma heurística do `grep` (search-port).
//        A amostra cobre TODO o teto de leitura (`sniffBytes`), não só 8 KiB — um
//        binário com cabeçalho ASCII longo (NUL pós-8 KiB) já não escapa o sniff.
//   3) TRUNCAMENTO/ORÇAMENTO: arquivo gigante é truncado a um teto de chars (não
//      estoura a janela de contexto) e o corte é AVISADO no próprio conteúdo.
//   4) ROTULAGEM (CLI-SEC-4): o conteúdo vira `HistoryItem` de `observation`
//      (`attachmentObservation`) — canal CONTEÚDO não-confiável, nunca instrução.
//
// O resultado é discriminado: `ok` (com o HistoryItem pronto p/ o loop) ou
// `rejected` (com o motivo legível p/ a UI/linear). Fail-safe: QUALQUER erro de
// confinamento/leitura ⇒ `rejected`, nunca um throw que derrube a sessão.

import { attachmentObservation, type HistoryItem } from '@aluy/cli-core';
import type { FileSystemPort } from '@aluy/cli-core';
import { relative, sep, isAbsolute } from 'node:path';
import { classifyAttachPath } from './path-deny.js';
import type { WorkspacePort } from '../io/workspace.js';
import { sniffBinaryFile } from '../io/binary-sniff.js';

/** Teto de caracteres injetados por anexo (anti-estouro de janela). ~16k chars. */
export const DEFAULT_MAX_ATTACH_CHARS = 16_000;

/**
 * Janela (bytes) p/ o sniff de binário do `@attach`. DEVE cobrir tudo o que a
 * `FileSystemPort.readFile` pode decodificar como texto (o teto anti-OOM, default
 * 5 MiB no NodeFileSystemPort) — senão um binário com cabeçalho ASCII longo (NUL só
 * depois de 8 KiB) escapa o sniff de prefixo e injeta NUL/mojibake no contexto.
 */
export const DEFAULT_ATTACH_SNIFF_BYTES = 5 * 1024 * 1024;

/** Resultado de tentar anexar um arquivo. */
export type AttachResult =
  | {
      readonly kind: 'ok';
      /** Caminho RELATIVO confinado (o que o chip mostra). */
      readonly path: string;
      /** O item de histórico pronto p/ o loop (observation rotulada). */
      readonly item: HistoryItem;
      /** `true` se o conteúdo foi truncado pelo teto. */
      readonly truncated: boolean;
    }
  | { readonly kind: 'rejected'; readonly path: string; readonly reason: string };

export interface AttachReaderOptions {
  readonly workspace: WorkspacePort;
  readonly fs: FileSystemPort;
  /** Teto de chars por anexo. Default `DEFAULT_MAX_ATTACH_CHARS`. */
  readonly maxChars?: number;
  /**
   * Bytes amostrados p/ o sniff de binário. Default `DEFAULT_ATTACH_SNIFF_BYTES`
   * (= o teto de leitura do FS-port): a janela do sniff bate com a do `readFile`,
   * então um binário com cabeçalho ASCII longo (NUL pós-8 KiB) é REJEITADO em vez
   * de injetado cru. Configurável só p/ teste (alinhar com um `maxReadBytes` menor).
   */
  readonly sniffBytes?: number;
}

export interface AttachOptions {
  /**
   * Confirmação explícita p/ um caminho SENSÍVEL (path-deny `ask`: `.env`,
   * `*token*`). Sem ela, sensível ⇒ `rejected`. `deny` (chave/credencial) IGNORA
   * a confirmação — nunca lê.
   */
  readonly confirmSensitive?: boolean;
}

export class AttachReader {
  private readonly workspace: WorkspacePort;
  private readonly fs: FileSystemPort;
  private readonly maxChars: number;
  private readonly sniffBytes: number;

  constructor(opts: AttachReaderOptions) {
    this.workspace = opts.workspace;
    this.fs = opts.fs;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_ATTACH_CHARS;
    this.sniffBytes = opts.sniffBytes ?? DEFAULT_ATTACH_SNIFF_BYTES;
  }

  /**
   * Resolve+confina+path-deny+lê+trunca+rotula um caminho. Devolve `ok` com o
   * HistoryItem ou `rejected` com o motivo. NUNCA lança (fail-safe).
   */
  async attach(requested: string, opts: AttachOptions = {}): Promise<AttachResult> {
    const shown = requested;
    // 1) CONFINAMENTO DURO: resolve contra a raiz; rejeita se escapa.
    let safeAbs: string;
    try {
      safeAbs = this.workspace.resolveInside(requested);
    } catch {
      return {
        kind: 'rejected',
        path: shown,
        reason: 'caminho fora do workspace — recusado (o @ só acessa a raiz do projeto).',
      };
    }
    // Caminho relativo confinado p/ o rótulo/path-deny (o que o usuário vê).
    const rel = relative(this.workspace.root, safeAbs).split(sep).join('/');
    // Caminho relativo nunca deve ser absoluto/escapar após resolveInside; guarda.
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      return { kind: 'rejected', path: shown, reason: 'caminho inválido p/ o workspace.' };
    }

    // 2) PATH-DENY (CLI-SEC-6 baseline) sobre o caminho relativo confinado.
    const verdict = classifyAttachPath(rel);
    if (verdict.kind === 'deny') {
      return {
        kind: 'rejected',
        path: rel,
        reason: `bloqueado: ${verdict.why} — esse tipo de arquivo nunca é anexado ao contexto.`,
      };
    }
    if (verdict.kind === 'ask' && opts.confirmSensitive !== true) {
      return {
        kind: 'rejected',
        path: rel,
        reason: `sensível: ${verdict.why} — confirme explicitamente p/ anexar (fora do picker por padrão).`,
      };
    }

    // 2.5) BINÁRIO (EST-1010 BUG-0021): fareja NUL nos primeiros KB. Imagem/PDF/zip/
    // executável ⇒ REJEITA (não despeja mojibake/NUL no contexto). O `grep` já fazia
    // isto; o `@` não. Fail-safe: se o sniff falhar (sumiu/ilegível), NÃO rejeita por
    // binário — segue p/ a leitura, que tem o seu próprio fail-safe (`rejected`).
    try {
      if (await sniffBinaryFile(safeAbs, this.sniffBytes)) {
        return {
          kind: 'rejected',
          path: rel,
          reason: 'arquivo binário — não anexado (conteúdo não é texto; evita lixo no contexto).',
        };
      }
    } catch {
      // sniff falhou (corrida/ilegível): não bloqueia por binário; a leitura decide.
    }

    // 3) LEITURA confinada (a FileSystemPort reconfina internamente — defesa dupla).
    let content: string;
    try {
      content = await this.fs.readFile(rel);
    } catch {
      return {
        kind: 'rejected',
        path: rel,
        reason: 'não foi possível ler o arquivo (sumiu/ilegível).',
      };
    }

    // 4) TRUNCAMENTO/ORÇAMENTO: corta arquivo gigante e AVISA no conteúdo.
    let truncated = false;
    if (content.length > this.maxChars) {
      content =
        content.slice(0, this.maxChars) +
        `\n[…conteúdo truncado: arquivo maior que ${this.maxChars} caracteres — só o início foi anexado…]`;
      truncated = true;
    }

    // 5) ROTULAGEM (CLI-SEC-4): observation rotulada `[arquivo: rel]`, dado, nunca instrução.
    return { kind: 'ok', path: rel, item: attachmentObservation(rel, content), truncated };
  }
}

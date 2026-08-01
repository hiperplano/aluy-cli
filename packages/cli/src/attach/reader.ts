// EST-0957 · CA-3/CA-4 · CLI-SEC-4/6 + confinamento — LEITOR de anexos `@arquivo`.
//
// O ponto onde o conteúdo de um arquivo apontado pelo usuário vira DADO p/ o turno.
// Toda trava do canal `@` converge aqui (gate seguranca-light AG-0008):
//
//   1) CONFINAMENTO (EST-0948): o path passa por `WorkspacePort.resolveInside` —
//      `..`/symlink/absoluto que ESCAPA a raiz ⇒ REJEITADO (nenhum byte fora lido).
//   2) PATH-DENY (CLI-SEC-6 baseline, path-deny.ts): `.env`/`~/.ssh`/`*token*` etc.
//      ⇒ `deny` nunca lê; `ask` só com `confirmSensitive` explícito.
//   2.5) IMAGEM (ADR-0159), checado PRIMEIRO: os MAGIC BYTES do arquivo contra a
//        lista FECHADA png/jpeg/gif/webp (`image-sniff.ts`) — ANTES do sniff de NUL
//        (não atrás dele: uma imagem minúscula/degenerada pode não ter NUL na
//        janela amostrada, e mesmo assim é imagem de verdade). Reconhecida ⇒ lê o
//        arquivo INTEIRO como binário, BASE64-codifica e vira `ContentPart` de
//        imagem (`attachmentImage`) — NUNCA passa pelo string-template do passo 4
//        (destruiria os bytes).
//   2.6) BINÁRIO genérico (EST-1010): não reconhecido como imagem no 2.5 ⇒ fareja
//        NUL na JANELA LIDA (mesma heurística do `grep`, search-port; a amostra
//        cobre TODO o teto de leitura, não só 8 KiB) ⇒ REJEITA (PDF/zip/executável
//        não viram mojibake/NUL no contexto). A exceção de imagem é FECHADA aos 4
//        tipos do 2.5 — nenhuma relaxação geral do guard.
//   3) TRUNCAMENTO/ORÇAMENTO (só p/ TEXTO): arquivo gigante é truncado a um teto de
//      chars (não estoura a janela de contexto) e o corte é AVISADO no próprio
//      conteúdo.
//   4) ROTULAGEM (CLI-SEC-4): o conteúdo TEXTO vira `HistoryItem` de `observation`
//      (`attachmentObservation`) — canal CONTEÚDO não-confiável, nunca instrução.
//
// O resultado é discriminado: `ok` (com o HistoryItem pronto p/ o loop — texto OU
// imagem) ou `rejected` (com o motivo legível p/ a UI/linear). Fail-safe: QUALQUER
// erro de confinamento/leitura ⇒ `rejected`, nunca um throw que derrube a sessão.

import { attachmentImage, attachmentObservation, type HistoryItem } from '@hiperplano/aluy-cli-core';
import type { FileSystemPort } from '@hiperplano/aluy-cli-core';
import { relative, sep, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import { classifyAttachPath } from './path-deny.js';
import type { WorkspacePort } from '../io/workspace.js';
import { sniffBinaryFile } from '../io/binary-sniff.js';
import { sniffImageMimeType } from '../io/image-sniff.js';

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
  /**
   * ADR-0159 — teto de bytes p/ uma IMAGEM reconhecida (png/jpeg/gif/webp). Distinto
   * do `maxChars` (que só governa texto truncado): a imagem NUNCA é truncada — acima
   * do teto, é REJEITADA inteira (base64 parcial não é uma imagem válida). Default
   * 8 MiB — generoso p/ foto/screenshot comuns, finito o bastante p/ não inflar a
   * janela do modelo (base64 soma ~33% ao tamanho cru).
   */
  readonly maxImageBytes?: number;
}

/** Default de `maxImageBytes` (ADR-0159). Ver doc do campo em `AttachReaderOptions`. */
export const DEFAULT_MAX_ATTACH_IMAGE_BYTES = 8 * 1024 * 1024;

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
  private readonly maxImageBytes: number;

  constructor(opts: AttachReaderOptions) {
    this.workspace = opts.workspace;
    this.fs = opts.fs;
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_ATTACH_CHARS;
    this.sniffBytes = opts.sniffBytes ?? DEFAULT_ATTACH_SNIFF_BYTES;
    this.maxImageBytes = opts.maxImageBytes ?? DEFAULT_MAX_ATTACH_IMAGE_BYTES;
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

    // 2.5) IMAGEM (ADR-0159) — checa os MAGIC BYTES PRIMEIRO (independente do sniff de
    // NUL abaixo): lista FECHADA png/jpeg/gif/webp. Fail-safe: sniff falhou (sumiu/
    // ilegível) ⇒ trata como NÃO-imagem (cai no 2.6, que tem o seu próprio fail-safe).
    let imageMimeType: string | null = null;
    try {
      imageMimeType = await sniffImageMimeType(safeAbs);
    } catch {
      imageMimeType = null;
    }
    if (imageMimeType !== null) {
      // Imagem reconhecida: lê o arquivo INTEIRO como binário (com teto anti-OOM
      // próprio — imagem NUNCA é truncada, ao contrário de texto) e base64-codifica.
      let raw: Buffer;
      try {
        raw = await readFile(safeAbs);
      } catch {
        return {
          kind: 'rejected',
          path: rel,
          reason: 'não foi possível ler o arquivo (sumiu/ilegível).',
        };
      }
      if (raw.byteLength > this.maxImageBytes) {
        return {
          kind: 'rejected',
          path: rel,
          reason: `imagem maior que o teto (${this.maxImageBytes} bytes) — não anexada (base64 parcial não é uma imagem válida).`,
        };
      }
      return {
        kind: 'ok',
        path: rel,
        item: attachmentImage(rel, imageMimeType, raw.toString('base64')),
        truncated: false,
      };
    }

    // 2.6) BINÁRIO genérico (EST-1010 BUG-0021): não é uma das 4 imagens reconhecidas
    // acima ⇒ fareja NUL nos primeiros KB. Fail-safe: se o sniff falhar (sumiu/
    // ilegível), NÃO rejeita por binário — segue p/ a leitura de texto, que tem o
    // seu próprio fail-safe (`rejected`).
    let isBinary = false;
    try {
      isBinary = await sniffBinaryFile(safeAbs, this.sniffBytes);
    } catch {
      isBinary = false;
    }
    if (isBinary) {
      return {
        kind: 'rejected',
        path: rel,
        reason: 'arquivo binário — não anexado (conteúdo não é texto; evita lixo no contexto).',
      };
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

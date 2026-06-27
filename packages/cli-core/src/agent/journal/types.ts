// EST-0960a · ADR-0056 — JOURNAL DE SNAPSHOT-DO-ANTES (a fronteira modular).
//
// A MECÂNICA do journal (pilha undo/redo por sessão, captura do `antes`, fronteira
// do reversível `edit_file`↔`run_command`, detecção de edição concorrente, e a API
// que a EST-0960b consome) é CÓDIGO PORTÁVEL — mora aqui no @aluy/cli-core. O I/O
// CONCRETO (escrever blobs em `~/.aluy/undo/<session>/` com `0600`/`0700` atômico,
// GC, teto de retenção, unlink real) é injetado por uma PORTA — `JournalStorePort`
// — cujo concreto mora em @aluy/cli (estilo `FileSystemPort`/`ShellPort`, §6 do ADR).
//
// PORTÁVEL: nenhum `node:fs`/`node:path` aqui — só tipos e a porta. O store
// concreto (NodeJournalStore, @aluy/cli) é quem toca o filesystem.

import type { WorkspacePort } from './workspace-port.js';
import type { JournalCipher } from './cipher.js';

/** Referência opaca a um blob de conteúdo-antes guardado pelo store. */
export type BlobRef = string;

/**
 * Um alvo de uma edição rastreada: o caminho (relativo ao workspace, como o
 * agente o pediu), a ref do blob com o conteúdo ANTERIOR, e o hash do antes
 * (p/ detectar edição concorrente na restauração — §4 do ADR).
 */
export interface SnapshotTarget {
  /** Caminho-alvo COMO O AGENTE O PEDIU (não-confiável; revalidado na restauração). */
  readonly path: string;
  /** Ref do blob com o conteúdo ANTES da edição (no store; possível segredo). */
  readonly beforeRef: BlobRef;
  /** Hash do conteúdo-antes (detecção de concorrência). */
  readonly beforeHash: string;
  /** `true` se o arquivo NÃO existia antes (a restauração = apagar o arquivo). */
  readonly createdByEdit: boolean;
}

/**
 * Um item na pilha undo/redo da sessão. `kind: 'edit'` é REVERSÍVEL (tem
 * snapshot); `kind: 'barrier'` marca um efeito NÃO-reversível (`run_command`) —
 * a 0960b avisa a barreira em vez de fingir desfazer (CA-3 / §2 do ADR).
 */
export type JournalEntry =
  | {
      readonly kind: 'edit';
      readonly seq: number;
      readonly ts: number;
      readonly tool: string; // 'edit_file'
      readonly targets: readonly SnapshotTarget[];
      /** Hash do conteúdo aplicado (depois) — detecção de concorrência. */
      readonly appliedHash: string;
    }
  | {
      readonly kind: 'barrier';
      readonly seq: number;
      readonly ts: number;
      readonly tool: string; // 'run_command'
      /** O comando EXATO (p/ a 0960b dizer "aqui rodou `<cmd>`"). NUNCA logado. */
      readonly command: string;
    };

/**
 * Diagnóstico de uma checagem de concorrência (consumido pela 0960b p/ pedir
 * confirmação): o estado atual divergiu do snapshot? (CA-4 / §4 do ADR).
 */
export interface ConcurrencyCheck {
  /** `true` se o arquivo no disco mudou desde o snapshot (hash diverge). */
  readonly diverged: boolean;
  /** Hash esperado (o `appliedHash` que a edição deixou). */
  readonly expectedHash: string;
  /** Hash do estado ATUAL do arquivo no disco (no momento da checagem). */
  readonly currentHash: string;
}

/** Resultado de uma restauração confinada (consumida pela 0960b). */
export interface RestoreOutcome {
  readonly path: string;
  /** `'written'` (conteúdo-antes restaurado) | `'removed'` (era arquivo novo). */
  readonly action: 'written' | 'removed';
}

/**
 * PORTA da ESCRITA de restauração (I/O concreto, @aluy/cli). Resolve o alvo pelo
 * `WorkspacePort` NO MOMENTO DA ESCRITA (R8/TOCTOU) e só então escreve/remove —
 * rejeita `..`/symlink/absoluto-fora plantado depois da captura. O core ORQUESTRA
 * (lê blob, checa concorrência) mas NÃO toca o filesystem: a resolução+escrita
 * atômica mora no concreto, p/ a revalidação acontecer junto da escrita (não
 * numa janela anterior). LANÇA (WorkspaceEscapeError) se o alvo escapa — o core
 * propaga (fail-safe: a restauração falha em vez de escrever fora).
 */
export interface RestoreWriterPort {
  /**
   * Escreve `content` no `requested` resolvido+confinado AGORA. Lança se escapa.
   * Devolve o path absoluto seguro onde escreveu.
   */
  writeConfined(requested: string, content: string): Promise<string>;
  /**
   * Remove o `requested` resolvido+confinado AGORA (desfaz uma criação). Lança
   * se escapa. No-op se o arquivo já não existe. Devolve o path absoluto seguro.
   */
  removeConfined(requested: string): Promise<string>;
}

/**
 * PORTA de leitura do estado ATUAL de um arquivo p/ a checagem de concorrência
 * (§4). Resolve+confina pelo WorkspacePort. Devolve `undefined` se o arquivo já
 * não existe (foi removido fora do agente). NÃO é o canal de leitura do agente
 * (uso interno da mecânica). O `FileSystemPort` concreto já a satisfaz.
 */
export interface CurrentReaderPort {
  /** Lê o conteúdo atual confinado, ou `undefined` se não existe/escapa. */
  readCurrent(requested: string): Promise<string | undefined>;
}

/**
 * PORTA do store do journal — o I/O concreto (mora em @aluy/cli). Tudo o que toca
 * `~/.aluy/` passa por aqui. Garantias do CONTRATO (o concreto DEVE honrar; o
 * gate do `seguranca` reconfere):
 *   - `putBlob`: cria o blob com `0600` ATÔMICO (O_CREAT|O_EXCL + mode), o dir da
 *     sessão `0700` ATÔMICO — nunca `0644`+chmod (R5).
 *   - blobs/pilha NUNCA vão p/ log/telemetria (R7/CLI-SEC-6).
 *   - `gcOrphans`/`cleanup`: unlink REAL dos blobs + dir-pai da sessão (R6).
 */
export interface JournalStorePort {
  /** Hash estável de um conteúdo (sha-256 hex). Determinístico, puro. */
  hash(content: string): string;
  /**
   * Persiste o conteúdo-antes e devolve a ref. Cria blob `0600`/dir `0700` de
   * forma ATÔMICA (R5). NUNCA loga o conteúdo (R7).
   */
  putBlob(content: string): Promise<BlobRef>;
  /**
   * Lê um blob pela ref (uso EXCLUSIVO da mecânica de restauração — NÃO é um
   * canal de leitura do agente; `~/.aluy/` está na path-deny de leitura, R7).
   */
  getBlob(ref: BlobRef): Promise<string>;
  /** Empilha um registro do journal (persistência da pilha da sessão). */
  appendEntry(entry: JournalEntry): Promise<void>;
  /**
   * Remove um blob pela ref — unlink REAL (R6/§3 teto de retenção: ao estourar,
   * o blob mais antigo é descartado fisicamente). Idempotente.
   */
  deleteBlob(ref: BlobRef): Promise<void>;
  /** Carrega a pilha persistida da sessão (p/ a 0960b reconstruir undo/redo). */
  loadEntries(): Promise<readonly JournalEntry[]>;
  /**
   * Limpeza de FIM de sessão: unlink REAL de todos os blobs E do dir-pai da
   * sessão (R6). Idempotente (chamar 2× não falha).
   */
  cleanup(): Promise<void>;
  /**
   * GC de sessões ÓRFÃS no start: remove dirs de sessões que terminaram
   * abruptamente (sem cleanup) — unlink REAL, cobre crash (R6).
   */
  gcOrphans(): Promise<void>;
}

/** Opções da construção do `SnapshotJournal`. */
export interface SnapshotJournalOptions {
  readonly store: JournalStorePort;
  /**
   * Workspace — confina a checagem de concorrência e a RESTAURAÇÃO ao workspace
   * NO MOMENTO DA ESCRITA (R8/TOCTOU): o path gravado na captura NÃO é confiável;
   * revalida-se aqui. Usado p/ ler o estado atual na checagem de divergência.
   */
  readonly workspace: WorkspacePort;
  /**
   * Escritor de restauração confinado (I/O concreto, @aluy/cli). A 0960b chama
   * `restore`, que delega a escrita/remoção a este port — que resolve o alvo
   * pelo WorkspacePort NO MOMENTO DA ESCRITA (R8). Opcional: sem ele, a captura
   * funciona mas `restore` lança (a 0960b sempre o injeta).
   */
  readonly restoreWriter?: RestoreWriterPort;
  /**
   * Leitor confinado do estado ATUAL de um arquivo (p/ a checagem de
   * concorrência §4). Resolve o path pelo WorkspacePort. Opcional: sem ele a
   * checagem assume "não-divergente" (a 0960b injeta o leitor real).
   */
  readonly currentReader?: CurrentReaderPort;
  /**
   * Teto de itens reversíveis (edições) retidos na pilha. Ao estourar, descarta
   * o mais ANTIGO com unlink real dos seus blobs (§3 do ADR). Default 100.
   */
  readonly maxEntries?: number;
  /**
   * Cifra de sessão dos blobs (#1 — a TRAVA REAL). Default: uma `JournalCipher`
   * nova com chave aleatória de 32 bytes (`crypto.randomBytes`), SÓ em memória.
   * Injetável APENAS p/ teste determinístico (chave fixa p/ round-trip/IV-único);
   * em produção o default é o caminho — a chave nasce e morre com a sessão.
   */
  readonly cipher?: JournalCipher;
}
